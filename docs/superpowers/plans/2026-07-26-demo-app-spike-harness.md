# Demo-App Spike Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build R-033 per `docs/specs/demo-app.md`: a React demo webapp (`demo-app/`) that showcases offbook and rehearses the R-006/R-007 spikes, backed by a broker-side connect fingerprint (structured `offbook.log` lines) and a long-running `offbook demo --serve`.

**Architecture:** Three server-side additions (broker fingerprint capture + subprotocol echo; `bootDemo` + a `demo` branch in the detached serve entry; a `launchDetached` refactor shared by `up` and the new `demo --serve`) plus a self-contained browser app under `demo-app/` (React + mqtt.js bundled by `Bun.build`, served by a tiny Bun static-server/proxy so the browser stays same-origin with `/v1`).

**Tech Stack:** Bun (runtime, bundler, test), TypeScript, React 19, mqtt.js v5, Aedes (already wrapped in `src/broker/`), Hono control plane (untouched).

## Global Constraints

- **Frozen contracts untouched:** no new `/v1` endpoint, no change to `Diagnostic.kind`, `ValidationSummary`, `BrokerModule.onInbound/onSubscribe/emit/getState`, or any §1–§6 interface in `docs/specs/contracts.md`. The fingerprint travels ONLY via `offbook.log` lines (D-015).
- **Transport isolation (R-030):** only `src/broker/` may import aedes/mqtt/ws packages. `demo-app/` sits OUTSIDE `src/`, so its `mqtt` import is sanctioned (the gate walks `src/` only). Never import transport packages in `src/cli/`, `src/compose/`, etc.
- **Passwords are never captured or logged** — presence boolean only (D-015).
- **Imports (D-013):** upward reaches use `#src/*` / `#scripts/*` / (new) `#demo-app/*`; same-dir and downward stay relative with explicit `.ts`/`.tsx` extensions. The gate `test/import-style.test.ts` walks `src`, `test`, `scripts`, `bin`.
- **Formatting:** Biome, tabs + double quotes. Run `bunx biome check --write .` before every commit.
- **Gates before every commit:** `bunx biome check .` clean, `bunx tsc --noEmit` clean, full `bun test` green (per-file coverage floors: lines 0.74 / functions 0.64 — a FOCUSED `bun test <file>` may exit 1 with zero failures; only the full run is authoritative), `bun scripts/check-docs.ts` ok.
- **MQTT 3.1.1 only** (`protocolVersion: 4`); QoS 0/1/2, default 1.
- **Commits:** conventional-commit style messages. NEVER add a `Co-Authored-By` or any AI-attribution trailer.
- **mqtt.js under Bun tests** needs `{ forceNativeWebSocket: true, reconnectPeriod: 0 }` for ws connects.
- **Test ports must be unique per file.** Already taken: 19001, 19010, 19051, 19060, 19070–19073, 12901, 12910, 12951, 12960, 12970–12973, 19801, 19810, 19850, 19860–19873. This plan assigns: broker fingerprint tests ws 19100 / tcp 12990; demo-serve in-process ws 19110 / tcp 12991 / ctrl 19891; demo-serve spawned ws 19111 / tcp 12992 / ctrl 19892; proxy tests compose ws 19112 / tcp 12993 / ctrl 19893, demo-app servers 19991 / 19992 (19992 pointing at dead ctrl 19899).
- **No `Date.now()` restrictions apply here** (that constraint is for Workflow scripts, not this codebase); the engine's own seeded clock is untouched.

---

## File Structure (what exists at the end)

```
src/broker/index.ts            # MODIFIED: WsFacts capture + subprotocol echo, FingerprintEvent,
                               #   onFingerprint, preConnect capture, sub/pub dedup, fingerprintLine
src/broker/fingerprint.test.ts # NEW: tasks 1–4 tests
src/compose/index.ts           # MODIFIED: one wiring line (onFingerprint → log)
src/demo/scenarios/50-thermostat-chain.yaml  # NEW: bundled reactive scenarios
src/cli/boot.ts                # MODIFIED: + bootDemo()
src/cli/serve.ts               # MODIFIED: BootFile.demo branch
src/cli/index.ts               # MODIFIED: launchDetached refactor, cmdDemoServe, dispatch, USAGE
test/demo-serve.test.ts        # NEW: bootDemo in-process + spawned demo --serve lifecycle
demo-app/index.html            # NEW: shell + styles
demo-app/server.ts             # NEW: createDemoAppServer + parseFingerprintLines (pure, tested)
demo-app/serve.ts              # NEW: CLI entry over server.ts
demo-app/src/main.tsx          # NEW: React mount
demo-app/src/App.tsx           # NEW: orchestration (mqtt client, polling, state)
demo-app/src/mqtt.ts           # NEW: probeWs + makeClientId helpers
demo-app/src/checklist.ts      # NEW: pure R-006 checklist reducer (tested)
demo-app/src/distinct.ts       # NEW: pure distinct-violation grouping (tested)
demo-app/src/capture.ts        # NEW: pure R-007 capture-JSON builder (tested)
demo-app/src/components/{Devices,CommandBar,ViolationsFeed,ContractStrip,SpikePanel}.tsx  # NEW
test/demo-app.test.ts          # NEW: build smoke + server/proxy + pure-module tests
package.json                   # MODIFIED: react deps, #demo-app alias, scripts
tsconfig.json                  # MODIFIED: jsx + include demo-app
.gitignore                     # MODIFIED: demo-app/dist/
REQUIREMENTS.md                # MODIFIED (last task): R-033 → tested with traces
AGENTS.md                      # MODIFIED (last task): status note
```

Shared type used across tasks 2–4 and 8 (defined once in Task 2, exported from `src/broker/index.ts`):

```ts
export interface WsFacts {
	path: string;
	subprotocolsOffered: string[];
	subprotocolSelected?: string;
	origin?: string;
	userAgent?: string;
}

export interface FingerprintEvent {
	kind: "connect" | "subscribe" | "publish";
	clientId: string;
	// kind 'connect':
	protocolLevel?: number;
	username?: string;
	passwordPresent?: boolean;
	keepalive?: number;
	clean?: boolean;
	ws?: WsFacts; // absent for tcp connects
	// kind 'subscribe' | 'publish':
	topic?: string;
	qos?: 0 | 1 | 2;
	retain?: boolean;
}
```

---

### Task 1: WS subprotocol echo + upgrade-facts capture

A real browser CLOSES a WebSocket whose requested subprotocol the server does not echo; mqtt.js always requests `mqtt`. Today `src/broker/index.ts`'s `Bun.serve` upgrade passes no headers and no data. Fix both at once: carry the upgrade facts as `ws.data` and echo the first offered subprotocol on the 101.

**Files:**
- Modify: `src/broker/index.ts` (the `createWsListener` function, lines ~64–163)
- Test: `src/broker/fingerprint.test.ts` (new)

**Interfaces:**
- Consumes: existing `createBroker(config)`, `loadConfig` from `#src/config/index.ts`.
- Produces: `WsFacts` exported from `src/broker/index.ts`; `createWsListener(aedes, factsOut: WeakMap<object, WsFacts>)` (internal); the 101 response now carries `Sec-WebSocket-Protocol` when offered. Task 2 reads `factsOut`.

- [ ] **Step 1: Write the failing test**

Create `src/broker/fingerprint.test.ts`:

```ts
// R-033 — connect fingerprint + ws-fidelity listener behavior (docs/specs/demo-app.md §3).
// [itest->R-033]
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectAsync } from "mqtt";
import type { BrokerModule, FingerprintEvent } from "#src/broker/index.ts";
import { createBroker } from "#src/broker/index.ts";
import { loadConfig } from "#src/config/index.ts";

// ports unique to this file: ws 19100 / tcp 12990
const WS = 19100;
const TCP = 12990;

let broker: BrokerModule;
const events: FingerprintEvent[] = [];

beforeAll(async () => {
	broker = createBroker(
		loadConfig({ brokerWsPort: WS, brokerTcpPort: TCP, controlPlanePort: 19898 }),
	);
	broker.onFingerprint((e) => events.push(e));
	await broker.start();
});
afterAll(async () => {
	await broker.stop();
});

test("the 101 echoes the first offered subprotocol — a real browser requires this", async () => {
	const ws = new WebSocket(`ws://localhost:${WS}`, ["mqtt", "mqttv3.1"]);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`));
	});
	expect(ws.protocol).toBe("mqtt");
	ws.close();
});
```

NOTE: `onFingerprint` does not exist yet — leave the `broker.onFingerprint` line COMMENTED OUT in this step (uncomment in Task 2), and drop the `FingerprintEvent` import for now, so this task's test compiles. The subprotocol test is the deliverable here.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/broker/fingerprint.test.ts`
Expected: FAIL — `ws.protocol` is `""` (Bun does not auto-negotiate). If it unexpectedly PASSES, Bun's runtime already echoes; then skip the header change in Step 3 and implement only the `data`/facts capture.

- [ ] **Step 3: Implement in `createWsListener`**

Change the signature and the `fetch`/`open` handlers (diff against current lines 69–141):

```ts
function createWsListener(
	aedes: Aedes,
	factsOut: WeakMap<object, WsFacts>,
): WsListener {
	const duplexes = new WeakMap<ServerWebSocket<WsFacts>, Duplex>();
	let server: ReturnType<typeof Bun.serve<WsFacts>> | undefined;

	return {
		listen(port, cb) {
			server = Bun.serve<WsFacts>({
				port,
				fetch(req, srv) {
					const offeredHeader = req.headers.get("sec-websocket-protocol");
					const offered = offeredHeader
						? offeredHeader.split(",").map((s) => s.trim()).filter(Boolean)
						: [];
					// a browser DROPS the connection if its requested subprotocol
					// isn't echoed on the 101 — echo the first offer (ws-fidelity)
					const selected = offered[0];
					const data: WsFacts = {
						path: new URL(req.url).pathname,
						subprotocolsOffered: offered,
						subprotocolSelected: selected,
						origin: req.headers.get("origin") ?? undefined,
						userAgent: req.headers.get("user-agent") ?? undefined,
					};
					const upgraded = srv.upgrade(req, {
						data,
						headers: selected
							? { "sec-websocket-protocol": selected }
							: undefined,
					});
					if (upgraded) return undefined;
					return new Response("Upgrade required", { status: 426 });
				},
				websocket: {
					open(ws) {
						/* ...existing body unchanged, plus ONE line right before
						   aedes.handle(duplex): */
						// factsOut.set(duplex, ws.data);
					},
					/* message/close handlers unchanged (types now ServerWebSocket<WsFacts>) */
				},
			});
			cb();
		},
		/* close() unchanged */
	};
}
```

