'use strict';
/*
 * probes.js — low-level proxy transports, hand-rolled on raw sockets:
 *   - HTTP proxy  : absolute-URI GET  (+ optional Basic proxy auth)
 *   - HTTPS proxy : CONNECT tunnel then TLS upgrade
 *   - SOCKS5      : full handshake, no-auth + user/pass auth
 *   - SOCKS4      : classic handshake (IP targets)
 * Everything is timeout-hardened: every promise either resolves or destroys
 * the socket and rejects. Errors are typed via .code for clean reporting.
 */
const net = require('net');
const tls = require('tls');
const dns = require('dns').promises;

class ProbeError extends Error {
  constructor(msg, code) { super(msg); this.name = 'ProbeError'; this.code = code || 'E_PROBE'; }
}

const PAUSE = (ms) => new Promise(r => setTimeout(r, ms));

/** TCP connect to (host, port) with timeout. */
function connectSock(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let done = false;
    const to = setTimeout(() => finish(new ProbeError('connect timeout', 'ETIMEDOUT')), timeoutMs);
    function finish(err) {
      if (done) return;
      done = true; clearTimeout(to);
      if (err) { sock.destroy(); reject(err); } else resolve(sock);
    }
    sock.once('connect', () => finish(null));
    sock.once('error', (e) => finish(new ProbeError(e.message, e.code)));
    sock.setNoDelay(true);
    sock.connect(port, host);
  });
}

/** Write buffer, wait for full response head+body (with limits). */
function httpOverSocket(sock, reqBuf, { timeoutMs = 8000, maxBytes = 512 * 1024, timeoutOnIdle = true } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, buf = takeLeftover(sock), headEnd = -1, finished = false;
    const start = process.hrtime.bigint();
    const timer = setTimeout(() => {
      // For speed tests a timeout simply means "this is how much we got" — still resolve.
      if (timeoutOnIdle) fail(new ProbeError('response timeout', 'ETIMEDOUT'));
      else succeed();
    }, timeoutMs);

    function fail(err) { if (finished) return; finished = true; clearTimeout(timer); sock.destroy(); reject(err); }
    function succeed() {
      if (finished) return;
      finished = true; clearTimeout(timer);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      try {
        const head = buf.slice(0, headEnd).toString('latin1');
        const body = buf.slice(headEnd + 4);
        const lines = head.split('\r\n');
        const m = /^HTTP\/1\.[01] (\d{3})(?:\s(.*))?$/i.exec(lines[0] || '');
        if (!m) throw new ProbeError('bad status line' + (head ? `: ${head.slice(0, 40)}` : ' (empty response)'), 'E_BADRESPONSE');
        const headers = {};
        for (let i = 1; i < lines.length; i++) {
          const idx = lines[i].indexOf(':');
          if (idx > 0) headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
        }
        resolve({ status: +m[1], statusText: m[2] || '', headers, body, bytes: size, elapsedMs });
      } catch (e) { reject(e); }
    }
    function onData(d) {
      if (finished) return;
      buf = buf && buf.length ? Buffer.concat([buf, d]) : d;
      size += d.length;
      if (headEnd < 0) {
        headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd < 0) { if (size > 64 * 1024) fail(new ProbeError('header flood', 'E_BADRESPONSE')); return; }
      }
      if (size >= maxBytes) succeed();
    }
    function onErr(e) { fail(new ProbeError(e.message, e.code)); }
    sock.once('error', onErr);
    sock.on('data', onData);
    sock.once('close', () => succeed()); // connection: close responses end here
    sock.write(reqBuf);
  });
}

/** Minimal chunked-transfer decoder (for judge bodies). */
function dechunk(body) {
  let out = [], pos = 0;
  while (pos < body.length) {
    const nl = body.indexOf('\r\n', pos);
    if (nl < 0) break;
    const len = parseInt(body.slice(pos, nl).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(len)) break;
    if (len === 0) break;
    out.push(body.slice(nl + 2, Math.min(nl + 2 + len, body.length)));
    pos = nl + 2 + len + 2;
  }
  return Buffer.concat(out);
}

