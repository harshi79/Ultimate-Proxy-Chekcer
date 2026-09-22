'use strict';
/*
 * gateway.js — a local HTTP forward-proxy that rotates traffic through the
 * pool's healthy upstreams. This is what turns the checker into a product:
 * point curl / a browser / a scraper at the gateway port and every request
 * exits from a different (verified) proxy.
 *
 *   Modes: round-robin | random | sticky (X-Session header or basic-auth user)
 *          | best (lowest average latency)
 *   Plain HTTP  → re-origin-form forwarded through an http-capable upstream.
 *   CONNECT     → tunnel chained through socks5/socks4/CONNECT-capable upstream.
 *   Dead upstream mid-request → automatic retry on the next healthy proxy.
 *
 * Also exposes pick()/forward() used by the dashboard's "fetch via gateway"
 * API so rotation can be demoed straight from the browser.
 */
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');
const probes = require('./probes');

class Gateway extends EventEmitter {
  constructor(store, config, log) {
    super();
    this.store = store;
    this.config = config;
    this.log = log || (() => {});
    this.server = null;
    this.running = false;
    this.rrCounter = 0;
    this.stickyMap = new Map();   // session -> {id, ts}
    this.stats = { served: 0, failed: 0, bytesUp: 0, bytesDown: 0, activeTunnels: 0, startedAt: null, lastExits: [] };
    this._stickyGc = setInterval(() => {
      const cutoff = Date.now() - 5 * 60_000;
      for (const [k, v] of this.stickyMap) if (v.ts < cutoff) this.stickyMap.delete(k);
    }, 60_000);
    this._stickyGc.unref();
  }