Add the `WsFacts` interface (from File Structure above) as an export near the top. In `createBroker`, declare `const wsFacts = new WeakMap<object, WsFacts>();` and pass it: `const wsServer = createWsListener(aedes, wsFacts);` (the map is consumed in Task 2 — unused-var is fine for one commit; if Biome objects, reference it in a comment or land Tasks 1+2 in one commit).

- [ ] **Step 4: Run tests**

Run: `bun test src/broker/fingerprint.test.ts` → the subprotocol test PASSES.
Run: `bun test` (full) → everything green: the existing broker/gate tests prove mqtt.js still connects with the echoed subprotocol.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write . && bunx tsc --noEmit
git add -A && git commit -m "feat(broker): echo ws subprotocol on upgrade + capture upgrade facts (R-033)"
```

---

### Task 2: `onFingerprint` connect events (correlated ws + CONNECT facts)

**Files:**
- Modify: `src/broker/index.ts` (`BrokerModule` interface, `createBroker`)
- Test: `src/broker/fingerprint.test.ts`

**Interfaces:**
- Consumes: `wsFacts` WeakMap from Task 1; aedes `preConnect` option; `client.conn` (the bridge Duplex for ws, the TCP socket otherwise).
- Produces: `FingerprintEvent` (exported, full shape from File Structure), `BrokerModule.onFingerprint(handler: (e: FingerprintEvent) => void): void`. Tasks 3–4 extend/consume it.

- [ ] **Step 1: Write the failing tests**

Append to `src/broker/fingerprint.test.ts` (and now uncomment the `broker.onFingerprint((e) => events.push(e));` line and the `FingerprintEvent` import from Task 1's skeleton):

```ts
test("a ws CONNECT emits a correlated connect fingerprint — password as presence only", async () => {
	const client = await connectAsync(`ws://localhost:${WS}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		protocolVersion: 4,
		clientId: "fp-ws-1",
		username: "alice",
		password: "s3cret-value",
		keepalive: 30,
		clean: true,
	});
	const connect = events.find(
		(e) => e.kind === "connect" && e.clientId === "fp-ws-1",
	);
	expect(connect).toMatchObject({
		protocolLevel: 4,
		username: "alice",
		passwordPresent: true,
		keepalive: 30,
		clean: true,
	});
	// correlation: the upgrade facts rode along
	expect(connect?.ws?.path).toBe("/");
	expect(connect?.ws?.subprotocolsOffered).toContain("mqtt");
	expect(connect?.ws?.subprotocolSelected).toBe("mqtt");
	// the redaction bar: the secret appears NOWHERE in any event
	expect(JSON.stringify(events)).not.toContain("s3cret-value");
	await client.endAsync();
});

test("a tcp CONNECT emits a fingerprint with no ws block", async () => {
	const client = await connectAsync(`mqtt://localhost:${TCP}`, {
		reconnectPeriod: 0,
		clientId: "fp-tcp-1",
	});
	const connect = events.find(
		(e) => e.kind === "connect" && e.clientId === "fp-tcp-1",
	);
	expect(connect).toBeDefined();
	expect(connect?.ws).toBeUndefined();
	expect(connect?.passwordPresent).toBe(false);
	await client.endAsync();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/broker/fingerprint.test.ts`
Expected: FAIL — `broker.onFingerprint is not a function`.

- [ ] **Step 3: Implement**

In `src/broker/index.ts`:

1. Add to `BrokerModule`:

```ts
	onFingerprint(handler: (e: FingerprintEvent) => void): void;
```

2. Export `FingerprintEvent` (full shape from File Structure).

3. In `createBroker`, BEFORE constructing aedes:

```ts
	const wsFacts = new WeakMap<object, WsFacts>();
	const fingerprints: Array<(e: FingerprintEvent) => void> = [];
	const emitFingerprint = (e: FingerprintEvent) => {
		for (const h of fingerprints) h(e);
	};
	// narrow view of the CONNECT packet — no mqtt-packet type import needed
	interface ConnectFacts {
		clientId: string;
		protocolVersion?: number;
		keepalive?: number;
		clean?: boolean;
		username?: string;
		password?: unknown;
	}
	const aedes = new Aedes({
		preConnect: (client, packet, done) => {
			const p = packet as unknown as ConnectFacts;
			const conn = (client as unknown as { conn: object }).conn;
			emitFingerprint({
				kind: "connect",
				clientId: p.clientId,
				protocolLevel: p.protocolVersion,
				username: typeof p.username === "string" ? p.username : undefined,
				passwordPresent: p.password !== undefined && p.password !== null,
				keepalive: p.keepalive,
				clean: p.clean,
				ws: wsFacts.get(conn), // undefined for tcp — that IS the signal
			});
			done(null, true); // accept-all auth (design §8) is unchanged
		},
	}) as AedesWithPersistence;
```

(The existing `new Aedes()` call is replaced; `wsFacts` moves here from Task 1's `createBroker` sketch.)

4. In the returned object: `onFingerprint: (h) => { fingerprints.push(h); },`

5. In `createWsListener`'s `open(ws)`: the Task 1 line `factsOut.set(duplex, ws.data);` must be live (placed just before `aedes.handle(duplex)` so `preConnect` — which fires on the first inbound CONNECT packet — finds the facts already registered).

- [ ] **Step 4: Run tests**

Run: `bun test src/broker/fingerprint.test.ts` → PASS. Then full `bun test` → green.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write . && bunx tsc --noEmit
git add -A && git commit -m "feat(broker): onFingerprint connect events, ws-correlated, password presence only (R-033)"
```

---

### Task 3: Deduped subscribe/publish observations

**Files:**
- Modify: `src/broker/index.ts` (the existing `aedes.on("subscribe")` and `aedes.on("publish")` handlers)
- Test: `src/broker/fingerprint.test.ts`

**Interfaces:**
- Consumes: `emitFingerprint` from Task 2.
- Produces: `FingerprintEvent` kinds `subscribe` (once per clientId·topic·qos) and `publish` (once per clientId·qos·retain class). Task 4's line formatter and Task 8's parser consume the shapes `{ kind:"subscribe", clientId, topic, qos }` and `{ kind:"publish", clientId, qos, retain }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/broker/fingerprint.test.ts`:

```ts
test("subscribe observations dedupe per clientId·topic·qos; publish per clientId·qos·retain", async () => {
	const client = await connectAsync(`ws://localhost:${WS}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		clientId: "fp-obs-1",
	});
	await client.subscribeAsync("state/#", { qos: 1 });
	await client.subscribeAsync("state/#", { qos: 1 }); // repeat — no new event
	await client.subscribeAsync("state/#", { qos: 2 }); // new qos — new event
	await client.publishAsync("command/t/set", "{}", { qos: 1 });
	await client.publishAsync("command/t/set", "{}", { qos: 1 }); // repeat class
	await client.publishAsync("command/t/set", "{}", { qos: 1, retain: true }); // new class

	const subs = events.filter(
		(e) => e.kind === "subscribe" && e.clientId === "fp-obs-1",
	);
	expect(subs.map((s) => ({ topic: s.topic, qos: s.qos }))).toEqual([
		{ topic: "state/#", qos: 1 },
		{ topic: "state/#", qos: 2 },
	]);
	const pubs = events.filter(
		(e) => e.kind === "publish" && e.clientId === "fp-obs-1",
	);
	expect(pubs.map((p) => ({ qos: p.qos, retain: p.retain }))).toEqual([
		{ qos: 1, retain: false },
		{ qos: 1, retain: true },
	]);
	await client.endAsync();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test src/broker/fingerprint.test.ts` — FAIL (no subscribe/publish events).

- [ ] **Step 3: Implement**

In `createBroker`, alongside the arrays:

```ts
	const seenSubs = new Set<string>();
	const seenPubs = new Set<string>();
```

Extend the existing `aedes.on("subscribe", ...)` handler:

```ts
	aedes.on("subscribe", (subscriptions, client) => {
		for (const s of subscriptions) {
			const clientId = client?.id ?? "";
			const key = `${clientId} ${s.topic} ${s.qos}`;
			if (!seenSubs.has(key)) {
				seenSubs.add(key);
				emitFingerprint({
					kind: "subscribe",
					clientId,
					topic: s.topic,
					qos: s.qos as 0 | 1 | 2,
				});
			}
			for (const h of subs) h({ topic: s.topic, clientId });
		}
	});
```

Extend the existing `aedes.on("publish", ...)` handler — add right after the `if (!client) return;` guard:

```ts
		const pubKey = `${client.id} ${packet.qos} ${packet.retain}`;
		if (!seenPubs.has(pubKey)) {
			seenPubs.add(pubKey);
			emitFingerprint({
				kind: "publish",
				clientId: client.id,
				qos: packet.qos,
				retain: packet.retain,
			});
		}
```

- [ ] **Step 4: Run tests**

`bun test src/broker/fingerprint.test.ts` → PASS; full `bun test` → green.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write . && bunx tsc --noEmit
git add -A && git commit -m "feat(broker): deduped subscribe/publish fingerprint observations (R-033)"
```

---

### Task 4: `fingerprintLine` formatter + compose wiring

**Files:**
- Modify: `src/broker/index.ts` (export the pure formatter), `src/compose/index.ts` (one wiring line)
- Test: `src/broker/fingerprint.test.ts`

**Interfaces:**
- Consumes: `FingerprintEvent`.
- Produces: `fingerprintLine(e: FingerprintEvent): string` — `ws-connect {json}` / `tcp-connect {json}` / `mqtt-subscribe {json}` / `mqtt-publish {json}` (single line; the JSON omits `kind`). Task 8's `parseFingerprintLines` and the D-015 capture procedure depend on exactly this format. Compose wires `broker.onFingerprint((e) => log(fingerprintLine(e)))`, so via `src/cli/serve.ts` each event lands in `offbook.log` as `[offbook] <iso> ws-connect {…}`.

- [ ] **Step 1: Write the failing test**

