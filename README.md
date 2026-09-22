# YORI — Proxy Checker

**Not a normal proxy checker.** Yori is a full proxy workstation: deep protocol
inspection, anonymity forensics, target-based testing (fire your pool at *your
own* URLs), a live world map — and a **rotating gateway** that turns your
verified pool into a single local endpoint. Wrapped in a glassmorphism ×
brutalism dashboard that updates live.

```
┌──────────────────────────────────────────────────────────────────────┐
│ paste / drop / fetch lists → ENGINE → verified, scored, geo'd pool    │
│      CUSTOM TARGETS ────────► test pool against YOUR urls             │
│                                  │                                    │
│           live dashboard ◄───────┤                                    │
│                                  ▼                                    │
│       curl / scraper / browser → :8899 → rotates healthy proxies      │
└──────────────────────────────────────────────────────────────────────┘
```

## What it checks (per proxy)

| Signal | How |
|---|---|
| **Alive / dead** | full request round-trip, not a TCP ping |
| **Protocol** | real handshakes: `HTTP` (absolute-URI), `HTTPS` (CONNECT + TLS), `SOCKS5`, `SOCKS4` |
| **Anonymity** | judge echoes: **elite** (no leaks) · **anonymous** (Via/Forwarded markers, IP hidden) · **transparent** (your IP leaks through) |
| **Latency** | judge round-trip through the proxy, rolling average |
| **Download speed** | streamed throughput probe |
| **Exit IP** | what the world sees, compared against your real IP |
| **Geo / ISP** | batched lookups (ip-api), proxy-host & hosting flags |
| **Auth** | `user:pass` for both HTTP proxies and SOCKS5 |

## ⌾ Custom targets — test proxies against YOUR websites

Add any URL (plus an optional keyword that must appear in the response body)
and Yori fires every alive proxy at it through the proxy's verified protocol
(SOCKS tunneled, CONNECT+TLS, or plain HTTP). Per proxy you get:

- HTTP status code (a 403 from behind a proxy tells you a lot)
- latency to *that site*, payload size, page title / error
- keyword hit or miss
- an aggregated `x/y PASS · avg ms` line per target, chips on every table row,
  and the full response details in the row inspector

This answers the only question that matters: *"does this proxy work for the
site **I** actually need?"*

## Any input format

```
1.2.3.4:8080                       socks5://5.6.7.8:1080
http://user:pass@9.9.9.9:3128      1.1.1.1:8080:user:pass
1.1.1.2 8080 socks5                1.1.1.3, 8080, socks4
{"ip":"6.6.6.6","port":9090,"protocol":"socks5"}
```

Paste, drag & drop a file, or one-click pull from public sources
(ProxyScrape, TheSpeedX, monosans, Proxifly, GeoNode).

## The rotating gateway

Start it from the dashboard and point anything at `http://localhost:8899`:

```bash
curl -x http://localhost:8899 https://api.ipify.org
```

- **round-robin** · **random** · **sticky sessions** (`X-Session: myid` or
  proxy-auth username) · **best** (lowest latency)
- dead upstream mid-request → automatic rotation (two-strike retirement)
- responses tagged `X-Rotated-Via: ip:port`
- dashboard button **FETCH VIA ROTATION** demos it from the browser

## The dashboard

Glass panels over neon ambient, hard brutalist borders and shadows, live over
WebSocket: KPI strip + checks/min sparkline, stats ticker, sortable/filterable
table (status, protocol, anonymity, country, free-text), **click any row for
the full inspection report**, canvas world map (self-contained), targets panel,
gateway panel, engine console, exports (`txt`/`json`/`csv`, filter-aware), and
full settings (concurrency, sniffing toggles, judges, speed probe, recheck
schedules, gateway).

## Run it

```bash
npm install
npm start            # dashboard on http://localhost:3000
```

Pool + config persist in `data/`.

### Demo mode (zero internet needed)

```bash
npm run demo         # dashboard :3000 + gateway :8899, local lab pool + targets
```

Ships with a local proxy lab: mock proxies with distinct personalities
(transparent / anonymous / elite / CONNECT-capable / SOCKS5 / slow / flaky /
dead) and a local judge — the entire pipeline runs for real, just loopback.

### Self test

```bash
npm run selftest     # 22 end-to-end assertions incl. target runs + gateway rotation
```

## REST API

| Endpoint | What |
|---|---|
| `GET /api/state` | full snapshot |
| `POST /api/import/text` | `{ text }` — any format |
| `POST /api/check/start` | `{ mode: "all" \| "unchecked" \| "dead" \| "alive" }` |
| `POST /api/targets` | `{ url, keyword? }` — add a custom target |
| `POST /api/targets/run` | `{ id, mode: "alive" \| "all" }` — fire the pool at it |
| `GET /api/export?format=txt\|json\|csv…` | filtered export |
| `POST /api/gateway/start` / `stop` / `config` | control the rotator |
| `WS /ws` | live tick stream |

## Notes

- Only check proxies you're allowed to use.
- Free public proxies churn hard — that's what recheck schedules and the
  two-strike gateway rule are for.
- Node 18+. Zero native dependencies.

MIT © 2026
