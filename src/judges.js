'use strict';
/*
 * judges.js — "judges" are echo endpoints we hit THROUGH a proxy to learn
 *   (a) the proxy's exit IP, and (b) which proxy-injected headers arrive.
 * From that we classify anonymity:
 *   transparent — forwards your real IP (X-Forwarded-For / Client-IP contains it,
 *                 or exit IP == your IP)
 *   anonymous   — identifies itself as a proxy (Via / Forwarded / Proxy-Connection…)
 *                 but hides your IP
 *   elite       — neither your IP nor any proxy markers leak through
 * Also: self-IP discovery (what the machine's public IP is) and a rolling
 * health score per judge so a dead judge stops burning proxy checks.
 */
const { httpViaProxy, httpsViaProxy, socks5ViaProxy, socks4ViaProxy } = require('./probes');

const PROXY_HEADER_MARKERS = [
  'via', 'forwarded', 'proxy-connection', 'x-forwarded', 'x-real-ip',
  'client-ip', 'x-client-ip', 'proxy-agent', 'x-proxy', 'forwarded-for',
];
const CLIENT_IP_HEADERS = ['x-forwarded-for', 'client-ip', 'x-client-ip', 'x-real-ip', 'forwarded', 'x-forwarded'];

const DEFAULT_JUDGES = [
  { url: 'http://ip-api.com/json/?fields=status,message,query', kind: 'json-ip', weight: 1 },
  { url: 'http://httpbin.org/get', kind: 'httpbin', weight: 3 },
  { url: 'http://azenv.net/', kind: 'azenv', weight: 3 },
];

class JudgePool {
  constructor(config, log) {
    this.config = config;              // needs .judgeUrls, .judgeTimeoutMs
    this.log = log || (() => {});
    this.health = new Map();           // url -> {fails, lastFail, lastOk, rr}
    this.rr = 0;
    this.judges = DEFAULT_JUDGES.slice();
    this.realIp = null;
    this.selfTested = false;
    this.echoAvailable = false;        // any echo judge reachable directly?
  }

  setJudges(urls) {
    const map = new Map(DEFAULT_JUDGES.map(j => [j.url, j]));
    this.judges = (urls && urls.length ? urls : DEFAULT_JUDGES.map(j => j.url)).map(u => map.get(u) || { url: u, kind: guessKind(u), weight: 3 });
  }

  list() { return this.judges; }

  mark(url, ok) {
    let h = this.health.get(url);
    if (!h) { h = { fails: 0, lastFail: 0, lastOk: 0 }; this.health.set(url, h); }
    if (ok) { h.fails = 0; h.lastOk = Date.now(); } else { h.fails++; h.lastFail = Date.now(); }
  }

  healthy() { return this.judges.filter(j => (this.health.get(j.url)?.fails || 0) < 3); }

  /** Pick next judge: prefer echo judges (richer signal) when healthy. */
  pick() {
    const pool = this.healthy().length ? this.healthy() : this.judges;
    if (!pool.length) return null;
    const echoes = pool.filter(j => j.kind !== 'json-ip');
    const from = (this.echoAvailable && echoes.length) ? echoes : pool;
    this.rr = (this.rr + 1) % from.length;
    return from[this.rr];
  }

  /** Probe judges directly (no proxy) to find our public IP + judge health. */
  async selfTest() {
    for (const j of this.judges) {
      try {
        const fakeProxy = { ip: 'direct', port: 0 };
        const res = await directGet(j.url, this.config.judgeTimeoutMs || 8000);
        const parsed = parseJudge(j, res);
        this.mark(j.url, true);
        if (parsed && parsed.exitIp && !this.realIp) {
          this.realIp = parsed.exitIp;
          this.log('info', `Judge ${hostOf(j.url)} online — this machine's public IP: ${this.realIp}`);
        }
        if (parsed && parsed.headers) this.echoAvailable = true;
      } catch {
        this.mark(j.url, false);
        this.log('warn', `Judge ${hostOf(j.url)} unreachable`);
      }
    }
    this.selfTested = true;
    return this.realIp;
  }
}

function hostOf(u) { try { return new URL(u).host; } catch { return u; } }
function guessKind(u) {
  if (/httpbin/.test(u)) return 'httpbin';
  if (/azenv/i.test(u)) return 'azenv';
  if (/ip-api|ipify|ifconfig|icanhazip|wtfismyip/.test(u)) return 'json-ip';
  return 'auto';
}

/** GET a URL directly (no proxy) using raw sockets. */
async function directGet(url, timeoutMs) {
  const { httpDirect } = require('./probes');
  return httpDirect(url, { timeoutMs, maxBytes: 512 * 1024 });
}

/**
 * Fetch a judge through `proxy` using the transport implied by the judge URL scheme
 * and the proxy protocol tag. Returns { exitIp, headers, raw, kind, judgeUrl }.
 */
