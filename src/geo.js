'use strict';
/*
 * geo.js — batched IP → country/ISP/ASN lookups via ip-api.com (free tier:
 * 15 batch calls/min, ≤100 IPs per call). Token-bucket + queue + cache.
 * Falls back gracefully when the machine has no internet (marks itself
 * offline instead of hammering).
 */
const { EventEmitter } = require('events');
const net = require('net');

const BATCH_URL = 'http://ip-api.com/batch?fields=status,query,country,countryCode,regionName,city,isp,org,as,lat,lon,proxy,hosting,query';
const MAX_PER_CALL = 100;
const CALLS_PER_MIN = 14;          // stay under the 15/min limit

class GeoQueue extends EventEmitter {
  constructor(log) {
    super();
    this.log = log || (() => {});
    this.cache = new Map();          // ip -> geo | null
    this.pending = new Set();
    this.queue = [];
    this.offline = false;
    this.lastError = null;
    this.resolved = 0;
    this.tokens = CALLS_PER_MIN;
    this._timer = setInterval(() => {
      this.tokens = Math.min(CALLS_PER_MIN, this.tokens + CALLS_PER_MIN / 12);
      this._pump();
    }, 5000);
    this._timer.unref();
  }

  /** Ask for geo of an IP; applies result via the callback when resolved. */
  request(ip, apply) {
    if (!ip) return;
    if (this.cache.has(ip)) { const g = this.cache.get(ip); if (apply) apply(g); return; }
    if (isLocal(ip)) {
      const g = { country: 'Local Lab', countryCode: null, city: 'loopback', isp: 'mock network', as: null, lat: null, lon: null, local: true };
      this.cache.set(ip, g); if (apply) apply(g); return;
    }
    this.pending.add(ip);
    this.queue.push({ ip, apply });
    this._pump();
  }

  stats() { return { cached: this.cache.size, queued: this.queue.length, resolved: this.resolved, offline: this.offline, lastError: this.lastError }; }

  async _pump() {
    if (this.offline || this.tokens < 1 || !this.queue.length) return;
    const batch = [];
    while (batch.length < MAX_PER_CALL && this.queue.length) {
      const item = this.queue.shift();
      if (!this.pending.has(item.ip)) continue;
      this.pending.delete(item.ip);
      batch.push(item);
    }
    if (!batch.length) return;
    this.tokens -= 1;
    const ips = batch.map(b => b.ip);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(BATCH_URL, { method: 'POST', body: JSON.stringify(ips), headers: { 'content-type': 'application/json' }, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      const byIp = new Map(rows.map(r => [r.query, r]));
      for (const item of batch) {
        const row = byIp.get(item.ip);
        let geo = null;
        if (row && row.status === 'success') {
          geo = {
            country: row.country, countryCode: row.countryCode, city: row.city,
            regionName: row.regionName, isp: row.isp || row.org, as: row.as,
            lat: Number.isFinite(row.lat) ? row.lat : null,
            lon: Number.isFinite(row.lon) ? row.lon : null,
            proxyHost: !!row.proxy, hosting: !!row.hosting, local: false,
          };
          this.resolved++;
        } else if (row) {
          geo = { country: 'Unknown', countryCode: null, city: null, isp: null, as: null, lat: null, lon: null, local: false };
        }
        this.cache.set(item.ip, geo);
        if (item.apply) item.apply(geo);
        if (geo) this.emit('resolved', { ip: item.ip, geo });
      }
      if (this.offline) { this.offline = false; this.log('info', 'Geo service back online'); }
    } catch (e) {
      this.lastError = e.message;
      if (!this.offline) {
        this.offline = true;
        this.log('warn', `Geo lookups offline (${e.message}) — country/ISP data will resolve when internet is available`);
      }
      for (const item of batch) { this.cache.delete(item.ip); this.pending.add(item.ip); }
      this.queue.push(...batch);
      setTimeout(() => { this.offline = false; this._pump(); }, 60_000); // retry in a minute
    }
  }
}

function isLocal(ip) {
  if (net.isIP(ip) !== 4) return ip === '::1' || ip.startsWith('fe80');
  const p = ip.split('.').map(Number);
  return p[0] === 127 || p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 169 && p[1] === 254);
}

module.exports = { GeoQueue, isLocal };
