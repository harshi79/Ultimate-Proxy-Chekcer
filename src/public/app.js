'use strict';
/* YORI PROXY CHECKER — dashboard client */

const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];

const state = {
  proxies: new Map(),
  config: null,
  realIp: null,
  engine: false,
  gw: null,
  targets: [],
  trun: { running: null, progress: {} },
  stats: {},
  filters: { q: '', status: 'all', proto: 'all', anon: 'all', country: 'all' },
  sort: { key: 'la', dir: 1 },
  rateHistory: [],
  judgeHint: null,
};

/* ───────────────────────── helpers ───────────────────────── */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flagOf = (cc) => {
  if (!cc || cc.length !== 2) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1a5 + c.charCodeAt(0)));
};
const fmtLat = (ms) => ms == null ? '—' : ms >= 10000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
const latColor = (ms) => ms == null ? 'var(--paper-faint)' : ms < 150 ? 'var(--acid)' : ms < 500 ? 'var(--amber)' : ms < 1500 ? '#fb923c' : 'var(--red)';
const fmtSpeed = (kb) => kb == null ? '—' : kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB/s' : kb + ' KB/s';
const fmtBytes = (b) => {
  if (b == null || isNaN(b)) return '0 B';
  if (b > 1 << 30) return (b / (1 << 30)).toFixed(2) + ' GB';
  if (b > 1 << 20) return (b / (1 << 20)).toFixed(2) + ' MB';
  if (b > 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
};
const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000 | 0);
  if (s < 5) return 'now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return (s / 60 | 0) + 'm ago';
  return (s / 3600 | 0) + 'h ago';
};
setInterval(() => { if (state.proxies.size) renderLive(); }, 30000);

function toast(kind, msg) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 3400);
}

function norm(r) {
  const geo = r.ge ? { country: r.ge[0], countryCode: r.ge[1], city: r.ge[2], isp: r.ge[3], lat: r.ge[4], lon: r.ge[5], local: !!r.ge[6], proxyHost: !!r.ge[7], hosting: !!r.ge[8] } : null;
  return {
    id: r.id, ip: r.ip, port: r.port,
    st: r.st, pr: r.pr || [], an: r.an || 'unknown',
    la: r.la, al: r.al, sp: r.sp,
    ex: r.ex, geo, tr: r.tr || null,
    ck: r.ck, fk: r.fk, lc: r.lc, ls: r.ls, gu: r.gu || 0,
    er: r.er, mk: r.mk || [],
  };
}

/* ───────────────────────── boot & live ───────────────────────── */

async function boot() {
  await resync();
  connectWS();
  bindUI();
  drawMapStatic();
  requestAnimationFrame(tickMap);
}

async function resync() {
  try {
    const res = await fetch('/api/state');
    const s = await res.json();
    state.config = s.config;
    state.realIp = s.realIp;
    state.engine = s.engine;
    state.gw = s.gateway;
    state.stats = s.stats;
    state.targets = s.targets || [];
    state.trun = s.targetRun || state.trun;
    state.judgeHint = (s.config.judgeUrls && s.config.judgeUrls[0]) || null;
    state.proxies = new Map((s.proxies || []).map(r => [r.id, norm(r)]));
    $('#console').innerHTML = '';
    logCount = 0;
    (s.logs || []).forEach(addLog);
    renderAll();
  } catch (e) {
    toast('err', 'Failed to reach server: ' + e.message);
  }
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'hello' || m.t === 'tick') {
      if (m.stats) state.stats = m.stats;
      if (m.progress) {
        state.progress = m.progress;
        state.rateHistory.push(m.progress.perMin);
        if (state.rateHistory.length > 60) state.rateHistory.shift();
        drawSpark();
      }
      if (m.engine !== undefined) state.engine = m.engine;
      if (m.gw) state.gw = m.gw;
      if (m.trun) state.trun = m.trun;
      if (m.updates) for (const u of m.updates) state.proxies.set(u.id, norm(u));
      if (m.logs) for (const l of m.logs) addLog(l);
      renderLive();
    } else if (m.t === 'engine') {
      state.engine = m.running;
      renderLive();
    } else if (m.t === 'gateway') {
      state.gw = m.gw;
      renderLive();
    } else if (m.t === 'trun') {
      state.trun = m.run;
      renderLive();
    } else if (m.t === 'targets') {
      state.targets = m.targets;
      renderTargets();
    } else if (m.t === 'imported') {
      state.stats = m.stats;
      toast('ok', `IMPORTED ${m.added} NEW · ${m.updated} KNOWN`);
      resync();
    } else if (m.t === 'reset') {
      resync();
    }
  };
  ws.onclose = () => setTimeout(connectWS, 1500);
}

/* ───────────────────────── rendering ───────────────────────── */

function renderAll() {
  renderKpis();
  renderTable();
  renderTargets();
  renderGw();
  renderTicker();
  renderCountryFilter();
  renderCountries();
  updateEngineUI();
  fillSettings();
}

function renderLive() {
  renderKpis();
  renderTable();
  renderTargets();
  renderGw();
  renderTicker();
  renderCountries();
  updateEngineUI();
}

