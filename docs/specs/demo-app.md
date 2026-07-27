# Demo webapp & spike harness (`demo-app/`) <!-- anchor: demo-app -->

**Status**: design for `R-033` (see `REQUIREMENTS.md`); decisions folded into `D-015`. This doc is canonical for the demo webapp, the connect fingerprint, and `offbook demo --serve`. The frozen contracts are untouched: no `/v1` endpoint is added, `Diagnostic.kind` stays a closed union, and §4/§5 interfaces are byte-identical.

**Role framing (fixed during design):** the webapp is a *showcase that doubles as a harness*. It rehearses the R-006 (WS-fidelity) and R-007 (capture `connect()`) spikes with a real browser ws stack, but **neither spike closes here**: the authoritative gate remains the real browser application run against offbook (build-plan §5). What this design adds is transferability: the broker-side fingerprint means the real, unmodifiable app can be pointed at offbook at work and its `connect()` read back out of `offbook logs`.

## 1. Architecture

Four pieces:

1. **`demo-app/`** (new top-level directory, outside `src/`): a React SPA speaking `mqtt.js` over WebSockets from a real browser, bundled by `Bun.build` (no new toolchain), plus a small Bun server (`serve.ts`) that serves the static build and proxies `/v1/*` to the control plane so the browser stays same-origin (no CORS change to the control plane).
2. **Connect fingerprint in `src/broker/`**: normalized capture of what the server actually saw at connect time, surfaced as structured lines in `offbook.log` (§3).
3. **`offbook demo --serve`**: a long-running variant of the demo verb booting the bundled thermostat spec + bundled chain scenarios over the standard G14 machinery (§4).
4. **The dev loop**: `offbook demo --serve`, then `bun demo-app/serve.ts`, then open a browser. Two terminals, zero project scaffolding.

## 2. The webapp

Stack: React + `react-dom` + `mqtt.js`, bundled by `Bun.build`; no router, no state library (plain hooks + one context holding the mqtt client). Dependencies land in the root `package.json` as devDependencies (single-package repo; `mqtt` is already there for tests).

```
demo-app/
  index.html
  serve.ts             # static + /v1 proxy + /spike/* (§5)
  src/
    main.tsx  App.tsx
    mqtt.ts            # client setup, context, checklist event wiring
    components/        # Devices, CommandBar, ViolationsFeed, ContractStrip, SpikePanel
  dist/                # build output, gitignored
```

One page, three zones plus the spike panel:

- **Devices**: cards keyed by `deviceId`, fed by a `state/#` subscribe at QoS 1. Retained state paints the cards on first subscribe (itself an R-006 checklist item); live emissions update them (status, target, units, freshness from `updatedAt`).
- **Command bar**: mode selector (heat/cool/off) + target slider (5-35) publishing `command/{deviceId}/set` at QoS 1, plus two deliberately red buttons: **"Break the schema"** (sends `{ mode: "broil", target: 22 }`) and **"Wrong direction"** (publishes onto `state/{deviceId}`, a `toClient` topic).
- **Violations feed**: polls `/v1/validation?sinceSeq=` through the proxy (~1s), rendering the CLI's distinct-collapsed style (`×N` · origin · kind · topic · headline) so a break button produces a visible catch within a second. A contract strip from `/v1/topics` shows each topic with direction ("you send" / "you receive") and its field list.

The client connects with a distinctive id (`demo-app-<random>`) so its fingerprint line is unambiguous among other clients.

## 3. The connect fingerprint (`src/broker/`)

`src/broker/` is the one module allowed to touch transport (R-030); the fingerprint is captured there and crosses the module boundary as plain data.

**Capture points.** The ws upgrade handler (`Bun.serve` `fetch`) sees the upgrade request: URL path, offered `Sec-WebSocket-Protocol`, `Origin`, `User-Agent`. The Aedes handshake sees the MQTT CONNECT: clientId, protocol level, username, password presence, keepalive, clean flag. The two arrive on different events; the broker correlates them per connection (upgrade facts keyed by the bridge stream, joined when Aedes announces the client).

**Normalized record** (broker-internal type, exported from `src/broker/`):

```ts
interface FingerprintEvent {
  kind: 'connect' | 'subscribe' | 'publish';
  clientId: string;
  // kind 'connect':
  protocolLevel?: number;        // 4 = MQTT 3.1.1
  username?: string;
  passwordPresent?: boolean;     // the value is NEVER captured or logged
  keepalive?: number;
  clean?: boolean;
  ws?: { path: string; subprotocolsOffered: string[]; subprotocolSelected?: string;
         origin?: string; userAgent?: string };   // absent for tcp connects
  // kind 'subscribe' | 'publish':
  topic?: string; qos?: 0 | 1 | 2; retain?: boolean;
}
```