```ts
test("fingerprintLine renders one greppable single-line-JSON entry per event", () => {
	expect(
		fingerprintLine({
			kind: "connect",
			clientId: "a",
			protocolLevel: 4,
			passwordPresent: false,
			ws: { path: "/", subprotocolsOffered: ["mqtt"], subprotocolSelected: "mqtt" },
		}),
	).toBe(
		'ws-connect {"clientId":"a","protocolLevel":4,"passwordPresent":false,"ws":{"path":"/","subprotocolsOffered":["mqtt"],"subprotocolSelected":"mqtt"}}',
	);
	expect(
		fingerprintLine({ kind: "connect", clientId: "b", passwordPresent: false }),
	).toStartWith("tcp-connect {");
	expect(
		fingerprintLine({ kind: "subscribe", clientId: "a", topic: "state/#", qos: 1 }),
	).toBe('mqtt-subscribe {"clientId":"a","topic":"state/#","qos":1}');
	expect(
		fingerprintLine({ kind: "publish", clientId: "a", qos: 2, retain: false }),
	).toBe('mqtt-publish {"clientId":"a","qos":2,"retain":false}');
});
```

Add `fingerprintLine` to the imports from `#src/broker/index.ts`.

- [ ] **Step 2: Run to verify failure** — `bun test src/broker/fingerprint.test.ts` fails on the missing export.

- [ ] **Step 3: Implement**

In `src/broker/index.ts`:

```ts
// One structured log line per fingerprint event — the R-007 capture surface
// (D-015): `offbook logs` + demo-app's /spike/fingerprint parse exactly this.
export function fingerprintLine(e: FingerprintEvent): string {
	const { kind, ...fields } = e;
	const prefix =
		kind === "connect"
			? e.ws
				? "ws-connect"
				: "tcp-connect"
			: kind === "subscribe"
				? "mqtt-subscribe"
				: "mqtt-publish";
	return `${prefix} ${JSON.stringify(fields)}`; // undefined fields drop out
}
```

In `src/compose/index.ts`, next to the existing `broker.onSubscribe(...)` line (~line 81):

```ts
	// D-015: every connect/subscribe/publish fingerprint becomes a structured
	// log line (the R-007 capture surface) — offbook.log via serve.ts's sink
	broker.onFingerprint((event) => log(fingerprintLine(event)));
```

with `fingerprintLine` added to the `#src/broker/index.ts` import.

- [ ] **Step 4: Run tests** — file test PASS, then full `bun test` green (compose-level tests now also emit fingerprint lines through their `log` captures; none assert on log content strictly enough to break — if one does, its capture just gained lines; fix the assertion to filter, not the feature).

- [ ] **Step 5: Commit**

```bash
bunx biome check --write . && bunx tsc --noEmit
git add -A && git commit -m "feat: fingerprint log lines wired through compose (D-015, R-033)"
```

---

### Task 5: Bundled demo scenarios + `bootDemo` + serve.ts demo branch

**Files:**
- Create: `src/demo/scenarios/50-thermostat-chain.yaml`
- Modify: `src/cli/boot.ts` (add `bootDemo`), `src/cli/serve.ts` (BootFile + branch)
- Test: `test/demo-serve.test.ts` (new)

**Interfaces:**
- Consumes: `compose`, `buildRegistry`, `loadConfig`; the bundled spec `src/demo/thermostat.yaml` (channels `command/{deviceId}/set` fromClient, `state/{deviceId}` toClient qos1 retained; DeviceState requires `deviceId`,`status`,`target`,`units`).
- Produces: `bootDemo(opts: { config: Config; log?: (line: string) => void }): Promise<Composed>` exported from `src/cli/boot.ts`; `BootFile` gains `demo?: boolean` and `src/cli/serve.ts` boots `bootDemo` when set. Task 6's `cmdDemoServe` writes `{ demo: true }` boot files.

- [ ] **Step 1: Write the scenario file**

Create `src/demo/scenarios/50-thermostat-chain.yaml`. Every emit carries all four required DeviceState fields (`deviceId`,`status`,`target`,`units`) so the chain never trips its own schema:

```yaml
# Bundled with `offbook demo --serve` (docs/specs/demo-app.md §4): makes the
# dashboard visibly REACT to commands, and demos payloadMatch + templating.
- name: set-heat
  when:
    topic: command/{deviceId}/set
    payloadMatch: { mode: heat }
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: accepted
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 100-250ms
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: heating
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 400-900ms
- name: set-cool
  when:
    topic: command/{deviceId}/set
    payloadMatch: { mode: cool }
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: accepted
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 100-250ms
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: cooling
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 400-900ms
- name: set-off
  when:
    topic: command/{deviceId}/set
    payloadMatch: { mode: "off" }
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: idle
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 100-250ms
```

(`"off"` quoted — bare `off` is YAML `false`.)

- [ ] **Step 2: Write the failing in-process test**

Create `test/demo-serve.test.ts`:

```ts
// R-033 — `offbook demo --serve` + bootDemo (docs/specs/demo-app.md §4):
// bundled spec + bundled chain scenarios over the standard machinery.
// [itest->R-033]
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAsync } from "mqtt";
import { bootDemo } from "#src/cli/boot.ts";
import { run } from "#src/cli/index.ts";
import { logPath, readRunfile } from "#src/cli/runfile.ts";
import { loadConfig } from "#src/config/index.ts";
import type { StateEntry } from "#src/model/index.ts";

test("bootDemo composes the bundled spec + chain scenarios; a heat command chains to heating", async () => {
	// in-process ports: ws 19110 / tcp 12991 / ctrl 19891
	const config = loadConfig({
		brokerWsPort: 19110,
		brokerTcpPort: 12991,
		controlPlanePort: 19891,
		mode: "passive", // reactive scenarios still fire; no autonomous ticks
		wallClock: false, // virtual clock — the 100-900ms delays are instant
	});
	const composed = await bootDemo({ config });
	await composed.start();
	try {
		const scenarios = (await (
			await composed.app.request("/v1/scenarios")
		).json()) as { scenarios: { name: string }[] };
		expect(scenarios.scenarios.map((s) => s.name).sort()).toEqual([
			"set-cool",
			"set-heat",
			"set-off",
		]);
		// seedInstances gave the demo device retained initial state at boot
		const state0 = (await (
			await composed.app.request("/v1/state")
		).json()) as { state: StateEntry[] };
		expect(state0.state.some((e) => e.topic === "state/thermostat-1")).toBe(true);

		await composed.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				topic: "command/thermostat-1/set",
				payload: { mode: "heat", target: 23 },
			}),
		});
		await composed.app.request("/v1/pending?wait");
		const state = (await (
			await composed.app.request("/v1/state")
		).json()) as { state: StateEntry[] };
		const final = state.state.find((e) => e.topic === "state/thermostat-1");
		expect((final?.payload as { status: string }).status).toBe("heating");
		expect((final?.payload as { target: number }).target).toBe(23);
	} finally {
		await composed.stop();
	}
}, 30_000);
```

- [ ] **Step 3: Run to verify failure** — `bun test test/demo-serve.test.ts` fails: `bootDemo` not exported.

- [ ] **Step 4: Implement `bootDemo`**

Append to `src/cli/boot.ts`:

```ts
// `offbook demo --serve` (D-015): the bundled thermostat spec + bundled chain
// scenarios, long-running — no services.yaml, no git, no specs.lock.
export async function bootDemo(opts: {
	config: Config;
	log?: (line: string) => void;
}): Promise<Composed> {
	const demoDir = join(import.meta.dir, "../demo");
	const specText = await Bun.file(join(demoDir, "thermostat.yaml")).text();
	const registry = await buildRegistry({
		specText,
		service: "demo",
		config: opts.config,
	});
	return compose({
		config: opts.config,
		registry,
		scenariosDir: join(demoDir, "scenarios"),
		// engine.start() materializes these and republishes initial retained
		// state, so the dashboard has a device before any client subscribes
		seedInstances: { "state/{deviceId}": [{ deviceId: "thermostat-1" }] },
		log: opts.log,
	});
}
```

- [ ] **Step 5: Wire the serve entry**

In `src/cli/serve.ts`: extend `BootFile` and branch the boot:

```ts
interface BootFile {
	projectDir: string;
	config: Partial<Config>;
	environment?: string;
	watch?: boolean;
	demo?: boolean; // demo --serve: bundled spec, no project files (D-015)
}
```

```ts
	const composed =
		boot.demo === true
			? await bootDemo({ config, log })
			: await bootProject({
					projectDir: boot.projectDir,
					config,
					environment: boot.environment,
					log,
				});
```

with `bootDemo` added to the `./boot.ts` import. (`cmdDemoServe` never sets `watch`, so the handlers-watch block stays project-only by construction.)

- [ ] **Step 6: Run tests** — `bun test test/demo-serve.test.ts` → PASS; full `bun test` → green.

- [ ] **Step 7: Commit**

```bash
bunx biome check --write . && bunx tsc --noEmit
git add -A && git commit -m "feat(cli): bootDemo + bundled thermostat chain scenarios (R-033)"
```

---

### Task 6: `launchDetached` refactor + `offbook demo --serve`

**Files:**
- Modify: `src/cli/index.ts` (extract `launchDetached` from `cmdUp`; add `cmdDemoServe`; dispatch; USAGE)
- Test: `test/demo-serve.test.ts`

**Interfaces:**
- Consumes: everything `cmdUp` already uses (`resolveRunning`, `clearRunfile`, `preflightPort`, `writeRunfile`, `probeOffbook`, `pidAlive`, `logPath`, `sleep`); `BootFile.demo` from Task 5.
- Produces: `async function launchDetached(spec: { runDir: string; config: Config; boot: { projectDir: string; config: Partial<Config>; environment?: string; watch?: boolean; demo?: boolean } }, io: Io): Promise<number | null>` — pid on success, `null` after printing the refusal/failure (caller returns 1). `cmdUp` and `cmdDemoServe` both call it. CLI surface: `offbook demo --serve [--run-dir d] [--seed n] [--ws-port n] [--tcp-port n] [--ctrl-port n]`.

- [ ] **Step 1: Write the failing spawned-lifecycle test**

Append to `test/demo-serve.test.ts`:

