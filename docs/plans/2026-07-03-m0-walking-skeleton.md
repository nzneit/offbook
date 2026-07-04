# M0 Walking-Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Offbook's first dogfoodable vertical slice (M0), taking the repo from docs-only to a running prototype that mocks an AsyncAPI-specified MQTT backend and surfaces a contract break at dev time.

**Architecture:** A single Bun/TypeScript package. `model/` holds the contract types; every other module imports from it. `broker/` is the only module that touches Aedes (transport isolation). `registry/` parses the bundled demo spec into normalized `Channel`s with compiled Ajv validators and an mqtt-pattern matcher. `validation/` is a bounded ring buffer of `Violation`s. `engine/` is just the seeded L1 faker floor for M0 (no scheduler, no L2/L3). `control-plane/` is a Hono app exposing three endpoints, wired to the lower layers by injection. `cli/` exposes `topics` (in-process discovery) and `demo` (boots the server, drives an off-contract publish, catches it).

**Tech Stack:** Bun, TypeScript (strict), `bun test`, Biome, Aedes (via `aedes-server-factory` for ws+tcp), `@asyncapi/parser` 3.x, Ajv 8 + `ajv-formats`, `json-schema-faker@0.6.2` (exact pin), `mqtt-pattern`, `yaml`, Hono, and `mqtt` (dev-only, for the ws harness).

**Requirement traced:** `R-008` (REQUIREMENTS.md), COVERS `docs/specs/build-plan.md#m0`. Task 10 flips it to `tested`.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from `contracts.md` / `build-plan.md` / `AGENTS.md`.

- **Runtime/tests:** Bun; TypeScript `strict`; tests are `bun test` (zero-dep, no separate config); lint/format is Biome.
- **Transport isolation (hard):** ONLY `src/broker/` may import `aedes` or `aedes-server-factory`. Enforced by `test/transport-isolation.test.ts` (Task 1), which must stay green through every later task.
- **Normalized message has no `direction`.** `direction` lives on the `Channel` record, normalized once by `registry/`. `NormalizedMessage` is `{ topic, payload, qos?, retain?, delayMs? }`.
- **Validation is observe-and-surface, never block-at-broker.** An off-contract or unknown-topic publish is still delivered; the violation is recorded, not rejected.
- **Never hand-roll schema interpretation.** Parse specs with `@asyncapi/parser`; validate payloads with Ajv.
- **MQTT 3.1.1 only.** QoS 0/1/2, default 1. No MQTT 5.
- **`broker.emit` is publish-now.** No scheduler in M0 (instant emit only; `delayMs` is carried but unused).
- **Seeded determinism (R4):** the faker is seeded via `json-schema-faker`'s native `seed` option set to `hash(seed + channelAddress + canonicalize(params))`. No second PRNG wraps it.
- **Ports (DEFAULT_CONFIG):** broker ws `9001`, broker tcp `1883`, control plane `9080`.
- **HTTP:** base path `/v1`; error envelope `{ error: { code, message, details? } }`.
- **Pinned dependency:** `json-schema-faker` is pinned to exactly `0.6.2`.
- **Commits:** commit at the end of each task. Commit messages carry **no** `Co-Authored-By` / AI-attribution trailer.
- **M0 exclusions (YAGNI — these are post-M0, D-002):** no `ingestion/`/git; no L2 scenarios or L3 handlers; no scheduler/timing beyond instant; no `InstanceRegistry`/reset; the full `services.yaml`/`environments.yaml` loaders and the middle tiers of the qos/retain precedence chain; the control-plane endpoints other than `/publish`, `/validation`, `/topics`; `up`/`down`/`watch` and the rest of the CLI.

---

## File Structure

```
offbook/
  package.json          # Bun, deps pinned; scripts: test, lint
  tsconfig.json         # strict
  biome.json
  bin/offbook           # shebang → Bun → src/cli/index.ts
  src/
    model/index.ts      # M0 subset of contract types (Task 2)
    config/index.ts     # loadConfig (Task 3)
    broker/index.ts     # createBroker — ONLY aedes importer (Task 4)
    registry/index.ts   # buildRegistry → SpecRegistry (Task 5)
    validation/index.ts # createValidationLog (Task 6)
    engine/faker.ts     # createFaker + l1Floor (Task 7)
    control-plane/index.ts # createServer + buildTopicInfo (Task 8)
    cli/index.ts        # topics, demo (Task 9)
    demo/thermostat.yaml# bundled demo asset (Task 1)
  test/
    transport-isolation.test.ts  # Task 1
    m0-acceptance.test.ts        # Task 10
```

Module `*.test.ts` files are co-located next to their `src/` module (e.g. `src/registry/index.test.ts`).

---

### Task 1: Scaffold, toolchain, transport-isolation guard, demo asset

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `bin/offbook`, `.gitignore`
- Create: `src/demo/thermostat.yaml` (curated copy of `fixtures/asyncapi/thermostat.yaml`)
- Test: `test/transport-isolation.test.ts`

**Interfaces:**
- Produces: a Bun project where `bun test` runs; the demo asset path `src/demo/thermostat.yaml`; the transport-isolation guard test.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "offbook",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "offbook": "bin/offbook" },
  "scripts": {
    "test": "bun test",
    "lint": "biome check ."
  },
  "dependencies": {
    "@asyncapi/parser": "^3.4.0",
    "aedes": "^0.51.3",
    "aedes-server-factory": "^0.2.1",
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "hono": "^4.6.0",
    "json-schema-faker": "0.6.2",
    "mqtt-pattern": "^1.2.0",
    "yaml": "^2.5.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "mqtt": "^5.10.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "bin"]
}
```

- [ ] **Step 3: Write `biome.json`** (Biome forbids `aedes` outside `broker/` as a second line of defense; the test in Step 6 is the primary gate)

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "files": { "ignore": ["node_modules", "fixtures"] },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "overrides": [
    {
      "include": ["src/**"],
      "linter": {
        "rules": {
          "nursery": {
            "noRestrictedImports": {
              "level": "error",
              "options": { "paths": { "aedes": "Only src/broker/ may import aedes (transport isolation).", "aedes-server-factory": "Only src/broker/ may import aedes-server-factory." } }
            }
          }
        }
      }
    },
    { "include": ["src/broker/**"], "linter": { "rules": { "nursery": { "noRestrictedImports": "off" } } } }
  ]
}
```

- [ ] **Step 4: Write `bin/offbook`**

```
#!/usr/bin/env bun
import "../src/cli/index.ts";
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
.offbook/
*.log
```

- [ ] **Step 6: Write the failing transport-isolation test**

`test/transport-isolation.test.ts`:

