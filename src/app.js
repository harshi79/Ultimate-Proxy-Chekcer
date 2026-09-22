'use strict';
/*
 * app.js — wires everything together: Express REST API, WebSocket live hub,
 * and the module graph (store → judges → geo → checker → gateway).
 */
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const config = require('./config');
const { Store } = require('./store');
const { JudgePool, classify } = require('./judges');
const { GeoQueue } = require('./geo');
const { Checker } = require('./checker');
const { Gateway } = require('./gateway');
const { SOURCES, fetchSource } = require('./sources');

function createApp(opts = {}) {
  const logs = [];
  const LOG_MAX = 400;
  const log = (level, msg) => {
    const line = { ts: Date.now(), level, msg };
    logs.push(line);
    if (logs.length > LOG_MAX) logs.shift();
    hub && hub.pushLog(line);
    if (!opts.quiet) console.log(`[${level}] ${msg}`);
  };

  const store = new Store();
  const judges = new JudgePool(config, log);
  if (config.get().judgeUrls) judges.setJudges(config.get().judgeUrls);
  const geo = new GeoQueue(log);
  const checker = new Checker(store, judges, geo, config, log);
  const gateway = new Gateway(store, config, log);

  /* ── live hub: batch events → websocket clients ── */
  const hub = {
    clients: new Set(),
    buf: { updates: [], logs: [] },
    pushLog(l) { this.buf.logs.push(l); },
    pushUpdate(rec) { this.buf.updates.push(compact(rec)); },
    broadcast(msg) {
      const data = JSON.stringify(msg);
      for (const ws of this.clients) { if (ws.readyState === 1) ws.send(data); }
    },
  };
  setInterval(() => {
    if (!hub.clients.size) { hub.buf.updates = []; hub.buf.logs = []; return; }
    const payload = {
      t: 'tick',
      stats: store.stats(),
      progress: checker.progress(),
      updates: hub.buf.updates.splice(0, 2000),
      logs: hub.buf.logs.splice(0, 200),
      gw: gateway.snapshot(),
      geo: geo.stats(),
      engine: checker.isRunning(),
    };
    hub.broadcast(payload);
  }, 400).unref();

  checker.on('update', rec => { store.touch(rec); hub.pushUpdate(rec); });
  checker.on('start', rec => hub.pushUpdate(rec));
  checker.on('state', () => hub.broadcast({ t: 'engine', running: checker.isRunning() }));
  checker.on('log', log);
  checker.on('drain', () => { store.scheduleSave(); log('info', 'Check run complete'); });
  gateway.on('stats', () => {});
  gateway.on('state', () => hub.broadcast({ t: 'gateway', gw: gateway.snapshot() }));
  store.on('updates', recs => { for (const r of recs) hub.pushUpdate(r); store.scheduleSave(); });
  store.on('removed', () => hub.broadcast({ t: 'reset' }));
  store.on('cleared', () => hub.broadcast({ t: 'reset' }));
  store.on('cleared-results', () => hub.broadcast({ t: 'reset' }));
  store.on('imported', ({ added, updated, invalid }) => {
    log('info', `Imported: ${added} new, ${updated} known, ${invalid} invalid lines`);
    hub.broadcast({ t: 'imported', added, updated, invalid, stats: store.stats() });
  });
  geo.on('resolved', ({ ip, geo: g }) => {
    for (const r of store.all()) if (r.exitIp === ip) { r.geo = g; hub.pushUpdate(r); }
  });

  judges.selfTest().then(ip => { if (!ip) log('warn', 'Could not determine this machine\'s public IP (no internet or judges down) — anonymity gets classified from header echoes only'); });

  /* ── express ── */
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  const api = express.Router();

  api.get('/state', (req, res) => {
    const compactMode = req.query.compact !== '0';
    res.json({
      version: '1.0.0',
      config: config.get(),
      realIp: judges.realIp,
      judges: judges.list().map(j => ({ url: j.url, kind: j.kind, health: judges.health.get(j.url) || { fails: 0 } })),
      sources: SOURCES.map(({ id, name, kinds }) => ({ id, name, kinds })),
      stats: store.stats(),
      progress: checker.progress(),
      engine: checker.isRunning(),
      gateway: gateway.snapshot(),
      geo: geo.stats(),
      logs: logs.slice(-200),
      proxies: [...store.all()].map(r => compactMode ? compact(r) : r),
    });
  });

  api.post('/import/text', (req, res) => {
    const r = store.importText(String(req.body?.text || ''));
    res.json(r);
  });

  api.post('/sources/fetch', async (req, res) => {
    const ids = req.body?.sources || [];
    const list = SOURCES.filter(s => ids.includes(s.id));
    if (!list.length) return res.status(400).json({ error: 'pick at least one source' });
    res.json({ started: list.length });
    for (const src of list) {
      try {
        const lines = await fetchSource(src);
        store.importText(lines.join('\n'));
        log('info', `Source ${src.name}: ${lines.length} proxies loaded`);
      } catch (e) {
        log('warn', `Source failed — ${e.message}`);
      }
    }
  });

  api.post('/check/start', (req, res) => {
    const mode = req.body?.mode || 'unchecked';
    const n = checker.start(mode === 'ids' ? { ids: req.body.ids || [] } : mode);
    res.json({ queued: n, running: checker.isRunning() });
  });
  api.post('/check/stop', (req, res) => { checker.stop(); res.json({ ok: true }); });

  api.post('/proxy/recheck', (req, res) => {
    const ids = req.body?.ids || [];
    const n = checker.start({ ids });
    res.json({ queued: n });
  });
  api.post('/proxy/remove', (req, res) => {
    const n = store.remove(req.body?.ids || []);
    res.json({ removed: n });
  });
  api.post('/pool/dead/clear', (req, res) => res.json({ removed: store.clearDead() }));
  api.post('/pool/clear', (req, res) => { store.clear(); res.json({ ok: true }); });
  api.post('/pool/reset-results', (req, res) => { store.resetResults(); res.json({ ok: true }); });

  api.post('/config', (req, res) => {
    const before = config.get().gateway.port;
    config.update(req.body || {});
    if (config.get().judgeUrls) judges.setJudges(config.get().judgeUrls);
    checker.applyRecheckSchedule();
    if (gateway.running && config.get().gateway.port !== before) {
      gateway.stop(); gateway.start();
    }
    log('info', 'Config updated');
    res.json({ config: config.get() });
  });

  api.get('/export', (req, res) => {
    const fmt = req.query.format || 'txt';
    let recs = [...store.all()];
    // mirror client-side filters
    const { status, proto, anon, country, q, aliveOnly } = req.query;
    if (status && status !== 'all') recs = recs.filter(r => r.status === status);
    if (aliveOnly === '1') recs = recs.filter(r => r.status === 'alive');
    if (proto && proto !== 'all') recs = recs.filter(r => r.protocols.includes(proto));
    if (anon && anon !== 'all') recs = recs.filter(r => r.anonymity === anon || (anon === 'anonymous' && r.anonymity === 'anonymous~'));
    if (country && country !== 'all') recs = recs.filter(r => r.geo && r.geo.countryCode === country);
    if (q) {
      const s = String(q).toLowerCase();
      recs = recs.filter(r => r.id.includes(s) || (r.exitIp || '').includes(s) || ((r.geo && (r.geo.country || '').toLowerCase().includes(s)) || (r.geo && (r.geo.isp || '').toLowerCase().includes(s))));
    }
    if (fmt === 'json') {
      res.setHeader('content-disposition', 'attachment; filename=proxies.json');
      return res.json(recs.map(r => ({ proxy: r.id, protocols: r.protocols, anonymity: r.anonymity, latencyMs: r.latencyMs, speedKbps: r.speedKbps, exitIp: r.exitIp, geo: r.geo, lastChecked: r.lastChecked })));
    }
    if (fmt === 'csv') {
      res.setHeader('content-disposition', 'attachment; filename=proxies.csv');
      res.setHeader('content-type', 'text/csv');
      const rows = [['proxy', 'protocols', 'anonymity', 'latency_ms', 'speed_kbps', 'exit_ip', 'country', 'city', 'isp', 'last_checked']];
      for (const r of recs) rows.push([r.id, r.protocols.join('|'), r.anonymity, r.latencyMs ?? '', r.speedKbps ?? '', r.exitIp ?? '', r.geo?.country ?? '', r.geo?.city ?? '', r.geo?.isp ?? '', r.lastChecked ? new Date(r.lastChecked).toISOString() : '']);
      return res.send(rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
    }
    // txt — with proto scheme when known, plain ip:port otherwise
    res.setHeader('content-disposition', 'attachment; filename=proxies.txt');
    res.setHeader('content-type', 'text/plain');
    const lines = recs.map(r => (r.protocols[0] ? `${r.protocols[0]}://${r.id}` : r.id));
    res.send(lines.join('\n') + (lines.length ? '\n' : ''));
  });

  api.get('/gateway/fetch', async (req, res) => {
    const url = String(req.query.url || '');
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url must be http(s)' });
    try {
      const { rec, ms, raw } = await gateway.fetchVia(url);
      const body = raw.toString('utf8').slice(0, 8000);
      res.json({ ok: true, via: rec.id, exitIp: rec.exitIp, country: rec.geo?.countryCode || null, ms, body });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  api.post('/gateway/start', async (req, res) => {
    if (req.body?.port || req.body?.mode) config.update({ gateway: req.body });
    const ok = await gateway.start();
    res.json({ ok, gateway: gateway.snapshot() });
  });
  api.post('/gateway/stop', (req, res) => { gateway.stop(); res.json({ ok: true, gateway: gateway.snapshot() }); });
  api.post('/gateway/config', (req, res) => {
    config.update({ gateway: req.body || {} });
    res.json({ gateway: gateway.snapshot() });
  });

  api.get('/judge/selftest', async (req, res) => {
    const ip = await judges.selfTest();
    res.json({ realIp: ip, echoAvailable: judges.echoAvailable, judges: judges.list().map(j => ({ url: j.url, health: judges.health.get(j.url) || {} })) });
  });

  app.use('/api', api);
  app.use('/api', (err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

  /* ── websockets ── */
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    hub.clients.add(ws);
    ws.send(JSON.stringify({ t: 'hello', stats: store.stats(), engine: checker.isRunning(), gw: gateway.snapshot() }));
    ws.on('close', () => hub.clients.delete(ws));
    ws.on('error', () => hub.clients.delete(ws));
  });

  return { app, server, store, judges, geo, checker, gateway, config, log, hub };
}

/** Compact wire format for a proxy record. */
function compact(r) {
  return {
    id: r.id, ip: r.ip, port: r.port,
    st: r.status, pr: r.protocols, an: r.anonymity,
    la: r.latencyMs, al: r.avgLatencyMs, sp: r.speedKbps,
    ex: r.exitIp, ge: r.geo ? [r.geo.country, r.geo.countryCode, r.geo.city, r.geo.isp, r.geo.lat, r.geo.lon, r.geo.local ? 1 : 0, r.geo.proxyHost ? 1 : 0, r.geo.hosting ? 1 : 0] : null,
    ck: r.checks, fk: r.fails, lc: r.lastChecked, ls: r.lastSeen, gu: r.gwUses,
    er: r.lastError, mk: r.markers && r.markers.length ? r.markers : null,
  };
}

module.exports = { createApp, compact };
