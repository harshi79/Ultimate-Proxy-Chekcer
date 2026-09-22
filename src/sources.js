'use strict';
/*
 * sources.js — one-click import from well-known public proxy lists.
 * Every fetch is timeout-guarded; failures degrade to a log line so the
 * dashboard keeps working offline.
 */
const SOURCES = [
  { id: 'proxyscrape', name: 'ProxyScrape (all)', kinds: ['http', 'https', 'socks4', 'socks5'],
    urls: ['https://api.proxyscrape.com/v2/?request=displayproxies&protocol=all&timeout=10000&country=all&ssl=all&anonymity=all'] },
  { id: 'thespeedx-http', name: 'TheSpeedX · HTTP', kinds: ['http'],
    urls: ['https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'] },
  { id: 'thespeedx-socks4', name: 'TheSpeedX · SOCKS4', kinds: ['socks4'],
    urls: ['https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt'] },
  { id: 'thespeedx-socks5', name: 'TheSpeedX · SOCKS5', kinds: ['socks5'],
    urls: ['https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt'] },
  { id: 'monosans-http', name: 'monosans · HTTP', kinds: ['http'],
    urls: ['https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'] },
  { id: 'monosans-socks5', name: 'monosans · SOCKS5', kinds: ['socks5'],
    urls: ['https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt'] },
  { id: 'proxifly', name: 'Proxifly (all)', kinds: ['http', 'https', 'socks4', 'socks5'],
    urls: ['https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt'] },
  { id: 'geonode', name: 'GeoNode (API, 500)', kinds: ['http', 'https', 'socks4', 'socks5'], json: true,
    urls: ['https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc'] },
];

async function fetchSource(src, timeoutMs = 20000) {
  const out = [];
  for (const url of src.urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'UltimateProxyChecker/1.0' } });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (src.json) {
        const j = await res.json();
        for (const row of (j.data || [])) {
          if (row.ip && row.port) out.push(`${row.protocols?.[0] || row.protocol || 'http'}://${row.ip}:${row.port}`);
        }
      } else {
        const text = await res.text();
        out.push(...text.split(/\r?\n/).filter(Boolean));
      }
    } catch (e) {
      const err = new Error(`${src.name}: ${e.message}`);
      err.sourceId = src.id;
      throw err;
    }
  }
  return out;
}

module.exports = { SOURCES, fetchSource };