A new broker capability `onFingerprint(handler)` delivers these. The existing frozen `BrokerModule` surface (`onInbound`/`onSubscribe`/`emit`/`getState`) is untouched; in particular `onSubscribe`'s handler payload is NOT extended (that shape is contracts §2).

**Volume control.** `connect` fires once per connection. `subscribe` fires once per (clientId, topic, qos). `publish` observations exist only to answer R-007's "note any QoS 2 use": they are deduped by (clientId, qos, retain) class, so a client emits at most six publish lines per session, never one per message.

**Surfacing.** Compose wires `onFingerprint` to the injected log sink; the serve entry (`src/cli/serve.ts`) writes each event as one single-line-JSON log entry with a fixed greppable prefix:

```
ws-connect {"clientId":"demo-app-x1","protocolLevel":4,...,"ws":{"path":"/","subprotocolsOffered":["mqtt"],...}}
tcp-connect {"clientId":"cli-probe",...}
mqtt-subscribe {"clientId":"demo-app-x1","topic":"state/#","qos":1}
mqtt-publish {"clientId":"demo-app-x1","qos":1,"retain":false}
```

This closes the tier-4 acceptance promise (`offbook.log` "receives a line per ws connect") that was never implemented, and **the line format is the R-007 capture surface** (D-015): no HTTP-contract change is needed, which is exactly why the log was chosen over extending `Diagnostic.kind` (closed union; extending it ripples into `DiagnosticSummary.byKind`) or adding an endpoint (§5's set is closed, per the D-014 precedent).

## 4. `offbook demo --serve`

The existing one-shot `offbook demo` (boot, scripted catch, print, exit) is unchanged. `offbook demo --serve` boots the same bundled spec **long-running over the same detached G14 machinery as `up`**: runfile + `offbook.log` under `./.offbook`, readiness probe, connect-target print; `down`/`status`/`logs` all work. Foreground was rejected: its log would go to the terminal, leaving no `offbook.log` for the proxy (or the at-work procedure) to read.

Profile: interactive (autonomous, wall-clock), default ports 9001/1883/9080; the standard `--ws-port`/`--tcp-port`/`--ctrl-port`/`--run-dir`/`--seed` overrides apply. No project files are read or written (no `services.yaml`, no `specs.lock`).

**Bundled scenarios** (`src/demo/scenarios/50-thermostat-chain.yaml`, loaded only by `demo`): three `payloadMatch` variants on `command/{deviceId}/set` (mode `heat` → `accepted` then `heating`; `cool` → `accepted` then `cooling`; `off` → `idle`), each echoing `{{payload.target}}` with short ranged delays. This makes the dashboard visibly *react* to commands and incidentally demos `payloadMatch` + templating.

## 5. The proxy server (`demo-app/serve.ts`)

A single `Bun.serve`:

- Static: `dist/` + `index.html`.
- `/v1/*`: forwarded verbatim to `http://localhost:<ctrl-port>/v1/*`. A connection failure maps to `502 { error: "offbook-unreachable" }`; the UI renders one banner, not per-widget errors.
- `/spike/fingerprint?clientId=`: reads `<run-dir>/offbook.log`, scans for the prefixed JSON lines matching that clientId, and returns `{ connect, subscribes, publishes }` (or `404 { error: "no-fingerprint" }` when absent, the degraded case in §7).

Flags: `--port` (default 9090), `--ctrl-port` (default 9080), `--run-dir` (default `./.offbook`). Parsing logic lives in exported pure functions (`parseFingerprintLines`, route table) so the unit tests import them directly.

## 6. The spike panel

Two columns plus a live checklist:

- **Client side**: the exact options object handed to `mqtt.js` (url, clientId, `protocolVersion: 4`, keepalive, clean, username, password presence) and what the established socket negotiated (`ws.url`, selected subprotocol; expected `mqtt`).
- **Server side**: this clientId's fingerprint from `/spike/fingerprint`. Rows where sent and seen disagree are flagged red: that disagreement is the WS-fidelity signal the spike exists to catch.
- **R-006 checklist**, checked off live: ws upgrade → CONNACK → SUBACK (with granted QoS shown) → retained receipt → QoS-1 publish round-trip → violation surfaced via `/v1/validation`. Reconnects are counted and displayed, never hidden by auto-retry.
- **R-007 capture**: a "Download capture" button emitting the config-fixture JSON:

```json
{ "capturedAt": "…", "source": "demo-app",
  "wsUrl": "ws://localhost:9001", "path": "/", "subprotocol": "mqtt", "protocolLevel": 4,
  "clientIdPattern": "demo-app-*", "auth": { "username": null, "passwordPresent": false },
  "keepalive": 60, "clean": true, "qosUsed": [1], "retainUsed": false }
```

`qosUsed`/`retainUsed` are the **client's own** publish/subscribe QoS classes and publish retain use (from the deduped `mqtt-subscribe`/`mqtt-publish` lines), answering R-007's "note any QoS 2 use"; they say nothing about retained messages *received*. At work the same shape is filled from the real app's fingerprint lines with `"source": "real-client"`; that artifact (plus the go/no-go and any listener config) is what closes R-007/R-006.

## 7. Error handling

- **offbook not running**: the mqtt connect fails visibly in the checklist; auto-reconnect stays on (`reconnectPeriod` 2s) with the §6 attempt counter always visible, never a silent loop. `/v1` proxy calls return 502 and the UI shows the single "offbook not reachable" banner.
- **Fingerprint missing** (log rotated, pre-fingerprint offbook): the server column degrades to "no fingerprint found"; everything client-side stays functional.
- **Multiple clients**: fingerprints are matched by exact clientId; the `demo-app-` prefix keeps the webapp's line unambiguous.
- **Off-contract traffic**: needs no handling by design; the dashboard renders whatever arrives, because offbook never blocks delivery (the property being demonstrated).

## 8. Testing

Automated (in the repo `bun test` suite, arrow-tagged to R-033):

1. **Fingerprint integration test**: a real `mqtt.js` ws connect against a composed server asserts the normalized `connect`/`subscribe` events (path, subprotocols, protocol level, clientId, username, password *presence*, keepalive, clean; subscribe dedup); an `up`-level test asserts the `ws-connect ` line lands in `offbook.log`.
2. **`demo --serve` lifecycle test**: spawn, probe readiness, assert the bundled scenarios appear in `/v1/scenarios` and seeded retained state exists, `down` cleanly.
3. **Build smoke**: `Bun.build` of `demo-app/src/main.tsx` succeeds with zero unresolved imports (the webapp cannot bit-rot invisibly).
4. **Proxy unit test**: `/v1` pass-through, `parseFingerprintLines` on sample log text, and the `no-fingerprint` degradation.

Manual, by design: the real-browser walk (§9). No Playwright/headless dependency in v1; the empirical real-browser step is the point.

Gate interplay: `demo-app/` sits outside `src/`, so the transport-isolation gate (which walks `src/`) is unaffected by its `mqtt` import; its internal imports are same-directory/downward relative, satisfying D-013 regardless of the gate's glob; the coverage floor judges only files imported by tests (`serve.ts`'s logic is factored into imported pure functions; React components are exercised in-browser).

