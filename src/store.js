'use strict';
/*
 * store.js — the proxy pool. In-memory Map keyed "ip:port", persisted to
 * data/pool.json (debounced). Parses all common list formats:
 *   1.2.3.4:8080
 *   socks5://1.2.3.4:1080          http://user:pass@1.2.3.4:8080
 *   1.2.3.4:8080:user:pass
 *   1.2.3.4:8080:socks5            ip port  (whitespace / csv / semicolons)
 * Emits 'update' (rec), 'remove', 'bulk' events for live broadcasting.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DATA_DIR = path.join(__dirname, '..', 'data');
const POOL_FILE = path.join(DATA_DIR, 'pool.json');

const FRESH = () => ({
  id: '', ip: '', port: 0,
  status: 'unchecked',              // unchecked | checking | alive | dead
  protocols: [],                    // http https socks5 socks4 (verified)
  protoHint: null,                  // from input format, if any
  auth: null,
  anonymity: 'unknown',             // elite | anonymous | anonymous~ | transparent | unknown
  markers: [],
  latencyMs: null,                  // best judge roundtrip through proxy
  avgLatencyMs: null,
  speedKbps: null,
  exitIp: null,
  geo: null,                        // {country, countryCode, city, isp, as, lat, lon, proxyHost, hosting}
  checks: 0, fails: 0, okChecks: 0,
  lastChecked: null, lastSeen: null, addedAt: Date.now(),
  lastError: null,
  gwUses: 0,
  tr: {},                        // target results: { targetId: {ok, code, ms, bytes, info, ts} }
});

class Store extends EventEmitter {
  constructor() {
    super();
    this.map = new Map();
    this._saveTimer = null;
    this._dirty = false;
    this._emitQueue = new Set();
    this._flushTimer = setInterval(() => this._flushEmits(), 250);
    this._flushTimer.unref();
  }

  /* ── parsing / import ── */

  static parseLine(line) {
    let s = String(line || '').trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) return null;

    // JSON object format: {"ip":"1.2.3.4","port":8080,"protocol":"socks5",...}
    if (s.startsWith('{')) {
      try {
        const j = JSON.parse(s);
        const ip = j.ip || j.host || j.addr || j.server;
        const port = parseInt(j.port || j.portNumber, 10);
        if (!ip || !Number.isFinite(port)) return null;
        let proto = String(j.protocol || j.type || (Array.isArray(j.protocols) ? j.protocols[0] : '') || '').toLowerCase()
          .replace('socks5h', 'socks5').replace('socks4a', 'socks4');
        const auth = (j.username || j.user) ? { user: String(j.username || j.user), pass: String(j.password || j.pass || '') } : null;
        return { ip: String(ip), port, auth, hint: /^(https?|socks[45])$/.test(proto) ? proto : null };
      } catch { return null; }
    }

    s = s.replace(/^proxy:\/\//i, 'http://').replace(/^socks5h:\/\//i, 'socks5://').replace(/^socks4a:\/\//i, 'socks4://');
    let auth = null, hint = null;
    const scheme = s.match(/^(https?|socks[45]):\/\//i);
    if (scheme) {
      hint = scheme[1].toLowerCase();
      s = s.slice(scheme[0].length);
    }
    const at = s.lastIndexOf('@');
    if (at > 0) {
      const creds = s.slice(0, at).split(':');
      if (creds.length === 2) auth = { user: creds[0], pass: creds[1] };
      s = s.slice(at + 1);
    }

    const toks = s.split(/[\s,;|]+/).filter(Boolean);

    // whitespace / comma / semicolon separated: "1.2.3.4 8080 [socks5 [user pass]]"
    if (toks.length >= 2 && !toks[0].includes(':')) {
      const [ip, port, proto, user, pass] = toks;
      if (proto && /^(https?|socks[45])$/i.test(proto)) hint = proto.toLowerCase();
      if (user && pass && !/^(https?|socks[45])$/i.test(proto)) { auth = { user, pass }; }
      else if (user && pass) { auth = { user, pass }; }
      const p = parseInt(port, 10);
      if (!/^[a-z0-9.\-[\]:]+$/i.test(ip) || !Number.isFinite(p) || p < 1 || p > 65535) return null;
      return { ip: ip.replace(/^\[|\]$/g, ''), port: p, auth, hint };
    }

    // colon format: ip:port[:proto] or ip:port:user:pass
    let parts = (toks[0] || '').split(':').filter(Boolean);
    if (parts.length < 2) return null;
    let [ip, port] = parts;
    if (parts.length >= 3) {
      if (/^(https?|socks[45])$/i.test(parts[2])) { hint = parts[2].toLowerCase(); }
      else if (parts.length >= 4) { auth = { user: parts[2], pass: parts.slice(3).join(':') }; }
    }
    port = parseInt(port, 10);
    if (!ip || !Number.isFinite(port) || port < 1 || port > 65535) return null;
    if (!/^[a-z0-9.\-[\]:]+$/i.test(ip)) return null;
    ip = ip.replace(/^\[|\]$/g, '');
    return { ip, port, auth, hint };
  }

  importText(text) {
    let added = 0, updated = 0, invalid = 0;
    for (const line of String(text || '').split(/\r?\n/)) {
      const p = Store.parseLine(line);
      if (!p) { if (line.trim()) invalid++; continue; }
      const id = `${p.ip}:${p.port}`;
      const existing = this.map.get(id);
      if (existing) {
        if (p.auth) existing.auth = p.auth;
        if (p.hint && !existing.protoHint) existing.protoHint = p.hint;
        updated++;
      } else {
        const rec = FRESH();
        Object.assign(rec, { id, ip: p.ip, port: p.port, auth: p.auth, protoHint: p.hint });
        this.map.set(id, rec);
        added++;
      }
    }
    if (added || updated) { this._dirty = true; this.emit('imported', { added, updated, invalid }); }
    return { added, updated, invalid };
  }

  /* ── CRUD ── */

  get(id) { return this.map.get(id); }
  has(id) { return this.map.has(id); }
  all() { return this.map.values(); }
  size() { return this.map.size; }

  remove(ids) {
    let n = 0;
    for (const id of ids) if (this.map.delete(id)) n++;
    if (n) { this._dirty = true; this.emit('removed', { ids }); }
    return n;
  }

  clear() { this.map.clear(); this._dirty = true; this.emit('cleared'); }

  clearDead() {
    const ids = [...this.map.values()].filter(r => r.status === 'dead').map(r => r.id);
    return this.remove(ids);
  }

  resetResults() {
    for (const r of this.map.values()) {
      Object.assign(r, {
        status: 'unchecked', protocols: [], anonymity: 'unknown', markers: [],
        latencyMs: null, avgLatencyMs: null, speedKbps: null, exitIp: null,
        checks: 0, fails: 0, okChecks: 0, lastChecked: null, lastSeen: null, lastError: null,
        tr: {},
      });
    }
    this._dirty = true; this.emit('cleared-results');
  }

  touch(rec) {
    this._dirty = true;
    this._emitQueue.add(rec.id);
  }

  _flushEmits() {
    if (!this._emitQueue.size) return;
    const ids = [...this._emitQueue];
    this._emitQueue.clear();
    const recs = ids.map(id => this.map.get(id)).filter(Boolean);
    if (recs.length) this.emit('updates', recs);
  }

  /* ── stats ── */

  stats() {
    let alive = 0, dead = 0, checking = 0, unchecked = 0;
    let elite = 0, anon = 0, transparent = 0;
    let latSum = 0, latN = 0;
    for (const r of this.map.values()) {
      if (r.status === 'alive') { alive++; if (r.latencyMs) { latSum += r.latencyMs; latN++; } }
      else if (r.status === 'dead') dead++;
      else if (r.status === 'checking') checking++;
      else unchecked++;
      if (r.status === 'alive' || r.anonymity === 'elite') {
        if (r.anonymity === 'elite') elite++;
        else if (r.anonymity === 'anonymous' || r.anonymity === 'anonymous~') anon++;
        else if (r.anonymity === 'transparent') transparent++;
      }
    }
    return {
      total: this.map.size, alive, dead, checking, unchecked,
      elite, anonymous: anon, transparent,
      avgLatencyMs: latN ? Math.round(latSum / latN) : null,
      geoResolved: [...this.map.values()].filter(r => r.geo).length,
    };
  }

  /** Healthy proxies usable by the gateway. scheme: 'http' | 'tunnel' */
  healthyFor(scheme) {
    const out = [];
    for (const r of this.map.values()) {
      if (r.status !== 'alive') continue;
      if (scheme === 'tunnel') { if (r.protocols.some(p => p === 'https' || p === 'socks5' || p === 'socks4')) out.push(r); }
      else if (r.protocols.includes('http')) out.push(r);
    }
    return out;
  }

  /* ── persistence ── */

  loadFromDisk() {
    try {
      const raw = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
      const arr = Array.isArray(raw) ? raw : raw.proxies || [];
      for (const r of arr) {
        const base = FRESH();
        const rec = Object.assign(base, r);
        if (!rec.id || !rec.ip || !rec.port) continue;
        rec.id = `${rec.ip}:${rec.port}`;
        if (rec.status === 'checking') rec.status = 'unchecked';
        this.map.set(rec.id, rec);
      }
      return this.map.size;
    } catch { return 0; }
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveToDisk(), 2000);
    this._saveTimer.unref?.();
  }

  saveToDisk() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const recs = [...this.map.values()].map(r => ({ ...r }));
      fs.writeFileSync(POOL_FILE, JSON.stringify({ savedAt: Date.now(), proxies: recs }));
      this._dirty = false;
    } catch (e) { console.error('pool save failed:', e.message); }
  }
}

module.exports = { Store, FRESH, DATA_DIR };
