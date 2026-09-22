'use strict';
/*
 * checker.js — the deep-inspection engine.
 *
 * Pipeline per proxy:
 *   1. protocol sniffing: SOCKS5 handshake → SOCKS4 → plain HTTP (absolute-URI)
 *      → CONNECT tunnel + TLS ("https"). First family that wins stops the sniff.
 *   2. judge round-trip through the winning transport → exit IP + injected
 *      headers → anonymity classification (elite / anonymous / transparent).
 *   3. optional download probe → throughput score (KB/s).
 *   4. exit IP queued for geo enrichment.
 * Workers run with bounded concurrency; everything streams live events:
 *   'start'(rec) 'update'(rec) 'log'(level,msg) 'tick'(delta) 'drain'
 */
const { EventEmitter } = require('events');
const probes = require('./probes');
const { classify } = require('./judges');

class Checker extends EventEmitter {
  constructor(store, judgePool, geoQueue, config, log) {
    super();
    this.store = store;
    this.judges = judgePool;
    this.geo = geoQueue;
    this.config = config;
    this.log = log || (() => {});
    this.queue = [];            // ids pending
    this.queued = new Set();
    this.running = new Map();   // id -> rec (in-flight)
    this.active = false;
    this.stopping = false;
    this.rateWindow = [];       // timestamps of finished checks
    this._recheckTimers = [];
  }

  isRunning() { return this.active; }

  /** start(mode): 'all' | 'unchecked' | 'dead' | {ids:[...]}. */
  start(mode = 'unchecked') {
    let ids = [];
    if (mode && mode.ids) ids = mode.ids.filter(id => this.store.has(id));
    else if (mode === 'all') ids = [...this.store.all()].map(r => r.id);
    else if (mode === 'dead') ids = [...this.store.all()].filter(r => r.status === 'dead').map(r => r.id);
    else if (mode === 'alive') ids = [...this.store.all()].filter(r => r.status === 'alive').map(r => r.id);
    else ids = [...this.store.all()].filter(r => r.status === 'unchecked').map(r => r.id);

    let enqueued = 0;
    for (const id of ids) {
      if (this.running.has(id) || this.queued.has(id)) continue;
      this.queue.push(id); this.queued.add(id); enqueued++;
    }
    if (enqueued) this.log('info', `Checker queued ${enqueued} proxies (concurrency ${this.config.get().concurrency})`);
    if (!this.active && this.queue.length) {
      this.active = true; this.stopping = false;
      this.emit('state');
      for (let i = 0; i < this.config.get().concurrency; i++) this._worker(i);
    }
    return enqueued;
  }

  stop() {
    this.stopping = true;
    this.queue = [];
    this.queued.clear();
    this.log('info', 'Checker stopped — in-flight checks will finish and report');
    this.emit('state');
    if (!this.running.size) this._setInactive();
  }

  _setInactive() {
    this.active = false;
    this.emit('state');
    this.emit('drain');
  }

  async _worker() {
    while (!this.stopping && this.queue.length) {
      const id = this.queue.shift();
      if (!id) break;
      this.queued.delete(id);
      const rec = this.store.get(id);
      if (!rec) continue;
      this.running.set(id, rec);
      try { await this._checkOne(rec); }
      catch (e) { this.log('error', `check ${id} crashed: ${e.message}`); }
      finally {
        this.running.delete(id);
        this.rateWindow.push(Date.now());
        if (this.rateWindow > 5000) this.rateWindow.splice(0, this.rateWindow.length - 5000);
      }
    }
    if (this.stopping && !this.running.size) this._setInactive();
    else if (!this.stopping && !this.queue.length && !this.running.size) this._setInactive();
  }