/** Build a raw proxy GET request buffer (absolute-URI form). */
function buildProxyGet(targetUrlObj, extraHeaders = {}, auth = null) {
  const lines = [
    `GET ${targetUrlObj.href} HTTP/1.1`,
    `Host: ${targetUrlObj.host}`,
    'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept: */*',
    'Accept-Encoding: identity',
    'Connection: close',
  ];
  if (auth) lines.push('Proxy-Authorization: Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64'));
  for (const [k, v] of Object.entries(extraHeaders)) lines.push(`${k}: ${v}`);
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
}

/** Build a CONNECT request buffer. */
function buildConnect(host, port, auth = null) {
  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`, 'User-Agent: Mozilla/5.0', 'Proxy-Connection: keep-alive'];
  if (auth) lines.push('Proxy-Authorization: Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64'));
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');
}

/** Wait for a CONNECT response head on the socket, verify 2xx, return leftover bytes count. */
function awaitConnectResponse(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new ProbeError('CONNECT timeout', 'ETIMEDOUT')); }, timeoutMs);
    function cleanup() { clearTimeout(timer); sock.removeListener('data', onData); sock.removeListener('error', onErr); }
    function onData(d) {
      buf = buf && buf.length ? Buffer.concat([buf, d]) : d;
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const line = buf.slice(0, buf.indexOf('\r\n')).toString('latin1');
      const code = +(/^HTTP\/1\.[01] (\d{3})/.exec(line) || [])[1];
      cleanup();
      if (code >= 200 && code < 300) {
        stashLeftover(sock, buf.slice(idx + 4));
        resolve(buf.length - (idx + 4));
      } else { sock.destroy(); reject(new ProbeError(`CONNECT refused (${code || line})`, 'E_TUNNEL_REFUSED')); }
    }
    function onErr(e) { cleanup(); reject(new ProbeError(e.message, e.code)); }
    sock.on('data', onData);
    sock.on('error', onErr);
  });
}

/**
 * SOCKS5 connect. Returns the connected socket (tunnel established to host:port).
 * Supports no-auth (0x00) and username/password (0x02) when proxy.auth given.
 */
function socks5Connect(proxy, host, port, timeoutMs) {
  const { ip, port: pport, auth } = proxy;
  let sock;
  const needsAuth = !!auth;
  return connectSock(ip, pport, timeoutMs).then(s => {
    sock = s;
    const methods = needsAuth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]);
    sock.write(methods);
    return readExact(sock, 2, timeoutMs);
  }).then(h => {
    if (h[0] !== 5) throw new ProbeError('not SOCKS5', 'E_NOTSOCKS5');
    if (h[1] === 0xFF) throw new ProbeError('SOCKS5: no acceptable auth', 'E_SOCKS_AUTH');
    if (h[1] === 2) {
      if (!auth) throw new ProbeError('SOCKS5 requires auth', 'E_SOCKS_AUTH');
      const u = Buffer.from(auth.user), p = Buffer.from(auth.pass || '');
      sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      return readExact(sock, 2, timeoutMs).then(a => {
        if (a[1] !== 0) throw new ProbeError('SOCKS5 auth failed', 'E_SOCKS_AUTH');
        return sendConnect();
      });
    }
    if (h[1] !== 0) throw new ProbeError(`SOCKS5: unexpected method ${h[1]}`, 'E_SOCKS_AUTH');
    return sendConnect();
  });

  function sendConnect() {
    const hb = Buffer.from(host);
    const atyp = net.isIP(host) === 4 ? 1 : net.isIP(host) === 6 ? 4 : 3;
    let addr;
    if (atyp === 1) {
      const parts = host.split('.').map(Number);
      addr = Buffer.from([1, parts[0], parts[1], parts[2], parts[3]]);
    } else if (atyp === 4) {
      addr = Buffer.concat([Buffer.from([4]), Buffer.from(Buffer.from(host.split(':').map(x => x.padStart(4, '0')).join(''), 'hex'))]);
    } else {
      addr = Buffer.concat([Buffer.from([3, hb.length]), hb]);
    }
    const req = Buffer.concat([Buffer.from([5, 1, 0]), addr, Buffer.from([(port >> 8) & 0xFF, port & 0xFF])]);
    sock.write(req);
    return readExact(sock, 4, timeoutMs).then(head => {
      if (head[1] !== 0) {
        const msgs = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' };
        throw new ProbeError('SOCKS5 error: ' + (msgs[head[1]] || head[1]), 'E_SOCKS_FAIL');
      }
      const extra = { 1: 4, 4: 16, 3: 1 }[head[3]] || 0;
      return readExact(sock, extra + 2, timeoutMs);
    }).then(() => sock);
  }
}

/** SOCKS4/4a connect (IP targets resolved locally). Returns tunneled socket. */
async function socks4Connect(proxy, host, port, timeoutMs) {
  let target = host;
  if (!net.isIP(host)) {
    try { target = (await dns.lookup(host)).address; } catch { throw new ProbeError('SOCKS4 needs resolvable host', 'E_SOCKS_FAIL'); }
  }
  const parts = target.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) throw new ProbeError('SOCKS4 needs IPv4', 'E_SOCKS_FAIL');
  const sock = await connectSock(proxy.ip, proxy.port, timeoutMs);
  const req = Buffer.from([4, 1, (port >> 8) & 0xFF, port & 0xFF, parts[0], parts[1], parts[2], parts[3], 0]);
  try {
    sock.write(req);
    const r = await readExact(sock, 8, timeoutMs);
    if (r[1] !== 0x5A) throw new ProbeError('SOCKS4 refused (' + r[1] + ')', 'E_SOCKS_FAIL');
    return sock;
  } catch (e) { sock.destroy(); throw e; }
}

/*
 * Per-socket leftover stash: bytes read past a handshake boundary are kept
 * here instead of socket.unshift() (which does not replay to a future
 * 'data' listener once the stream is flowing).
 */
const sockStash = new WeakMap();
function stashLeftover(sock, rest) { if (rest && rest.length) sockStash.set(sock, rest); }
function takeLeftover(sock) { const b = sockStash.get(sock) || null; sockStash.delete(sock); return b; }

/** Read exactly n bytes from a socket (leftover-aware). */
function readExact(sock, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = takeLeftover(sock);
    const settle = (out) => {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      resolve(out);
    };
    const timer = setTimeout(() => {
      settleGuard = true;
      stashLeftover(sock, buf);
      cleanup();
      reject(new ProbeError('handshake timeout', 'ETIMEDOUT'));
    }, timeoutMs);
    let settleGuard = false;
    function cleanup() { clearTimeout(timer); sock.removeListener('data', onData); sock.removeListener('error', onErr); }
    function onData(d) {
      buf = buf && buf.length ? Buffer.concat([buf, d]) : d;
      if (buf.length < n) return;
      if (settleGuard) return;
      stashLeftover(sock, buf.slice(n));
      settle(buf.slice(0, n));
    }
    function onErr(e) { cleanup(); reject(new ProbeError(e.message, e.code)); }
    if (buf && buf.length >= n) {
      stashLeftover(sock, buf.slice(n));
      return settle(buf.slice(0, n));
    }
    sock.on('data', onData);
    sock.on('error', onErr);
  });
}

/* ────────────────────────── High-level probes ────────────────────────── */

/**
 * GET targetUrl through an HTTP proxy (absolute-URI). Returns parsed response.
 * opts: { timeoutMs, maxBytes, headers, keepOpen:false } — with keepOpen the
 * socket is returned instead of destroyed (server may close anyway due to
 * Connection: close).
 */
async function httpViaProxy(proxy, targetUrl, { timeoutMs = 8000, maxBytes = 512 * 1024, headers = {} } = {}) {
  const u = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
  if (u.protocol !== 'http:') throw new ProbeError('httpViaProxy is for http targets', 'E_USAGE');
  const sock = await connectSock(proxy.ip, proxy.port, timeoutMs);
  try {
    const res = await httpOverSocket(sock, buildProxyGet(u, headers, proxy.auth), { timeoutMs, maxBytes });
    sock.destroy();
    return res;
  } catch (e) { sock.destroy(); throw e; }
}

/**
 * GET an https target through an HTTP proxy via CONNECT + TLS.
 * Returns { status, headers, body, bytes, elapsedMs, tunnelMs }.
 */
async function httpsViaProxy(proxy, targetUrl, { timeoutMs = 10000, maxBytes = 512 * 1024, servername } = {}) {
  const u = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
  if (u.protocol !== 'https:') throw new ProbeError('httpsViaProxy is for https targets', 'E_USAGE');
  const t0 = Date.now();
  const sock = await connectSock(proxy.ip, proxy.port, timeoutMs);
  try {
    sock.write(buildConnect(u.hostname, u.port || 443, proxy.auth));
    await awaitConnectResponse(sock, timeoutMs);
    const tunnelMs = Date.now() - t0;
    const tlsSock = tls.connect({ socket: sock, servername: servername || (net.isIP(u.hostname) ? undefined : u.hostname), rejectUnauthorized: false });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new ProbeError('TLS timeout', 'ETIMEDOUT')), timeoutMs);
      tlsSock.once('secureConnect', () => { clearTimeout(t); res(); });
      tlsSock.once('error', (e) => { clearTimeout(t); rej(new ProbeError('TLS: ' + e.message, 'E_TLS')); });
    });
    const get = [
      `GET ${u.pathname}${u.search} HTTP/1.1`,
      `Host: ${u.host}`,
      'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Accept: */*', 'Accept-Encoding: identity', 'Connection: close', '', ''
    ].join('\r\n');
    const res = await httpOverSocket(tlsSock, Buffer.from(get, 'latin1'), { timeoutMs, maxBytes });
    tlsSock.destroy();
    return { ...res, tunnelMs };
  } catch (e) { sock.destroy(); throw e; }
}

/** GET target through SOCKS5 proxy (works for http and https targets). */
async function socks5ViaProxy(proxy, targetUrl, { timeoutMs = 10000, maxBytes = 512 * 1024 } = {}) {
  const u = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
  const t0 = Date.now();
  const sock = await socks5Connect(proxy, u.hostname, +(u.port || (u.protocol === 'https:' ? 443 : 80)), timeoutMs);
  const handshakeMs = Date.now() - t0;
  if (u.protocol === 'https:') {
    const tlsSock = tls.connect({ socket: sock, servername: require('net').isIP(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new ProbeError('TLS timeout', 'ETIMEDOUT')), timeoutMs);
      tlsSock.once('secureConnect', () => { clearTimeout(t); res(); });
      tlsSock.once('error', (e) => { clearTimeout(t); rej(new ProbeError('TLS: ' + e.message, 'E_TLS')); });
    });
    const get = [`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, 'User-Agent: Mozilla/5.0', 'Accept: */*', 'Accept-Encoding: identity', 'Connection: close', '', ''].join('\r\n');
    const res = await httpOverSocket(tlsSock, Buffer.from(get, 'latin1'), { timeoutMs, maxBytes });
    tlsSock.destroy();
    return { ...res, handshakeMs };
  }
  const get = [
    `GET ${u.pathname}${u.search || '/'} HTTP/1.1`,
    `Host: ${u.host}`,
    'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    'Accept: */*', 'Accept-Encoding: identity', 'Connection: close', '', ''
  ].join('\r\n');
  const res = await httpOverSocket(sock, Buffer.from(get, 'latin1'), { timeoutMs, maxBytes });
  sock.destroy();
  return { ...res, handshakeMs };
}

/** GET target through SOCKS4 proxy. */
async function socks4ViaProxy(proxy, targetUrl, { timeoutMs = 10000, maxBytes = 512 * 1024 } = {}) {
  const u = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
  const t0 = Date.now();
  const sock = await socks4Connect(proxy, u.hostname, +(u.port || (u.protocol === 'https:' ? 443 : 80)), timeoutMs);
  const handshakeMs = Date.now() - t0;
  if (u.protocol === 'https:') {
    const tlsSock = tls.connect({ socket: sock, servername: net.isIP(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new ProbeError('TLS timeout', 'ETIMEDOUT')), timeoutMs);
      tlsSock.once('secureConnect', () => { clearTimeout(t); res(); });
      tlsSock.once('error', (e) => { clearTimeout(t); rej(new ProbeError('TLS: ' + e.message, 'E_TLS')); });
    });
    const get = [`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`, 'User-Agent: Mozilla/5.0', 'Accept: */*', 'Accept-Encoding: identity', 'Connection: close', '', ''].join('\r\n');
    const res = await httpOverSocket(tlsSock, Buffer.from(get, 'latin1'), { timeoutMs, maxBytes });
    tlsSock.destroy();
    return { ...res, handshakeMs };
  }
  const get = [
    `GET ${u.pathname}${u.search || '/'} HTTP/1.1`,
    `Host: ${u.host}`,
    'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    'Accept: */*', 'Accept-Encoding: identity', 'Connection: close', '', ''
  ].join('\r\n');
  const res = await httpOverSocket(sock, Buffer.from(get, 'latin1'), { timeoutMs, maxBytes });
  sock.destroy();
  return { ...res, handshakeMs };
}

/** GET a URL directly (no proxy). Same parsed shape as httpViaProxy. */
async function httpDirect(targetUrl, { timeoutMs = 8000, maxBytes = 512 * 1024 } = {}) {
  const u = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
  if (u.protocol !== 'http:') throw new ProbeError('httpDirect is for http targets', 'E_USAGE');
  const sock = await connectSock(u.hostname, +(u.port || 80), timeoutMs);
  try {
    const req = Buffer.from([
      `GET ${u.pathname}${u.search || '/'} HTTP/1.1`,
      `Host: ${u.host}`,
      'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      'Accept: */*', 'Accept-Encoding: identity', 'Connection: close', '', ''
    ].join('\r\n'), 'latin1');
    const res = await httpOverSocket(sock, req, { timeoutMs, maxBytes });
    sock.destroy();
    return res;
  } catch (e) { sock.destroy(); throw e; }
}

/** Quick TCP reachability check. */
async function tcpAlive(ip, port, timeoutMs) {
  const sock = await connectSock(ip, port, timeoutMs);
  sock.destroy();
}

/** Open a raw tunnel through the given proxy to host:port (for the gateway). */
async function tunnelThrough(proxy, host, port, timeoutMs) {
  if (proxy.protocols && proxy.protocols.includes('socks5')) {
    return socks5Connect(proxy, host, port, timeoutMs);
  }
  if (proxy.protocols && proxy.protocols.includes('socks4')) {
    return socks4Connect(proxy, host, port, timeoutMs);
  }
  // HTTP proxy → CONNECT
  const sock = await connectSock(proxy.ip, proxy.port, timeoutMs);
  try {
    sock.write(buildConnect(host, port, proxy.auth));
    await awaitConnectResponse(sock, timeoutMs);
    return sock;
  } catch (e) { sock.destroy(); throw e; }
}

module.exports = {
  ProbeError,
  connectSock, httpViaProxy, httpsViaProxy, socks5ViaProxy, socks4ViaProxy,
  socks5Connect, socks4Connect, tcpAlive, tunnelThrough, dechunk, httpDirect,
};
