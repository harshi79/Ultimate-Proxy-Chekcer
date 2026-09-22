'use strict';
/* config.js — defaults + persisted user config (data/config.json) */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const DEFAULTS = {
  port: 3000,                    // dashboard port
  concurrency: 150,              // parallel proxy checks
  timeoutMs: 9000,               // per-check budget (connect + judge)
  speedTest: true,               // measure download throughput of alive proxies
  speedUrl: 'http://httpbin.org/bytes/262144',
  speedBytes: 262144,            // target payload for the speed probe
  speedTimeoutMs: 6000,
  sniff: { socks5: true, socks4: true, http: true, https: true },
  httpsProbeUrl: 'https://api.ipify.org/?format=json',  // CONNECT verification target
  recheckAliveMin: 0,            // minutes; 0 = off
  recheckDeadMin: 0,
  judgeUrls: null,               // null = built-in defaults
  judgeTimeoutMs: 8000,
  targets: [],                   // user-defined target URLs: [{id, url, keyword}]
  gateway: {
    port: 8899,
    mode: 'round-robin',         // round-robin | random | sticky | best
    retries: 3,
    autostart: false,
  },
};

let cfg = load();

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
    return deepMerge(structuredClone(DEFAULTS), raw);
  } catch {
    return structuredClone(DEFAULTS);
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(cfg, null, 2));
    } catch (e) { console.error('config save failed:', e.message); }
  }, 400);
}

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}

module.exports = {
  get: () => cfg,
  update(patch) { deepMerge(cfg, patch); save(); return cfg; },
  reset() { cfg = structuredClone(DEFAULTS); save(); return cfg; },
  DEFAULTS, DATA_DIR,
};