  async _checkOne(rec) {
    const cfg = this.config.get();
    const timeoutMs = cfg.timeoutMs;
    rec.status = 'checking'; rec.lastError = null;
    this.store.touch(rec); this.emit('start', rec);

    // Transport order: SOCKS5, SOCKS4, HTTP, HTTPS-CONNECT. A protoHint from
    // the import format moves that transport to the front.
    const order = [];
    if (cfg.sniff.socks5) order.push('socks5');
    if (cfg.sniff.socks4) order.push('socks4');
    if (cfg.sniff.http) order.push('http');
    if (rec.protoHint) {
      const i = order.indexOf(rec.protoHint);
      if (i > 0) order.splice(0, 0, ...order.splice(i, 1));
    }
    const fams = order.slice();
    if (cfg.sniff.https) fams.push('https'); // CONNECT check (own transport family)

    let win = null;       // { transport, judge, parsed, latencyMs }
    let firstError = null;
    rec._httpsOk = false;

    for (const fam of fams) {
      if (this.stopping || win) break;
      try {
        const judge = this.judges.pick();
        const r = await this._probeFamily(rec, fam, judge, timeoutMs);
        win = { ...r, fam, judge };
        if (fam === 'http' && cfg.sniff.https) {
          // plain HTTP won — additionally verify CONNECT for the https tag
          try {
            const httpsJudge = { url: cfg.httpsProbeUrl, kind: 'json-ip' };
            await this._probeFamily(rec, 'https', httpsJudge, timeoutMs);
            rec._httpsOk = true;
          } catch { /* CONNECT optional */ }
        }
      } catch (e) {
        if (!firstError) firstError = e;
      }
    }

    if (!win) {
      rec.status = 'dead';
      rec.checks++; rec.fails++;
      rec.lastChecked = Date.now();
      rec.lastError = firstError ? (firstError.code || 'fail') + ': ' + (firstError.message || '').slice(0, 80) : 'unreachable';
      this.store.touch(rec); this.emit('update', rec);
      this.emit('tick');
      return rec;
    }

    rec.protocols = [win.fam];
    if (rec._httpsOk && !rec.protocols.includes('https')) rec.protocols.push('https');
    rec.status = 'alive';
    rec.checks++; rec.okChecks++; rec.fails = 0;
    rec.latencyMs = Math.round(win.latencyMs);
    rec.avgLatencyMs = rec.avgLatencyMs == null ? rec.latencyMs : Math.round(rec.avgLatencyMs * 0.6 + rec.latencyMs * 0.4);
    rec.lastChecked = Date.now();
    rec.lastSeen = Date.now();

    // anonymity
    if (win.parsed) {
      rec.exitIp = win.parsed.exitIp;
      const cls = classify(win.parsed, this.judges.realIp);
      rec.anonymity = cls.anonymity;
      rec.markers = cls.markers.slice(0, 6);
    }

    this.store.touch(rec); this.emit('update', rec);

    // speed probe (through the winning transport)
    if (cfg.speedTest) {
      try {
        const kbps = await this._speedProbe(rec, win.fam, cfg);
        rec.speedKbps = kbps;
        this.store.touch(rec); this.emit('update', rec);
      } catch { rec.speedKbps = null; }
    }

    // geo enrichment
    if (rec.exitIp) this.geo.request(rec.exitIp, g => { rec.geo = g; this.store.touch(rec); });

    this.emit('tick');
    return rec;
  }

  /** Try one protocol family against the judge. Throws on failure. */
  async _probeFamily(rec, fam, judge, timeoutMs) {
    const proxy = { ip: rec.ip, port: rec.port, auth: rec.auth, protocols: [fam] };
    if (!judge) {
      // No judge at all — liveness-only: TCP connect (or socks handshake).
      const t0 = Date.now();
      if (fam === 'socks5') { await probes.socks5Connect(proxy, '1.1.1.1', 80, timeoutMs); }
      else if (fam === 'socks4') { await probes.socks4Connect(proxy, '1.1.1.1', 80, timeoutMs); }
      else await probes.tcpAlive(rec.ip, rec.port, timeoutMs);
      return { latencyMs: Date.now() - t0, parsed: null };
    }
    const t0 = Date.now();
    const parsed = await require('./judges').queryThrough.call(this.judges, judge, proxy, fam, timeoutMs);
    return { parsed, latencyMs: Date.now() - t0 };
  }