```ts
test("demo --serve: detached boot, fingerprint line in offbook.log, down cleans up", async () => {
	// spawned ports: ws 19111 / tcp 12992 / ctrl 19892
	const dir = mkdtempSync(join(tmpdir(), "offbook-demo-serve-"));
	const runDir = join(dir, ".offbook");
	const flags = [
		"--run-dir", runDir,
		"--ws-port", "19111",
		"--tcp-port", "12992",
		"--ctrl-port", "19892",
	];
	const out: string[] = [];
	const errs: string[] = [];
	try {
		const code = await run(["demo", "--serve", ...flags], {
			out: (l) => out.push(l),
			err: (l) => errs.push(l),
		});
		if (code !== 0) throw new Error(`demo --serve failed:\n${errs.join("\n")}`);
		expect(out.join("\n")).toContain("ws://localhost:19111");

		// the bundled scenarios are live on the spawned server
		const scenarios = (await (
			await fetch("http://localhost:19892/v1/scenarios")
		).json()) as { scenarios: { name: string }[] };
		expect(scenarios.scenarios.map((s) => s.name)).toContain("set-heat");

		// a real ws client's connect lands as a ws-connect line in offbook.log
		const client = await connectAsync("ws://localhost:19111", {
			forceNativeWebSocket: true,
			reconnectPeriod: 0,
			clientId: "demo-serve-probe",
		});
		await client.endAsync();
		let logged = "";
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			logged = await Bun.file(logPath(runDir)).text().catch(() => "");
			if (logged.includes("ws-connect ")) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const line = logged
			.split("\n")
			.find((l) => l.includes("ws-connect ") && l.includes("demo-serve-probe"));
		expect(line).toBeDefined();

		expect(await run(["down", "--run-dir", runDir], { out: () => {}, err: () => {} })).toBe(0);
	} finally {
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);
```

- [ ] **Step 2: Run to verify failure** — `bun test test/demo-serve.test.ts`: the new test fails (`demo --serve` prints the one-shot demo output / unknown flags error).

- [ ] **Step 3: Extract `launchDetached`**

In `src/cli/index.ts`, move the body of `cmdUp` between the `resolveRunning` check and the readiness-probe outro into:

```ts
// shared by `up` and `demo --serve` (G14): guards, preflight, boot file,
// detached spawn with the log APPENDED, runfile, readiness probe.
// Returns the child pid, or null after printing the refusal/failure.
async function launchDetached(
	spec: {
		runDir: string;
		config: Config;
		boot: {
			projectDir: string;
			config: Partial<Config>;
			environment?: string;
			watch?: boolean;
			demo?: boolean;
		};
	},
	io: Io,
): Promise<number | null> {
	const { runDir, config } = spec;
	const existing = await resolveRunning(runDir);
	if (existing?.live) {
		io.err(
			`offbook: already running (pid ${existing.run.pid}, ports ws ${existing.run.brokerWsPort} / tcp ${existing.run.brokerTcpPort} / http ${existing.run.controlPlanePort}) — run \`offbook down\` first`,
		);
		return null;
	}
	if (existing) {
		io.out(`(reclaiming stale runfile — pid ${existing.run.pid} is gone)`);
		clearRunfile(runDir);
	}
	preflightPort(config.brokerWsPort, "brokerWsPort or --ws-port");
	preflightPort(config.brokerTcpPort, "brokerTcpPort or --tcp-port");
	preflightPort(config.controlPlanePort, "controlPlanePort or --ctrl-port");
	mkdirSync(runDir, { recursive: true });
	const bootFile = join(runDir, "offbook.boot.json");
	await Bun.write(bootFile, JSON.stringify(spec.boot, null, 2));
	const logFd = openSync(logPath(runDir), "a");
	const serveEntry = fileURLToPath(new URL("./serve.ts", import.meta.url));
	const child = spawn(process.execPath, [serveEntry, bootFile], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
	});
	closeSync(logFd);
	child.unref();
	const pid = child.pid;
	if (pid === undefined) throw new CliError("up: failed to spawn the server");
	await writeRunfile(runDir, {
		pid,
		brokerWsPort: config.brokerWsPort,
		brokerTcpPort: config.brokerTcpPort,
		controlPlanePort: config.controlPlanePort,
		startedAt: new Date().toISOString(),
	});
	const deadline = Date.now() + 30_000;
	let ready = false;
	while (Date.now() < deadline) {
		if (await probeOffbook(config.controlPlanePort, 300)) {
			ready = true;
			break;
		}
		if (!pidAlive(pid)) break;
		await sleep(100);
	}
	if (!ready) {
		clearRunfile(runDir);
		io.err(`offbook up: server failed to start — ${logPath(runDir)} ends:`);
		const tail = (
			await Bun.file(logPath(runDir))
				.text()
				.catch(() => "")
		)
			.trimEnd()
			.split("\n")
			.slice(-15);
		for (const line of tail) io.err(`  ${line}`);
		return null;
	}
	return pid;
}
```

`cmdUp` keeps: flag parsing, the `--ci`/`--watch` profile block, config assembly; then

```ts
	const pid = await launchDetached(
		{
			runDir,
			config,
			boot: {
				projectDir: process.cwd(),
				config: overrides,
				environment: str(values.env),
				watch,
			},
		},
		io,
	);
	if (pid === null) return 1;
```

followed by its existing outro + EI2 banner, unchanged. All messages are byte-identical to before, so the existing `cli-dispatch` suite must stay green untouched.

- [ ] **Step 4: Add `cmdDemoServe` + dispatch + USAGE**

```ts
async function cmdDemoServe(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		serve: { type: "boolean" },
		"run-dir": { type: "string" },
		seed: { type: "string" },
		"ws-port": { type: "string" },
		"tcp-port": { type: "string" },
		"ctrl-port": { type: "string" },
	});
	const runDir = runDirOf(values);
	// interactive profile — the demo should feel alive (wall-clock, autonomous)
	const overrides: Partial<Config> = {
		runDir,
		mode: "autonomous",
		wallClock: true,
		strict: false,
	};
	if (values.seed !== undefined)
		overrides.seed = toInt(str(values.seed) ?? "", "--seed");
	if (values["ws-port"] !== undefined)
		overrides.brokerWsPort = toInt(str(values["ws-port"]) ?? "", "--ws-port");
	if (values["tcp-port"] !== undefined)
		overrides.brokerTcpPort = toInt(str(values["tcp-port"]) ?? "", "--tcp-port");
	if (values["ctrl-port"] !== undefined)
		overrides.controlPlanePort = toInt(
			str(values["ctrl-port"]) ?? "",
			"--ctrl-port",
		);
	const config = loadConfig(overrides);
	const pid = await launchDetached(
		{ runDir, config, boot: { projectDir: process.cwd(), config: overrides, demo: true } },
		io,
	);
	if (pid === null) return 1;
	io.out(
		`offbook demo --serve — pid ${pid} · bundled thermostat spec · mode ${config.mode} · seed ${config.seed}`,
	);
	io.out(
		`  control http://localhost:${config.controlPlanePort} · logs ${logPath(runDir)}`,
	);
	io.out(
		`point your MQTT client at ws://localhost:${config.brokerWsPort} (MQTT 3.1.1) — \`offbook down\` stops it`,
	);
	return 0;
}
```

In `run()`:

```ts
		if (cmd === "demo") {
			if (rest.includes("--serve")) return await cmdDemoServe(rest, io);
			const { output } = await runDemo();
			io.out(output);
			return 0;
		}
```

USAGE line for demo becomes:

```
  demo [--serve]             bundled demo spec — one-shot catch, or --serve to keep serving
```

- [ ] **Step 5: Run tests** — `bun test test/demo-serve.test.ts` → both PASS; full `bun test` → green (cli-dispatch's up/down suite proves the refactor byte-compatible).

- [ ] **Step 6: Commit**

```bash
bunx biome check --write . && bunx tsc --noEmit
git add -A && git commit -m "feat(cli): offbook demo --serve over the shared launchDetached path (R-033, D-015)"
```

---

### Task 7: demo-app scaffolding + build smoke test

**Files:**
- Modify: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `demo-app/index.html`, `demo-app/src/main.tsx`, `demo-app/src/App.tsx` (minimal placeholder)
- Test: `test/demo-app.test.ts` (new)

**Interfaces:**
- Produces: `#demo-app/*` subpath alias; `bun run demo-app:build` → `demo-app/dist/main.js`; the build-smoke test that later UI tasks must keep green. App.tsx here is a placeholder that Task 10 REPLACES entirely.

- [ ] **Step 1: Scaffolding edits**

`package.json` — add to `imports`, `scripts`, `devDependencies`:

```json
	"imports": {
		"#src/*": "./src/*",
		"#scripts/*": "./scripts/*",
		"#demo-app/*": "./demo-app/*"
	},
	"scripts": {
		"test": "bun test",
		"lint": "biome check .",
		"mutate": "stryker run",
		"demo-app:build": "bun build demo-app/src/main.tsx --outdir demo-app/dist --target browser",
		"demo-app": "bun demo-app/serve.ts"
	},
```

devDependencies gain:

```json
		"react": "^19.1.0",
		"react-dom": "^19.1.0",
		"@types/react": "^19.1.0",
		"@types/react-dom": "^19.1.0",
```

`tsconfig.json`: add `"jsx": "react-jsx"` to compilerOptions and `"demo-app"` to `include`.

`.gitignore`: add a line `demo-app/dist/`.

Run: `bun install`.

- [ ] **Step 2: Write the failing build-smoke test**

Create `test/demo-app.test.ts`:

```ts
// R-033 — demo-app: build smoke, proxy server, pure UI logic
// (docs/specs/demo-app.md §5/§8).
// [itest->R-033]
import { expect, test } from "bun:test";

test("the webapp bundles for the browser with zero unresolved imports", async () => {
	const result = await Bun.build({
		entrypoints: ["demo-app/src/main.tsx"],
		target: "browser",
	});
	expect(result.logs.filter((l) => l.level === "error")).toEqual([]);
	expect(result.success).toBe(true);
	expect(result.outputs.length).toBeGreaterThan(0);
}, 30_000);
```

- [ ] **Step 3: Run to verify failure** — `bun test test/demo-app.test.ts` fails (no entrypoint file).

- [ ] **Step 4: Minimal webapp shell**

