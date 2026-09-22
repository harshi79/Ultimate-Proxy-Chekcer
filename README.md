# ⚡ Ultimate Proxy Checker

Not a normal proxy checker. Most checkers give you a dead-or-alive list and call it a day.
This one is a **full proxy workstation**: deep inspection, anonymity forensics, a live
world map, and — the part that makes it a tool you actually *use* — a **rotating proxy
gateway** that turns your verified pool into a single local endpoint.

```
┌────────────────────────────────────────────────────────────────────┐
│  paste / drop / fetch lists → ENGINE → verified, scored, geo'd pool │
│                                   │                                 │
│              live dashboard ◄─────┤                                 │
│                                   ▼                                 │
│        curl / scraper / browser → :8899 → rotates healthy proxies   │
└────────────────────────────────────────────────────────────────────┘
```

## What it checks (per proxy)

| Signal | How |
|---|---|
| **Alive / dead** | full request round-trip, not a TCP ping |
| **Protocol** | real handshakes: `HTTP` (absolute-URI), `HTTPS` (CONNECT + TLS), `SOCKS5`, `SOCKS4` |
| **Anonymity** | judge echoes: **elite** (no leaks) · **anonymous** (Via/Forwarded markers, IP hidden) · **transparent** (your IP leaks through) |
| **Latency** | judge round-trip through the proxy, rolling average |
| **Download speed** | streamed throughput probe (configurable payload/URL) |
| **Exit IP** | what the world sees, compared against your real IP |
| **Geo / ISP / ASN** | batched lookups (ip-api), proxy-host & hosting flags |
| **Auth** | `user:pass` for both HTTP proxies and SOCKS5 |

## The rotating gateway

Start it from the dashboard and point anything at `http://localhost:8899`:

```bash
curl -x http://localhost:8899 https://api.ipify.org          # plain HTTP proxying
curl -x http://localhost:8899 https://example.com            # CONNECT tunneling
```

- **round-robin** · **random** · **sticky sessions** (send `X-Session: myid`, or use
  proxy basic-auth username as the session key) · **best** (lowest latency first)
- dead upstream mid-request? → automatic rotation to the next healthy proxy
  (two-strike rule before a proxy is retired)
- each response is tagged with `X-Rotated-Via: ip:port` so you know who served you
- SOCKS upstreams are chained for CONNECT, HTTP upstreams for plain requests

There's also a **Fetch via rotation** button on the dashboard that demonstrates
rotation straight from the browser (shows the exit IP + upstream used per fetch).

## The dashboard

Dark ops-room UI, everything live over WebSocket:

- KPI strip: pool, alive/dead, in-flight + queue, avg latency, elite count, checks/min sparkline
- sortable/filterable table (status, protocol, anonymity, country, free-text) with per-row recheck/copy/remove
- **live geo map** (canvas, self-contained — no tile server) + top-countries ranking, click to filter
- engine console streaming checker/gateway events
- import: paste, drag & drop file, or one-click pull from public sources (ProxyScrape,
  TheSpeedX, monosans, Proxifly, GeoNode)
- export: `txt` (`proto://ip:port`), `json`, `csv` — honoring the filters you've set
- settings: concurrency, timeouts, protocol sniffing toggles, judges, speed probe,
  recheck schedules, gateway port/mode

## Run it

```bash
npm install
npm start            # dashboard on http://localhost:3000
```

Then: **Import** → paste a list or pick public sources → **Start check**.
Pool + config persist in `data/` and survive restarts.

### Demo mode (no internet needed)

A self-contained lab ships with the repo — mock proxies with distinct
personalities (transparent / anonymous / elite / CONNECT-capable / SOCKS5 /
slow / flaky / dead) and a local judge:

```bash
npm run demo         # dashboard :3000 + gateway :8899, pre-loaded lab pool
```

### Self test

```bash
npm run selftest     # end-to-end: engine, classification, gateway rotation — 18 assertions
```

## REST API

| Endpoint | What |
|---|---|
| `GET /api/state` | full snapshot (pool, stats, config, logs) |
| `POST /api/import/text` | `{ text }` — any common list format |
| `POST /api/sources/fetch` | `{ sources: [ids] }` |
| `POST /api/check/start` | `{ mode: "all" \| "unchecked" \| "dead" \| "alive" \| ids }` |
| `POST /api/check/stop` | pause the engine |
| `GET /api/export?format=txt\|json\|csv&status=alive…` | filtered export |
| `POST /api/gateway/start` / `stop` / `config` | control the rotator |
| `GET /api/gateway/fetch?url=…` | fetch a URL through the rotation (JSON result) |
| `WS /ws` | live tick stream (stats, updates, logs) |

## How judging works

A *judge* is an echo endpoint that reveals (a) the exit IP the world sees and
(b) which proxy-injected headers arrived (`Via`, `X-Forwarded-For`, `Forwarded`,
`Client-IP`, …). Built-in judges: ip-api, httpbin, azenv — health-tracked with
automatic fallback, and fully replaceable in Settings. Your own public IP is
measured at startup, so *transparent* leaks are detected by header content **and**
by exit-IP equality. If a judge is header-less (e.g. ip-api only), anonymity is
marked `anon*` — a softer "at least not transparent" verdict. Honest classification
over confident guessing.

## Notes

- Only check proxies you're allowed to use; this tool is for managing your own
  pools and evaluating lists.
- Free public proxies are hostile territory: expect heavy churn — that's what the
  recheck scheduler and two-strike gateway rule are for.
- Node 18+ (built on Node 22). Zero native dependencies.

MIT © 2026
