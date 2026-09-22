#!/usr/bin/env node
'use strict';
/* server.js — entry point. `npm start` or `node server.js` */
const { createApp } = require('./src/app');
const store = require('./src/store');

const { server, store: pool, gateway, config, log } = createApp();
const n = pool.loadFromDisk();
const port = process.env.PORT ? +process.env.PORT : config.get().port;

server.listen(port, '0.0.0.0', () => {
  console.log('');
  console.log('  ⚡ ULTIMATE PROXY CHECKER');
  console.log('  ──────────────────────────────────────────────');
  console.log(`  Dashboard   http://localhost:${port}`);
  if (n) console.log(`  Restored    ${n} proxies from pool.json`);
  console.log(`  Gateway     http://localhost:${config.get().gateway.port} (start it from the UI)`);
  console.log('');
  log('info', `Dashboard up on port ${port}`);
  if (config.get().gateway.autostart) gateway.start();
});

process.on('SIGINT', () => { pool.saveToDisk(); process.exit(0); });
process.on('SIGTERM', () => { pool.saveToDisk(); process.exit(0); });