function filtered() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  let rows = [...state.proxies.values()];
  if (f.status !== 'all') rows = rows.filter(r => r.st === f.status);
  if (f.proto !== 'all') rows = rows.filter(r => r.pr.includes(f.proto));
  if (f.anon !== 'all') rows = rows.filter(r => r.an === f.anon || (f.anon === 'anonymous' && r.an === 'anonymous~'));
  if (f.country !== 'all') rows = rows.filter(r => r.geo && r.geo.countryCode === f.country);
  if (q) rows = rows.filter(r =>
    r.id.toLowerCase().includes(q) ||
    (r.ex || '').includes(q) ||
    (r.geo && ((r.geo.country || '').toLowerCase().includes(q) || (r.geo.isp || '').toLowerCase().includes(q) || (r.geo.city || '').toLowerCase().includes(q)))
  );
  const { key, dir } = state.sort;
  const val = (r) => {
    switch (key) {
      case 'st': return ['dead', 'unchecked', 'checking', 'alive'].indexOf(r.st);
      case 'id': return r.id;
      case 'pr': return r.pr.join() || '';
      case 'an': return r.an;
      case 'la': return r.la ?? 1e9;
      case 'sp': return -(r.sp ?? 0);
      case 'geo': return (r.geo && r.geo.country) || 'zzz';
      default: return r.id;
    }
  };
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  return rows;
}

function tchipHtml(r, t) {
  const tr = r.tr && r.tr[t.id];
  if (state.trun.running === t.id && (!tr || tr.info === 'testing…')) return `<span class="tchip run" title="${esc(t.url)} — testing">▮▮</span>`;
  if (!tr) return `<span class="tchip" title="${esc(t.url)} — not tested against this proxy">—</span>`;
  if (tr.ok === 1) return `<span class="tchip ok" title="${esc(t.url)} — ${esc(tr.info || '')}">✓${tr.ms != null ? tr.ms : ''}</span>`;
  return `<span class="tchip bad" title="${esc(t.url)} — ${esc(tr.info || '')}">${tr.code ? '✗' + tr.code : '✗'}</span>`;
}

function renderTable() {
  const rows = filtered();
  const tbody = $('#tbody');
  const MAX = 400;
  const shown = rows.slice(0, MAX);
  const targets = state.targets.slice(0, 3);
  const extra = state.targets.length > 3 ? `<span class="tchip">+${state.targets.length - 3}</span>` : '';
  tbody.innerHTML = shown.map(r => {
    const stCls = r.st === 'alive' ? 'alive' : r.st === 'dead' ? 'dead' : r.st === 'checking' ? 'checking' : 'unchecked';
    const stLbl = r.st.toUpperCase();
    const protos = r.pr.length
      ? r.pr.map(p => `<span class="proto-chip ${p.startsWith('socks') ? 'socks' : p === 'https' ? 'tls' : ''}">${p.toUpperCase()}</span>`).join('')
      : (r.st === 'checking' ? '<span class="dim">sniffing…</span>' : '<span class="dim">—</span>');
    const anonCls = r.an === 'elite' ? 'elite' : r.an === 'anonymous' ? 'anonymous' : r.an === 'anonymous~' ? 'anonymous2' : r.an === 'transparent' ? 'transparent' : 'unknown';
    const anonLbl = r.an === 'anonymous~' ? 'ANON*' : r.an.toUpperCase();
    const latPct = r.la == null ? 0 : Math.max(6, 100 - Math.min(100, (r.la / 30)));
    const flag = r.geo && r.geo.countryCode ? flagOf(r.geo.countryCode) : '';
    const geoTxt = r.geo ? esc(r.geo.country || '—') : '<span class="dim">—</span>';
    const city = r.geo && r.geo.city && r.geo.city !== 'loopback' ? esc(r.geo.city) : '';
    const chips = state.targets.length ? targets.map(t => tchipHtml(r, t)).join('') + extra : '<span class="dim small">no targets</span>';
    return `<tr class="${r.st === 'checking' ? 'checking' : ''}" data-id="${esc(r.id)}">
    <td><span class="st ${stCls}"><i></i>${stLbl}</span></td>
    <td class="addr">${esc(r.ip)}<span class="port">:${r.port}</span></td>
    <td>${protos}</td>
    <td><span class="badge ${anonCls}" title="${esc((r.mk || []).join(', '))}">${anonLbl}</span></td>
    <td><div class="lat-cell"><div class="lat-bar"><b style="width:${latPct}%;background:${latColor(r.la)}"></b></div><span style="color:${latColor(r.la)}">${fmtLat(r.la)}</span></div></td>
    <td class="spd">${fmtSpeed(r.sp)}</td>
    <td><div class="geo-cell">${flag ? `<span class="flag">${flag}</span>` : ''}<span>${geoTxt}</span>${city ? `<span class="city">${city}</span>` : ''}</div></td>
    <td class="isp-cell" title="${esc(r.geo && r.geo.isp || '')}">${r.geo && r.geo.isp ? esc(r.geo.isp) : '—'}</td>
    <td><div class="tchips">${chips}</div></td>
    <td><div class="row-actions">
      <button class="icon-btn" data-act="recheck" title="Recheck now">↻</button>
      <button class="icon-btn" data-act="copy" title="Copy">⧉</button>
      <button class="icon-btn danger" data-act="remove" title="Remove">✕</button>
    </div></td>
  </tr>`;
  }).join('');
  $('#emptyState').style.display = state.proxies.size ? 'none' : 'block';
  $('#footInfo').textContent = `${state.proxies.size.toLocaleString()} IN POOL · SHOWING ${shown.length}${rows.length > MAX ? ` OF ${rows.length.toLocaleString()} MATCHED` : ''}`;
}