async function queryThrough(judge, proxy, transport, timeoutMs) {
  const url = judge.url;
  let res;
  if (transport === 'socks5') res = await socks5ViaProxy(proxy, url, { timeoutMs, maxBytes: 1024 * 1024 });
  else if (transport === 'socks4') res = await socks4ViaProxy(proxy, url, { timeoutMs, maxBytes: 1024 * 1024 });
  else if (transport === 'https') res = await httpsViaProxy(proxy, url, { timeoutMs, maxBytes: 1024 * 1024 });
  else res = await httpViaProxy(proxy, url, { timeoutMs, maxBytes: 1024 * 1024 });
  if (res.status !== 200) throw Object.assign(new Error(`judge HTTP ${res.status}`), { code: 'E_JUDGE_STATUS' });
  const parsed = parseJudge(judge, res);
  if (!parsed || !parsed.exitIp) throw Object.assign(new Error('judge gave no exit IP'), { code: 'E_JUDGE_PARSE' });
  this && this.mark && this.mark(judge.url, true);
  return parsed;
}

/** Parse a raw judge response into { exitIp, headers, anonymitySignal } per judge kind. */
function parseJudge(judge, res) {
  let body = res.body;
  const enc = res.headers && res.headers['content-encoding'];
  if (enc && enc.includes('gzip')) return { exitIp: null, headers: null, raw: null }; // we asked for identity; skip
  const { dechunk } = require('./probes');
  if ((res.headers && res.headers['transfer-encoding'] === 'chunked')) body = dechunk(body);
  const text = body.toString('utf8').slice(0, 64 * 1024);
  const kind = judge.kind === 'auto' ? guessKind(judge.url) : judge.kind;

  if (kind === 'json-ip') {
    const m = text.match(/"(?:query|ip|origin)"\s*:\s*"([^"]+)"/);
    if (m) return { exitIp: m[1].split(',')[0].trim(), headers: null, raw: text, kind };
    const ip = text.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (ip) return { exitIp: ip[1], headers: null, raw: text, kind };
    return { exitIp: null, headers: null, raw: text, kind };
  }
  if (kind === 'httpbin' || kind === 'auto-json' || kind === 'auto') {
    try {
      const j = JSON.parse(text);
      const origin = String(j.origin || j.origin_ip || '').split(',')[0].trim();
      const headers = {};
      for (const [k, v] of Object.entries(j.headers || {})) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
      return { exitIp: origin || null, headers, raw: text, kind: 'httpbin' };
    } catch { /* fallthrough */ }
  }
  // azenv & generic text echo: REMOTE_ADDR = 1.2.3.4, HTTP_VIA = ...
  const addr = text.match(/REMOTE_ADDR\s*=\s*([\d.]+)/) || text.match(/"?(?:REMOTE_ADDR|REMOTE_?HOST)"?\s*[:=]\s*"?([\d.]+)/);
  const headers = {};
  const hdrRe = /([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*([^\r\n<]+)/g;
  let m;
  while ((m = hdrRe.exec(text))) {
    const k = m[1].toLowerCase();
    if (k === 'remote_addr' || k === 'remote_host' || k === 'request_method' || k === 'query_string' || k === 'server_protocol' || k === 'request_uri' || k === 'server_addr' || k === 'server_name' || k === 'document_root' || k === 'script_name' || k === 'path' || k === 'server_software' || k === 'gateway_interface' || k === 'server_admin' || k === 'unique_id' || k === 'context_prefix' || k === 'http_cookie') continue;
    headers[k.replace(/^http_/, '')] = m[2].trim();
  }
  if (addr) return { exitIp: addr[1], headers: Object.keys(headers).length ? headers : null, raw: text, kind: 'azenv' };
  // fallback: find any IP that looks like the answer
  const anyIp = text.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
  if (anyIp && Object.keys(headers).length) return { exitIp: anyIp[1], headers, raw: text, kind };
  return { exitIp: null, headers: Object.keys(headers).length ? headers : null, raw: text, kind };
}

/**
 * Classify anonymity from a judge result.
 * realIp — this machine's public IP (may be null → weaker classification).
 */
function classify(parsed, realIp) {
  if (!parsed) return { anonymity: 'unknown', markers: [], ipLeaked: false };
  const headers = parsed.headers || {};
  const markers = Object.keys(headers).filter(k =>
    PROXY_HEADER_MARKERS.some(p => k.startsWith(p)) || k === 'proxy-connection'
  );
  let ipLeaked = false;
  for (const h of CLIENT_IP_HEADERS) {
    const v = headers[h];
    if (v && realIp && v.includes(realIp)) { ipLeaked = true; break; }
  }
  const exitIsSelf = realIp && parsed.exitIp === realIp;
  if (ipLeaked || exitIsSelf) return { anonymity: 'transparent', markers, ipLeaked: true };
  if (markers.length) return { anonymity: 'anonymous', markers, ipLeaked: false };
  if (!headers) return { anonymity: parsed.exitIp && realIp && parsed.exitIp !== realIp ? 'anonymous~' : 'unknown', markers: [], ipLeaked: false };
  return { anonymity: 'elite', markers, ipLeaked: false };
}

module.exports = { JudgePool, classify, parseJudge, guessKind, queryThrough, DEFAULT_JUDGES, PROXY_HEADER_MARKERS };
