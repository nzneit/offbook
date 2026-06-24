# Offbook — Interface & API Contracts (v1)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-design.md` (decisions/rationale), `offbook-l2-scenarios.md` (P0 — L2 authoring), `offbook-prework.md` (P1 tracker). **Provenance/rationale for every choice here:** `offbook-contracts-decisions.md` (the P1 dialog log). Section refs (e.g. §5) point to the design doc.

**Purpose:** freeze the seams so a team of agents can build v1 modules in parallel without colliding. These types and endpoints are the contract; everything else is implementation.

**Vocabulary (locked):** the connecting party under development = **`client`** (this adopter's client is a browser application). The tool's own emissions = **`mock`**. Channel/flow direction = **`toClient` / `fromClient`**. MQTT terms (`topic`, `qos`, `retain`, bindings) stay concrete — we generalize the **client** vocabulary, **not** the MQTT transport (transport abstraction is the n=2 fork, §3).

---

## 1. Normalized message model

The single type the whole codebase agrees on. Pure content + routing; **no direction** (direction is derived — it lives on the `Channel`, §5's normalize-once).

```ts
type Direction = 'toClient' | 'fromClient';   // on the Channel record, NOT the message

interface NormalizedMessage {
  topic: string;        // fully concrete (no wildcards)
  payload: unknown;     // DECODED value; the broker module owns byte<->value
  qos?: 0 | 1 | 2;      // full MQTT 3.1.1; default 1; v2 duplicate-faults are QoS-1-specific
  retain?: boolean;
  delayMs?: number;     // engine-consumed scheduling hint; default 0
}

interface InboundEvent {
  message: NormalizedMessage;                                    // flow ⇒ fromClient
  meta: { clientId: string; seq: number; receivedAt: number; decodeError?: string };  // seq = engine inbound-arrival ordering counter, distinct from the unique per-entry Violation.seq log cursor (§4); decodeError set when the payload failed to decode (§2); packetId reserved for v2
}

interface Channel {     // produced by the Spec Registry
  topic: string;        // address / pattern (may contain {params})
  direction: Direction; // normalized ONCE here (§5): v3 send→toClient · receive→fromClient; v2 subscribe→toClient · publish→fromClient
  service: string;      // owning service (services.yaml key) — feeds ?service= filters + SpecInfo/TopicInfo (§5, §6)
  schema: object;       // FULLY BUNDLED JSON Schema — every $ref inlined or rewritten to internal $defs, no dangling/external ref, 2020-12 dialect declared so Ajv compiles it standalone; feeds the L1 faker + GET /topics
  validate: (payload: unknown) => SchemaError[];  // compiled from `schema`
  qos?: 0 | 1 | 2;      // RESOLVED by the registry per the §2 precedence chain (G13)
  retain?: boolean;     // RESOLVED by the registry per the §2 precedence chain (G13)
  title?: string;       // from the AsyncAPI message/channel, when present
  description?: string; //   "        "         "
}

interface SpecRegistry {  // the ONE concrete-topic → Channel matcher; lives in `registry/`, imported everywhere
  match(topic: string): { channel: Channel; params: Record<string, string> } | undefined;
  channels(): readonly Channel[];
}
```

- **One matcher, owned by `registry/`.** Every consumer that turns a concrete `NormalizedMessage.topic` into its `Channel` — `/publish` direction inference, `unknown-topic`/`schema` validation, `Violation.channel` stamping, the `onSubscribe` initial-state path, L3 `register` routing (§3) — imports this single `match`. Hand-rolling a second matcher is forbidden (divergent semantics make the CI gate non-deterministic).
- **Match is over the channel ADDRESS.** `{param}` is a **single-segment** AsyncAPI capture on the channel address (`state/{deviceId}` ↦ `{ deviceId: 'thermostat-1' }`). MQTT `+`/`#` are **SUBSCRIBE-side filters** (a different operation, handled by the §7a wildcard policy) — they are **not** channel patterns and `match` never interprets them.
- **Precedence when more than one channel matches:** most-specific first — a literal segment beats a `{param}` segment at the same position — then declaration order in the spec. Two channels matching the same concrete topic resolve to the same winner on every run.
- **`Channel.schema` is fully bundled** so it is hand-able to Ajv and the L1 faker with no parser/registry present: the `external-ref.yaml` + `shared/common.yaml` fixture (the §5/§12.4 bundling bar) must, taken as `channel.schema` alone, compile under Ajv standalone.

- **Direction is derived, not stored on messages:** flow position (`onInbound` vs `emit`) gives inbound/outbound; the topic→`Channel` lookup gives the spec-declared direction. In v1 it's a clean bijection (the client only publishes `fromClient`; the mock only emits `toClient`).
- **`delayMs`** is resolved in the engine (seeded Mulberry32 draw — see §3 Behavior engine, this doc) and consumed by the engine scheduler; the broker ignores it.
- **Clocks (G5):** the **logical seeded clock** (`now()` = `fixedEpoch + Σ` seeded delays; §3 — also called the *virtual clock* / *virtual time* elsewhere in these docs, the same construct) is the *emission* timeline only (drives `{{now}}` and `delayMs`) — reproducible, not wall time. **Inbound** is externally driven, so `meta.receivedAt` is **wall-clock** (human) and `meta.seq` is a **logical inbound-arrival ordering counter** (distinct from the unique per-entry `Violation.seq` log cursor, §4) giving reproducible inbound ordering.
- A decode failure is surfaced as `payload: undefined` + `meta.decodeError` (never dropped — see §2 Broker module, this doc).

## 2. Broker module interface

The de-facto transport adapter. **Everything MQTT lives behind it** — ws subprotocol/path/handshake quirks, 3.1.1 pinning, accept-all auth + credential logging (§8), `packetId`, the byte codec. **Nothing above this interface imports Aedes.** Do not extract a generic adapter until a second transport exists (n=2, §3).

```ts
interface BrokerModule {
  start(): Promise<void>;   // bind ws + tcp listeners (3.1.1)
  stop(): Promise<void>;
  onInbound(handler: (event: InboundEvent) => void): void;
  onSubscribe(handler: (sub: { topic: string; clientId: string }) => void): void;
  emit(message: NormalizedMessage): Promise<void>;     // the ONE outbound primitive; publish-NOW; encodes payload
  getState(): ReadonlyMap<string, NormalizedMessage>;  // control-plane read of the retained store
}
```

- **`emit` is `Promise<void>` for deterministic ordered delivery:** the engine awaits sequential emits so enqueue order = intent. The engine *owns* this guarantee rather than assuming Aedes internals.
- **One outbound primitive.** `retain` is a PUBLISH flag; **clear retained = a zero-byte retained publish** (`emit` with `payload: undefined`, `retain: true`), which **evicts** the key from the retained store — the broker does **not** keep a tombstone, so `getState()` never returns an entry with an empty/`undefined` payload and `StateEntry.retain` is therefore always `true` (§5). There is no `setRetained` (un-MQTT). `getState` is an out-of-band control-plane read.
- **Payload-agnostic:** a malformed payload is **never dropped or blocked** — the broker delivers raw bytes and surfaces the event with `payload: undefined` + `meta.decodeError`; the validation engine logs a `decode` violation (observe-and-surface, §5). A decode failure is surfaced **only** via `meta.decodeError` (+ the violation) and is **never written to the retained store**, so a non-decodable retained publish creates no `StateEntry` — this is the other `payload: undefined` case, kept distinct from the clear-retained eviction above.
- **`onSubscribe` & the initial-state materialization policy (G3).** Retained initial state for `toClient` channels is published by the **engine**; **when** depends on whether the channel address is parametrized — these are the **normative rules** (`offbook-design.md` §7a elaborates them with examples + rationale):
  - **Non-parametrized** `toClient` channels → published **eagerly at startup** (one concrete topic, nothing to de-wildcard).
  - **Parametrized** `toClient` channels → an instance is **materialized lazily** when a concrete subscribe binds its params **or** a `fromClient` command first references a concrete param; the engine keeps a **materialized-instance set**.
  - A **wildcard subscribe** (`+`/`#`) replays retained state for **already-materialized** instances only and **never invents** params.
  - Optional per-channel **`seedInstances`** pre-materializes a deterministic demo set at startup (so onboarding isn't a blank UI).
  - **`reset`** re-materializes **exactly the recorded set** (seed instances + those materialized since the last reset), re-seeded — so post-`reset` `/state` is deterministic, not empty.
- **qos/retain resolution precedence** (**registry-resolved** — the registry already holds the spec binding; config injected at construction; result stored on the `Channel` (§1); the broker just carries the flags): **spec MQTT binding → offbook per-topic override → per-service default → global (qos 1)**. The middle tiers live in `ServiceConfig` (`topicOverrides` / `retainDefault` / `qosDefault`, §6).

## 3. Behavior engine — registration, dispatch, scheduling

**The scheduler lives here, not the transport.** It owns the virtual clock, applies `delayMs`, guarantees deterministic ordering, and (in v2) injects MQTT-semantic timing faults. `broker.emit` is publish-now.

**Clock model (G5 — virtual/wall split).** Two clocks, never conflated:
- **`now()` is logical**, not wall-clock: `fixedEpoch + Σ(resolved seeded delays applied on the emission timeline)`. This is what `{{now}}` stamps (l2 §5) and what emission ordering uses; it is a pure function of the seed, so it replays byte-identically.
- **Default scheduler = virtual time + a single event-loop yield, NOT real wall delay.** Forcing the client's async code to actually suspend/resume (design §6) needs only *one* yield boundary (`queueMicrotask`/`setImmediate`/`await`), not the literal `delayMs` elapsed in wall time. So the scheduler delivers each emit on the **next task** while advancing logical `now()` by the **full** seeded delay — async-forcing **and** deterministic **and** fast (CI never pays real seconds for a 300 ms step, and no wall-scheduler jitter can reorder anything). This is the DST-faithful default.
- **Real-wall latency is an opt-in interactive mode** (`delayMs` of actual elapsed wall time) for human-perceptible/UX timing — never the CI path.
- **Autonomous `tick`** fires on a config `tickIntervalMs` (default `1000`) with optional seeded jitter; "reproducible autonomous" = same seed ⇒ same sequence of tick emissions and their logical timestamps, independent of wall scheduling. **`passive` mode fires no ticks** (§5) — and, per G24, also freezes the scenario set (no watcher).

**Dispatch atomicity (G23 — run-to-completion per event).** The engine processes one event — an inbound publish, a `tick`, or a scheduled `emit` — and the synchronous handler work it triggers, **to completion before dequeuing the next**. Externally-driven inbound and virtual-clock emissions never interleave mid-event. Concurrent arrivals queue in arrival order: inbound by `meta.seq` assignment, emissions by the seeded timeline. This is what keeps `(seq, ordering)` host-load-independent under a fixed seed — without it, the determinism G6 establishes for the *counter* would be reintroduced as a *concurrency* race one layer down.

**Two trigger paths** (refines §4's flat ordering):

| Trigger | Layers (first-match-wins) |
|---|---|
| **Reactive** — client publishes (inbound) | **L3 → L2** (no L1) |
| **Proactive** — subscribe (initial state) / autonomous tick | **L3 → L1** (L1 is the floor) |
| **Explicit** — `POST /trigger/{name}` | the named **L2** scenario (or an L3 action) |

So **L1 = proactive floor, L2 = reactive/triggered, L3 = both.** "Works day one" = the UI renders from L1 initial state; behavior is authored on top in L2/L3.

```ts
type HandlerFactory = () => Handler;   // a FACTORY — re-instantiated on reset for clean deterministic state

interface Handler {
  onInbound?(event: InboundEvent, ctx: HandlerContext): void;    // reactive
  initialState?(topic: string, ctx: HandlerContext): void;       // proactive (on subscribe)
  tick?(ctx: HandlerContext): void;                              // autonomous mode
}

interface HandlerContext {
  publish(msg: Partial<NormalizedMessage> & { topic: string }): void;  // routed through the engine scheduler
  random(): number;   // seeded PRNG draw (deterministic)
  now(): number;      // LOGICAL clock: fixedEpoch + Σ(seeded delays) — NOT wall-clock (G5)
}

declare function register(topicPrefix: string, factory: HandlerFactory): void;
```

- L3 **publishes through the engine scheduler**, never `broker.emit` directly (§3 layering).
- L1 is not registered — it's the built-in floor: `fake(channel, seed) → payload`, seeded and Ajv-rechecked before emit.
- L2 scenarios are loaded per `offbook-l2-scenarios.md` (sorted-path → in-file dispatch order).
- *(Deferred: AsyncAPI-3.0 reply-channel auto-response as a future L1 reactive enhancement.)*

**L3 discovery & `register` semantics (G11).** L3 modules are discovered by the glob `handlers/**/*.ts` (mirroring L2's `scenarios/**/*.yaml`); each module calls `register(...)` on import. The first argument is a **channel pattern** — the full AsyncAPI channel address with single-segment `{param}` captures (e.g. `command/{deviceId}/set`), **not** a bare literal prefix and **not** an MQTT `+`/`#` subscribe filter. It is resolved by the **same matcher the registry owns** (the `SpecRegistry.match(topic)` of §1/§2), so a concrete inbound topic routes to the same channel for L3 as for validation and `/publish`. When more than one registered pattern matches a topic, precedence is **identical to that matcher's**: most-specific (a literal segment beats a `{param}`), then sorted module path → registration order — so reordering files never changes the winner. *(The frozen declaration still names the parameter `topicPrefix`; read it as `pattern`. Renaming the identifier is a one-token edit the engine/registry owner applies when wiring the matcher import.)*

**`emitSource` provenance (G10).** `broker.emit` is content-only (§2) and carries no layer/scenario/step identity; the **engine** owns emit and therefore knows which layer produced each message. The engine attaches the in-scope `EmitSource` (§4) to any `mock` `Violation` raised by that emit's Ajv recheck: the **L1** floor sets `{ layer: 'L1' }`; the **L2** scenario runner sets `{ layer: 'L2', scenarioName, stepIndex }` (`scenarioName` = the matched `Scenario.name`, `stepIndex` = the 0-based index into its `then[]` — §3a); the **L3** `register` wrapper tags its `ctx.publish` calls `{ layer: 'L3', … }`. So a mock violation is never shipped with `emitSource` permanently `undefined`.

## 3a. Scenario model (L2)

The normalized, parsed shape of an L2 scenario — the type `scenarios/` (dispatch table, matcher, templating) and `control-plane` (`POST /trigger/{name}` → `{ scenario, fired, seq }`) both import. Transcribed from `offbook-l2-scenarios.md` §9 (the authoring format; this is the canonical *type*).

```ts
interface Scenario {
  name: string;                 // globally unique; keys POST /trigger/{name}, the validation log, and reset
  when?: WhenClause;            // present ⇒ reactive (fires on a matching fromClient publish); absent ⇒ on-demand-only
  then: EmitStep[];             // ordered list, ≥1 step; one-shot is the degenerate single element
}

interface WhenClause {
  topic: string;                            // {param} captures + MQTT +/# (l2 §4); must resolve to a fromClient channel
  payloadMatch?: Record<string, unknown>;  // subset equality; dotted-path keys deep-equal the inbound payload; extra fields ignored
}

interface EmitStep {
  emit: {
    topic: string;              // {{substitution}}; must resolve to a toClient channel
    payload: unknown;           // {{substitution}}; omitted required fields are seed-faked by L1, then Ajv-rechecked before emit
    delay?: string;             // "<n>ms|s" or "<min>-<max>ms|s" (l2 §6); omitted ⇒ 0; relative/cumulative across steps
  };
}
```

- The only step kind in v1 is `emit`. v2 fault steps (`duplicate`/`reorder`/`drop`/`redeliver`) are additive on `EmitStep`.
- `Violation.emitSource.scenarioName` (§4) keys to `Scenario.name`; `emitSource.stepIndex` is the 0-based index into `then[]`.
- `{param}` (single brace) is a capture on `when.topic`; `{{…}}` (double brace) is substitution on the emit side — the closed templating vocabulary (`{{param}}` / `{{payload.<path>}}` / `{{uuid}}` / `{{seq}}` / virtual `{{now}}`) is l2 §5.

## 4. Validation

```ts
type ViolationKind = 'schema' | 'direction' | 'unknown-topic' | 'decode';  // qos-mismatch deferred → tier-3 warn log

interface SchemaError {            // OUR shape — not Ajv's — since it crosses the HTTP boundary
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params?: Record<string, unknown>;
}

type EmitSource = { layer: 'L1' | 'L2' | 'L3'; scenarioName?: string; stepIndex?: number };  // engine-populated provenance (§3), present when origin === 'mock'

interface Violation {
  seq: number;                     // UNIQUE, monotonic, per-entry log cursor; reproducible; the sole /validation ordering key (G6)
  observedAt: string;              // ISO8601 wall-clock; human; non-reproducible
  origin: 'client' | 'mock';
  kind: ViolationKind;
  severity: 'error' | 'warning';   // default from kind; policy may override
  topic: string;
  channel?: string;                // AsyncAPI channel matched / should-match
  detail: string;
  payload?: unknown;               // offending/contextual; raw string for decode; may be truncated
  clientId?: string;               // when origin === 'client'
  errors?: SchemaError[];          // when kind === 'schema'
  emitSource?: EmitSource;          // when origin === 'mock' (engine-populated, §3)
}
```

- Single record with optionals (not a discriminated union) for v1.
- **`emitSource` is engine-populated (G10):** `broker.emit` is content-only, so the **engine** (which owns emit) stamps the active layer onto any `mock` violation raised by that emit's recheck — `L1` for the faker floor, `L2` with `scenarioName` (= `Scenario.name`, §3a) + `stepIndex` (the `then[]` index) for the scenario runner, `L3` for `register`ed handler `ctx.publish` calls. It is therefore never permanently `undefined` for a `mock` violation.
- **`seq` is unique per log entry (G6).** It is a strictly-increasing cursor minted as the violation is logged — *not* shared across a group of violations. `/validation` orders by `seq` **alone** (a total order; no `insertion` tiebreak), `?sinceSeq=` is **strictly-greater**, and the `reset` baseline is the last assigned `seq` (so the first post-reset entry is `baseline + 1`). This is exactly what makes `fce44fa`'s `summary.oldestSeq` (lowest still-retained `seq`), FIFO ring-buffer eviction, and the `sinceSeq` boundary mutually coherent: under a non-unique `seq`, a group sharing one value could be split by eviction or dropped/double-counted at the boundary. The two `seq` notions are **separate counters**, never one overloaded field: `Violation.seq` here is the unique per-entry log cursor; `InboundEvent.meta.seq` (§1) is the engine's inbound-arrival ordering counter.
- **Determinism guarantee (precise).** Given a fixed inbound script + seed, the emission/violation stream and its `seq` ordering are byte-identical across runs. The CI harness drives inbound deterministically (`reset` → `publish`/`trigger` → poll), and run-to-completion dispatch (§3) plus the logical clock (§3) make the ordering independent of wall scheduling and host load.
- **Three-tier surfacing:**
  1. **`/validation`** — structured runtime contract violations (CI-grade; the §5 headline).
  2. **`/diagnostics`** — static config/load issues (scenario-load errors, overlap/shadow warnings).
  3. **warn-level logs** — low-ceremony runtime notices, e.g. a **qos/retain divergence from the spec binding** (surfaced-not-silent; *not* a `Violation`; one-line upgrade to a `qos-mismatch` kind if it ever matters).

## 5. Control-plane HTTP API

**Conventions:** `/v1` prefix · JSON only · error envelope `{ error: { code: ErrorCode, message, details? } }` where `ErrorCode` is the closed union below · **actions return promptly after *injecting*** (CI polls `/state` + `/validation` for effects) · no-auth / no-CORS / localhost bind (dev appliance; the client uses MQTT, not this API).

### Reads
| Endpoint | Returns | Notes |
|---|---|---|
| `GET /v1/topics` | `{ topics: TopicInfo[] }` | dereferenced **schema + seeded example inline**; `?direction=` / `?service=` filters; `?schema=false` slim mode |
| `GET /v1/state` | `{ state: StateEntry[] }` | lean, **concrete** topics; `?topic=` prefix filter |
| `GET /v1/validation` | `{ violations: Violation[]; summary: ValidationSummary }` | `?sinceSeq=` (strictly-greater) `?origin=` `?severity=` `?kind=`; ordered by `seq` alone (now a total order — G6); violations-only. **Bounded ring buffer** — see note below |
| `GET /v1/specs` | `{ specs: SpecInfo[]; resolutionMode; warnings? }` | `resolutionMode: 'branch' \| 'pinned'` honesty flag (§7) |
| `GET /v1/diagnostics` | `{ diagnostics: Diagnostic[]; summary }` | load/hot-reload-populated; dev-time surface |
| `GET /v1/mode` | `{ mode, seed }` | |

```ts
interface TopicInfo { topic: string; direction: Direction; service: string;
  title?: string; description?: string; schema: object; example?: unknown; qos?: 0|1|2; retain?: boolean; }
interface StateEntry { topic: string; payload: unknown; qos?: 0|1|2; retain: true; }  // retain is always true — clearing a retained topic EVICTS it (§2), so /state never returns tombstones; a decode-failure (§2) is never stored, so payload is always a successfully-decoded value
interface SpecInfo { service: string; declaredVersion?: string; source: string; contentHash: string; channelCount: number; }  // declaredVersion = info.version, read parser-free by ingestion/ (shallow yaml read, G12) — NOT the requested version (they differ in v1 branch mode)
interface Diagnostic { kind: 'scenario-load' | 'overlap' | 'spec-load';
  severity: 'error' | 'warning' | 'info'; detail: string; source?: string; scenarioName?: string; }

interface ValidationSummary {    // the CI-facing payload of GET /v1/validation
  errors: number;                // count of severity === 'error' violations (within the retained window)
  warnings: number;              // count of severity === 'warning'
  byOrigin: { client: number; mock: number };  // counts ALL severities, not errors-only
  byKind: Record<ViolationKind, number>;        // ALL kinds always present, zero-filled (schema, direction, unknown-topic, decode)
  oldestSeq: number;             // lowest still-retained seq (bounded ring buffer); 0 when the log is empty
}

// Closed set of error-envelope codes (every non-2xx path returns one); the CLI/CI branch on this union, no ad-hoc strings.
type ErrorCode =
  | 'unknown-topic'              // a referenced topic matches no channel
  | 'unknown-scenario'           // POST /trigger/{name} with no such scenario
  | 'bad-request'                // malformed body / params (generic 400)
  | 'example-on-unknown-topic'   // POST /publish { example: true } on an unknown topic
  | 'example-and-payload';       // POST /publish with BOTH payload and example present
```

> **Violation-log retention.** The log is a **bounded ring buffer** capped at `config.maxViolations` (FIFO eviction), so a left-running dev instance has a **memory ceiling, not unbounded growth**. (It is the only unbounded log in v1 — `/state` is the retained store, bounded by topic count; `config.maxEvents` is reserved should inbound-event history ever be retained.) `seq` is **unique per entry**, process-monotonic, and **never reused** (G6), so `?sinceSeq=` (strictly-greater) stays correct even across eviction; `summary.oldestSeq` is the lowest still-retained `seq`, so a caller whose `sinceSeq < oldestSeq` knows older violations were evicted. **The CI loop is unaffected** — its `reset`-checkpoint → poll window holds far fewer than `maxViolations` entries, so nothing it cares about is ever evicted. (`reset` does not clear the log — eviction is by capacity only.)
| Endpoint | Body | Result | Notes |
|---|---|---|---|
| `POST /v1/publish` | `{ topic, payload?, example?, qos?, retain? }` — **`payload` XOR `example`** | `202 { topic, direction, injected, seq }` | **direction inferred from the channel** (toClient drives UI / fromClient simulates client + validates); reports resolved `direction`; unknown topic → raw publish + flag. `payload?: unknown` is an explicit value; `example?: boolean` (`true`) generates a seeded schema-valid payload; **both present → `400 example-and-payload`**; `example: true` on an unknown topic → `400 example-on-unknown-topic` |
| `POST /v1/trigger/{name}` | `{ params?, payload? }` (omitted → seed-faked) | `202 { scenario, fired, seq }` | `params` entries bind the scenario's `{{param}}` captures (e.g. `params.deviceId` → `{{deviceId}}`); `payload` supplies the inbound payload for a reactive scenario fired by hand. `404 unknown-scenario` |
| `POST /v1/reset` | `{ seed? }` | `200 { reset, seed, seq }` | returns **active seed + `seq` baseline** (feeds `?sinceSeq=`); **non-destructive** — re-seeds PRNG, resets virtual clock, re-instantiates L3 handlers, republishes initial state, halts autonomous; `seq` is process-monotonic, log not cleared |
| `POST /v1/mode` | `{ mode: 'autonomous' \| 'passive' }` | `200 { mode, seed }` | default `autonomous` (§7b); startup flag/env boots `passive` for CI; mode-set ≠ reset |
| `POST /v1/specs/refresh` | — | `200 { specs: SpecInfo[] }` | re-resolves each service, rewrites `specs.lock`, hot-swaps the running registry, returns the new `SpecInfo[]` — no restart; `offbook specs update` calls this (the running server's registry would otherwise go stale). `up`/`down` are **not** endpoints — see the process-management note below (G14) |

> **`passive` quiesces both the clock *and* the scenario set (G24).** Just as `passive` fires no autonomous ticks (§3), it also **freezes the L2 scenario set**: scenarios are loaded once at startup and the file watcher / hot-reload is **off**, so editing a scenario file between `reset` and an assertion cannot change which scenario matches. Hot-reload (l2 §8) is a dev-only, `autonomous`-mode affordance. This makes the dispatch table as deterministic across a CI window as the emission stream.

- **A `fromClient` `/publish` re-enters the broker's inbound path (G9).** An HTTP-injected publish has no ws client to mint `meta`, so the control-plane synthesizes an `InboundEvent` and feeds it through the **same `onInbound` path the broker uses for real client publishes** — `meta.clientId = 'control-plane'` (configurable via `config.injectedClientId`), `meta.receivedAt = wall now`, `meta.seq` assigned by the engine — so it is validated identically to a real publish and tagged **`origin: 'client'`**. A contract break therefore lands in `byOrigin.client` (never silently in `byOrigin.mock`), so the headline gate below can't false-negative on injected traffic.
- **`up` / `down` are NOT HTTP endpoints — they are process management (G14).** No request can start the server that would serve it; `offbook up` **spawns the server detached, writes a PID + port runfile, and probes the control-plane port for readiness**, and `offbook down` reads the runfile and signals the process. (`offbook specs update` *is* HTTP — it hits `POST /v1/specs/refresh` above so the running registry doesn't go stale.)

The CI loop reads cleanly: `reset` (checkpoint `seq`) → `publish`/`trigger` → poll `GET /validation?sinceSeq=<checkpoint>` → assert `summary.byOrigin.client === 0`.

## 6. Spec ingestion & config (the §7 seams, v1)

v1 ships the **branch stopgap** behind §7's forward-compatible seams; `specs.lock` from day one; semver→ref resolution is v2.

```ts
interface ServiceConfig {
  name: string;
  repo: string;            // full URL (https://… or git@…:…), used as-is; OR an 'org/name' slug resolved against gitHost (G20)
  gitHost?: string;        // per-service base URL override for the slug form; falls back to the global gitHost (G20)
  specPath: string;        // v1: a fixed path
  branch?: string;         // v1 ref selection; default 'main'
  qosDefault?: 0 | 1 | 2;  // per-service default qos — tier 3 of the §2 precedence chain (above the global qos 1 fallback; the last config tier, consulted just before global) (G13)
  retainDefault?: boolean; // per-service default retain — tier 3
  topicOverrides?: Record<string, { qos?: 0 | 1 | 2; retain?: boolean }>;  // per-topic override — tier 2 (above the per-service default, below the spec binding); key = channel address
  // v2: versionToSha strategy, specPath glob strategy, range policy, manual override
}

interface ResolvedSpec {
  content: string;          // raw spec text (YAML/JSON)
  contentHash: string;      // "sha256:…" — our byte fingerprint
  specPath: string;
  resolvedRef: string;      // the selection input (branch in v1; tag/sha in v2)
  resolvedSha: string;      // FULL canonical commit sha (40 hex sha-1 / 64 hex sha-256) — the pin, never abbreviated
  source: string;           // human origin, e.g. "dev@org/service-b:asyncapi.yaml"
  declaredVersion?: string; // info.version — shallow parser-free read by ingestion/ (G12), not the registry parse; best-effort (absent ⇒ undefined)
  fetchedAt: string;        // ISO8601
}

interface Resolver      { resolve(repo: string, ref: string, specPath: string): Promise<ResolvedSpec>; }  // v1+v2: GitRefResolver
interface VersionSource { versions(environment: string | null): Promise<Record<string, string>>; }        // v1: StaticManifestSource
```

- **`GitRefResolver` is the only resolver, v1 and v2** — fetching a spec at a git ref is identical regardless of ref kind. The v1↔v2 difference is purely *ref selection*: v1 uses `ref = serviceConfig.branch ?? 'main'` (a moving branch tip, unpinned); v2 resolves a requested semver → a pinned tag/sha via the `versionToSha` strategies. **v1 hands it a branch tip on `up`, and the lockfile's `resolvedSha` on `up --frozen`** (frozen mode passes `ref = lockEntry.resolvedSha`; the signature is unchanged — a SHA is just another ref).
- **Atomic SHA acquisition (writer side, G4).** `GitRefResolver` resolves the branch to a full SHA **once** via `git ls-remote <repoUrl> <branch>`, then fetches **that SHA** — so a tip advancing between the resolve and the fetch cannot desync the fetched bytes from the recorded `resolvedSha`. Branch-tip mode shallow-fetches the branch ref; by-SHA mode uses `git fetch <repoUrl> <sha>` (relying on the host's `uploadpack.allowAnySHA1InWant`) + reads the file out — **not** `git archive --remote <sha>`, which GitHub and most hosts refuse for an unadvertised SHA. `<repoUrl>` is `serviceConfig.repo` when it is a full URL, else the `org/name` slug resolved against `gitHost` (G20).
- **Lockfile reader (`up --frozen`, G4).** Default `offbook up` re-fetches each service's branch tip (branch mode = liveness, honestly warned). `offbook up --frozen` (alias `--locked`) loads `specs.lock` and re-resolves **each service by its `resolvedSha`**, writing `resolution-mode: pinned`; this is what makes the stored SHA load-bearing and the §6 reproducibility guarantee real. **v1 only ever hands it a branch tip.**
- **`resolvedRef` vs `resolvedSha`:** `resolvedRef` = what we asked git for (branch/tag/sha — provenance, disambiguated by `resolution-strategy`); `resolvedSha` = the full canonical commit it dereferenced to (the pin). When the ref *is* a sha they may be identical. **Always store the full sha** — git auto-expands abbreviations as repos grow, so a short sha is not a stable identifier and would break reproducibility.

### Config files (v1 minimal, v2-shaped)
```yaml
# services.yaml — per-service location (v1: repo + fixed specPath + optional branch; strategy machinery is v2)
gitHost: https://git.example.com   # global base URL for slug-form repos — NO built-in default (host-agnostic); a slug with no gitHost is a config error (G20)
services:
  serviceA: { repo: org/service-a, specPath: asyncapi.yaml }                                  # slug → resolved against gitHost; branch defaults to main
  serviceB: { repo: org/service-b, specPath: asyncapi.yaml, branch: dev }                     # slug, deploys from dev
  # qos/retain config tiers (§2 precedence): order is spec MQTT binding → topicOverrides → qosDefault/retainDefault → global qos 1.
  # A binding always wins; the config tiers fill in channels the spec leaves unbound. serviceC drives fixtures/asyncapi/qos-overrides.yaml (G13):
  serviceC:                                        # slug → resolved against gitHost
    repo: org/service-c
    specPath: asyncapi.yaml
    qosDefault: 2                                  # tier 3: unbound toClient channels default to qos 2 …
    retainDefault: true                            #         … retain true
    topicOverrides:                                # tier 2: a per-topic override beats the per-service default
      telemetry/{deviceId}: { qos: 0, retain: false }  # → qos 0, distinct from BOTH global (1) and the per-service default (2), so the override tier is unambiguously observable
  serviceD: { repo: https://other.example.com/org/service-d.git, specPath: asyncapi.yaml }    # full URL used as-is (ignores gitHost) (G20)

# environments.yaml — env → { service: version } (v1 reads `default`; --env selection is v2)
environments:
  default:
    serviceA: 1.4.7
    serviceB: 2.0.1
```

### `specs.lock` (v1)

Typed shape (closes the gap where the lockfile YAML had no model):
```ts
interface Lockfile {
  lockfileVersion: number;
  environment: string;
  resolutionMode: 'branch' | 'pinned';
  generatedAt: string;                 // ISO8601
  services: Record<string, LockEntry>;
}
interface LockEntry {
  requestedVersion: string;            // from environments.yaml — recorded, UNHONORED in v1
  resolutionStrategy: 'branch';        // v2 adds git-tag | release-branch | manual | …
  resolvedRef: string;
  resolvedSha: string;                 // FULL canonical commit sha — never abbreviated
  specPath: string;
  specDeclaredVersion?: string;        // info.version
  contentHash: string;                 // "sha256:…"
  fetchedAt: string;                   // ISO8601
  resolvedVersion?: string;            // v2 only — semver after range policy
}
```
```yaml
lockfile-version: 1
environment: default
resolution-mode: branch             # 'branch' | 'pinned' — the warning names the branch (§7 "never lie about fidelity")
generated-at: 2026-06-23T…
services:
  serviceB:
    requested-version: 2.0.1        # from environments.yaml — recorded, UNHONORED in v1
    resolution-strategy: branch
    resolved-ref: dev               # selection input
    resolved-sha: 9f2c3a1b4d5e6f70819a2b3c4d5e6f7081929a3b   # FULL commit sha
    spec-path: asyncapi.yaml
    spec-declared-version: 2.0.0    # info.version
    content-hash: sha256:c1d2…      # byte fingerprint
    fetched-at: 2026-06-23T…
    # resolved-version:  (v2 only — semver after range policy)
```

> **Key-casing convention:** hand-authored config (`services.yaml`, `environments.yaml`) uses **camelCase** keys mirroring the TS fields (`specPath`, `branch`); the generated **lockfile uses kebab-case** throughout (`lockfile-version`, `resolution-mode`, `spec-path`, …). A `LockEntry`↔YAML serializer maps camelCase fields → kebab keys uniformly. *(The `resolutionMode` field on the `GET /v1/specs` JSON response stays camelCase — HTTP/JSON DTOs are camelCase; only the on-disk YAML is kebab.)*

- Recording **`resolved-ref` + full `resolved-sha` + `content-hash`** gives v1 the **full reproducibility guarantee**, *made real by the `up --frozen` reader (§6 GitRefResolver bullet)*: rebuild the exact mock even after the branch moves by re-resolving each service at its `resolved-sha`. The byte-identical acceptance test runs against a **pinned SHA**, not a live tip (a mutable tip has no operationally-definable byte-identity).
- **`spec-declared-version` is written by `ingestion/`, parser-free (G12).** Ingestion does a **shallow `info.version` read with the `yaml` lib** (already a dependency) on the fetched bytes — **no `@asyncapi/parser` import** — so the lockfile `spec-declared-version` and `SpecInfo.declaredVersion` are populated without serializing ingestion behind `registry/`'s full parse. It is best-effort: absent `info.version` ⇒ the field stays `undefined` (optional on both `ResolvedSpec` and `LockEntry`).
- The declared-vs-requested **drift-check is v2** (v1 always fetches a branch tip, so there's no resolved semver to check).
- **Seam-complete:** `environments.yaml` exists in v1 so `requested-version` is real and the requested-vs-resolved gap is *honestly visible*; v2 swaps `StaticManifestSource → ReleaseToolingSource` with no restructure.

## 7. v1 / v2 boundary (what these contracts stub)

**In v1, behind these seams:** `GitRefResolver` selecting `ref = branch`; `StaticManifestSource`; single `default` environment; `specs.lock` with `resolved-ref`/`resolved-sha`/`content-hash`.

**Deferred to v2 (no restructure — implementations swap behind the same seams):** `versionToSha` strategy enums + range policy + manual override in `services.yaml`; `resolved-version` + drift-check; `--env` selection; `ReleaseToolingSource`; adversarial-timing step kinds (`duplicate`/`reorder`/`drop`/`redeliver`); `qos-mismatch` violation kind; the open §7 boundary question (does the mock *call* release tooling or *consume its output*).

---

*Rationale for every decision above — including the alternatives weighed — is in `offbook-contracts-decisions.md`.*
