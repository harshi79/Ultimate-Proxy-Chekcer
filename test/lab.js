'use strict';
/*
 * lab.js — a local proxy laboratory for testing the checker end-to-end
 * without any internet access (also powers the sandbox demo).
 *
 * Every mock binds to its own loopback alias (127.0.0.11, 127.0.0.12, …) and
 * makes its outbound connections from that address — so each proxy has a
 * genuinely distinct "public identity" as seen by the judge, exactly like
 * real proxies on the internet. Classification semantics are therefore real:
 *   transparent  → adds X-Forwarded-For (your IP) + Via
 *   anonymous    → adds Via only
 *   elite        → adds nothing, strips leaks
 *   https-elite  → elite + honours CONNECT (tunnels to loopback)
 *   socks5       → a real SOCKS5 server (no-auth)
 *   slow         → elite + 1s latency injection
 *   flaky        → drops ~half of all connections
 *   dead         → closed port
 * All mocks only forward to loopback targets (never an open relay).
 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');

const CERT_DIR = path.join(__dirname, 'certs');
const LOCAL_IP = '127.0.0.1';            // the checker's identity in the lab
const LOOPBACK = /^127\.\d+\.\d+\.\d+$|^\[::1\]$|^localhost$/i;

function judgeHandler(req, res) {
  const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (req.url.startsWith('/bytes/')) {
    const n = Math.min(2 * 1024 * 1024, parseInt(req.url.split('/')[2], 10) || 1024);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': n });
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    let sent = 0;
    const iv = setInterval(() => {
      const left = n - sent;
      if (left <= 0 || res.destroyed) { clearInterval(iv); return res.end(); }
      const c = chunk.subarray(0, Math.min(chunk.length, left));
      sent += c.length;
      res.write(c);
    }, 2);
    return;
  }
  if (req.url.startsWith('/ip')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(peer);
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ origin: peer, headers: req.headers }));
}

function startHttpServer(srv, host) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, host || '127.0.0.1', () => resolve(srv.address().port));
  });
}

/** Mock HTTP proxy with a personality bound to `alias`. Only forwards to loopback. */
function startHttpProxy(personality, alias) {
  const srv = http.createServer((req, res) => {
    if (personality.flaky && Math.random() < personality.flaky) { req.socket.destroy(); return; }
    let u = null;
    try {
      if (/^https?:\/\//i.test(req.url)) u = new URL(req.url);
    } catch {}
    if (!u || !LOOPBACK.test(u.hostname)) { res.writeHead(403); return res.end('lab proxy: loopback targets only'); }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['x-forwarded-for'];
    delete headers.via;
    if (personality.inject === 'transparent') {
      headers['x-forwarded-for'] = LOCAL_IP;
      headers['via'] = '1.1 ultimatelab';
    } else if (personality.inject === 'anonymous') {
      headers['via'] = '1.1 ultimatelab';
    }
    const fwd = () => {
      const up = http.request({ host: u.hostname, port: +u.port || 80, path: u.pathname + u.search, method: req.method, headers, localAddress: alias }, (ures) => {
        res.writeHead(ures.statusCode, ures.headers);
        ures.pipe(res);
      });
      up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
      req.pipe(up);
    };
    if (personality.delay) setTimeout(fwd, personality.delay);
    else fwd();
  });
  srv.on('connect', (req, sock, head) => {
    if (!personality.connect) { sock.destroy(); return; }
    const [host, p] = (req.url || '').split(':');
    if (!LOOPBACK.test(host)) { sock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return sock.destroy(); }
    sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
    const up = net.connect({ host, port: +p || 443, localAddress: alias }, () => { if (head && head.length) up.write(head); sock.pipe(up); up.pipe(sock); });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  return startHttpServer(srv, alias);
}

/** Minimal but real SOCKS5 server (no-auth), loopback targets only. */
function startSocks5(alias) {
  const srv = net.createServer((sock) => {
    sock.once('error', () => {});
    let stage = 0;
    sock.on('data', function onData(buf) {
      if (stage === 0) {
        if (buf[0] !== 5) return sock.destroy();
        const methods = buf.subarray(2, 2 + (buf[1] || 0));
        if (!methods.includes(0)) { sock.write(Buffer.from([5, 0xFF])); return sock.destroy(); }
        sock.write(Buffer.from([5, 0]));
        stage = 1;
        return;
      }
      if (stage !== 1) return;
      stage = 2;
      const b = buf;
      if (b[0] !== 5 || b[1] !== 1) return sock.destroy();
      let host, extra;
      if (b[3] === 1) { host = `${b[4]}.${b[5]}.${b[6]}.${b[7]}`; extra = 4; }
      else if (b[3] === 3) { const len = b[4]; host = b.subarray(5, 5 + len).toString(); extra = 1 + len; }
      else if (b[3] === 4) { host = '::1'; extra = 16; }
      else return sock.destroy();
      const port = b.readUInt16BE(4 + extra);
      if (!LOOPBACK.test(host)) {
        sock.write(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
        return sock.destroy();
      }
      const up = net.connect({ host, port, localAddress: alias }, () => {
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        const rest = b.subarray(6 + extra);
        if (rest.length) up.write(rest);
        up.pipe(sock); sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
    });
  });
  return startHttpServer(srv, alias);
}

/** Dead proxy: reserve a port then release it (nothing listens there). */
function reserveDeadPort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/**
 * Start the whole lab. `base`/`tlsBase` (optional) pin the judges to exact
 * ports for scripted setups; mock proxies always get OS-assigned ports.
 * Returns { judgePort, judgeUrl, judgeTlsPort, proxies, lines, stop }.
 */
async function startLab({ base = null, tlsBase = null } = {}) {
  const judgeHttp = http.createServer(judgeHandler);
  const judgePort = base
    ? await new Promise((resolve, reject) => {
        judgeHttp.once('error', reject);
        judgeHttp.listen(base, '127.0.0.1', () => resolve(base));
      })
    : await startHttpServer(judgeHttp, '127.0.0.1');

  let judgeTlsPort = null;
  try {
    const key = fs.readFileSync(path.join(CERT_DIR, 'lab-key.pem'));
    const cert = fs.readFileSync(path.join(CERT_DIR, 'lab-cert.pem'));
    const tlsSrv = https.createServer({ key, cert }, judgeHandler);
    judgeTlsPort = tlsBase
      ? await new Promise((resolve, reject) => {
          tlsSrv.once('error', reject);
          tlsSrv.listen(tlsBase, '127.0.0.1', () => resolve(tlsBase));
        })
      : await startHttpServer(tlsSrv, '127.0.0.1');
  } catch { /* no certs — https judge disabled */ }

  const specs = [
    { key: 'transparent', kind: 'http', personality: { inject: 'transparent' } },
    { key: 'anonymous', kind: 'http', personality: { inject: 'anonymous' } },
    { key: 'elite', kind: 'http', personality: { inject: 'elite' } },
    { key: 'https-elite', kind: 'http', personality: { inject: 'elite', connect: true } },
    { key: 'slow', kind: 'http', personality: { inject: 'elite', delay: 1000 } },
    { key: 'flaky', kind: 'http', personality: { inject: 'anonymous', flaky: 0.5 } },
    { key: 'socks5', kind: 'socks5', personality: {} },
  ];

  const proxies = [];
  let aliasIdx = 10;
  for (const spec of specs) {
    const alias = `127.0.0.${aliasIdx++}`;
    let port = null;
    try {
      port = spec.kind === 'http' ? await startHttpProxy(spec.personality, alias) : await startSocks5(alias);
    } catch {
      // alias binding unsupported (e.g. some platforms) — fall back to 127.0.0.1
      aliasIdx--;
      port = spec.kind === 'http' ? await startHttpProxy(spec.personality, '127.0.0.1') : await startSocks5('127.0.0.1');
    }
    const host = alias === '127.0.0.1' ? '127.0.0.1' : alias;
    proxies.push({ key: spec.key, kind: spec.kind, host, port, url: `${spec.kind}://${host}:${port}` });
  }
  const deadPort = await reserveDeadPort();
  proxies.push({ key: 'dead', kind: 'http', host: '127.0.0.1', port: deadPort, url: `http://127.0.0.1:${deadPort}` });

  return {
    judgePort, judgeTlsPort,
    judgeUrl: `http://127.0.0.1:${judgePort}/`,
    localIp: LOCAL_IP,
    proxies, lines: proxies.map(p => p.url), deadPort,
    stop() { judgeHttp.close(); },
  };
}

module.exports = { startLab, LOCAL_IP };
