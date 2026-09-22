#!/usr/bin/env node
'use strict';
/*
 * scripts/demo.js — self-contained demo: starts the local proxy lab, the
 * dashboard, imports the mock proxies and runs the checker + gateway on a
 * loop. Perfect for trying the UI with zero internet access.
 *
 *   npm run demo
 */
const { startLab } = require('../test/lab');
const config = require('../src/config');
const { createApp } = require('../src/app');

const PORT = process.env.PORT ? +process.env.PORT : 3000;

(async () => {
  const lab = await startLab({ base: 7080, tlsBase: 7099 });
  console.log('lab judge      → http://127.0.0.1:' + lab.judgePort + '  (tls :' + (lab.judgeTlsPort || '—') + ')');
  for (const p of lab.proxies) console.log(`  mock ${p.key.padEnd(12)} ${p.url}`);

  // Point the engine at the local lab
  config.update({
    judgeUrls: [lab.judgeUrl],
    httpsProbeUrl: lab.judgeTlsPort ? `https://127.0.0.1:${lab.judgeTlsPort}/?format=json` : 'https://api.ipify.org/?format=json',
    speedTest: true,
    speedUrl: `http://127.0.0.1:${lab.judgePort}/bytes/262144`,
    speedBytes: 262144,
    timeoutMs: 9000,
    concurrency: 20,
    recheckAliveMin: 2,
    recheckDeadMin: 3,
    gateway: { port: 8899, mode: 'round-robin', autostart: true },
    targets: [
      { id: 'tlab', url: `http://127.0.0.1:${lab.judgePort}/`, keyword: '' },
      { id: 'tlabkw', url: `http://127.0.0.1:${lab.judgePort}/ip`, keyword: '127.' },
    ],
  });

  const { server, store, checker, gateway, targets, config: cfg, log } = createApp({ quiet: false });
  store.clear(); // demo starts fresh

  server.listen(PORT, '0.0.0.0', async () => {
    console.log('');
    console.log('  ⚡ YORI PROXY CHECKER — demo mode');
    console.log(`  Dashboard   http://localhost:${PORT}`);
    console.log(`  Gateway     http://localhost:8899`);
    console.log('');
    store.importText(lab.lines.join('\n'));
    log('info', `Demo pool loaded with ${lab.proxies.length} lab proxies — starting the engine`);
    checker.applyRecheckSchedule();
    checker.start('all');
    await gateway.start();
    log('info', 'Rotating gateway started on :8899 — use the "Fetch via rotation" button');
  });

  // After the first check run, demo the custom-target feature automatically
  checker.once('drain', () => {
    log('info', 'Running the pool against the demo targets (see CUSTOM TARGETS panel)');
    targets.run('tlab', 'alive').then(() => targets.run('tlabkw', 'alive')).catch(() => {});
  });

  process.on('SIGINT', () => process.exit(0));
})().catch(e => { console.error('demo failed:', e); process.exit(1); });