  start() {
    if (this.running) return true;
    const port = this.config.get().gateway.port;
    return new Promise((resolve) => {
      this.server = http.createServer();
      this.server.on('request', (req, res) => this._onPlain(req, res).catch(() => {}));
      this.server.on('connect', (req, sock, head) => this._onConnect(req, sock, head).catch(() => {}));
      this.server.on('clientError', (err, sock) => { try { sock.destroy(); } catch {} });
      this.server.listen(port, '0.0.0.0', () => {
        this.running = true;
        this.stats.startedAt = Date.now();
        this.log('info', `Rotating gateway listening on 0.0.0.0:${port} (mode: ${this.config.get().gateway.mode})`);
        this.emit('state'); resolve(true);
      });
      this.server.on('error', (e) => {
        this.log('error', `Gateway: ${e.message}`);
        this.running = false; this.emit('state'); resolve(false);
      });
    });
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch {} }
    this.running = false;
    this.emit('state');
    this.log('info', 'Rotating gateway stopped');
  }

  /* ── upstream selection ── */

  pick(scheme = 'http', session = null) {
    const pool = this.store.healthyFor(scheme);
    if (!pool.length) return null;
    const mode = this.config.get().gateway.mode;
    if (mode === 'random') return pool[Math.floor(Math.random() * pool.length)];
    if (mode === 'best') {
      pool.sort((a, b) => (a.avgLatencyMs || a.latencyMs || 9999) - (b.avgLatencyMs || b.latencyMs || 9999));
      return pool[0];
    }
    if (mode === 'sticky' && session) {
      const hit = this.stickyMap.get(session);
      if (hit) {
        const rec = this.store.get(hit.id);
        if (rec && rec.status === 'alive' && pool.includes(rec)) return rec;
      }
      const rec = pool[Math.floor(Math.random() * pool.length)];
      this.stickyMap.set(session, { id: rec.id, ts: Date.now() });
      return rec;
    }
    // round-robin (deterministic-ish even across scheme pools)
    this.rrCounter = (this.rrCounter + 1) % pool.length;
    return pool[this.rrCounter];
  }

  noteUse(rec, ok, bytesDown = 0, bytesUp = 0) {
    rec.gwUses = (rec.gwUses || 0) + (ok ? 1 : 0);
    this.stats.served += ok ? 1 : 0;
    this.stats.failed += ok ? 0 : 1;
    this.stats.bytesDown += bytesDown; this.stats.bytesUp += bytesUp;
    if (ok) {
      this.stats.lastExits.unshift({ id: rec.id, exitIp: rec.exitIp, country: rec.geo?.countryCode || null, ts: Date.now() });
      this.stats.lastExits = this.stats.lastExits.slice(0, 8);
    }
    this.store.touch(rec);
    this.emit('stats');
  }

  /* ── plain HTTP proxying ── */

  async _onPlain(req, res) {
    const host = req.headers.host;
    if (!host && !/^https?:\/\//i.test(req.url || '')) { res.writeHead(400); return res.end('gateway: missing Host header'); }
    const target = /^https?:\/\//i.test(req.url) ? req.url : `http://${host}${req.url}`;
    const session = req.headers['x-session'] || (req.headers['proxy-authorization'] ? Buffer.from(req.headers['proxy-authorization'].replace(/^Basic /i, ''), 'base64').toString().split(':')[0] : null);
    const maxTries = Math.max(1, this.config.get().gateway.retries);
    let lastErr = null;

    for (let i = 0; i < maxTries; i++) {
      const rec = this.pick('http', session);
      if (!rec) {
        this.emit('stats');
        res.writeHead(502, { 'content-type': 'text/plain' });
        return res.end('gateway: no healthy proxies in pool (check some first)');
      }
      try {
        const upstreamRes = await this._forwardRequest(rec, req, target);
        res.writeHead(upstreamRes.statusCode, sanitizeHeaders(upstreamRes.headers, { 'x-rotated-via': rec.id }));
        upstreamRes.pipe(res);
        let down = 0;
        upstreamRes.on('data', d => { down += d.length; });
        upstreamRes.on('end', () => { this.noteUse(rec, true, down); });
        return;
      } catch (e) {
        lastErr = e;
        this.failUpstream(rec, e.message);
        this.log('warn', `Gateway: upstream ${rec.id} failed (${e.message}) — rotating to next`);
      }
    }
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('gateway: all retries failed — ' + (lastErr ? lastErr.message : 'unknown'));
  }

  /** Two-strike rule: one failure is bad luck, two in a row is a dead proxy. */
  failUpstream(rec, msg) {
    rec.fails = (rec.fails || 0) + 1;
    rec.lastError = 'gateway: ' + msg;
    rec.lastChecked = Date.now();
    if (rec.fails >= 2) rec.status = 'dead';
    this.store.touch(rec);
    this.noteUse(rec, false);
  }

  _forwardRequest(rec, req, targetUrl) {
    return new Promise((resolve, reject) => {
      const u = new URL(targetUrl);
      const headers = { ...req.headers };
      delete headers['proxy-connection']; delete headers['x-session'];
      headers.host = u.host;
      if (rec.auth) headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${rec.auth.user}:${rec.auth.pass}`).toString('base64');
      const ureq = http.request({
        host: rec.ip, port: rec.port,
        method: req.method, path: u.href, headers,
        timeout: 15000,
      }, (ures) => resolve(ures));
      ureq.on('timeout', () => { ureq.destroy(new Error('upstream timeout')); });
      ureq.on('error', reject);
      req.pipe(ureq);
    });
  }

  /* ── CONNECT tunneling ── */

  async _onConnect(req, clientSock, head) {
    const [host, portStr] = (req.url || '').split(':');
    const port = +portStr || 443;
    const session = req.headers['x-session'] || null;
    const maxTries = Math.max(1, this.config.get().gateway.retries);
    clientSock.setTimeout(60000);
    clientSock.on('error', () => {});
    for (let i = 0; i < maxTries; i++) {
      const rec = this.pick('tunnel', session);
      if (!rec) {
        try { clientSock.write('HTTP/1.1 502 No healthy proxies\r\n\r\n'); } catch {}
        return clientSock.destroy();
      }
      try {
        const upstream = await probes.tunnelThrough({ ip: rec.ip, port: rec.port, auth: rec.auth, protocols: rec.protocols }, host, port, 12000);
        try { clientSock.write('HTTP/1.1 200 Connection established\r\n\r\n'); } catch {}
        upstream.on('error', () => {});
        this.stats.activeTunnels++; this.emit('stats');
        this.noteUse(rec, true);
        upstream.write(head && head.length ? head : undefined);
        clientSock.pipe(upstream);
        upstream.pipe(clientSock);
        const done = () => { this.stats.activeTunnels = Math.max(0, this.stats.activeTunnels - 1); this.emit('stats'); try { clientSock.destroy(); } catch {} try { upstream.destroy(); } catch {} };
        clientSock.once('close', done);
        upstream.once('close', done);
        return;
      } catch (e) {
        this.failUpstream(rec, 'tunnel: ' + e.message);
        this.log('warn', `Gateway: tunnel via ${rec.id} failed (${e.message}) — rotating`);
      }
    }
    try { clientSock.write('HTTP/1.1 502 All retries failed\r\n\r\n'); } catch {}
    clientSock.destroy();
  }

  /* ── dashboard helper: fetch a URL through the rotation ── */

  async fetchVia(url, { timeoutMs = 15000 } = {}) {
    const u = new URL(url);
    const t0 = Date.now();
    if (u.protocol === 'https:') {
      const tries = Math.max(1, this.config.get().gateway.retries);
      for (let i = 0; i < tries; i++) {
        const rec = this.pick('tunnel', null);
        if (!rec) throw new Error('no healthy tunnel-capable proxies');
        try {
          const sock = await probes.tunnelThrough({ ip: rec.ip, port: rec.port, auth: rec.auth, protocols: rec.protocols }, u.hostname, +(u.port || 443), timeoutMs);
          const tls = require('tls');
          const tlsSock = tls.connect({ socket: sock, servername: require('net').isIP(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false });
          await new Promise((r, j) => { tlsSock.once('secureConnect', r); tlsSock.once('error', j); setTimeout(() => j(new Error('tls timeout')), timeoutMs); });
          const body = await new Promise((resolve, reject) => {
            let buf = Buffer.alloc(0);
            const t = setTimeout(() => { tlsSock.destroy(); resolve(buf); }, timeoutMs);
            tlsSock.on('data', d => { buf = Buffer.concat([buf, d]); if (buf.length > 512 * 1024) { clearTimeout(t); resolve(buf); } });
            tlsSock.on('error', e => { clearTimeout(t); reject(e); });
            tlsSock.on('close', () => { clearTimeout(t); resolve(buf); });
            tlsSock.write(`GET ${u.pathname}${u.search || '/'} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: UltimateProxyChecker/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
          });
          this.noteUse(rec, true, body.length);
          return { rec, ms: Date.now() - t0, raw: body };
        } catch (e) {
          this.failUpstream(rec, e.message);
          this.log('warn', `fetchVia: ${rec.id} failed (${e.message}) — rotating`);
        }
      }
      throw new Error('all gateway retries failed');
    }
    // http URL
    const tries = Math.max(1, this.config.get().gateway.retries);
    for (let i = 0; i < tries; i++) {
      const rec = this.pick('http', null);
      if (!rec) throw new Error('no healthy http proxies');
      try {
        const res = await probes.httpViaProxy({ ip: rec.ip, port: rec.port, auth: rec.auth }, u.href, { timeoutMs, maxBytes: 512 * 1024 });
        this.noteUse(rec, true, res.bytes);
        const raw = Buffer.concat([Buffer.from(`HTTP/1.1 ${res.status} ${res.statusText}\r\n`, 'latin1'), Buffer.from(Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n', 'latin1'), res.body]);
        return { rec, ms: Date.now() - t0, raw };
      } catch (e) {
        rec.status = 'dead'; this.store.touch(rec); this.noteUse(rec, false);
        this.log('warn', `fetchVia: ${rec.id} failed (${e.message}) — rotating`);
      }
    }
    throw new Error('all gateway retries failed');
  }

  snapshot() {
    return { running: this.running, stats: this.stats, cfg: this.config.get().gateway };
  }
}

function sanitizeHeaders(headers, extra) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (['transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  Object.assign(out, extra);
  return out;
}

module.exports = { Gateway };
