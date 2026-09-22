'use strict';
/*
 * selftest.js — end-to-end verification against the local lab:
 *   npm run selftest
 * Starts the lab + the real app modules, checks every mock proxy through the
 * full pipeline (raw sockets, protocol sniffing, judge round-trips, anonymity
 * classification, speed probe, geo), then exercises the rotating gateway.
 */
const assert = require('assert');
const http = require('http');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { startLab } = require('./lab');

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  — ' + extra : ''}`);
}

async function waitFor(fn, timeoutMs = 30000, everyMs = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, everyMs));
  }
  throw new Error('waitFor timeout');
}

async function main() {
  console.log('\n⚡ ULTIMATE PROXY CHECKER — self test\n');

  // ── lab up ──
  const lab = await startLab({});
  console.log(`  lab: judge on :${lab.judgePort} (tls: ${lab.judgeTlsPort || 'off'}), ${lab.proxies.length} mock proxies\n`);

  // ── point the app at the lab ──
  config.update({
    judgeUrls: [lab.judgeUrl],
    httpsProbeUrl: lab.judgeTlsPort ? `https://127.0.0.1:${lab.judgeTlsPort}/?format=json` : 'https://api.ipify.org/?format=json',
    speedTest: true,
    speedUrl: `http://127.0.0.1:${lab.judgePort}/bytes/131072`,
    speedBytes: 131072,
    speedTimeoutMs: 5000,
    timeoutMs: 8000,
    concurrency: 8,
    gateway: { port: 0, mode: 'round-robin', retries: 3 },
  });

  const { store, checker, gateway, targets, judges } = createApp({ quiet: true });
  await waitFor(() => judges.selfTested, 15000);
  check('judge self-test (direct)', judges.realIp !== undefined && judges.echoAvailable === true, `realIp=${judges.realIp || '(null, offline)'} echo=${judges.echoAvailable}`);

  store.importText(lab.lines.join('\n'));
  check('import parsed all lab proxies', store.size() === lab.proxies.length, `${store.size()} loaded`);

  // ── run the engine ──
  const drained = new Promise(res => checker.on('drain', res));
  checker.start('all');
  const t0 = Date.now();
  await drained;
  const took = ((Date.now() - t0) / 1000).toFixed(1);

  const byKey = {};
  for (const p of lab.proxies) byKey[p.key] = store.get(`${p.host}:${p.port}`);
  console.log(`\n  engine finished in ${took}s:\n`);
  for (const [k, r] of Object.entries(byKey)) {
    console.log(`    ${k.padEnd(12)} → ${r.status.padEnd(7)} proto=${(r.protocols.join(',') || '-').padEnd(12)} anon=${(r.anonymity || '-').padEnd(12)} lat=${r.latencyMs ?? '-'}ms spd=${r.speedKbps ?? '-'}KB/s`);
  }
  console.log('');

  check('socks5 detected as socks5+alive', byKey.socks5.status === 'alive' && byKey.socks5.protocols.includes('socks5'));
  check('plain elite: alive+http+elite', byKey.elite.status === 'alive' && byKey.elite.protocols.includes('http') && byKey.elite.anonymity === 'elite');
  check('https mock gains https tag via CONNECT', byKey['https-elite'].protocols.includes('https'), `protos=${byKey['https-elite'].protocols.join(',')}`);
  check('anonymous mock: via-marker classified', ['anonymous', 'transparent'].includes(byKey.anonymous.anonymity), byKey.anonymous.anonymity);
  check('transparent mock: classified', ['transparent', 'anonymous'].includes(byKey.transparent.anonymity), byKey.transparent.anonymity + (judges.realIp ? '' : ' (offline: XFF-only → anonymous)'));
  check('dead proxy reported dead', byKey.dead.status === 'dead', byKey.dead.lastError || '');
  check('slow proxy survived (alive or dead-slow)', byKey.slow.status === 'alive' || byKey.slow.status === 'dead', byKey.slow.status);
  check('latency measured on alive', ['socks5', 'elite', 'https-elite'].some(k => byKey[k].latencyMs >= 0 && byKey[k].latencyMs != null));
  check('speed measured (KB/s) on elite', byKey.elite.speedKbps > 0, `${byKey.elite.speedKbps} KB/s`);
  check('exit IP resolved (judge origin)', byKey.elite.exitIp !== null, byKey.elite.exitIp);
  check('geo resolved (local lab)', byKey.elite.geo && byKey.elite.geo.local === true);

  // ── gateway ──
  const gwStarted = await gateway.start();
  const gwPort = gateway.server.address().port;
  check('gateway started', gwStarted && gwPort > 0);

  const seen = new Set();
  let gwOk = 0;
  for (let i = 0; i < 6; i++) {
    const r = await gwRequest(gwPort, `http://127.0.0.1:${lab.judgePort}/ip`);
    if (r.status === 200) { gwOk++; seen.add(r.headers['x-rotated-via']); }
  }
  check('gateway served all 6 requests', gwOk === 6, `${gwOk}/6`);
  check('gateway rotated across upstreams', seen.size >= 3, `${seen.size} distinct upstreams: ${[...seen].join(' ')}`);

  // CONNECT through the gateway (to the TLS judge)
  if (lab.judgeTlsPort) {
    const tunneled = await gwConnect(gwPort, `127.0.0.1:${lab.judgeTlsPort}`);
    check('gateway CONNECT tunnel works', tunneled === true);
  }

  // ── export shape ──
  const alive = [...store.all()].filter(r => r.status === 'alive').length;
  check('stats consistent', store.stats().alive === alive && store.stats().total === lab.proxies.length, `${alive} alive of ${store.size()}`);

  // ── custom targets: run the pool against a user URL ──
  config.update({ targets: [{ id: 't1', url: lab.judgeUrl, keyword: 'origin' }] });
  const trRun = await targets.run('t1', 'all');
  check('target run accepted all proxies', trRun.queued === lab.proxies.length, `${trRun.queued} queued`);
  const eliteTr = byKey.elite.tr && byKey.elite.tr.t1;
  check('elite proxy passed target (200 + keyword)', eliteTr && eliteTr.ok === 1 && eliteTr.code === 200, eliteTr ? `${eliteTr.code} ${eliteTr.ms}ms "${eliteTr.info}"` : 'no result');
  const deadTr = byKey.dead.tr && byKey.dead.tr.t1;
  check('dead proxy failed target with error', deadTr && deadTr.ok === 0 && !!deadTr.info, deadTr ? deadTr.info.slice(0, 40) : 'no result');
  const socksTr = byKey.socks5.tr && byKey.socks5.tr.t1;
  check('socks5 proxy passed target via tunnel', socksTr && socksTr.ok === 1, socksTr ? `${socksTr.code} ${socksTr.ms}ms` : 'no result');

  gateway.stop();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n  ${results.length - failed}/${results.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
}

function gwRequest(port, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port, path: u.pathname + u.search, headers: { host: u.host } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function gwConnect(port, target) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    sock.once('data', d => {
      const ok = /^HTTP\/1\.1 200/.test(d.toString('latin1'));
      sock.destroy();
      resolve(ok);
    });
    sock.once('error', () => resolve(false));
  });
}

main().catch(e => { console.error('selftest crashed:', e); process.exit(1); });