function renderKpis() {
  const s = state.stats;
  $('#vTotal').textContent = (s.total || 0).toLocaleString();
  $('#vAlive').textContent = (s.alive || 0).toLocaleString();
  $('#vDead').textContent = (s.dead || 0).toLocaleString();
  $('#vChecking').textContent = ((s.checking || 0) + (state.progress ? state.progress.running : 0)).toLocaleString();
  $('#tChecking').textContent = 'QUEUED ' + (state.progress ? state.progress.queued : 0);
  $('#vLat').textContent = s.avgLatencyMs != null ? fmtLat(s.avgLatencyMs) : '—';
  $('#vElite').textContent = (s.elite || 0).toLocaleString();
  $('#tElite').textContent = `${s.anonymous || 0} ANON · ${s.transparent || 0} TRANSP`;
  $('#vGeo').textContent = (s.geoResolved || 0).toLocaleString();
  $('#tTotal').textContent = s.unchecked ? `${s.unchecked.toLocaleString()} UNCHECKED` : '—';
  $('#tAlive').textContent = s.alive ? ((s.alive / Math.max(1, s.total) * 100).toFixed(0) + '% OF POOL') : '—';
  $('#tDead').textContent = s.dead ? ((s.dead / Math.max(1, s.total) * 100).toFixed(0) + '% OF POOL') : '—';
  $('#rateChip').innerHTML = `<b>${(state.progress ? state.progress.perMin : 0)}</b>/MIN`;
}

function updateEngineUI() {
  const pill = $('#enginePill'), btn = $('#btnEngine'), lbl = $('#engineLbl');
  const running = state.engine || (state.progress && (state.progress.running > 0 || state.progress.queued > 0));
  pill.classList.toggle('on', !!running);
  lbl.textContent = running ? 'RUNNING' : 'IDLE';
  btn.className = 'btn ' + (running ? 'stop' : 'go');
  btn.innerHTML = running ? '■ STOP' : '▶ RUN CHECK';
  const p = state.progress;
  $('#tLat').textContent = p && p.running ? `CHECKING ${p.running} NOW` : 'ALIVE PROXIES';
}

/* ticker */
function renderTicker() {
  const s = state.stats;
  const p = state.progress || { perMin: 0 };
  const gw = state.gw && state.gw.stats || {};
  const tr = state.trun && state.trun.progress || {};
  let parts = [
    `YORI`, `ALIVE <b>${s.alive || 0}</b>`, `DEAD <b>${s.dead || 0}</b>`, `ELITE <b>${s.elite || 0}</b>`,
    `ANON <b>${s.anonymous || 0}</b>`, `AVG LAT <b>${s.avgLatencyMs != null ? fmtLat(s.avgLatencyMs) : '—'}</b>`,
    `<b>${p.perMin || 0}</b> CHECKS/MIN`,
  ];
  if (state.trun.running) parts.push(`TARGET RUN <b>${tr.done || 0}/${tr.total || 0}</b>`);
  parts.push(`GW SERVED <b>${gw.served || 0}</b>`, `POOL <b>${s.total || 0}</b>`, 'YOUR TARGETS. YOUR RULES.');
  const html = parts.join('<i>▓</i>');
  $('#tickA').innerHTML = html;
  $('#tickB').innerHTML = html;
}

/* sparkline */
function drawSpark() {
  const cv = $('#spark');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const data = state.rateHistory.slice(-60);
  if (data.length < 2) return;
  const max = Math.max(4, ...data);
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * (w - 2) + 1;
    const y = h - 2 - (v / max) * (h - 6);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = 'rgba(217,255,61,0.95)';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.lineTo(w - 1, h); ctx.lineTo(1, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(217,255,61,0.3)'); g.addColorStop(1, 'rgba(217,255,61,0)');
  ctx.fillStyle = g; ctx.fill();
}

/* ───────────────────────── map ───────────────────────── */

let mapLand = null;
fetch('/world-110m.json').then(r => r.json()).then(j => { mapLand = j; drawMapStatic(); }).catch(() => {});

const MAP_W = 760, MAP_H = 380;
function project(lon, lat) {
  return [((lon + 180) / 360) * MAP_W, ((90 - lat) / 180) * MAP_H];
}

function drawMapStatic() {
  const cv = $('#map');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, MAP_W, MAP_H);
  ctx.fillStyle = 'rgba(8,10,18,0.55)';
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  if (!mapLand) return;
  ctx.beginPath();
  for (const c of mapLand) for (const poly of c.rings) for (const ring of poly) {
    ring.forEach(([lon, lat], i) => {
      const [x, y] = project(lon, lat);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
  }
  ctx.fillStyle = '#171a26';
  ctx.fill();
  ctx.strokeStyle = 'rgba(217,255,61,0.16)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
}

function geoPoints() {
  const byCc = new Map();
  for (const r of state.proxies.values()) {
    if (r.st !== 'alive' || !r.geo || r.geo.lat == null) continue;
    const key = r.geo.countryCode || r.geo.country || '??';
    if (!byCc.has(key)) byCc.set(key, { name: r.geo.country || key, cc: r.geo.countryCode, lat: r.geo.lat, lon: r.geo.lon, n: 0 });
    byCc.get(key).n++;
  }
  return [...byCc.values()];
}

let mapPulse = 0;
function tickMap(ts) {
  mapPulse = (ts / 1000) % 2;
  drawMapDots();
  requestAnimationFrame(tickMap);
}

function drawMapDots() {
  if (!mapLand) return;
  const cv = $('#map');
  const ctx = cv.getContext('2d');
  const pts = geoPoints();
  if (!drawMapDots.base) {
    const off = document.createElement('canvas');
    off.width = MAP_W; off.height = MAP_H;
    const octx = off.getContext('2d');
    octx.fillStyle = 'rgba(8,10,18,0.55)';
    octx.fillRect(0, 0, MAP_W, MAP_H);
    octx.beginPath();
    for (const c of mapLand) for (const poly of c.rings) for (const ring of poly) {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = project(lon, lat);
        i ? octx.lineTo(x, y) : octx.moveTo(x, y);
      });
      octx.closePath();
    }
    octx.fillStyle = '#171a26'; octx.fill();
    octx.strokeStyle = 'rgba(217,255,61,0.16)'; octx.lineWidth = 0.6; octx.stroke();
    drawMapDots.base = off;
  }
  ctx.clearRect(0, 0, MAP_W, MAP_H);
  ctx.drawImage(drawMapDots.base, 0, 0);
  const max = Math.max(1, ...pts.map(p => p.n));
  for (const p of pts) {
    const [x, y] = project(p.lon, p.lat);
    const rad = 3 + (p.n / max) * 7;
    const pulse = (Math.sin(mapPulse * Math.PI) + 1) / 2;
    const rr = rad * (1.8 + pulse * 0.7);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, 'rgba(217,255,61,0.9)');
    g.addColorStop(0.4, 'rgba(217,255,61,0.26)');
    g.addColorStop(1, 'rgba(217,255,61,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f4ffd0';
    ctx.beginPath(); ctx.arc(x, y, Math.max(1.6, rad * 0.28), 0, Math.PI * 2); ctx.fill();
  }
  $('#mapEmpty').style.display = pts.length ? 'none' : 'flex';
  $('#mapCount').textContent = pts.length ? `${pts.reduce((a, p) => a + p.n, 0)} LOCATED` : '';
}