`demo-app/index.html`:

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>offbook demo</title>
		<style>
			:root { color-scheme: dark; }
			* { box-sizing: border-box; }
			body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: #111418; color: #e6e9ee; }
			header { padding: 12px 20px; border-bottom: 1px solid #2a2f37; display: flex; gap: 12px; align-items: baseline; }
			header h1 { font-size: 16px; margin: 0; }
			header .sub { color: #8a93a2; font-size: 12px; }
			main { display: grid; grid-template-columns: 1fr 380px; gap: 16px; padding: 16px 20px; align-items: start; }
			section { background: #171b21; border: 1px solid #2a2f37; border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; }
			section h2 { font-size: 13px; margin: 0 0 10px; color: #aab3c0; text-transform: uppercase; letter-spacing: 0.04em; }
			.banner { background: #3a1f22; border: 1px solid #6e3038; color: #f2b8bd; padding: 8px 12px; border-radius: 6px; margin: 12px 20px 0; }
			.card { border: 1px solid #2a2f37; border-radius: 6px; padding: 10px 12px; display: inline-block; margin: 0 10px 10px 0; min-width: 180px; }
			.card .status { font-size: 18px; font-weight: 600; }
			.card .meta { color: #8a93a2; font-size: 12px; }
			button { background: #2b3440; color: #e6e9ee; border: 1px solid #3a4553; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
			button.danger { background: #4a2328; border-color: #7a3740; }
			select, input[type="range"] { accent-color: #5b8def; }
			table { width: 100%; border-collapse: collapse; font-size: 12px; }
			td, th { text-align: left; padding: 3px 6px; border-bottom: 1px solid #232830; vertical-align: top; }
			.viol { color: #f2b8bd; }
			.ok { color: #9ad1a5; }
			.flag { color: #f2b8bd; font-weight: 600; }
			.mono { font-family: ui-monospace, monospace; font-size: 12px; }
			.check { list-style: none; padding: 0; margin: 0; }
			.check li { padding: 2px 0; }
		</style>
	</head>
	<body>
		<div id="root"></div>
		<script type="module" src="/main.js"></script>
	</body>
</html>
```

`demo-app/src/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
```

`demo-app/src/App.tsx` (placeholder, replaced wholesale in Task 10):

```tsx
export function App() {
	return (
		<header>
			<h1>offbook demo</h1>
			<span className="sub">loading…</span>
		</header>
	);
}
```

- [ ] **Step 5: Run tests** — `bun test test/demo-app.test.ts` → PASS. Also run `bun run demo-app:build` once and confirm `demo-app/dist/main.js` appears. Full `bun test` + `bunx tsc --noEmit` green.

CONTINGENCY: if `Bun.build` fails resolving `mqtt` for the browser later (Task 10 imports it), switch the webapp import to `import mqtt from "mqtt/dist/mqtt.min.js";` with a `// mqtt's browser UMD — Bun.build could not resolve the package browser condition` comment, and add `declare module "mqtt/dist/mqtt.min.js";` in `demo-app/src/mqtt-shim.d.ts`. Prefer plain `import mqtt from "mqtt";` first — the smoke test decides.

- [ ] **Step 6: Commit**

```bash
bunx biome check --write . && bunx tsc --noEmit
git add -A && git commit -m "feat(demo-app): scaffold React webapp shell + build smoke gate (R-033)"
```

---

### Task 8: demo-app server — static, `/v1` proxy, `/spike/fingerprint`

**Files:**
- Create: `demo-app/server.ts`, `demo-app/serve.ts`
- Test: `test/demo-app.test.ts`

**Interfaces:**
- Consumes: Task 4's line format (`[offbook] <iso> ws-connect {json}` — the prefix regex must tolerate the `[offbook]`/timestamp preamble).
- Produces (all from `demo-app/server.ts`):
  - `interface FingerprintBundle { connect?: Record<string, unknown>; subscribes: Record<string, unknown>[]; publishes: Record<string, unknown>[] }`
  - `parseFingerprintLines(logText: string, clientId: string): FingerprintBundle | undefined`
  - `createDemoAppServer(opts: { port: number; ctrlPort: number; runDir: string; root?: string }): ReturnType<typeof Bun.serve>`
  - Routes: `/` (index.html), `/main.js` (dist), `/v1/*` (proxy; 502 `{error:"offbook-unreachable"}` when down), `/spike/fingerprint?clientId=` (200 bundle | 404 `{error:"no-fingerprint"}`).
  Task 10's UI fetches `/v1/*` and `/spike/fingerprint` same-origin.

- [ ] **Step 1: Write the failing tests**

Append to `test/demo-app.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoAppServer, parseFingerprintLines } from "#demo-app/server.ts";
import { compose } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import { buildRegistry } from "#src/registry/index.ts";

const SAMPLE_LOG = [
	"[offbook] 2026-07-26T10:00:00.000Z listening — http :9080 · ws :9001 · tcp :1883 · mode autonomous · seed 42",
	'[offbook] 2026-07-26T10:00:05.000Z ws-connect {"clientId":"demo-app-x1","protocolLevel":4,"passwordPresent":false,"keepalive":60,"clean":true,"ws":{"path":"/","subprotocolsOffered":["mqtt"],"subprotocolSelected":"mqtt"}}',
	'[offbook] 2026-07-26T10:00:05.100Z mqtt-subscribe {"clientId":"demo-app-x1","topic":"state/#","qos":1}',
	'[offbook] 2026-07-26T10:00:06.000Z mqtt-publish {"clientId":"demo-app-x1","qos":1,"retain":false}',
	'[offbook] 2026-07-26T10:00:07.000Z ws-connect {"clientId":"someone-else","passwordPresent":false,"ws":{"path":"/","subprotocolsOffered":[]}}',
].join("\n");

test("parseFingerprintLines: filters by clientId, groups by kind, survives junk", () => {
	const bundle = parseFingerprintLines(SAMPLE_LOG, "demo-app-x1");
	expect(bundle?.connect?.protocolLevel).toBe(4);
	expect((bundle?.connect?.ws as { path: string }).path).toBe("/");
	expect(bundle?.subscribes).toEqual([
		{ clientId: "demo-app-x1", topic: "state/#", qos: 1 },
	]);
	expect(bundle?.publishes).toEqual([
		{ clientId: "demo-app-x1", qos: 1, retain: false },
	]);
	expect(parseFingerprintLines(SAMPLE_LOG, "nobody")).toBeUndefined();
	expect(parseFingerprintLines("garbage\nws-connect notjson{", "x")).toBeUndefined();
});

test("proxy: /v1 pass-through when offbook is up; 502 when unreachable; /spike/fingerprint 200/404", async () => {
	// compose on ws 19112 / tcp 12993 / ctrl 19893; demo-app on 19991
	const config = loadConfig({
		brokerWsPort: 19112,
		brokerTcpPort: 12993,
		controlPlanePort: 19893,
	});
	const registry = await buildRegistry({
		specText: await Bun.file("src/demo/thermostat.yaml").text(),
		service: "demo",
		config,
	});
	const composed = await compose({ config, registry });
	await composed.start();
	const dir = mkdtempSync(join(tmpdir(), "offbook-demo-app-"));
	writeFileSync(join(dir, "offbook.log"), SAMPLE_LOG);
	const server = createDemoAppServer({
		port: 19991,
		ctrlPort: 19893,
		runDir: dir,
	});
	// a second demo-app pointing at a dead control port for the 502 case
	const deadServer = createDemoAppServer({
		port: 19992,
		ctrlPort: 19899,
		runDir: dir,
	});
	try {
		const mode = (await (
			await fetch("http://localhost:19991/v1/mode")
		).json()) as { mode: string };
		expect(mode.mode).toBe("autonomous");

		const dead = await fetch("http://localhost:19992/v1/mode");
		expect(dead.status).toBe(502);
		expect(await dead.json()).toEqual({ error: "offbook-unreachable" });

		const fp = await fetch(
			"http://localhost:19991/spike/fingerprint?clientId=demo-app-x1",
		);
		expect(fp.status).toBe(200);
		const bundle = (await fp.json()) as { subscribes: unknown[] };
		expect(bundle.subscribes).toHaveLength(1);

		const none = await fetch(
			"http://localhost:19991/spike/fingerprint?clientId=nobody",
		);
		expect(none.status).toBe(404);
		expect(await none.json()).toEqual({ error: "no-fingerprint" });

		const index = await fetch("http://localhost:19991/");
		expect(index.status).toBe(200);
		expect(await index.text()).toContain('<div id="root">');
	} finally {
		server.stop(true);
		deadServer.stop(true);
		await composed.stop();
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);
```

- [ ] **Step 2: Run to verify failure** — `bun test test/demo-app.test.ts` fails resolving `#demo-app/server.ts`.

- [ ] **Step 3: Implement `demo-app/server.ts`**

```ts
// The demo-app's little server (docs/specs/demo-app.md §5): static shell,
// same-origin /v1 proxy (so the control plane needs no CORS), and the
// fingerprint read over <runDir>/offbook.log's D-015 structured lines.
import { join } from "node:path";

export interface DemoAppServerOptions {
	port: number;
	ctrlPort: number;
	runDir: string;
	root?: string; // demo-app/ itself; overridable for tests
}

export interface FingerprintBundle {
	connect?: Record<string, unknown>;
	subscribes: Record<string, unknown>[];
	publishes: Record<string, unknown>[];
}

const LINE = /(ws-connect|tcp-connect|mqtt-subscribe|mqtt-publish) (\{.*\})\s*$/;

export function parseFingerprintLines(
	logText: string,
	clientId: string,
): FingerprintBundle | undefined {
	let connect: Record<string, unknown> | undefined;
	const subscribes: Record<string, unknown>[] = [];
	const publishes: Record<string, unknown>[] = [];
	for (const line of logText.split("\n")) {
		const m = LINE.exec(line);
		if (!m) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(m[2] ?? "") as Record<string, unknown>;
		} catch {
			continue; // torn/rotated line — skip, never crash
		}
		if (parsed.clientId !== clientId) continue;
		if (m[1] === "ws-connect" || m[1] === "tcp-connect") connect = parsed; // last wins (reconnects)
		else if (m[1] === "mqtt-subscribe") subscribes.push(parsed);
		else publishes.push(parsed);
	}
	if (connect === undefined && subscribes.length === 0 && publishes.length === 0)
		return undefined;
	return { connect, subscribes, publishes };
}

export function createDemoAppServer(opts: DemoAppServerOptions) {
	const root = opts.root ?? import.meta.dir;
	return Bun.serve({
		port: opts.port,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.startsWith("/v1/")) {
				try {
					return await fetch(
						`http://localhost:${opts.ctrlPort}${url.pathname}${url.search}`,
						{ method: req.method, headers: req.headers, body: req.body },
					);
				} catch {
					return Response.json({ error: "offbook-unreachable" }, { status: 502 });
				}
			}
			if (url.pathname === "/spike/fingerprint") {
				const clientId = url.searchParams.get("clientId") ?? "";
				const text = await Bun.file(join(opts.runDir, "offbook.log"))
					.text()
					.catch(() => "");
				const bundle = parseFingerprintLines(text, clientId);
				if (bundle === undefined)
					return Response.json({ error: "no-fingerprint" }, { status: 404 });
				return Response.json(bundle);
			}
			if (url.pathname === "/")
				return new Response(Bun.file(join(root, "index.html")));
			if (url.pathname === "/main.js")
				return new Response(Bun.file(join(root, "dist/main.js")));
			return new Response("not found", { status: 404 });
		},
	});
}
```

- [ ] **Step 4: Implement `demo-app/serve.ts`** (thin CLI entry):

```ts
// `bun demo-app/serve.ts [--port 9090] [--ctrl-port 9080] [--run-dir ./.offbook]`
import { parseArgs } from "node:util";
import { createDemoAppServer } from "./server.ts";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		port: { type: "string" },
		"ctrl-port": { type: "string" },
		"run-dir": { type: "string" },
	},
});
const ctrlPort = Number(values["ctrl-port"] ?? 9080);
const server = createDemoAppServer({
	port: Number(values.port ?? 9090),
	ctrlPort,
	runDir: values["run-dir"] ?? "./.offbook",
});
console.log(
	`demo-app on http://localhost:${server.port} → offbook control :${ctrlPort} (run \`bun run demo-app:build\` after UI edits)`,
);
```

- [ ] **Step 5: Run tests** — `bun test test/demo-app.test.ts` → PASS; full `bun test` green.

- [ ] **Step 6: Commit**

```bash
bunx biome check --write . && bunx tsc --noEmit
git add -A && git commit -m "feat(demo-app): static+proxy server and fingerprint log parsing (R-033)"
```

---

### Task 9: Pure UI logic — checklist reducer, distinct grouping, capture builder

**Files:**
- Create: `demo-app/src/checklist.ts`, `demo-app/src/distinct.ts`, `demo-app/src/capture.ts`
- Test: `test/demo-app.test.ts`

**Interfaces:**
- Consumes: `FingerprintBundle` from `#demo-app/server.ts` (capture.ts imports the type — same-package downward/sibling: use `import type { FingerprintBundle } from "../server.ts";` — WAIT: that is an upward reach from `demo-app/src/`. Use `#demo-app/server.ts` instead, consistent with D-013.)
- Produces (exact exports Task 10 imports):
  - `checklist.ts`: `ChecklistId`, `ChecklistState { done: Record<ChecklistId, boolean>; grantedQos?: number; reconnects: number }`, `initialChecklist`, `checklistReduce(s, e): ChecklistState`, `CHECKLIST_LABELS: Record<ChecklistId, string>`.
  - `distinct.ts`: `ViolationLite`, `DistinctRow { key: string; count: number; latest: ViolationLite }`, `distinctRows(violations: ViolationLite[]): DistinctRow[]`.
  - `capture.ts`: `CaptureInputs`, `buildCapture(i: CaptureInputs): Record<string, unknown>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/demo-app.test.ts`:

```ts
import {
	checklistReduce,
	initialChecklist,
} from "#demo-app/src/checklist.ts";
import { distinctRows } from "#demo-app/src/distinct.ts";
import { buildCapture } from "#demo-app/src/capture.ts";

test("checklist: events check items off; reconnects count without unchecking", () => {
	let s = initialChecklist;
	s = checklistReduce(s, { type: "ws-upgrade" });
	s = checklistReduce(s, { type: "connack" });
	s = checklistReduce(s, { type: "suback", qos: 1 });
	expect(s.done["ws-upgrade"]).toBe(true);
	expect(s.done.connack).toBe(true);
	expect(s.done.suback).toBe(true);
	expect(s.grantedQos).toBe(1);
	expect(s.done.retained).toBe(false);
	s = checklistReduce(s, { type: "reconnect" });
	expect(s.reconnects).toBe(1);
	expect(s.done.connack).toBe(true); // history is not rewritten
});

test("distinctRows collapses repeats on origin·kind·channel·instancePath·keyword", () => {
	const v = (seq: number, kind: string, instancePath = "/mode") => ({
		seq,
		origin: "client",
		kind,
		topic: "command/thermostat-1/set",
		channel: "command/{deviceId}/set",
		detail: "x",
		errors: [{ instancePath, keyword: "enum", message: "must be equal" }],
	});
	const rows = distinctRows([v(1, "schema"), v(2, "schema"), v(3, "decode")]);
	expect(rows).toHaveLength(2);
	const schema = rows.find((r) => r.latest.kind === "schema");
	expect(schema?.count).toBe(2);
	expect(schema?.latest.seq).toBe(3 - 1); // latest schema seq is 2
});

test("buildCapture: server view wins, client options fill, qos/retain from observations", () => {
	const capture = buildCapture({
		clientOptions: {
			wsUrl: "ws://localhost:9001",
			clientId: "demo-app-abc",
			protocolVersion: 4,
			keepalive: 60,
			clean: true,
			username: undefined,
			passwordPresent: false,
		},
		probe: { subprotocolSelected: "mqtt" },
		fingerprint: {
			connect: {
				clientId: "demo-app-abc",
				protocolLevel: 4,
				keepalive: 60,
				clean: true,
				passwordPresent: false,
				ws: { path: "/", subprotocolsOffered: ["mqtt"], subprotocolSelected: "mqtt" },
			},
			subscribes: [{ clientId: "demo-app-abc", topic: "state/#", qos: 1 }],
			publishes: [{ clientId: "demo-app-abc", qos: 1, retain: false }],
		},
	});
	expect(capture).toMatchObject({
		source: "demo-app",
		wsUrl: "ws://localhost:9001",
		path: "/",
		subprotocol: "mqtt",
		protocolLevel: 4,
		clientIdPattern: "demo-app-*",
		auth: { username: null, passwordPresent: false },
		keepalive: 60,
		clean: true,
		qosUsed: [1],
		retainUsed: false,
	});
	expect(typeof capture.capturedAt).toBe("string");
});
```

- [ ] **Step 2: Run to verify failure** — modules missing.

- [ ] **Step 3: Implement**

`demo-app/src/checklist.ts`:

```ts
// The live R-006 checklist (docs/specs/demo-app.md §6) as a pure reducer so
// bun test can drive it without a browser.
export type ChecklistId =
	| "ws-upgrade"
	| "connack"
	| "suback"
	| "retained"
	| "puback"
	| "violation";

export const CHECKLIST_LABELS: Record<ChecklistId, string> = {
	"ws-upgrade": "WebSocket upgrade (subprotocol negotiated)",
	connack: "MQTT CONNACK received",
	suback: "SUBACK received",
	retained: "retained state received on subscribe",
	puback: "QoS-1 publish round-trip (PUBACK)",
	violation: "contract break surfaced in /v1/validation",
};

export interface ChecklistState {
	done: Record<ChecklistId, boolean>;
	grantedQos?: number;
	reconnects: number;
}

export type ChecklistEvent =
	| { type: "ws-upgrade" }
	| { type: "connack" }
	| { type: "suback"; qos: number }
	| { type: "retained" }
	| { type: "puback" }
	| { type: "violation" }
	| { type: "reconnect" };

export const initialChecklist: ChecklistState = {
	done: {
		"ws-upgrade": false,
		connack: false,
		suback: false,
		retained: false,
		puback: false,
		violation: false,
	},
	reconnects: 0,
};

export function checklistReduce(
	s: ChecklistState,
	e: ChecklistEvent,
): ChecklistState {
	if (e.type === "reconnect") return { ...s, reconnects: s.reconnects + 1 };
	if (e.type === "suback")
		return { ...s, grantedQos: e.qos, done: { ...s.done, suback: true } };
	return { ...s, done: { ...s.done, [e.type]: true } };
}
```

`demo-app/src/distinct.ts`:

```ts
// The CLI's distinct-violation collapse (design §5), client-side: key =
// origin·kind·channel·errors[0].instancePath+keyword.
export interface ViolationLite {
	seq: number;
	origin: string;
	kind: string;
	topic: string;
	channel?: string;
	detail: string;
	clientId?: string;
	errors?: { instancePath?: string; keyword?: string; message?: string }[];
}

export interface DistinctRow {
	key: string;
	count: number;
	latest: ViolationLite;
}

export function distinctRows(violations: ViolationLite[]): DistinctRow[] {
	const rows = new Map<string, DistinctRow>();
	for (const v of violations) {
		const key = `${v.origin} ${v.kind} ${v.channel ?? v.topic} ${v.errors?.[0]?.instancePath ?? ""} ${v.errors?.[0]?.keyword ?? ""}`;
		const row = rows.get(key);
		if (row) {
			row.count += 1;
			if (v.seq > row.latest.seq) row.latest = v;
		} else rows.set(key, { key, count: 1, latest: v });
	}
	return [...rows.values()].sort((a, b) => b.latest.seq - a.latest.seq);
}
```

`demo-app/src/capture.ts`:

```ts
// The R-007 capture artifact (docs/specs/demo-app.md §6): server view wins,
// client options fill the gaps. qosUsed/retainUsed = the CLIENT's own
// publish/subscribe classes, never retained-receipt.
import type { FingerprintBundle } from "#demo-app/server.ts";

export interface CaptureInputs {
	clientOptions: {
		wsUrl: string;
		clientId: string;
		protocolVersion: number;
		keepalive: number;
		clean: boolean;
		username?: string;
		passwordPresent: boolean;
	};
	probe?: { subprotocolSelected?: string };
	fingerprint?: FingerprintBundle;
}

export function buildCapture(i: CaptureInputs): Record<string, unknown> {
	const c = i.fingerprint?.connect ?? {};
	const ws = (c.ws ?? {}) as Record<string, unknown>;
	const qosUsed = [
		...new Set(
			[...(i.fingerprint?.subscribes ?? []), ...(i.fingerprint?.publishes ?? [])]
				.map((o) => o.qos)
				.filter((q): q is number => typeof q === "number"),
		),
	].sort();
	return {
		capturedAt: new Date().toISOString(),
		source: "demo-app",
		wsUrl: i.clientOptions.wsUrl,
		path: (ws.path as string | undefined) ?? "/",
		subprotocol:
			(ws.subprotocolSelected as string | undefined) ??
			i.probe?.subprotocolSelected ??
			null,
		protocolLevel:
			(c.protocolLevel as number | undefined) ?? i.clientOptions.protocolVersion,
		clientIdPattern: `${i.clientOptions.clientId.replace(/[^-]*$/, "")}*`,
		auth: {
			username:
				(c.username as string | undefined) ?? i.clientOptions.username ?? null,
			passwordPresent:
				(c.passwordPresent as boolean | undefined) ??
				i.clientOptions.passwordPresent,
		},
		keepalive: (c.keepalive as number | undefined) ?? i.clientOptions.keepalive,
		clean: (c.clean as boolean | undefined) ?? i.clientOptions.clean,
		qosUsed,
		retainUsed: (i.fingerprint?.publishes ?? []).some((p) => p.retain === true),
	};
}
```

- [ ] **Step 4: Run tests** — `bun test test/demo-app.test.ts` → PASS; full run green.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write . && bunx tsc --noEmit
git add -A && git commit -m "feat(demo-app): checklist reducer, distinct grouping, capture builder (R-033)"
```

---

### Task 10: The full webapp UI

No new bun-testable behavior (the logic was Task 9); the gates here are `bunx tsc --noEmit`, the Task 7 build-smoke test, and Task 11's browser walk. Write it all, keep components dumb (props in, callbacks out), all state in `App.tsx`.

**Files:**
- Create: `demo-app/src/mqtt.ts`, `demo-app/src/components/Devices.tsx`, `demo-app/src/components/CommandBar.tsx`, `demo-app/src/components/ViolationsFeed.tsx`, `demo-app/src/components/ContractStrip.tsx`, `demo-app/src/components/SpikePanel.tsx`
- Modify: `demo-app/src/App.tsx` (replace the placeholder wholesale)

**Interfaces:**
- Consumes: Task 9 exports; `/v1/validation`, `/v1/topics`, `/spike/fingerprint` same-origin; mqtt.js `mqtt.connect(url, opts)`.
- Produces: the shipped UI. Query params: `?ws=<port>` (default 9001) picks the broker ws port; everything HTTP is same-origin through the proxy.

- [ ] **Step 1: `demo-app/src/mqtt.ts`**

```ts
import mqtt from "mqtt";

export function makeClientId(): string {
	return `demo-app-${Math.random().toString(36).slice(2, 8)}`;
}

// A raw probe BEFORE mqtt.js connects: mqtt.js hides its socket, and the
// R-006 checklist wants the upgrade + negotiated subprotocol observed
// directly (docs/specs/demo-app.md §6). Sends no CONNECT — leaves no
// fingerprint line.
export function probeWs(
	url: string,
): Promise<{ ok: boolean; subprotocolSelected?: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (r: { ok: boolean; subprotocolSelected?: string }) => {
			if (settled) return;
			settled = true;
			try {
				ws.close();
			} catch {
				/* already closed */
			}
			resolve(r);
		};
		const ws = new WebSocket(url, ["mqtt"]);
		ws.onopen = () =>
			done({ ok: true, subprotocolSelected: ws.protocol || undefined });
		ws.onerror = () => done({ ok: false });
		setTimeout(() => done({ ok: false }), 3000);
	});
}

export interface ConnectOptions {
	wsUrl: string;
	clientId: string;
}

export function connectClient({ wsUrl, clientId }: ConnectOptions) {
	return mqtt.connect(wsUrl, {
		protocolVersion: 4, // MQTT 3.1.1 — the only level offbook speaks
		clientId,
		keepalive: 60,
		clean: true,
		reconnectPeriod: 2000, // visible in the checklist's reconnect counter
	});
}
```

- [ ] **Step 2: Components** (each file complete):

`demo-app/src/components/Devices.tsx`:

```tsx
export interface DeviceState {
	deviceId: string;
	status: string;
	target?: number;
	units?: string;
	updatedAt?: string;
	receivedAt: number;
}

export function Devices({ devices }: { devices: Map<string, DeviceState> }) {
	if (devices.size === 0)
		return (
			<section>
				<h2>Devices</h2>
				<p className="sub">waiting for retained state on state/#…</p>
			</section>
		);
	return (
		<section>
			<h2>Devices</h2>
			{[...devices.values()].map((d) => (
				<div className="card" key={d.deviceId}>
					<div className="meta">{d.deviceId}</div>
					<div className="status">{d.status}</div>
					<div className="meta">
						target {d.target ?? "—"}
						{d.units ?? ""} · {new Date(d.receivedAt).toLocaleTimeString()}
					</div>
				</div>
			))}
		</section>
	);
}
```

`demo-app/src/components/CommandBar.tsx`:

```tsx
import { useState } from "react";

export function CommandBar({
	deviceIds,
	onCommand,
	onBreakSchema,
	onWrongDirection,
}: {
	deviceIds: string[];
	onCommand(deviceId: string, mode: string, target: number): void;
	onBreakSchema(deviceId: string): void;
	onWrongDirection(deviceId: string): void;
}) {
	const [mode, setMode] = useState("heat");
	const [target, setTarget] = useState(21);
	const device = deviceIds[0] ?? "thermostat-1";
	return (
		<section>
			<h2>Command — {device}</h2>
			<label>
				mode{" "}
				<select value={mode} onChange={(e) => setMode(e.target.value)}>
					<option>heat</option>
					<option>cool</option>
					<option>off</option>
				</select>
			</label>{" "}
			<label>
				target {target}°{" "}
				<input
					type="range"
					min={5}
					max={35}
					value={target}
					onChange={(e) => setTarget(Number(e.target.value))}
				/>
			</label>{" "}
			<button type="button" onClick={() => onCommand(device, mode, target)}>
				send command
			</button>{" "}
			<button type="button" className="danger" onClick={() => onBreakSchema(device)}>
				break the schema
			</button>{" "}
			<button
				type="button"
				className="danger"
				onClick={() => onWrongDirection(device)}
			>
				wrong direction
			</button>
		</section>
	);
}
```

`demo-app/src/components/ViolationsFeed.tsx`:

```tsx
import type { DistinctRow } from "../distinct.ts";

export function ViolationsFeed({ rows }: { rows: DistinctRow[] }) {
	return (
		<section>
			<h2>Violations (distinct)</h2>
			{rows.length === 0 ? (
				<p className="ok">none — everything on contract</p>
			) : (
				<table>
					<tbody>
						{rows.map((r) => (
							<tr key={r.key} className="viol">
								<td className="mono">×{r.count}</td>
								<td className="mono">{r.latest.origin}</td>
								<td className="mono">{r.latest.kind}</td>
								<td className="mono">{r.latest.topic}</td>
								<td>{r.latest.detail}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}
```

`demo-app/src/components/ContractStrip.tsx`:

```tsx
export interface TopicRow {
	topic: string;
	direction: "toClient" | "fromClient";
	example?: unknown;
}

export function ContractStrip({ topics }: { topics: TopicRow[] }) {
	return (
		<section>
			<h2>Contract</h2>
			<table>
				<tbody>
					{topics.map((t) => (
						<tr key={t.topic}>
							<td className="mono">{t.topic}</td>
							<td>{t.direction === "toClient" ? "you receive" : "you send"}</td>
							<td className="mono">
								{t.example === undefined ? "" : JSON.stringify(t.example)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}
```

`demo-app/src/components/SpikePanel.tsx`:

```tsx
import type { FingerprintBundle } from "#demo-app/server.ts";
import type { CaptureInputs } from "../capture.ts";
import { buildCapture } from "../capture.ts";
import type { ChecklistState } from "../checklist.ts";
import { CHECKLIST_LABELS } from "../checklist.ts";

interface RowSpec {
	label: string;
	client: string;
	server: string;
}

function rows(i: CaptureInputs): RowSpec[] {
	const c = i.fingerprint?.connect ?? {};
	const ws = (c.ws ?? {}) as Record<string, unknown>;
	const s = (v: unknown) => (v === undefined ? "—" : String(v));
	return [
		{ label: "clientId", client: i.clientOptions.clientId, server: s(c.clientId) },
		{
			label: "protocol level",
			client: String(i.clientOptions.protocolVersion),
			server: s(c.protocolLevel),
		},
		{
			label: "subprotocol",
			client: i.probe?.subprotocolSelected ?? "—",
			server: s(ws.subprotocolSelected),
		},
		{ label: "ws path", client: "/", server: s(ws.path) },
		{
			label: "keepalive",
			client: String(i.clientOptions.keepalive),
			server: s(c.keepalive),
		},
		{ label: "clean", client: String(i.clientOptions.clean), server: s(c.clean) },
		{
			label: "password present",
			client: String(i.clientOptions.passwordPresent),
			server: s(c.passwordPresent),
		},
	];
}

export function SpikePanel({
	inputs,
	checklist,
}: {
	inputs: CaptureInputs;
	checklist: ChecklistState;
}) {
	const download = () => {
		const blob = new Blob([JSON.stringify(buildCapture(inputs), null, 2)], {
			type: "application/json",
		});
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = "offbook-connect-capture.json";
		a.click();
		URL.revokeObjectURL(a.href);
	};
	const fp: FingerprintBundle | undefined = inputs.fingerprint;
	return (
		<section>
			<h2>Spike panel (R-006 / R-007)</h2>
			<ul className="check">
				{(Object.keys(CHECKLIST_LABELS) as (keyof typeof CHECKLIST_LABELS)[]).map(
					(id) => (
						<li key={id} className={checklist.done[id] ? "ok" : ""}>
							{checklist.done[id] ? "✓" : "○"} {CHECKLIST_LABELS[id]}
							{id === "suback" && checklist.grantedQos !== undefined
								? ` (granted qos ${checklist.grantedQos})`
								: ""}
						</li>
					),
				)}
			</ul>
			<p className="sub">reconnects: {checklist.reconnects}</p>
			<table>
				<thead>
					<tr>
						<th />
						<th>client sent</th>
						<th>server saw</th>
					</tr>
				</thead>
				<tbody>
					{rows(inputs).map((r) => (
						<tr key={r.label}>
							<td>{r.label}</td>
							<td className="mono">{r.client}</td>
							<td
								className={
									r.server !== "—" && r.server !== r.client ? "mono flag" : "mono"
								}
							>
								{r.server}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{fp === undefined && (
				<p className="sub">no fingerprint found — is offbook logging to this run dir?</p>
			)}
			<p>
				<button type="button" onClick={download}>
					Download capture (R-007 fixture)
				</button>
			</p>
		</section>
	);
}
```

- [ ] **Step 3: `demo-app/src/App.tsx`** (full replacement):

```tsx
import { useEffect, useRef, useState } from "react";
import type { FingerprintBundle } from "#demo-app/server.ts";
import type { ChecklistState } from "./checklist.ts";
import { checklistReduce, initialChecklist } from "./checklist.ts";
import type { ViolationLite } from "./distinct.ts";
import { distinctRows } from "./distinct.ts";
import { connectClient, makeClientId, probeWs } from "./mqtt.ts";
import { CommandBar } from "./components/CommandBar.tsx";
import type { TopicRow } from "./components/ContractStrip.tsx";
import { ContractStrip } from "./components/ContractStrip.tsx";
import type { DeviceState } from "./components/Devices.tsx";
import { Devices } from "./components/Devices.tsx";
import { SpikePanel } from "./components/SpikePanel.tsx";
import { ViolationsFeed } from "./components/ViolationsFeed.tsx";

const params = new URLSearchParams(location.search);
const WS_URL = `ws://${location.hostname}:${params.get("ws") ?? "9001"}`;
const CLIENT_ID = makeClientId();

export function App() {
	const [checklist, setChecklist] = useState<ChecklistState>(initialChecklist);
	const [probe, setProbe] = useState<{ subprotocolSelected?: string }>();
	const [devices, setDevices] = useState(new Map<string, DeviceState>());
	const [violations, setViolations] = useState<ViolationLite[]>([]);
	const [topics, setTopics] = useState<TopicRow[]>([]);
	const [fingerprint, setFingerprint] = useState<FingerprintBundle>();
	const [unreachable, setUnreachable] = useState(false);
	const clientRef = useRef<ReturnType<typeof connectClient>>(null);
	const tick = (e: Parameters<typeof checklistReduce>[1]) =>
		setChecklist((s) => checklistReduce(s, e));

	// probe first (upgrade + subprotocol), then the real mqtt client
	useEffect(() => {
		let disposed = false;
		void probeWs(WS_URL).then((p) => {
			if (disposed) return;
			if (p.ok) {
				tick({ type: "ws-upgrade" });
				setProbe({ subprotocolSelected: p.subprotocolSelected });
			}
			const client = connectClient({ wsUrl: WS_URL, clientId: CLIENT_ID });
			clientRef.current = client;
			client.on("connect", () => {
				tick({ type: "connack" });
				client.subscribe("state/#", { qos: 1 }, (err, granted) => {
					if (!err && granted?.[0])
						tick({ type: "suback", qos: granted[0].qos });
				});
			});
			client.on("reconnect", () => tick({ type: "reconnect" }));
			client.on("message", (topic, payload, packet) => {
				if (packet.retain) tick({ type: "retained" });
				if (!topic.startsWith("state/")) return;
				try {
					const body = JSON.parse(payload.toString()) as Omit<
						DeviceState,
						"receivedAt"
					>;
					setDevices((prev) => {
						const next = new Map(prev);
						next.set(body.deviceId ?? topic.slice("state/".length), {
							...body,
							deviceId: body.deviceId ?? topic.slice("state/".length),
							receivedAt: Date.now(),
						});
						return next;
					});
				} catch {
					/* non-JSON state — the feed will show the decode violation */
				}
			});
		});
		return () => {
			disposed = true;
			clientRef.current?.end(true);
		};
	}, []);

	// same-origin polls through the proxy
	useEffect(() => {
		const poll = setInterval(() => {
			void fetch("/v1/validation")
				.then((r) => {
					if (r.status === 502) throw new Error("unreachable");
					return r.json() as Promise<{ violations: ViolationLite[] }>;
				})
				.then((body) => {
					setUnreachable(false);
					setViolations(body.violations);
					if (body.violations.some((v) => v.origin === "client"))
						tick({ type: "violation" });
				})
				.catch(() => setUnreachable(true));
		}, 1000);
		const fpPoll = setInterval(() => {
			void fetch(`/spike/fingerprint?clientId=${CLIENT_ID}`)
				.then((r) => (r.ok ? (r.json() as Promise<FingerprintBundle>) : undefined))
				.then((b) => b && setFingerprint(b))
				.catch(() => {});
		}, 2000);
		void fetch("/v1/topics")
			.then((r) => r.json() as Promise<{ topics: TopicRow[] }>)
			.then((body) => setTopics(body.topics))
			.catch(() => {});
		return () => {
			clearInterval(poll);
			clearInterval(fpPoll);
		};
	}, []);

	const publish = (topic: string, body: unknown) =>
		clientRef.current?.publish(topic, JSON.stringify(body), { qos: 1 }, (err) => {
			if (!err) tick({ type: "puback" });
		});

	return (
		<>
			<header>
				<h1>offbook demo</h1>
				<span className="sub">
					{WS_URL} · client {CLIENT_ID}
				</span>
			</header>
			{unreachable && (
				<div className="banner">
					offbook not reachable through the proxy — is `offbook demo --serve`
					running?
				</div>
			)}
			<main>
				<div>
					<Devices devices={devices} />
					<CommandBar
						deviceIds={[...devices.keys()]}
						onCommand={(id, mode, target) =>
							publish(`command/${id}/set`, { mode, target })
						}
						onBreakSchema={(id) =>
							publish(`command/${id}/set`, { mode: "broil", target: 22 })
						}
						onWrongDirection={(id) =>
							publish(`state/${id}`, {
								deviceId: id,
								status: "idle",
								target: 0,
								units: "C",
							})
						}
					/>
					<ViolationsFeed rows={distinctRows(violations)} />
					<ContractStrip topics={topics} />
				</div>
				<SpikePanel
					checklist={checklist}
					inputs={{
						clientOptions: {
							wsUrl: WS_URL,
							clientId: CLIENT_ID,
							protocolVersion: 4,
							keepalive: 60,
							clean: true,
							passwordPresent: false,
						},
						probe,
						fingerprint,
					}}
				/>
			</main>
		</>
	);
}
```

- [ ] **Step 4: Gates**

Run: `bunx tsc --noEmit` → clean. `bun test` (full) → green — the Task 7 build-smoke test now bundles the real app (this is where the mqtt-browser-resolution contingency from Task 7 fires if it's going to). `bun run demo-app:build` → `demo-app/dist/main.js` regenerates.

- [ ] **Step 5: Commit**

```bash
bunx biome check --write . && bunx tsc --noEmit
git add -A && git commit -m "feat(demo-app): full dashboard + spike panel UI (R-033)"
```

---

### Task 11: Manual browser walk (CHECKPOINT — needs the user)

The empirical half. An agent can start the stack and pre-verify with curl, but the real-browser checklist walk is the user's (docs/specs/demo-app.md §9).

- [ ] **Step 1: Start the stack**

```bash
bun run demo-app:build
bun bin/offbook demo --serve
bun demo-app/serve.ts
```

Expected: `demo --serve` prints the ws target; the proxy prints `demo-app on http://localhost:9090`.

- [ ] **Step 2: Pre-verify headlessly** (agent-runnable):

```bash
curl -s http://localhost:9090/v1/mode          # → {"mode":"autonomous",...}
curl -s http://localhost:9090/ | head -3        # → the index.html shell
```

- [ ] **Step 3: Hand to the user** — ask them to open `http://localhost:9090` in Chromium AND Firefox and walk §9 of the spec: checklist all-green, command → `accepted` → `heating` on the card, both break buttons produce feed rows, spike panel shows zero sent-vs-seen flags, capture downloads. Fix-forward anything they report, re-running the gates per fix.

- [ ] **Step 4: Stop the stack** (`offbook down`, Ctrl-C the proxy) and commit any fixes:

```bash
bunx biome check --write . && bunx tsc --noEmit && bun test
git add -A && git commit -m "fix(demo-app): browser-walk findings (R-033)"   # only if fixes were needed
```

---

### Task 12: Flip R-033 to `tested` + status + final gates

**Files:**
- Modify: `REQUIREMENTS.md` (R-033 entry), `AGENTS.md` (Status & next)

- [ ] **Step 1: R-033 entry** — change `**STATUS**: specified` to `tested` and add traces between COVERS and the prose:

```
**STATUS**: tested
**COVERS**: docs/specs/demo-app.md#demo-app
**IMPL**: demo-app/, src/broker/index.ts, src/compose/index.ts, src/cli/boot.ts, src/cli/serve.ts, src/cli/index.ts, src/demo/scenarios/50-thermostat-chain.yaml
**TEST**: src/broker/fingerprint.test.ts, test/demo-serve.test.ts, test/demo-app.test.ts
```

- [ ] **Step 2: AGENTS.md** — in "Status & next", replace the R-033 clause `and `R-033` (`specified`), the `demo-app/` spike-harness webapp + connect fingerprint (`docs/specs/demo-app.md`) that rehearses both spikes and makes the at-work capture a no-app-change procedure` with `plus `R-033` (`tested`): the `demo-app/` spike-harness webapp + connect fingerprint (`docs/specs/demo-app.md`), which rehearses both spikes — the at-work capture is now a no-app-change procedure (point the real client at offbook, read `offbook logs`)`. Update the count `(30 of 33 requirements)` to `(31 of 33 requirements)`.

- [ ] **Step 3: Full gates**

```bash
bunx biome check --write .
bunx tsc --noEmit
bun scripts/check-docs.ts     # must print ok — 33 requirements, 15 decisions
bun test                      # FULL run — the only authoritative coverage gate
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: demo-app spike harness complete — R-033 tested (docs/specs/demo-app.md)"
```

---

## Plan Self-Review (done at authoring time)

- **Spec coverage:** §1 architecture → Tasks 5–8; §2 webapp → 7, 9, 10; §3 fingerprint → 1–4; §4 demo --serve + scenarios → 5–6; §5 proxy → 8; §6 spike panel/capture → 9–10; §7 error handling → 8 (502/404), 10 (banner, reconnect counter, degraded panel); §8 testing → every task's test steps + Task 11 manual; §9 runbook → Task 11; §10 paper trail → Task 12. No gaps.
- **Placeholders:** none — every code step is complete; the two contingencies (Bun auto-negotiating subprotocols in Task 1, mqtt browser resolution in Task 7) are explicit forks with concrete alternatives, not TODOs.
- **Type consistency:** `FingerprintEvent`/`WsFacts` (Task 2) match `fingerprintLine` (4), `parseFingerprintLines` sample lines (8), and `buildCapture`/SpikePanel field reads (9–10). `launchDetached`'s spec shape matches `BootFile` + `demo: true` (5–6). `qosUsed`/`retainUsed` naming matches the spec's §6 (post-self-review) wording.