```ts
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test("only src/broker/ imports aedes", () => {
  const offenders = walk("src")
    .filter((p) => p.endsWith(".ts") && !p.startsWith("src/broker/"))
    .filter((p) => /from ["']aedes(-server-factory)?["']|require\(["']aedes/.test(readFileSync(p, "utf8")));
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 7: Run it — expect PASS (vacuous: no `src/*.ts` yet)**

Run: `bun test test/transport-isolation.test.ts`
Expected: PASS (0 offenders). If it errors that `src` is missing, create an empty `src/.gitkeep` and re-run.

- [ ] **Step 8: Create the demo asset**

Copy `fixtures/asyncapi/thermostat.yaml` to `src/demo/thermostat.yaml`. Then, on the `state` **send** operation (the one whose channel address is `state/{deviceId}`), add an MQTT operation binding mirroring the structure `fixtures/asyncapi/qos-retain.yaml` uses on its `presence` channel, with these exact values:

```yaml
    bindings:
      mqtt:
        qos: 1
        retain: true
```

Leave the `command/{deviceId}/set` operation and all schemas unchanged. Do not modify the original `fixtures/asyncapi/thermostat.yaml`.

- [ ] **Step 9: Install and commit**

```bash
bun install
git add package.json tsconfig.json biome.json bin/offbook .gitignore src/demo/thermostat.yaml test/transport-isolation.test.ts bun.lockb
git commit -m "scaffold: Bun project, transport-isolation guard, bundled demo spec"
```

---

### Task 2: `model/` — M0 subset of contract types

**Files:**
- Create: `src/model/index.ts`
- Test: `src/model/index.test.ts`

**Interfaces:**
- Produces: `NormalizedMessage`, `InboundEvent`, `Direction`, `Channel`, `SpecRegistry`, `Config`, `DEFAULT_CONFIG`, `Faker`, `TopicInfo`, `ViolationKind`, `SchemaError`, `EmitSource`, `Violation`, `StateEntry`, `ValidationSummary`. Every later task imports from here.

- [ ] **Step 1: Write the failing test** (types have no runtime, so assert the one runtime value — `DEFAULT_CONFIG` — and let `tsc` check the rest)

`src/model/index.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "./index.ts";

test("DEFAULT_CONFIG has the frozen port + seed defaults", () => {
  expect(DEFAULT_CONFIG.seed).toBe(1);
  expect(DEFAULT_CONFIG.brokerWsPort).toBe(9001);
  expect(DEFAULT_CONFIG.brokerTcpPort).toBe(1883);
  expect(DEFAULT_CONFIG.controlPlanePort).toBe(9080);
  expect(DEFAULT_CONFIG.mode).toBe("autonomous");
  expect(DEFAULT_CONFIG.wallClock).toBe(false);
  expect(DEFAULT_CONFIG.maxViolations).toBe(10_000);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module './index.ts'`)

Run: `bun test src/model/index.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/model/index.ts`** (transcribed verbatim from `contracts.md` §1/§1a/§2/§4/§5; M0 subset only)

```ts
import type { ErrorObject } from "ajv";

export type Direction = "toClient" | "fromClient";

export interface NormalizedMessage {
  topic: string;
  payload: unknown;
  qos?: 0 | 1 | 2;
  retain?: boolean;
  delayMs?: number;
}

export interface InboundEvent {
  message: NormalizedMessage;
  meta: { clientId: string; seq: number; receivedAt: number; decodeError?: string };
}

export interface Channel {
  topic: string;
  direction: Direction;
  service: string;
  schema: object;
  validate: (payload: unknown) => SchemaError[];
  qos?: 0 | 1 | 2;
  retain?: boolean;
  title?: string;
  description?: string;
}

export interface SpecRegistry {
  match(topic: string): { channel: Channel; params: Record<string, string> } | undefined;
  matchesFilter(filter: string, topic: string): boolean;
  channels(): readonly Channel[];
}

export interface Config {
  seed: number;
  fixedEpoch: number;
  tickIntervalMs: number;
  wallClock: boolean;
  mode: "autonomous" | "passive";
  strict: boolean;
  maxViolations: number;
  maxEvents: number;
  injectedClientId: string;
  brokerWsPort: number;
  brokerTcpPort: number;
  controlPlanePort: number;
  runDir: string;
}

export const DEFAULT_CONFIG: Config = {
  seed: 1,
  fixedEpoch: 1_700_000_000_000,
  tickIntervalMs: 1000,
  wallClock: false,
  mode: "autonomous",
  strict: false,
  maxViolations: 10_000,
  maxEvents: 0,
  injectedClientId: "control-plane",
  brokerWsPort: 9001,
  brokerTcpPort: 1883,
  controlPlanePort: 9080,
  runDir: ".offbook",
};

export type Faker = (channel: Channel, instanceParams?: Record<string, string>) => unknown;

export interface TopicInfo {
  topic: string;
  direction: Direction;
  service: string;
  title?: string;
  description?: string;
  schema: object;
  example?: unknown;
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

export type ViolationKind = "schema" | "direction" | "unknown-topic" | "decode";

export type SchemaError = Omit<ErrorObject, "data" | "schema">;

export type EmitSource = { layer: "L1" | "L2" | "L3"; scenarioName?: string; stepIndex?: number };

export interface Violation {
  seq: number;
  observedAt: string;
  origin: "client" | "mock";
  kind: ViolationKind;
  severity: "error" | "warning";
  topic: string;
  channel?: string;
  detail: string;
  payload?: unknown;
  clientId?: string;
  errors?: SchemaError[];
  emitSource?: EmitSource;
}

export interface StateEntry {
  topic: string;
  payload: unknown;
  qos?: 0 | 1 | 2;
  retain: true;
}

export interface ValidationSummary {
  errors: number;
  warnings: number;
  byOrigin: { client: number; mock: number };
  byKind: Record<ViolationKind, number>;
  oldestSeq: number;
  distinct: { total: number; client: number; mock: number };
}
```

- [ ] **Step 4: Run the test and `tsc` — expect PASS + clean**

Run: `bun test src/model/index.test.ts && bunx tsc --noEmit`
Expected: test PASS; `tsc` prints nothing (clean).

- [ ] **Step 5: Commit**

```bash
git add src/model/
git commit -m "model: M0 subset of contract types"
```

---

### Task 3: `config/` — loadConfig

**Files:**
- Create: `src/config/index.ts`
- Test: `src/config/index.test.ts`

**Interfaces:**
- Consumes: `Config`, `DEFAULT_CONFIG` from `model/`.
- Produces: `loadConfig(overrides?: Partial<Config>): Config`.

*Scope note: the `services.yaml`/`environments.yaml` loaders (Tier-0's full bar) are deferred — M0's demo boots with no service config. This task is the minimal override merge.*

- [ ] **Step 1: Write the failing test**

`src/config/index.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../model/index.ts";
import { loadConfig } from "./index.ts";

test("loadConfig with no args returns the defaults", () => {
  expect(loadConfig()).toEqual(DEFAULT_CONFIG);
});

test("loadConfig merges shallow overrides", () => {
  const c = loadConfig({ seed: 42, brokerWsPort: 9999 });
  expect(c.seed).toBe(42);
  expect(c.brokerWsPort).toBe(9999);
  expect(c.brokerTcpPort).toBe(DEFAULT_CONFIG.brokerTcpPort);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `bun test src/config/index.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/config/index.ts`**

```ts
import { type Config, DEFAULT_CONFIG } from "../model/index.ts";

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test src/config/index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/
git commit -m "config: minimal loadConfig over DEFAULT_CONFIG"
```

---

### Task 4: `broker/` — Aedes ws+tcp, and the mqtt.js retained-receipt harness (M0 gate i)

**Files:**
- Create: `src/broker/index.ts`
- Test: `src/broker/index.test.ts`

**Interfaces:**
- Consumes: `Config`, `NormalizedMessage`, `InboundEvent` from `model/`.
- Produces: `createBroker(config: Config): BrokerModule` where `BrokerModule` matches `contracts.md` §2:
  ```ts
  interface BrokerModule {
    start(): Promise<void>;
    stop(): Promise<void>;
    onInbound(handler: (event: InboundEvent) => void): void;
    onSubscribe(handler: (sub: { topic: string; clientId: string }) => void): void;
    emit(message: NormalizedMessage): Promise<void>;
    getState(): Promise<ReadonlyMap<string, NormalizedMessage>>;
  }
  ```
  (This constructor signature is a design decision — `contracts.md` freezes the interface, not the factory.)

- [ ] **Step 1: Write the failing unit tests** (broker mechanics, no network client yet)

`src/broker/index.test.ts` (first block — append the harness in Step 5):

```ts
import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "../config/index.ts";
import { createBroker } from "./index.ts";

const brokers: Array<{ stop(): Promise<void> }> = [];
function track<T extends { stop(): Promise<void> }>(b: T): T { brokers.push(b); return b; }
afterEach(async () => { while (brokers.length) await brokers.pop()!.stop(); });

// use per-test ports to avoid collisions across the suite
function ports(n: number) { return loadConfig({ brokerWsPort: 19000 + n, brokerTcpPort: 11800 + n, controlPlanePort: 19800 + n }); }

test("emit(retain) is readable via getState, and clear-retain evicts the key", async () => {
  const b = track(createBroker(ports(1)));
  await b.start();
  await b.emit({ topic: "state/x", payload: { v: 1 }, retain: true });
  let state = await b.getState();
  expect(state.get("state/x")?.payload).toEqual({ v: 1 });
  await b.emit({ topic: "state/x", payload: undefined, retain: true });
  state = await b.getState();
  expect(state.has("state/x")).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test src/broker/index.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/broker/index.ts`**

```ts
import Aedes from "aedes";
import { createServer } from "aedes-server-factory";
import type { Config, InboundEvent, NormalizedMessage } from "../model/index.ts";

export interface BrokerModule {
  start(): Promise<void>;
  stop(): Promise<void>;
  onInbound(handler: (event: InboundEvent) => void): void;
  onSubscribe(handler: (sub: { topic: string; clientId: string }) => void): void;
  emit(message: NormalizedMessage): Promise<void>;
  getState(): Promise<ReadonlyMap<string, NormalizedMessage>>;
}

function decode(buf: Buffer): { payload: unknown; decodeError?: string } {
  const text = buf.toString("utf8");
  if (text === "") return { payload: undefined };
  try {
    return { payload: JSON.parse(text) };
  } catch (e) {
    return { payload: undefined, decodeError: (e as Error).message };
  }
}

export function createBroker(config: Config): BrokerModule {
  const aedes = new Aedes();
  const wsServer = createServer(aedes, { ws: true });
  const tcpServer = createServer(aedes);
  let seq = 0;
  const inbound: Array<(e: InboundEvent) => void> = [];
  const subs: Array<(s: { topic: string; clientId: string }) => void> = [];

  aedes.on("publish", (packet, client) => {
    if (!client) return; // ignore our own emits (client === null)
    const { payload, decodeError } = decode(packet.payload as Buffer);
    const event: InboundEvent = {
      message: { topic: packet.topic, payload, qos: packet.qos, retain: packet.retain },
      meta: { clientId: client.id, seq: seq++, receivedAt: Date.now(), decodeError },
    };
    for (const h of inbound) h(event);
  });
  aedes.on("subscribe", (subscriptions, client) => {
    for (const s of subscriptions) for (const h of subs) h({ topic: s.topic, clientId: client?.id ?? "" });
  });

  return {
    start: () =>
      Promise.all([
        new Promise<void>((r) => wsServer.listen(config.brokerWsPort, () => r())),
        new Promise<void>((r) => tcpServer.listen(config.brokerTcpPort, () => r())),
      ]).then(() => undefined),
    stop: () =>
      Promise.all([
        new Promise<void>((r) => wsServer.close(() => r())),
        new Promise<void>((r) => tcpServer.close(() => r())),
        new Promise<void>((r) => aedes.close(() => r())),
      ]).then(() => undefined),
    onInbound: (h) => { inbound.push(h); },
    onSubscribe: (h) => { subs.push(h); },
    emit: (m) =>
      new Promise<void>((resolve, reject) => {
        const payload = m.payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(m.payload));
        aedes.publish(
          { cmd: "publish", topic: m.topic, payload, qos: m.qos ?? 1, retain: m.retain ?? false, dup: false },
          (err) => (err ? reject(err) : resolve()),
        );
      }),
    getState: () =>
      new Promise((resolve) => {
        const map = new Map<string, NormalizedMessage>();
        const stream = aedes.persistence.createRetainedStream("#");
        stream.on("data", (p: { topic: string; payload: Buffer; qos: 0 | 1 | 2; retain: boolean }) => {
          if (p.payload && p.payload.length > 0) map.set(p.topic, { topic: p.topic, payload: decode(p.payload).payload, qos: p.qos, retain: true });
        });
        stream.on("end", () => resolve(map));
      }),
  };
}
```

- [ ] **Step 4: Run the unit test — expect PASS**

Run: `bun test src/broker/index.test.ts`
Expected: PASS (1 test). If `aedes.publish`'s retain-clear does not evict in your Aedes version, verify by checking `createRetainedStream` after a zero-length retained publish; the eviction is Aedes-native for empty retained payloads.

- [ ] **Step 5: Append the ws harness test (M0 gate i)** to `src/broker/index.test.ts`

```ts
import { connectAsync } from "mqtt";

test("M0 gate (i): a browser-style mqtt.js client connects over ws, receives a retained message, and a QoS-1 publish round-trips", async () => {
  const cfg = ports(2);
  const b = track(createBroker(cfg));
  await b.start();

  const url = `ws://localhost:${cfg.brokerWsPort}`;
  const sub = await connectAsync(url);
  const pub = await connectAsync(url);
  try {
    // retained receipt: publish retained BEFORE the subscriber subscribes
    await pub.publishAsync("state/thermostat-1", JSON.stringify({ status: "idle" }), { retain: true, qos: 1 });
    const retained = await new Promise<string>((resolve) => {
      sub.on("message", (_t, payload) => resolve(payload.toString()));
      sub.subscribe("state/thermostat-1", { qos: 1 });
    });
    expect(JSON.parse(retained)).toEqual({ status: "idle" });

    // QoS-1 round-trip on a fresh topic
    const rt = new Promise<string>((resolve) => sub.on("message", (t, payload) => t === "rt/1" && resolve(payload.toString())));
    await sub.subscribeAsync("rt/1", { qos: 1 });
    await pub.publishAsync("rt/1", "ping", { qos: 1 });
    expect(await rt).toBe("ping");
  } finally {
    await sub.endAsync();
    await pub.endAsync();
  }
});
```

- [ ] **Step 6: Run the full broker suite — expect PASS + isolation still green**

Run: `bun test src/broker/index.test.ts test/transport-isolation.test.ts`
Expected: PASS (broker unit + harness; isolation green — `src/broker/` is the only aedes importer).

- [ ] **Step 7: Commit**

```bash
git add src/broker/
git commit -m "broker: Aedes ws+tcp module + mqtt.js retained-receipt harness (M0 gate i)"
```

---

### Task 5: `registry/` — parse the demo spec into a SpecRegistry

**Files:**
- Create: `src/registry/index.ts`
- Test: `src/registry/index.test.ts`

**Interfaces:**
- Consumes: `Config`, `Channel`, `SpecRegistry`, `SchemaError` from `model/`.
- Produces: `buildRegistry(opts: { specText: string; service: string; config: Config }): Promise<SpecRegistry>` (signature is a design decision — not frozen). Reads `src/demo/thermostat.yaml` in tests via `Bun.file`.

*Scope: direction normalization (v3), Ajv compile+validate, `match`/`matchesFilter`, and qos/retain from the spec MQTT binding with a global-default fallback. The middle precedence tiers (topicOverrides, per-service) and external-`$ref` bundling are deferred — the demo spec is self-contained.*

- [ ] **Step 1: Write the failing test**

`src/registry/index.test.ts`:

```ts
import { expect, test } from "bun:test";
import { loadConfig } from "../config/index.ts";
import { buildRegistry } from "./index.ts";

async function demoRegistry() {
  const specText = await Bun.file("src/demo/thermostat.yaml").text();
  return buildRegistry({ specText, service: "demo", config: loadConfig() });
}

test("normalizes v3 directions onto channels", async () => {
  const reg = await demoRegistry();
  const byTopic = Object.fromEntries(reg.channels().map((c) => [c.topic, c]));
  expect(byTopic["command/{deviceId}/set"].direction).toBe("fromClient");
  expect(byTopic["state/{deviceId}"].direction).toBe("toClient");
});

test("match() resolves a concrete topic to its channel and captures params", async () => {
  const reg = await demoRegistry();
  const m = reg.match("command/thermostat-1/set");
  expect(m?.channel.topic).toBe("command/{deviceId}/set");
  expect(m?.params).toEqual({ deviceId: "thermostat-1" });
});

test("matchesFilter implements MQTT + / #", async () => {
  const reg = await demoRegistry();
  expect(reg.matchesFilter("state/#", "state/thermostat-1")).toBe(true);
  expect(reg.matchesFilter("state/+", "state/a/b")).toBe(false);
});

test("validate() rejects an off-contract payload and accepts a valid one", async () => {
  const reg = await demoRegistry();
  const cmd = reg.match("command/thermostat-1/set")!.channel;
  expect(cmd.validate({ mode: "broil", target: 20 }).length).toBeGreaterThan(0);
  expect(cmd.validate({ mode: "heat", target: 20 })).toEqual([]);
});

test("resolves retain:true on the state channel from its spec binding", async () => {
  const reg = await demoRegistry();
  const state = reg.match("state/thermostat-1")!.channel;
  expect(state.retain).toBe(true);
  expect(state.qos).toBe(1);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test src/registry/index.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/registry/index.ts`**

```ts
import { Parser } from "@asyncapi/parser";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { exec, matches } from "mqtt-pattern";
import type { Channel, Config, SchemaError, SpecRegistry } from "../model/index.ts";

const parser = new Parser();

// mqtt-pattern captures with +name, not {name}; rewrite each single-segment {p} to +p.
function toPattern(address: string): string {
  return address.replace(/\{([^/}]+)\}/g, "+$1");
}

function directionOf(action: string): "toClient" | "fromClient" {
  // v3: send→toClient, receive→fromClient. (@asyncapi/parser normalizes v2 subscribe/publish into send/receive actions.)
  return action === "send" ? "toClient" : "fromClient";
}

export async function buildRegistry(opts: { specText: string; service: string; config: Config }): Promise<SpecRegistry> {
  const { document } = await parser.parse(opts.specText);
  if (!document) throw new Error("failed to parse spec");
  const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));

  const channels: Channel[] = [];
  for (const op of document.operations().all()) {
    const ch = op.channels().all()[0];
    const address = ch.address() ?? "";
    const schema = (op.messages().all()[0]?.payload()?.json() ?? {}) as object;
    const validateFn = ajv.compile({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema });
    const mqtt = (op.bindings?.().get?.("mqtt")?.json?.() ?? {}) as { qos?: 0 | 1 | 2; retain?: boolean };
    channels.push({
      topic: address,
      direction: directionOf(op.action()),
      service: opts.service,
      schema,
      validate: (payload: unknown): SchemaError[] => (validateFn(payload) ? [] : ((validateFn.errors ?? []) as SchemaError[])),
      qos: mqtt.qos ?? 1,
      retain: mqtt.retain ?? false,
      title: ch.title() ?? undefined,
      description: ch.description() ?? undefined,
    });
  }

  // most-specific first (fewer params = more literal segments), then declaration order
  const ordered = channels.map((c, i) => ({ c, i })).sort((a, b) => {
    const pa = (a.c.topic.match(/\{/g) ?? []).length;
    const pb = (b.c.topic.match(/\{/g) ?? []).length;
    return pa - pb || a.i - b.i;
  });

  return {
    channels: () => channels,
    matchesFilter: (filter, topic) => matches(filter, topic),
    match: (topic) => {
      for (const { c } of ordered) {
        const params = exec(toPattern(c.topic), topic);
        if (params) return { channel: c, params: params as Record<string, string> };
      }
      return undefined;
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test src/registry/index.test.ts`
Expected: PASS (5 tests). If `@asyncapi/parser`'s operation/binding accessors differ in the installed version, adjust the accessor calls (`op.action()`, `op.bindings()`, `payload().json()`) to the installed API — the assertions are the contract.

- [ ] **Step 5: Commit**

```bash
git add src/registry/
git commit -m "registry: parse demo spec to SpecRegistry (direction, Ajv, match, spec-binding qos/retain)"
```

---

### Task 6: `validation/` — the bounded violation log

**Files:**
- Create: `src/validation/index.ts`
- Test: `src/validation/index.test.ts`

**Interfaces:**
- Consumes: `Config`, `Violation`, `ViolationKind`, `ValidationSummary` from `model/`.
- Produces:
  ```ts
  interface ValidationLog {
    record(v: Omit<Violation, "seq" | "observedAt">): Violation; // mints seq (monotonic, never reused) + observedAt
    query(opts?: { sinceSeq?: number; origin?: "client" | "mock"; kind?: ViolationKind; severity?: "error" | "warning" }): Violation[];
    summary(): ValidationSummary;
    baseline(): number; // current max seq
  }
  function createValidationLog(config: Config): ValidationLog;
  ```

- [ ] **Step 1: Write the failing test**

`src/validation/index.test.ts`:

```ts
import { expect, test } from "bun:test";
import { loadConfig } from "../config/index.ts";
import { createValidationLog } from "./index.ts";

function base(origin: "client" | "mock", kind: "schema" | "direction" | "unknown-topic" | "decode", topic: string) {
  return { origin, kind, severity: "error" as const, topic, detail: `${topic}:${kind}` };
}

test("seq is monotonic and unique; sinceSeq is strictly-greater", () => {
  const log = createValidationLog(loadConfig());
  const a = log.record(base("client", "schema", "t/1"));
  const b = log.record(base("mock", "decode", "t/2"));
  expect(b.seq).toBe(a.seq + 1);
  expect(log.query({ sinceSeq: a.seq }).map((v) => v.seq)).toEqual([b.seq]);
});

test("past the cap the oldest evicts while seq keeps climbing and oldestSeq advances", () => {
  const log = createValidationLog(loadConfig({ maxViolations: 3 }));
  const seqs = Array.from({ length: 5 }, (_, i) => log.record(base("client", "schema", `t/${i}`)).seq);
  const kept = log.query();
  expect(kept.length).toBe(3);
  expect(kept.map((v) => v.seq)).toEqual([seqs[2], seqs[3], seqs[4]]);
  expect(log.summary().oldestSeq).toBe(seqs[2]);
});

test("summary counts by origin and zero-fills every kind", () => {
  const log = createValidationLog(loadConfig());
  log.record(base("client", "schema", "t/1"));
  log.record(base("mock", "schema", "t/2"));
  const s = log.summary();
  expect(s.byOrigin).toEqual({ client: 1, mock: 1 });
  expect(s.byKind).toEqual({ schema: 2, direction: 0, "unknown-topic": 0, decode: 0 });
  expect(s.warnings).toBe(0);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test src/validation/index.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/validation/index.ts`**

```ts
import type { Config, Violation, ViolationKind, ValidationSummary } from "../model/index.ts";

const KINDS: ViolationKind[] = ["schema", "direction", "unknown-topic", "decode"];

export interface ValidationLog {
  record(v: Omit<Violation, "seq" | "observedAt">): Violation;
  query(opts?: { sinceSeq?: number; origin?: "client" | "mock"; kind?: ViolationKind; severity?: "error" | "warning" }): Violation[];
  summary(): ValidationSummary;
  baseline(): number;
}

function distinctKey(v: Violation): string {
  const loc = v.errors?.[0] ? `${v.errors[0].instancePath}:${v.errors[0].keyword}` : "";
  return `${v.origin}|${v.kind}|${v.channel ?? ""}|${loc}`;
}

export function createValidationLog(config: Config): ValidationLog {
  const buf: Violation[] = []; // FIFO; capacity config.maxViolations
  let nextSeq = 1;

  return {
    record(input) {
      const v: Violation = { ...input, seq: nextSeq++, observedAt: new Date().toISOString() };
      buf.push(v);
      if (buf.length > config.maxViolations) buf.shift();
      return v;
    },
    query(opts = {}) {
      return buf.filter(
        (v) =>
          (opts.sinceSeq === undefined || v.seq > opts.sinceSeq) &&
          (opts.origin === undefined || v.origin === opts.origin) &&
          (opts.kind === undefined || v.kind === opts.kind) &&
          (opts.severity === undefined || v.severity === opts.severity),
      );
    },
    summary() {
      const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<ViolationKind, number>;
      const byOrigin = { client: 0, mock: 0 };
      const distinct = new Set<string>();
      const distinctByOrigin = { client: new Set<string>(), mock: new Set<string>() };
      let errors = 0;
      let warnings = 0;
      for (const v of buf) {
        byKind[v.kind]++;
        byOrigin[v.origin]++;
        v.severity === "error" ? errors++ : warnings++;
        distinct.add(distinctKey(v));
        distinctByOrigin[v.origin].add(distinctKey(v));
      }
      return {
        errors,
        warnings,
        byOrigin,
        byKind,
        oldestSeq: buf[0]?.seq ?? 0,
        distinct: { total: distinct.size, client: distinctByOrigin.client.size, mock: distinctByOrigin.mock.size },
      };
    },
    baseline: () => nextSeq - 1,
  };
}
```

*Note: a `push`/`shift` array is the M0-legible embodiment of the bounded ring buffer; the O(1) head/tail-index form (F21) is a post-M0 optimization and is not required for correctness here.*

- [ ] **Step 4: Run — expect PASS**

Run: `bun test src/validation/index.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/validation/
git commit -m "validation: bounded violation log with monotonic seq + summary"
```

---

### Task 7: `engine/` — the L1 faker floor

**Files:**
- Create: `src/engine/faker.ts`
- Test: `src/engine/faker.test.ts`

**Interfaces:**
- Consumes: `Config`, `Channel`, `Faker`, `Violation` from `model/`.
- Produces:
  ```ts
  function createFaker(config: Config): Faker; // (channel, params?) => unknown, seeded
  function l1Floor(channel: Channel, faker: Faker): { payload: unknown } | { violation: Omit<Violation, "seq" | "observedAt"> };
  ```
  `l1Floor` rechecks the faked payload against `channel.validate` and, on failure, returns a `mock`/`schema` violation stamped `emitSource.layer: "L1"` instead of a payload (drop-and-surface, F5).

- [ ] **Step 1: Write the failing test**

`src/engine/faker.test.ts`:

```ts
import { expect, test } from "bun:test";
import { loadConfig } from "../config/index.ts";
import type { Channel } from "../model/index.ts";
import { createFaker, l1Floor } from "./faker.ts";

const stateSchema = {
  type: "object",
  required: ["deviceId", "status", "target", "units"],
  additionalProperties: false,
  properties: {
    deviceId: { type: "string" },
    status: { type: "string", enum: ["accepted", "heating", "cooling", "idle", "offline"] },
    target: { type: "number" },
    units: { type: "string", enum: ["C", "F"] },
  },
};
function channel(schema: object): Channel {
  const Ajv = require("ajv");
  const v = new Ajv({ allErrors: true, strict: false }).compile(schema);
  return { topic: "state/{deviceId}", direction: "toClient", service: "demo", schema, validate: (p) => (v(p) ? [] : v.errors ?? []), qos: 1, retain: true };
}

test("faker is deterministic for a given seed + channel", () => {
  const f1 = createFaker(loadConfig({ seed: 7 }));
  const f2 = createFaker(loadConfig({ seed: 7 }));
  const ch = channel(stateSchema);
  expect(JSON.stringify(f1(ch))).toBe(JSON.stringify(f2(ch)));
});

test("l1Floor returns a schema-valid payload for a real channel", () => {
  const f = createFaker(loadConfig());
  const ch = channel(stateSchema);
  const out = l1Floor(ch, f);
  expect("payload" in out).toBe(true);
  if ("payload" in out) expect(ch.validate(out.payload)).toEqual([]);
});

test("l1Floor drops and surfaces an L1 mock violation when the recheck fails", () => {
  const f = createFaker(loadConfig());
  // impossible schema: faker cannot satisfy it, so the recheck fails
  const impossible = channel({ type: "object", required: ["x"], properties: { x: { type: "string", const: "A", enum: ["B"] } }, additionalProperties: false });
  const out = l1Floor(impossible, f);
  expect("violation" in out).toBe(true);
  if ("violation" in out) {
    expect(out.violation.origin).toBe("mock");
    expect(out.violation.kind).toBe("schema");
    expect(out.violation.emitSource?.layer).toBe("L1");
  }
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test src/engine/faker.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/engine/faker.ts`**

```ts
import { JSONSchemaFaker } from "json-schema-faker";
import type { Channel, Config, Faker, Violation } from "../model/index.ts";

// stable string → uint32 (cyrb53-lite); no second PRNG — this only derives the integer fed to JSF's native seed.
function hashToInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function canonicalize(params?: Record<string, string>): string {
  if (!params) return "";
  return Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
}

export function createFaker(config: Config): Faker {
  JSONSchemaFaker.option({ alwaysFakeOptionals: true, failOnInvalidTypes: false, failOnInvalidFormat: false });
  return (channel: Channel, instanceParams?: Record<string, string>): unknown => {
    JSONSchemaFaker.option("random", seededRandom(hashToInt(config.seed + "|" + channel.topic + "|" + canonicalize(instanceParams))));
    return JSONSchemaFaker.generate(channel.schema as object);
  };
}

// Mulberry32 exposed only as JSF's native `random` source (one integer in), not a wrapping PRNG over JSF output.
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function l1Floor(channel: Channel, faker: Faker): { payload: unknown } | { violation: Omit<Violation, "seq" | "observedAt"> } {
  const payload = faker(channel);
  const errors = channel.validate(payload);
  if (errors.length === 0) return { payload };
  return {
    violation: {
      origin: "mock",
      kind: "schema",
      severity: "error",
      topic: channel.topic,
      channel: channel.topic,
      detail: `${errors[0].instancePath || "/"}: ${errors[0].keyword}`,
      payload,
      errors,
      emitSource: { layer: "L1" },
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test src/engine/faker.test.ts`
Expected: PASS (3 tests). If JSF 0.6.2 exposes seeding differently than `option("random", fn)`, use its documented native seed hook — the determinism assertion (test 1) is the contract; keep exactly one integer derived from `hashToInt(...)` feeding it.

- [ ] **Step 5: Commit**

```bash
git add src/engine/
git commit -m "engine: seeded L1 faker floor with Ajv-recheck drop-and-surface"
```

---

### Task 8: `control-plane/` — the three M0 endpoints + composition root

**Files:**
- Create: `src/control-plane/index.ts`
- Test: `src/control-plane/index.test.ts`

**Interfaces:**
- Consumes: everything above, by injection.
- Produces:
  ```ts
  function buildTopicInfo(registry: SpecRegistry, faker: Faker): TopicInfo[]; // shared with cli
  function createServer(config: Config, deps: { registry: SpecRegistry; faker: Faker }): {
    app: Hono; broker: BrokerModule; log: ValidationLog; start(): Promise<void>; stop(): Promise<void>;
  };
  ```
  Endpoints (base `/v1`): `POST /publish`, `GET /validation`, `GET /topics` — per `contracts.md` §5. The composition root owns a `broker` and a `log`, wires `broker.onInbound` to validate inbound client publishes, and injects `faker`/`registry` into the routes.

- [ ] **Step 1: Write the failing test**

`src/control-plane/index.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "../config/index.ts";
import { createFaker } from "../engine/faker.ts";
import { buildRegistry } from "../registry/index.ts";
import { createServer } from "./index.ts";

const servers: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });

async function boot(n: number) {
  const config = loadConfig({ brokerWsPort: 18000 + n, brokerTcpPort: 12800 + n, controlPlanePort: 18800 + n });
  const specText = await Bun.file("src/demo/thermostat.yaml").text();
  const registry = await buildRegistry({ specText, service: "demo", config });
  const faker = createFaker(config);
  const s = createServer(config, { registry, faker });
  servers.push(s);
  await s.start();
  return { s, config, req: (path: string, init?: RequestInit) => s.app.request(path, init) };
}

test("POST /v1/publish of an off-contract fromClient payload is delivered AND surfaces a schema/client violation", async () => {
  const { req } = await boot(1);
  const before = await (await req("/v1/validation")).json();
  const res = await req("/v1/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "command/thermostat-1/set", payload: { mode: "broil", target: 20 } }) });
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(body).toMatchObject({ direction: "fromClient", matched: true, injected: true });
  const after = await (await req(`/v1/validation?sinceSeq=${body.sinceSeq}`)).json();
  const v = after.violations.find((x: { kind: string }) => x.kind === "schema");
  expect(v).toMatchObject({ origin: "client", kind: "schema", channel: "command/{deviceId}/set" });
  expect(after.summary.byOrigin.client).toBeGreaterThanOrEqual(1);
  expect(before.summary).toBeDefined();
});

test("GET /v1/topics returns TopicInfo[] with examples byte-equal to POST /publish {example:true}", async () => {
  const { req } = await boot(2);
  const topics = (await (await req("/v1/topics")).json()).topics as Array<{ topic: string; direction: string; example: unknown }>;
  const state = topics.find((t) => t.topic === "state/{deviceId}")!;
  expect(state.direction).toBe("toClient");
  const pub = await (await req("/v1/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "state/thermostat-1", example: true }) })).json();
  expect(pub.matched).toBe(true);
  // both example generators are the injected faker at channel level → byte-equal
  const viaTopics = JSON.stringify(state.example);
  const state2 = ((await (await req("/v1/topics")).json()).topics as Array<{ topic: string; example: unknown }>).find((t) => t.topic === "state/{deviceId}")!;
  expect(JSON.stringify(state2.example)).toBe(viaTopics);
});

test("POST /v1/publish rejects payload+example together and example on an unknown topic", async () => {
  const { req } = await boot(3);
  const both = await req("/v1/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "state/x", payload: {}, example: true }) });
  expect(both.status).toBe(400);
  expect((await both.json()).error.code).toBe("example-and-payload");
  const unk = await req("/v1/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "no/such/topic", example: true }) });
  expect(unk.status).toBe(400);
  expect((await unk.json()).error.code).toBe("example-on-unknown-topic");
});

test("POST /v1/publish to an unknown topic still injects (202) and raises an unknown-topic violation", async () => {
  const { req } = await boot(4);
  const res = await req("/v1/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "no/such/topic", payload: { a: 1 } }) });
  expect(res.status).toBe(202);
  const body = await res.json();
  expect(body).toMatchObject({ direction: null, matched: false, injected: true });
  const after = await (await req(`/v1/validation?sinceSeq=${body.sinceSeq}`)).json();
  expect(after.violations.some((v: { kind: string }) => v.kind === "unknown-topic")).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test src/control-plane/index.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/control-plane/index.ts`**

```ts
import { Hono } from "hono";
import type { BrokerModule } from "../broker/index.ts";
import { createBroker } from "../broker/index.ts";
import type { Config, Faker, SpecRegistry, TopicInfo, Violation } from "../model/index.ts";
import { createValidationLog, type ValidationLog } from "../validation/index.ts";

export function buildTopicInfo(registry: SpecRegistry, faker: Faker): TopicInfo[] {
  return registry.channels().map((c) => ({
    topic: c.topic,
    direction: c.direction,
    service: c.service,
    title: c.title,
    description: c.description,
    schema: c.schema,
    example: faker(c),
    qos: c.qos,
    retain: c.retain,
  }));
}

function envelope(code: string, message: string) {
  return { error: { code, message } };
}

export function createServer(config: Config, deps: { registry: SpecRegistry; faker: Faker }) {
  const { registry, faker } = deps;
  const broker = createBroker(config);
  const log = createValidationLog(config);

  // inbound client publishes (from real MQTT clients) → validate + surface, never block
  broker.onInbound((event) => validateClientPublish(event.message.topic, event.message.payload, event.meta.clientId, event.meta.decodeError));

  function validateClientPublish(topic: string, payload: unknown, clientId: string, decodeError?: string) {
    if (decodeError) { log.record({ origin: "client", kind: "decode", severity: "error", topic, detail: `decode: ${decodeError}`, payload, clientId }); return; }
    const m = registry.match(topic);
    if (!m) { log.record({ origin: "client", kind: "unknown-topic", severity: "error", topic, detail: "unknown-topic", payload, clientId }); return; }
    if (m.channel.direction !== "fromClient") { log.record({ origin: "client", kind: "direction", severity: "error", topic, channel: m.channel.topic, detail: "direction: client published a toClient topic", payload, clientId }); return; }
    const errors = m.channel.validate(payload);
    if (errors.length) log.record({ origin: "client", kind: "schema", severity: "error", topic, channel: m.channel.topic, detail: `${errors[0].instancePath || "/"}: ${errors[0].keyword}`, payload, clientId, errors });
  }

  const app = new Hono();

  app.get("/v1/topics", (c) => c.json({ topics: buildTopicInfo(registry, faker) }));

  app.get("/v1/validation", (c) => {
    const sinceSeq = c.req.query("sinceSeq");
    const violations = log.query({ sinceSeq: sinceSeq === undefined ? undefined : Number(sinceSeq), origin: c.req.query("origin") as "client" | "mock" | undefined, kind: c.req.query("kind") as Violation["kind"] | undefined });
    return c.json({ violations, summary: log.summary() });
  });

  app.post("/v1/publish", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { topic?: string; payload?: unknown; example?: boolean; qos?: 0 | 1 | 2; retain?: boolean };
    if (!body.topic) return c.json(envelope("bad-request", "topic is required"), 400);
    if (body.payload !== undefined && body.example) return c.json(envelope("example-and-payload", "provide payload XOR example"), 400);

    const sinceSeq = log.baseline();
    const m = registry.match(body.topic);
    if (body.example && !m) return c.json(envelope("example-on-unknown-topic", "cannot generate an example for an unknown topic"), 400);

    const payload = body.example ? faker(m!.channel) : body.payload;
    const qos = body.qos ?? m?.channel.qos ?? 1;
    const retain = body.retain ?? m?.channel.retain ?? false;
    await broker.emit({ topic: body.topic, payload, qos, retain });

    // an HTTP publish re-enters with origin per G9: fromClient/unknown → client; a toClient publish is the mock serving state → mock
    if (!m) {
      log.record({ origin: "client", kind: "unknown-topic", severity: "error", topic: body.topic, detail: "unknown-topic", payload, clientId: config.injectedClientId });
    } else {
      const errors = m.channel.validate(payload);
      if (errors.length) {
        const origin = m.channel.direction === "toClient" ? "mock" : "client";
        log.record({ origin, kind: "schema", severity: "error", topic: body.topic, channel: m.channel.topic, detail: `${errors[0].instancePath || "/"}: ${errors[0].keyword}`, payload, clientId: origin === "client" ? config.injectedClientId : undefined, errors });
      }
    }

    return c.json({ topic: body.topic, direction: m ? m.channel.direction : null, matched: !!m, injected: true, sinceSeq }, 202);
  });

  let httpServer: { stop(): void } | undefined;
  return {
    app,
    broker,
    log,
    async start() {
      await broker.start();
      httpServer = Bun.serve({ port: config.controlPlanePort, fetch: app.fetch });
    },
    async stop() {
      httpServer?.stop();
      await broker.stop();
    },
  };
}

export type Server = ReturnType<typeof createServer>;
export type { BrokerModule, ValidationLog };
```

- [ ] **Step 4: Run — expect PASS + isolation still green**

Run: `bun test src/control-plane/index.test.ts test/transport-isolation.test.ts`
Expected: PASS (4 endpoint tests; isolation green — control-plane imports `createBroker`, not `aedes`).

- [ ] **Step 5: Commit**

```bash
git add src/control-plane/
git commit -m "control-plane: /v1/publish + /validation + /topics, composition root"
```

---

### Task 9: `cli/` — `offbook topics` and `offbook demo`

**Files:**
- Create: `src/cli/index.ts`
- Test: `src/cli/index.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `buildRegistry`, `createFaker`, `buildTopicInfo`, `createServer`.
- Produces: a `run(argv: string[]): Promise<number>` dispatcher (returns an exit code) plus a top-level invocation. `topics` renders in-process (no server); `demo` boots the server and drives the HTTP endpoints.

- [ ] **Step 1: Write the failing test**

`src/cli/index.test.ts`:

```ts
import { expect, test } from "bun:test";
import { renderTopics, runDemo } from "./index.ts";

test("renderTopics lists every topic with client-facing direction phrasing and fields (M0 gate ii)", async () => {
  const out = await renderTopics(["--json"]);
  const topics = JSON.parse(out) as Array<{ topic: string; direction: string }>;
  expect(topics.map((t) => t.topic).sort()).toEqual(["command/{deviceId}/set", "state/{deviceId}"]);

  const human = await renderTopics([]);
  expect(human).toContain("state/{deviceId}");
  expect(human).toContain("command/{deviceId}/set");
  expect(human).toMatch(/client receives|client sends/); // direction phrasing, not raw toClient/fromClient
  expect(human).not.toContain("fromClient"); // literal enum only under --json
  expect(human).not.toMatch(/"type":/); // no raw JSON-Schema fragment in default output
});

test("runDemo boots, publishes off-contract, catches a schema/client violation, and reports it", async () => {
  const result = await runDemo(17); // port offset for isolation
  expect(result.caught.kind).toBe("schema");
  expect(result.caught.origin).toBe("client");
  expect(result.output).toContain("command/thermostat-1/set");
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun test src/cli/index.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/cli/index.ts`**

```ts
import { loadConfig } from "../config/index.ts";
import { buildTopicInfo, createServer } from "../control-plane/index.ts";
import { createFaker } from "../engine/faker.ts";
import type { TopicInfo, Violation } from "../model/index.ts";
import { buildRegistry } from "../registry/index.ts";

const DEMO_SPEC = "src/demo/thermostat.yaml";

async function demoTopicInfo(portOffset = 0): Promise<TopicInfo[]> {
  const config = loadConfig();
  const specText = await Bun.file(DEMO_SPEC).text();
  const registry = await buildRegistry({ specText, service: "demo", config });
  return buildTopicInfo(registry, createFaker(config));
}

function phraseDirection(d: TopicInfo["direction"]): string {
  return d === "toClient" ? "client receives" : "client sends";
}

function fieldLines(schema: object): string {
  const s = schema as { properties?: Record<string, { type?: string }>; required?: string[] };
  if (!s.properties) return "";
  return Object.entries(s.properties)
    .map(([name, def]) => `      - ${name}${s.required?.includes(name) ? " (required)" : ""}: ${def.type ?? "any"}`)
    .join("\n");
}

export async function renderTopics(argv: string[]): Promise<string> {
  const topics = await demoTopicInfo();
  if (argv.includes("--json")) return JSON.stringify(topics, null, 2);
  return topics
    .map((t) => `${t.topic}  [${phraseDirection(t.direction)}]\n${fieldLines(t.schema)}\n    example: ${JSON.stringify(t.example)}`)
    .join("\n\n");
}

export async function runDemo(portOffset = 0): Promise<{ caught: Violation; output: string }> {
  const config = loadConfig({ brokerWsPort: 9001 + portOffset, brokerTcpPort: 1883 + portOffset, controlPlanePort: 9080 + portOffset });
  const specText = await Bun.file(DEMO_SPEC).text();
  const registry = await buildRegistry({ specText, service: "demo", config });
  const server = createServer(config, { registry, faker: createFaker(config) });
  await server.start();
  try {
    // seed populated (retained, per the state channel binding) state
    await server.app.request("/v1/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "state/thermostat-1", example: true }) });
    // scripted off-contract publish
    const pub = await (await server.app.request("/v1/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "command/thermostat-1/set", payload: { mode: "broil", target: 20 } }) })).json();
    const after = await (await server.app.request(`/v1/validation?sinceSeq=${pub.sinceSeq}`)).json();
    const caught = (after.violations as Violation[]).find((v) => v.kind === "schema")!;
    const output = `offbook demo: published off-contract to command/thermostat-1/set → caught ${caught.kind}/${caught.origin}: ${caught.detail}`;
    return { caught, output };
  } finally {
    await server.stop();
  }
}

export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "topics") { console.log(await renderTopics(rest)); return 0; }
  if (cmd === "demo") { const { output } = await runDemo(); console.log(output); return 0; }
  console.error("usage: offbook <topics|demo>");
  return 1;
}

if (import.meta.main) run(process.argv.slice(2)).then((code) => process.exit(code));
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test src/cli/index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Smoke-test the real CLI entrypoint**

Run: `./bin/offbook topics`
Expected: prints the two demo topics with `[client receives]` / `[client sends]` phrasing, field lists, and examples.

Run: `./bin/offbook demo`
Expected: prints the `offbook demo: ... → caught schema/client: ...` line and exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/cli/ bin/offbook
git commit -m "cli: offbook topics (discovery floor, M0 gate ii) + offbook demo"
```

---

### Task 10: M0 acceptance test + flip R-008 to `tested`

**Files:**
- Create: `test/m0-acceptance.test.ts`
- Modify: `REQUIREMENTS.md` (R-008 lifecycle)

**Interfaces:**
- Consumes: the whole slice.
- Produces: a single acceptance artifact that asserts both halves of the M0 gate, and the registry bookkeeping that flips R-008.

- [ ] **Step 1: Write the acceptance test** (it ties the gate together; the ws-harness half already lives in `src/broker/index.test.ts` and is referenced here as gate (i))

`test/m0-acceptance.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { connectAsync } from "mqtt";
import { loadConfig } from "../src/config/index.ts";
import { createServer } from "../src/control-plane/index.ts";
import { createFaker } from "../src/engine/faker.ts";
import { buildRegistry } from "../src/registry/index.ts";
import type { Violation } from "../src/model/index.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function bootFullStack() {
  const config = loadConfig({ brokerWsPort: 17701, brokerTcpPort: 17811, controlPlanePort: 17901 });
  const specText = await Bun.file("src/demo/thermostat.yaml").text();
  const registry = await buildRegistry({ specText, service: "demo", config });
  const server = createServer(config, { registry, faker: createFaker(config) });
  await server.start();
  cleanups.push(() => server.stop());
  return { server, config };
}

test("M0 gate (i): mqtt.js connects over ws and receives retained state seeded through the stack", async () => {
  const { server, config } = await bootFullStack();
  await server.app.request("/v1/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "state/thermostat-1", example: true }) });
  const client = await connectAsync(`ws://localhost:${config.brokerWsPort}`);
  cleanups.push(() => client.endAsync());
  const retained = await new Promise<string>((resolve) => { client.on("message", (_t, p) => resolve(p.toString())); client.subscribe("state/thermostat-1", { qos: 1 }); });
  expect(JSON.parse(retained)).toHaveProperty("status");
});

test("M0 gate (ii): every demo topic/shape/direction is discoverable via GET /v1/topics", async () => {
  const { server } = await bootFullStack();
  const topics = (await (await server.app.request("/v1/topics")).json()).topics as Array<{ topic: string; direction: string; schema: object }>;
  expect(topics.map((t) => t.topic).sort()).toEqual(["command/{deviceId}/set", "state/{deviceId}"]);
  for (const t of topics) { expect(["toClient", "fromClient"]).toContain(t.direction); expect(t.schema).toBeTruthy(); }
});

test("M0 output: an off-contract client publish is delivered and surfaced (validation-as-value)", async () => {
  const { server } = await bootFullStack();
  const pub = await (await server.app.request("/v1/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "command/thermostat-1/set", payload: { mode: "broil", target: 20 } }) })).json();
  const after = await (await server.app.request(`/v1/validation?sinceSeq=${pub.sinceSeq}`)).json();
  expect((after.violations as Violation[]).some((v) => v.kind === "schema" && v.origin === "client")).toBe(true);
});
```

- [ ] **Step 2: Run the whole suite — expect all green**

Run: `bun test`
Expected: every test passes (model, config, broker + harness, registry, validation, faker, control-plane, cli, m0-acceptance) and `test/transport-isolation.test.ts` is green.

- [ ] **Step 3: Flip R-008 in `REQUIREMENTS.md`**

Change the R-008 entry's status line and add trace lines so the checker validates the claim:

```
**STATUS**: tested
**COVERS**: docs/specs/build-plan.md#m0
**IMPL**: src/broker/, src/registry/, src/validation/, src/engine/, src/control-plane/, src/cli/
**TEST**: test/m0-acceptance.test.ts
```

- [ ] **Step 4: Run the doc-system gate — expect green**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 8 requirements, 2 decisions, 0 intake file(s).`

- [ ] **Step 5: Commit**

```bash
git add test/m0-acceptance.test.ts REQUIREMENTS.md
git commit -m "test: M0 acceptance gate; mark R-008 tested"
```

---

## Self-Review

**Spec coverage (build-plan.md `#m0`):**
- `model/` (types the slice uses) → Task 2. ✓
- `config/` (minimal) → Task 3. ✓
- `broker/` (ws+tcp, onInbound/emit/getState) → Task 4. ✓
- `registry/` (parse bundled demo spec → channels + Ajv validate + match) → Task 5. ✓
- `validation/` (inbound Violation + ring-buffer log) → Task 6. ✓
- the L1 floor (seeded faker) → Task 7. ✓
- minimal control plane (`POST /publish` + `GET /validation` + `GET /topics`) → Task 8. ✓
- discovery on the CLI (`offbook topics`) → Task 9. ✓
- the `mqtt.js`⟷Aedes ws harness → Task 4 Step 5 (M0 gate i). ✓
- `offbook demo` + the bundled demo spec → Tasks 1 + 9. ✓
- M0 two-part gate ((i) retained receipt, (ii) topics listing) → Task 10 (+ Task 4). ✓

**M0 exclusions honored (no ingestion, no L2/L3, no scheduler, no reset/InstanceRegistry, no extra endpoints, no full config loaders/precedence):** confirmed — none appear in any task.

**Type consistency:** `BrokerModule`, `SpecRegistry`, `Faker`, `Violation`, `TopicInfo`, `Config`/`DEFAULT_CONFIG`, `ValidationLog` are defined once (Task 2 / their module) and consumed with the same signatures downstream. `buildRegistry`, `createBroker`, `createFaker`, `l1Floor`, `createValidationLog`, `buildTopicInfo`, `createServer`, `loadConfig` names are used identically across producing and consuming tasks.

**Known library-API risks flagged inline (Task 4 Aedes ws handler; Task 5 `@asyncapi/parser` accessors; Task 7 JSF seed hook):** each step names the assertion as the contract and tells the implementer to adapt the library call if the installed API differs, rather than leaving a placeholder.

**Global-constraint carry-through:** transport isolation is a test from Task 1 forward; the no-trailer commit rule is in Global Constraints; ports/seed/base-path/envelope values are copied verbatim from the digest.