$('#map').addEventListener('mousemove', (e) => {
  const rect = $('#map').getBoundingClientRect();
  const x = (e.clientX - rect.left) * (MAP_W / rect.width);
  const y = (e.clientY - rect.top) * (MAP_H / rect.height);
  const pts = geoPoints();
  let best = null, bd = 1e9;
  for (const p of pts) {
    const [px, py] = project(p.lon, p.lat);
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  const tip = $('#mapTip');
  if (best && bd < 26 * 26) {
    const [px, py] = project(best.lon, best.lat);
    tip.style.display = 'block';
    tip.style.left = (px / MAP_W * rect.width + 12) + 'px';
    tip.style.top = (py / MAP_H * rect.height - 10) + 'px';
    tip.innerHTML = `${flagOf(best.cc)} <b>${esc(best.name)}</b> · ${best.n} PROX${best.n > 1 ? 'IES' : 'Y'}`;
  } else tip.style.display = 'none';
});
$('#map').addEventListener('mouseleave', () => { $('#mapTip').style.display = 'none'; });

function renderCountries() {
  const counts = new Map();
  for (const r of state.proxies.values()) {
    if (r.st !== 'alive' || !r.geo || !r.geo.countryCode) continue;
    const cc = r.geo.countryCode;
    if (!counts.has(cc)) counts.set(cc, { cc, name: r.geo.country, n: 0 });
    counts.get(cc).n++;
  }
  const list = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 12);
  const max = list.length ? list[0].n : 1;
  $('#countryList').innerHTML = list.map(c => `
    <div class="crow" data-cc="${esc(c.cc)}" title="FILTER: ${esc(c.name)}">
      <span>${flagOf(c.cc)}</span>
      <span class="bar"><b style="width:${(c.n / max * 100).toFixed(0)}%"></b></span>
      <span class="n">${c.n}</span>
    </div>`).join('');
  $$('#countryList .crow').forEach(el => el.onclick = () => {
    state.filters.country = el.dataset.cc;
    $('#fCountry').value = el.dataset.cc;
    syncCountryOptions();
    renderLive();
  });
}

function renderCountryFilter() { syncCountryOptions(); }
function syncCountryOptions() {
  const sel = $('#fCountry');
  const cur = state.filters.country;
  const counts = new Map();
  for (const r of state.proxies.values()) if (r.geo && r.geo.countryCode) counts.set(r.geo.countryCode, (counts.get(r.geo.countryCode) || 0) + 1);
  const opts = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  sel.innerHTML = `<option value="all">COUNTRY: ALL</option>` +
    (cur !== 'all' && !counts.has(cur) ? `<option value="${esc(cur)}">${esc(cur)}</option>` : '') +
    opts.map(([cc, n]) => `<option value="${esc(cc)}">${flagOf(cc)} ${esc(cc)} (${n})</option>`).join('');
  sel.value = cur;
}

/* ───────────────────────── custom targets ───────────────────────── */

function targetAgg(t) {
  let tested = 0, ok = 0, msSum = 0, running = 0;
  for (const r of state.proxies.values()) {
    const tr = r.tr && r.tr[t.id];
    if (!tr) continue;
    if (tr.info === 'testing…') { running++; continue; }
    tested++;
    if (tr.ok === 1) { ok++; msSum += tr.ms || 0; }
  }
  return { tested, ok, running, avg: ok ? Math.round(msSum / ok) : null };
}