## 9. Spike runbook

**Here (rehearsal):**
1. `offbook demo --serve` (note the printed `ws://localhost:9001` target).
2. `bun demo-app/serve.ts`, open `http://localhost:9090` in a real browser (Chromium and Firefox both).
3. Walk the checklist to all-green; send a valid command and watch the chain react; press both break buttons and watch the feed catch them.
4. Confirm the spike panel shows zero sent-vs-seen discrepancies; download the capture JSON.

**At work (the authoritative runs):**
1. `offbook demo --serve` (bare-listener parity) or `offbook up` on a project with the real service specs.
2. Point the real browser application's broker URL at `ws://localhost:9001`. No app changes.
3. Exercise the app; then `offbook logs` and read the `ws-connect` / `mqtt-subscribe` / `mqtt-publish` lines.
4. Fill the §6 capture shape (`"source": "real-client"`), commit it under `fixtures/connect/`, record go/no-go + any required listener config.
5. Only then: flip R-006/R-007 per their entries. Any discrepancy (path, subprotocol, protocol level, auth, QoS 2 use) becomes the broker listener-config work R-006 was scoped to gate.

## 10. Paper trail

- **R-033** (`REQUIREMENTS.md`): this deliverable, `specified` at design time, flipped through `built`/`tested` by the implementation with the §8 traces.
- **D-015** (`DECISIONS.md`): fingerprint-as-log-line (and the rejected `Diagnostic.kind`/new-endpoint routes), `demo --serve` over the G14 machinery (and the rejected foreground form), password-presence-only redaction.
- **AGENTS.md**: doc-map line for this doc; status note.
- **contracts.md**: no change. If implementation discovers a genuine contract gap, it must come back as its own D-### (per the conflict rule), not silently through this doc.