  /** Download probe: stream up to cfg.speedBytes through the proxy, return KB/s. */
  async _speedProbe(rec, fam, cfg) {
    const url = cfg.speedUrl;
    const budget = Math.min(cfg.speedTimeoutMs, 8000);
    const t0 = Date.now();
    let bytes = 0;
    const proxy = { ip: rec.ip, port: rec.port, auth: rec.auth, protocols: [fam] };

    if (fam === 'http') {
      const u = new URL(url);
      const sock = await probes.connectSock(rec.ip, rec.port, cfg.timeoutMs);
      try {
        const reqBuf = Buffer.from([
          `GET ${u.href} HTTP/1.1`, `Host: ${u.host}`,
          'User-Agent: Mozilla/5.0', 'Accept: */*', 'Accept-Encoding: identity',
          `Proxy-Connection: close`, 'Connection: close', '', ''
        ].join('\r\n'), 'latin1');
        bytes = await _drainCount(sock, reqBuf, budget, cfg.speedBytes);
      } finally { sock.destroy(); }
    } else if (fam === 'https') {
      const sock = await probes.tunnelThrough(proxy, new URL(url).hostname, +(new URL(url).port || 443), cfg.timeoutMs);
      try { bytes = await _drainCount(sock, null, budget, cfg.speedBytes, url); } finally { sock.destroy(); }
    } else if (fam === 'socks5') {
      const sock = await probes.socks5Connect(proxy, new URL(url).hostname, +(new URL(url).port || 80), cfg.timeoutMs);
      try { bytes = await _drainCount(sock, null, budget, cfg.speedBytes, url); } finally { sock.destroy(); }
    } else {
      const sock = await probes.socks4Connect(proxy, new URL(url).hostname, +(new URL(url).port || 80), cfg.timeoutMs);
      try { bytes = await _drainCount(sock, null, budget, cfg.speedBytes, url); } finally { sock.destroy(); }
    }
    const ms = Date.now() - t0;
    if (bytes < 512 || ms < 5) throw new Error('no data');
    return Math.round((bytes / 1024) / (ms / 1000));
  }

  /** Recheck timers for alive/dead pools (minutes, 0 = off). */
  applyRecheckSchedule() {
    this._recheckTimers.forEach(clearInterval);
    this._recheckTimers = [];
    const cfg = this.config.get();
    if (cfg.recheckAliveMin > 0) {
      this._recheckTimers.push(setInterval(() => { if (!this.active) this.start('alive'); }, cfg.recheckAliveMin * 60000));
    }
    if (cfg.recheckDeadMin > 0) {
      this._recheckTimers.push(setInterval(() => { if (!this.active) this.start('dead'); }, cfg.recheckDeadMin * 60000));
    }
    this._recheckTimers.forEach(t => t.unref && t.unref());
  }

  ratePerMin() {
    const cutoff = Date.now() - 60_000;
    while (this.rateWindow.length && this.rateWindow[0] < cutoff) this.rateWindow.shift();
    return this.rateWindow.length;
  }

  progress() {
    return { queued: this.queue.length, running: this.running.size, perMin: this.ratePerMin() };
  }
}

/** Stream-count response bytes up to maxBytes / budgetMs, sending `reqBuf` first (or a GET for `url`). */
function _drainCount(sock, reqBuf, budgetMs, maxBytes, url) {
  return new Promise((resolve, reject) => {
    let bytes = 0, headerDone = !!reqBuf;
    if (!reqBuf && url) {
      const u = new URL(url);
      reqBuf = Buffer.from([
        `GET ${u.pathname}${u.search || '/'} HTTP/1.1`, `Host: ${u.host}`,
        'User-Agent: Mozilla/5.0', 'Accept: */*', 'Accept-Encoding: identity', 'Connection: close', '', ''
      ].join('\r\n'), 'latin1');
    }
    const timer = setTimeout(() => done(), budgetMs);
    function done() { cleanup(); resolve(bytes); }
    function cleanup() { clearTimeout(timer); sock.removeListener('data', onData); sock.removeListener('error', onErr); sock.removeListener('close', done); }
    function onData(d) {
      if (!headerDone) {
        const idx = Buffer.concat([d]).indexOf('\r\n\r\n');
        if (idx < 0) return;
        headerDone = true;
      }
      bytes += d.length;
      if (bytes >= maxBytes) done();
    }
    function onErr(e) { cleanup(); if (bytes > 512) resolve(bytes); else reject(e); }
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.once('close', () => { if (bytes > 0) done(); });
    sock.write(reqBuf);
  });
}

module.exports = { Checker };