function renderTargets() {
  const box = $('#tgtList');
  if (!box) return;
  const run = state.trun || {};
  if (run.running) {
    const p = run.progress || {};
    $('#tgtRunInfo').textContent = `RUN ${p.done || 0}/${p.total || 0}`;
  } else $('#tgtRunInfo').textContent = '';

  if (!state.targets.length) {
    box.innerHTML = `<div class="dim mono small" style="padding:6px 2px">// NO TARGETS YET — ADD YOUR URL ABOVE</div>`;
    return;
  }
  box.innerHTML = state.targets.map(t => {
    const a = targetAgg(t);
    const isRun = run.running === t.id;
    const resLine = a.tested || a.running
      ? `<b>${a.ok}</b>/${a.tested} PASS${a.avg != null ? ` · AVG ${a.avg}MS` : ''}${a.running ? ` · <span style="color:var(--amber)">▮${a.running}</span>` : ''}`
      : `<span class="zero">NOT RUN YET</span>`;
    return `<div class="tgt-item ${isRun ? 'run' : ''}" data-tid="${esc(t.id)}">
      <div class="tgt-top">
        <span class="tgt-url" title="${esc(t.url)}">${esc(t.url)}</span>
        ${t.keyword ? `<span class="tgt-kw" title="body must contain">◈ ${esc(t.keyword)}</span>` : ''}
        <button class="tgt-del" data-tdel="${esc(t.id)}" title="Delete target">✕</button>
      </div>
      <div class="tgt-bot">
        <span class="tgt-res">${resLine}</span>
        ${isRun
          ? `<button class="btn sm stop tgt-run" data-trun="${esc(t.id)}">■ ${((run.progress || {}).done) || 0}/${((run.progress || {}).total) || 0}</button>`
          : `<button class="btn sm acid tgt-run" data-trun="${esc(t.id)}" data-mode="alive" title="Fire all alive proxies at this URL">▶ RUN ALIVE</button>`}
      </div>
    </div>`;
  }).join('');
}

/* ───────────────────────── inspector ───────────────────────── */

