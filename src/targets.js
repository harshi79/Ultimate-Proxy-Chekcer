'use strict';
/*
 * targets.js — user-defined target URLs. This is the "test proxies against
 * MY website" feature: every proxy is exercised by actually requesting the
 * target through it and recording HTTP status, latency, payload size, page
 * title (or error), plus an optional keyword that must appear in the body.
 *
 * Transport is picked per-proxy from its verified protocol tags:
 *   https target → socks5 | socks4 | CONNECT+TLS
 *   http  target → absolute-URI http | socks5 | socks4 | CONNECT
 * Runs on its own bounded worker pool, independent of the judge checker.
 */
const { EventEmitter } = require('events');
const probes = require('./probes');

const MAX_BODY = 256 * 1024;

class TargetRunner extends EventEmitter {
  constructor(store, config, log) {
    super();
    this.store = store;
    this.config = config;
    this.log = log || (() => {});
    this.runningId = null;
    this.queue = [];
    this.progress = { total: 0, done: 0 };
    this.stopping = false;
    this.active = 0;
  }

  isRunning() { return this.runningId !== null; }

  snapshot() {
    return { running: this.runningId, progress: { ...this.progress }, active: this.active };
  }

  /** run(targetId, mode): mode 'alive' | 'all' | 'unchecked' | {ids}. */
  async run(targetId, mode = 'alive') {
    if (this.runningId) return { error: 'a target run is already in progress' };
    const target = (this.config.get().targets || []).find(t => t.id === targetId);
    if (!target) return { error: 'unknown target' };

    let list;
    if (mode && mode.ids) list = mode.ids.map(id => this.store.get(id)).filter(Boolean);
    else if (mode === 'all') list = [...this.store.all()];
    else if (mode === 'unchecked') list = [...this.store.all()].filter(r => r.status === 'unchecked');
    else list = [...this.store.all()].filter(r => r.status === 'alive');

    if (!list.length) return { queued: 0 };
    this.runningId = targetId;
    this.stopping = false;
    this.queue = list.map(r => r.id);
    this.progress = { total: this.queue.length, done: 0 };
    this.emit('state');
    this.log('info', `Target run started: ${list.length} proxies → ${target.url}${target.keyword ? ` (must contain "${target.keyword}")` : ''}`);

    const conc = Math.min(100, Math.max(4, this.config.get().concurrency || 40));
    const workers = [];
    for (let i = 0; i < conc; i++) workers.push(this._worker(target));
    await Promise.all(workers);

    this.runningId = null;
    this.emit('state');
    this.log('info', `Target run finished: ${target.url} — ${this.progress.done} proxies tested`);
    return { queued: this.progress.total };
  }

  stop() {
    if (!this.runningId) return;
    this.stopping = true;
    this.queue = [];
    this.log('info', 'Target run stopped — in-flight requests will finish');
  }

  async _worker(target) {
    while (!this.stopping && this.queue.length) {
      const id = this.queue.shift();
      const rec = this.store.get(id);
      if (!rec) { this.progress.done++; continue; }
      this.active++;
      try { await this.testOne(rec, target); } catch (e) { this.log('warn', `target test ${id}: ${e.message}`); }
      this.active--;
      this.progress.done++;
      this.store.touch(rec);
      this.emit('progress');
    }
  }