let inspId = null;
function openInspector(id) {
  const r = state.proxies.get(id);
  if (!r) return;
  inspId = id;
  const stCls = r.st === 'alive' ? 'alive' : r.st === 'dead' ? 'dead' : r.st === 'checking' ? 'checking' : '';
  $('#inspTitle').textContent = r.id;
  $('#inspTitle').classList.add('insp-title-mono');
  const stamp = $('#inspStamp');
  stamp.textContent = r.st.toUpperCase();
  stamp.className = `stamp sm ${stCls}`;
  const cell = (l, v) => `<div class="insp-cell"><div class="l">${l}</div><div class="v">${v}</div></div>`;
  const anonCls = r.an === 'elite' ? 'elite' : r.an === 'anonymous' ? 'anonymous' : r.an === 'anonymous~' ? 'anonymous2' : r.an === 'transparent' ? 'transparent' : 'unknown';
  const body = `
    <div class="insp-grid">
      ${cell('PROTOCOLS', r.pr.length ? r.pr.map(p => `<span class="proto-chip ${p.startsWith('socks') ? 'socks' : p === 'https' ? 'tls' : ''}">${p.toUpperCase()}</span>`).join(' ') : '—')}
      ${cell('ANONYMITY', `<span class="badge ${anonCls}">${r.an === 'anonymous~' ? 'ANON*' : esc(r.an.toUpperCase())}</span>`)}
      ${cell('EXIT IP', r.ex ? esc(r.ex) : '—')}
      ${cell('LATENCY', `${fmtLat(r.la)} ${r.al != null ? `<small>avg ${fmtLat(r.al)}</small>` : ''}`)}
      ${cell('SPEED', fmtSpeed(r.sp))}
      ${cell('GEO', r.geo ? `${r.geo.countryCode ? flagOf(r.geo.countryCode) + ' ' : ''}${esc(r.geo.country || '—')}${r.geo.city ? ' · ' + esc(r.geo.city) : ''}` : '—')}
      ${cell('ISP', r.geo && r.geo.isp ? esc(r.geo.isp) : '—')}
      ${cell('CHECKS', `${r.ck} total · ${r.fk} fail${r.gu ? ` · ${r.gu} gw uses` : ''}`)}
      ${cell('LAST CHECK', ago(r.lc))}
    </div>
    ${r.mk && r.mk.length ? `<div class="insp-sec">// LEAKED PROXY HEADERS</div><div class="insp-markers">${r.mk.map(m => `<span>${esc(m)}</span>`).join('')}</div>` : ''}
    <div class="insp-sec">// TARGET RESULTS</div>
    ${state.targets.length ? state.targets.map(t => {
      const tr = r.tr && r.tr[t.id];
      let line;
      if (!tr) line = `<span class="dim">— not tested</span>`;
      else if (tr.info === 'testing…') line = `<span class="tchip run">▮▮ TESTING</span>`;
      else if (tr.ok === 1) line = `<span class="ok">${tr.code || 'OK'} · ${tr.ms}ms · ${fmtBytes(tr.bytes)}</span><span>${esc(tr.info || '')}</span>`;
      else line = `<span class="bad">${tr.code ? 'HTTP ' + tr.code : 'FAILED'} · ${tr.ms != null ? tr.ms + 'ms' : ''}</span><span>${esc(tr.info || '')}</span>`;
      return `<div class="insp-tgt"><div class="u">${esc(t.url)}${t.keyword ? ` <span class="tgt-kw">◈ ${esc(t.keyword)}</span>` : ''}</div><div class="r">${line}</div></div>`;
    }).join('') : '<div class="dim mono small">// NO TARGETS CONFIGURED — ADD ONE IN THE CUSTOM TARGETS PANEL</div>'}
    ${r.er ? `<div class="insp-sec">// LAST ERROR</div><div class="insp-err">${esc(r.er)}</div>` : ''}
  `;
  $('#inspBody').innerHTML = body;
  $('#inspFoot').innerHTML = `
    <button class="btn sm ghost" data-iact="recheck">↻ RECHECK</button>
    <button class="btn sm ghost" data-iact="copy">⧉ COPY</button>
    <span style="flex:1"></span>
    <button class="btn sm danger" data-iact="remove">✕ REMOVE</button>`;
  $$('#inspFoot [data-iact]').forEach(b => b.onclick = () => rowAction(b.dataset.iact, id));
  $('#inspectorOverlay').classList.add('open');
}

async function rowAction(act, id) {
  if (act === 'copy') {
    const r = state.proxies.get(id);
    await navigator.clipboard.writeText(r && r.pr.length ? `${r.pr[0]}://${id}` : id).catch(() => {});
    toast('ok', 'COPIED ' + id);
  } else if (act === 'recheck') {
    await fetch('/api/proxy/recheck', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    toast('info', 'RECHECKING ' + id);
  } else if (act === 'remove') {
    await fetch('/api/proxy/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    state.proxies.delete(id);
    $('#inspectorOverlay').classList.remove('open');
    renderLive();
    toast('ok', 'REMOVED ' + id);
  }
}

/* ───────────────────────── console ───────────────────────── */
let logCount = 0;
function addLog(l) {
  const con = $('#console');
  const el = document.createElement('div');
  const time = new Date(l.ts).toTimeString().slice(0, 8);
  el.className = `log-line ${l.level}`;
  el.innerHTML = `<span class="t">${time}</span><span class="m">${esc(l.msg)}</span>`;
  con.appendChild(el);
  if (++logCount > 300) { con.firstChild.remove(); logCount--; }
  if (autoscroll) con.scrollTop = con.scrollHeight;
}
let autoscroll = true;
$('#console').addEventListener('scroll', (e) => {
  autoscroll = e.target.scrollTop + e.target.clientHeight >= e.target.scrollHeight - 24;
});

/* ───────────────────────── gateway ───────────────────────── */

function renderGw() {
  const gw = state.gw;
  if (!gw) return;
  $('#gwToggle').checked = !!gw.running;
  $('#gwServed').textContent = (gw.stats.served || 0).toLocaleString();
  $('#gwFailed').textContent = (gw.stats.failed || 0).toLocaleString();
  $('#gwTunnels').textContent = gw.stats.activeTunnels || 0;
  $('#gwBytes').textContent = fmtBytes(gw.stats.bytesDown || 0);
  $('#gwMode').value = gw.cfg.mode;
  $('#gwEndpoint').textContent = `http://localhost:${gw.cfg.port}`;
  const exits = gw.stats.lastExits || [];
  $('#gwExits').innerHTML = exits.length ? `<span class="dim mono small">RECENT EXITS:</span>` + exits.slice(0, 6).map(e =>
    `<span class="exit-chip" title="${esc(e.id)}">${esc(e.exitIp || e.id)}${e.country ? ' ' + flagOf(e.country) : ''}</span>`).join('') : '';
}

function suggestTestUrl() {
  if ($('#gwTestUrl').value) return;
  const j = state.judgeHint;
  if (j && /127\.0\.0\.1|localhost/.test(j)) $('#gwTestUrl').value = j.replace(/\/$/, '') + '/ip';
  else $('#gwTestUrl').value = 'http://ip-api.com/json';
}

async function gwTest() {
  const url = $('#gwTestUrl').value.trim();
  const box = $('#gwResult');
  if (!url) { toast('err', 'ENTER A URL TO FETCH'); return; }
  box.classList.add('show');
  box.innerHTML = '<span class="dim">rotating through healthy proxies…</span>';
  try {
    const res = await fetch('/api/gateway/fetch?url=' + encodeURIComponent(url));
    const j = await res.json();
    if (j.ok) {
      const bodyLine = String(j.body || '').split(/\r?\n/).find(l => l.trim()) || '';
      box.innerHTML = `<span class="ok">✓ ${res.status}</span> VIA <span class="via">${esc(j.via)}</span> · EXIT <span class="via">${esc(j.exitIp || '?')}</span> ${j.country ? flagOf(j.country) : ''} · ${j.ms}MS<br>${esc(bodyLine.slice(0, 220))}`;
    } else {
      box.innerHTML = `<span class="fail">✗ ${esc(j.error)}</span>`;
    }
  } catch (e) {
    box.innerHTML = `<span class="fail">✗ ${esc(e.message)}</span>`;
  }
}

/* ───────────────────────── UI bindings ───────────────────────── */

function bindUI() {
  // topbar
  $('#btnEngine').onclick = async () => {
    const running = state.engine || (state.progress && (state.progress.running > 0 || state.progress.queued > 0));
    if (running) await fetch('/api/check/stop', { method: 'POST' });
    else {
      const res = await fetch('/api/check/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'unchecked' }) });
      const j = await res.json();
      toast('info', j.queued ? `CHECKING ${j.queued} PROXIES…` : 'NOTHING TO CHECK — IMPORT FIRST');
    }
  };
  $('#btnImport').onclick = openImport;
  $('#btnSettings').onclick = openSettings;

  // filters
  let qT;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qT);
    qT = setTimeout(() => { state.filters.q = e.target.value; renderLive(); }, 180);
  });
  $('#fStatus').onchange = (e) => { state.filters.status = e.target.value; renderLive(); };
  $('#fProto').onchange = (e) => { state.filters.proto = e.target.value; renderLive(); };
  $('#fAnon').onchange = (e) => { state.filters.anon = e.target.value; renderLive(); };
  $('#fCountry').onchange = (e) => { state.filters.country = e.target.value; renderLive(); };
  $$('#tablePanel thead th[data-sort]').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    if (state.sort.key === k) state.sort.dir *= -1;
    else state.sort = { key: k, dir: 1 };
    $$('th .arr').forEach(a => a.remove());
    th.insertAdjacentHTML('beforeend', `<span class="arr">${state.sort.dir > 0 ? '▲' : '▼'}</span>`);
    renderLive();
  });

  // export
  $('#btnExport').onclick = (e) => { e.stopPropagation(); $('#exportMenu').classList.toggle('open'); };
  document.addEventListener('click', () => $('#exportMenu').classList.remove('open'));
  $$('#exportMenu button').forEach(b => b.onclick = () => {
    const f = state.filters;
    const p = new URLSearchParams();
    p.set('format', b.dataset.fmt === 'txt-alive' ? 'txt' : b.dataset.fmt);
    if (b.dataset.fmt === 'txt-alive') p.set('status', 'alive');
    else {
      if (f.status !== 'all') p.set('status', f.status);
      if (f.proto !== 'all') p.set('proto', f.proto);
      if (f.anon !== 'all') p.set('anon', f.anon);
      if (f.country !== 'all') p.set('country', f.country);
      if (f.q.trim()) p.set('q', f.q.trim());
    }
    window.open('/api/export?' + p.toString());
    toast('info', 'EXPORT STARTED');
  });

  // table: row click → inspector, action buttons → rowAction
  $('#tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    if (btn) return rowAction(btn.dataset.act, id);
    openInspector(id);
  });

  $('#btnRecheckDead').onclick = async () => {
    const r = await fetch('/api/check/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'dead' }) });
    const j = await r.json();
    toast('info', j.queued ? `RECHECKING ${j.queued} DEAD PROXIES` : 'NO DEAD PROXIES');
  };
  $('#btnClearDead').onclick = async () => {
    const r = await fetch('/api/pool/dead/clear', { method: 'POST' });
    const j = await r.json();
    toast('ok', `REMOVED ${j.removed} DEAD PROXIES`);
  };

  // targets
  $('#tgtAdd').onclick = async () => {
    const url = $('#tgtUrl').value.trim();
    const keyword = $('#tgtKw').value.trim();
    if (!url) return toast('err', 'GIVE A TARGET URL');
    const res = await fetch('/api/targets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, keyword }) });
    const j = await res.json();
    if (j.error) return toast('err', j.error.toUpperCase());
    $('#tgtUrl').value = ''; $('#tgtKw').value = '';
    toast('ok', 'TARGET ADDED — RUN IT');
  };
  $('#tgtList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-tdel]');
    if (del) {
      await fetch('/api/targets/' + del.dataset.tdel, { method: 'DELETE' });
      toast('ok', 'TARGET DELETED');
      return;
    }
    const run = e.target.closest('[data-trun]');
    if (run) {
      if (state.trun.running) {
        await fetch('/api/targets/stop', { method: 'POST' });
        toast('info', 'STOPPING TARGET RUN');
        return;
      }
      const mode = run.dataset.mode || 'alive';
      const res = await fetch('/api/targets/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: run.dataset.trun, mode }) });
      const j = await res.json();
      if (j.error) return toast('err', j.error.toUpperCase());
      toast('info', `TARGET RUN STARTED (${j.queued || 0} PROXIES)`);
    }
  });

  // gateway
  $('#gwToggle').onchange = async (e) => {
    const on = e.target.checked;
    const res = await fetch(on ? '/api/gateway/start' : '/api/gateway/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const j = await res.json();
    state.gw = j.gateway;
    if (j.ok || !on) toast('ok', on ? `GATEWAY LIVE ON :${j.gateway.cfg.port}` : 'GATEWAY STOPPED');
    else toast('err', 'COULD NOT START GATEWAY (PORT BUSY?)');
    renderGw();
  };
  $('#gwMode').onchange = async (e) => {
    await fetch('/api/gateway/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: e.target.value }) });
    toast('ok', 'ROTATION MODE: ' + e.target.value);
  };
  $('#gwTest').onclick = gwTest;
  $('#gwTestUrl').addEventListener('focus', suggestTestUrl);
  $('#gwCopy').onclick = () => { navigator.clipboard.writeText($('#gwEndpoint').textContent).catch(() => {}); toast('ok', 'ENDPOINT COPIED'); };

  // import modal
  $$('#importOverlay .tab').forEach(t => t.onclick = () => {
    $$('#importOverlay .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $$('#importOverlay .tabbody').forEach(b => b.style.display = b.dataset.body === t.dataset.tab ? 'block' : 'none');
    $('#btnDoImport').style.display = t.dataset.tab === 'sources' ? 'none' : 'inline-flex';
    $('#btnSrcFetch').style.display = t.dataset.tab === 'sources' ? 'inline-flex' : 'none';
  });
  $('#pasteTa').addEventListener('input', (e) => {
    const lines = e.target.value.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
    $('#importCnt').textContent = lines.length + ' LINES';
  });
  $('#btnDoImport').onclick = async () => {
    const text = $('#pasteTa').value;
    if (!text.trim()) return toast('err', 'NOTHING TO IMPORT');
    const res = await fetch('/api/import/text', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    const j = await res.json();
    $('#importCnt').textContent = '';
    if (j.added + j.updated === 0) toast('err', `NO VALID PROXIES (${j.invalid} INVALID LINES)`);
  };
  const drop = $('#fileDrop');
  drop.onclick = () => $('#fileInput').click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files[0]) readfile(e.dataTransfer.files[0]); };
  $('#fileInput').onchange = (e) => { if (e.target.files[0]) readfile(e.target.files[0]); };
  function readfile(f) {
    const rd = new FileReader();
    rd.onload = async () => {
      const res = await fetch('/api/import/text', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: String(rd.result) }) });
      const j = await res.json();
      toast(j.added ? 'ok' : 'err', `${f.name}: +${j.added} NEW · ${j.updated} KNOWN · ${j.invalid} INVALID`);
    };
    rd.readAsText(f);
  }
  (async () => {
    const s = await (await fetch('/api/state')).json();
    $('#srcList').innerHTML = s.sources.map(src => `
      <div class="src-item" data-src="${esc(src.id)}">
        <span class="cb"></span><span>${esc(src.name)}</span>
        <span class="kinds">${src.kinds.map(k => `<span class="proto-chip ${k.startsWith('socks') ? 'socks' : k === 'https' ? 'tls' : ''}" style="font-size:8.5px">${k}</span>`).join('')}</span>
      </div>`).join('');
    $$('#srcList .src-item').forEach(el => el.onclick = () => el.classList.toggle('on'));
  })().catch(() => {});
  $('#btnSrcFetch').onclick = async () => {
    const ids = $$('#srcList .src-item.on').map(el => el.dataset.src);
    if (!ids.length) return toast('err', 'SELECT AT LEAST ONE SOURCE');
    $('#btnSrcFetch').disabled = true;
    await fetch('/api/sources/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sources: ids }) });
    toast('info', 'FETCHING SOURCES — RESULTS STREAM INTO THE POOL');
    setTimeout(() => { $('#btnSrcFetch').disabled = false; }, 4000);
  };

  // overlays
  $$('.overlay').forEach(o => {
    o.addEventListener('click', (e) => { if (e.target === o) o.classList.remove('open'); });
    $$('[data-close]', o).forEach(b => b.onclick = () => o.classList.remove('open'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.overlay.open').forEach(o => o.classList.remove('open'));
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
  });

  // settings
  $('#btnSaveSettings').onclick = saveSettings;
  $('#btnResetResults').onclick = async () => {
    if (!confirm('Reset all check results? The pool stays, statuses go back to unchecked.')) return;
    await fetch('/api/pool/reset-results', { method: 'POST' });
    toast('ok', 'RESULTS RESET');
  };
  $('#btnWipe').onclick = async () => {
    if (!confirm('Wipe the ENTIRE pool? This cannot be undone.')) return;
    await fetch('/api/pool/clear', { method: 'POST' });
    toast('ok', 'POOL WIPED');
  };
}

/* ───────────────────────── modals ───────────────────────── */

function openImport() {
  $('#importOverlay').classList.add('open');
  setTimeout(() => $('#pasteTa').focus(), 60);
}
window.openImport = openImport;

function openSettings() { fillSettings(); $('#settingsOverlay').classList.add('open'); }

function fillSettings() {
  const c = state.config;
  if (!c) return;
  $('#sConc').value = c.concurrency;
  $('#sTimeout').value = c.timeoutMs;
  $('#sRecheckAlive').value = c.recheckAliveMin;
  $('#sRecheckDead').value = c.recheckDeadMin;
  $$('[data-sniff]').forEach(cb => cb.checked = !!c.sniff[cb.dataset.sniff]);
  $('#sHttpsProbe').value = c.httpsProbeUrl;
  $('#sSpeedOn').checked = c.speedTest;
  $('#sSpeedUrl').value = c.speedUrl;
  $('#sSpeedBytes').value = c.speedBytes;
  $('#sJudges').value = (c.judgeUrls && c.judgeUrls.length ? c.judgeUrls : []).join('\n');
  $('#sGwPort').value = c.gateway.port;
  $('#sGwMode').value = c.gateway.mode;
}

async function saveSettings() {
  const body = {
    concurrency: +$('#sConc').value || 150,
    timeoutMs: +$('#sTimeout').value || 9000,
    recheckAliveMin: +$('#sRecheckAlive').value || 0,
    recheckDeadMin: +$('#sRecheckDead').value || 0,
    sniff: Object.fromEntries($$('[data-sniff]').map(cb => [cb.dataset.sniff, cb.checked])),
    httpsProbeUrl: $('#sHttpsProbe').value.trim(),
    speedTest: $('#sSpeedOn').checked,
    speedUrl: $('#sSpeedUrl').value.trim(),
    speedBytes: +$('#sSpeedBytes').value || 262144,
    judgeUrls: $('#sJudges').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
    gateway: { port: +$('#sGwPort').value || 8899, mode: $('#sGwMode').value },
  };
  await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  $('#setSaved').textContent = 'SAVED ' + new Date().toLocaleTimeString();
  toast('ok', 'SETTINGS SAVED');
  await resync();
}

/* ───────────────────────── go ───────────────────────── */
boot();