  /** Request the target through one proxy, store the outcome on rec.tr. */
  async testOne(rec, target) {
    let url;
    try { url = new URL(target.url); } catch { return; }
    if (!/^https?:$/.test(url.protocol)) return;
    const timeoutMs = Math.min(Math.max(this.config.get().timeoutMs, 4000) * 2, 25000);
    const t0 = Date.now();

    rec.tr = rec.tr || {};
    rec.tr[target.id] = { ok: 0, code: null, ms: null, bytes: 0, info: 'testing…', ts: Date.now() };
    this.store.touch(rec);

    try {
      const out = await this._fetch(rec, url, timeoutMs);
      const ms = Date.now() - t0;
      const kw = (target.keyword || '').toLowerCase();
      const kwHit = !kw || out.body.toLowerCase().includes(kw);
      const pass = out.status >= 200 && out.status < 400 && kwHit;
      rec.tr[target.id] = {
        ok: pass ? 1 : 0,
        code: out.status,
        ms,
        bytes: out.bytes,
        info: kw ? (kwHit ? `keyword ✓ · ${titleOf(out.body)}` : `keyword ✗ · ${titleOf(out.body)}`) : titleOf(out.body),
        ts: Date.now(),
      };
    } catch (e) {
      rec.tr[target.id] = {
        ok: 0, code: null, ms: Date.now() - t0, bytes: 0,
        info: (e.code ? e.code + ' ' : '') + String(e.message || 'failed').slice(0, 70),
        ts: Date.now(),
      };
    }
  }

  async _fetch(rec, url, timeoutMs) {
    const fams = rec.protocols || [];
    const mk = (fam) => ({ ip: rec.ip, port: rec.port, auth: rec.auth, protocols: [fam] });
    const isTls = url.protocol === 'https:';
    const path = (url.pathname + url.search) || '/';

    if (isTls) {
      if (fams.includes('socks5')) return await viaTunnel(probes.socks5Connect, mk('socks5'), url.hostname, +(url.port || 443), path, url.host, true, timeoutMs);
      if (fams.includes('socks4')) return await viaTunnel(probes.socks4Connect, mk('socks4'), url.hostname, +(url.port || 443), path, url.host, true, timeoutMs);
      return await viaTunnel(null, mk('http'), url.hostname, +(url.port || 443), path, url.host, true, timeoutMs);
    }
    if (fams.includes('http')) {
      const res = await probes.httpViaProxy(mk('http'), url.href, { timeoutMs, maxBytes: MAX_BODY });
      return { status: res.status, bytes: res.bytes, body: bodyText(res) };
    }
    if (fams.includes('socks5')) return await viaTunnel(probes.socks5Connect, mk('socks5'), url.hostname, +(url.port || 80), path, url.host, false, timeoutMs);
    if (fams.includes('socks4')) return await viaTunnel(probes.socks4Connect, mk('socks4'), url.hostname, +(url.port || 80), path, url.host, false, timeoutMs);
    return await viaTunnel(null, mk('http'), url.hostname, +(url.port || 80), path, url.host, false, timeoutMs);
  }
}

/** Tunnel (CONNECT or SOCKS) then raw GET; tls=true upgrades the channel. */
async function viaTunnel(socksConnect, proxy, host, port, path, hostHeader, tls, timeoutMs) {
  const sock = socksConnect
    ? await socksConnect(proxy, host, port, timeoutMs)
    : await probes.tunnelThrough(proxy, host, port, timeoutMs);
  try {
    let chan = sock;
    if (tls) chan = await probes.tlsUpgrade(sock, host, timeoutMs);
    const req = Buffer.from([
      `GET ${path} HTTP/1.1`, `Host: ${hostHeader}`,
      'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Accept: text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Encoding: identity', 'Connection: close', '', ''
    ].join('\r\n'), 'latin1');
    const res = await probes.httpOverSocket(chan, req, { timeoutMs, maxBytes: MAX_BODY });
    if (chan !== sock) chan.destroy();
    return { status: res.status, bytes: res.bytes, body: bodyText(res) };
  } finally { sock.destroy(); }
}

function bodyText(res) {
  let body = res.body;
  if (res.headers && res.headers['transfer-encoding'] === 'chunked') body = probes.dechunk(body);
  return body.toString('utf8').slice(0, 8192);
}

function titleOf(body) {
  const m = /<title[^>]*>([^<]{1,140})/i.exec(body);
  if (m) return m[1].trim().slice(0, 70);
  const txt = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (txt.slice(0, 56) + (txt.length > 56 ? '…' : '')) || `${body.length}B`;
}

module.exports = { TargetRunner };
