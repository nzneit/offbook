# Offbook — Interface & API Contracts (v1)

*Knows every line. Needs no cast.*

**Companion to:** `design.md` (decisions/rationale), `l2-scenarios.md` (P0 — L2 authoring), `../archive/decision-logs/prework.md` (P1 tracker). **Provenance/rationale for every choice here:** `../archive/decision-logs/contracts-decisions.md` (the P1 dialog log). **Section-ref convention:** a bare `§N` refers to **this** document's sections; cross-document refs are always prefixed — `design §N`, `l2 §N`, `contracts §N`.

**Purpose:** freeze the seams so a team of agents can build v1 modules in parallel without colliding. These types and endpoints are the contract; everything else is implementation.

**Vocabulary (locked):** the connecting party under development = **`client`** (this adopter's client is a browser application). The tool's own emissions = **`mock`**. Channel/flow direction = **`toClient` / `fromClient`**. MQTT terms (`topic`, `qos`, `retain`, bindings) stay concrete — we generalize the **client** vocabulary, **not** the MQTT transport (transport abstraction is the n=2 fork, design §3).

---

## 1. Normalized message model

The single type the whole codebase agrees on. Pure content + routing; **no direction** (direction is derived — it lives on the `Channel`, design §5's normalize-once).

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
  direction: Direction; // normalized ONCE here (design §5): v3 send→toClient · receive→fromClient; v2 subscribe→toClient · publish→fromClient
  service: string;      // owning service (services.yaml key) — feeds ?service= filters + SpecInfo/TopicInfo (§5, §6)
  schema: object;       // FULLY BUNDLED JSON Schema — every $ref inlined or rewritten to internal $defs, no dangling/external ref, draft-07 dialect declared (D-018) so Ajv compiles it standalone; feeds the L1 faker + GET /topics
  validate: (payload: unknown) => SchemaError[];  // compiled from `schema`
  qos?: 0 | 1 | 2;      // RESOLVED by the registry per the §2 precedence chain (G13)
  retain?: boolean;     // RESOLVED by the registry per the §2 precedence chain (G13)
  title?: string;       // from the AsyncAPI message/channel, when present
  description?: string; //   "        "         "
}

interface SpecRegistry {  // the ONE concrete-topic → Channel matcher; lives in `registry/`, imported everywhere
  match(topic: string): { channel: Channel; params: Record<string, string> } | undefined;
  matchesFilter(filter: string, topic: string): boolean;  // MQTT +/# SUBSCRIBE-side filter test (F6); shared by engine (wildcard replay, §2) + scenarios (when.topic, §3a)
  channels(): readonly Channel[];
  diagnostics(): readonly Diagnostic[];  // registry-time spec-QUALITY findings (D-018): discoverable only while BUILDING the catalog, so they cannot be recomputed from a Channel later (binding placement, dialect mismatch, a schema that would not compile). Collected once at build; the composition root merges them into GET /v1/diagnostics (§5) beside the computed ones. Reuses the closed `spec-load` kind with a machine-greppable `detail` tag prefix; `mergeRegistries` concatenates its inputs'
}
```

- **One matcher, owned by `registry/`.** Every consumer that turns a concrete `NormalizedMessage.topic` into its `Channel` — `/publish` direction inference, `unknown-topic`/`schema` validation, `Violation.channel` stamping, the `onSubscribe` initial-state path, L3 `register` routing (§3) — imports this single `match`. Hand-rolling a second matcher is forbidden **for concrete-topic→`Channel` resolution** (divergent semantics make the CI gate non-deterministic). **`match` and `matchesFilter` delegate to [`mqtt-pattern`](https://www.npmjs.com/package/mqtt-pattern)**, minding the syntax gap: mqtt-pattern's named capture is `+param`/`#param`, **not** AsyncAPI's `{param}` (a `{param}` segment is matched *literally*). So `match` **rewrites each single-segment `{p}` on the channel address to mqtt-pattern's `+p`**, then calls `exec` on the rewritten pattern; because the rewrite is `{p}`→`+p`, the returned captures are already keyed by `p` (the back-map is the identity — no rename layer). `matchesFilter` calls `matches` directly on a native MQTT `+`/`#` SUBSCRIBE filter and needs **no** rewrite (R2). One tested library, no hand-rolled segment-splitting — while offbook's precedence (below) stays our sort on top, operating on the original `{param}` form. A build-time parity spike confirms the `{p}`→`+p` rewrite reproduces AsyncAPI single-segment capture exactly (it does **not** assert mqtt-pattern reads `{param}` natively — it does not) before we rely on it. *(The L2 scenario `when.topic` matcher — which fuses `{param}` capture, `+`/`#` filter, and `payloadMatch` in one walk, l2 §4 — is a separate, **permitted** matcher: a different operation `match` deliberately refuses — it never interprets `+`/`#` (see the *"Match is over the channel ADDRESS"* bullet below).)*
- **Match is over the channel ADDRESS.** `{param}` is a **single-segment** AsyncAPI capture on the channel address (`state/{deviceId}` ↦ `{ deviceId: 'thermostat-1' }`). MQTT `+`/`#` are **SUBSCRIBE-side filters** (a different operation, tested by `matchesFilter` above per the design §7a wildcard policy) — they are **not** channel patterns and `match` never interprets them.
- **Precedence when more than one channel matches:** most-specific first — a literal segment beats a `{param}` segment at the same position — then declaration order in the spec. Two channels matching the same concrete topic resolve to the same winner on every run.
- **`Channel.schema` is fully bundled** so it is hand-able to Ajv and the L1 faker with no parser/registry present: the `external-ref.yaml` + `shared/common.yaml` fixture (the design §5/§12.4 bundling bar) must, taken as `channel.schema` alone, compile under Ajv standalone. The bundling comes from the **parser stack** — `@asyncapi/parser`'s resolved output (it depends on `@apidevtools/json-schema-ref-parser`, whose `$RefParser.bundle()` produces the self-contained internal-`$ref` form, dedup'd not blown-up) — **not** hand-rolled `$ref`-walking in `registry/`; we only stamp the dialect (R1).
- **`Channel.schema` is validated under JSON Schema draft-07**, the dialect both AsyncAPI majors declare for the Schema Object ("a superset of JSON Schema Draft 07") and the one `@asyncapi/parser` actually emits; `registry/` stamps `$schema: http://json-schema.org/draft-07/schema#` explicitly, so the schema `GET /topics` hands out is self-describing (D-018). Stamping 2020-12 over a draft-07 schema was the root cause of a legal tuple payload (`items` as an array) crashing `ajv.compile()` and of `additionalItems` being silently ignored. Keywords JSON Schema added after draft-07 (`prefixItems`, `unevaluatedProperties`, `dependentRequired`, and friends) therefore cannot be honored, and are surfaced as a `spec-load` diagnostic rather than ignored in silence.

- **Direction is derived, not stored on messages:** flow position (`onInbound` vs `emit`) gives inbound/outbound; the topic→`Channel` lookup gives the spec-declared direction. In v1 it's a clean bijection (the client only publishes `fromClient`; the mock only emits `toClient`).
- **`delayMs`** is resolved in the engine (seeded Mulberry32 draw — see §3 Behavior engine) and consumed by the engine scheduler; the broker ignores it.
- **Clocks (G5):** the **logical seeded clock** (`now()` = `fixedEpoch + Σ` seeded delays; §3 — also called the *virtual clock* / *virtual time* elsewhere in these docs, the same construct) is the *emission* timeline only (drives `{{now}}` and `delayMs`) — reproducible, not wall time. **Inbound** is externally driven, so `meta.receivedAt` is **wall-clock** (human) and `meta.seq` is a **logical inbound-arrival ordering counter** (distinct from the unique per-entry `Violation.seq` log cursor, §4) giving reproducible inbound ordering.
- A decode failure is surfaced as `payload: undefined` + `meta.decodeError` (never dropped — see §2 Broker module).

## 1a. Runtime config — `Config` (model/)

The single global runtime config every module reads; declared in `model/` (Tier 0) so no module invents its own shape (F2). Fields are grouped by lifecycle: only `seed` is varied by `reset` (via `POST /reset {seed?}`); `mode` is mutable at runtime via its own endpoint (`POST /mode`, §5) but **not** by `reset`; every other field is **process-scoped** — bound once at startup, never touched by `reset`.

```ts
interface Config {
  // — determinism (reset re-seeds to `seed`, or the `POST /reset {seed?}` override) —
  seed: number;            // default run seed; base of the keyed PRNG (§3, F7)
  fixedEpoch: number;      // fixed logical-clock base: now() = fixedEpoch + Σ(seeded delays) (§3, G5)
  // — scheduler —
  tickIntervalMs: number;  // autonomous tick cadence: WALL time when wallClock, else a virtual-time increment per tick (§3, CR6)
  wallClock: boolean;      // false (default) = fast-virtual scheduler (single event-loop yield, no wall delay; CI/replay/determinism path); true = wall-paced — real delayMs AND ticks at tickIntervalMs of wall time (interactive `offbook up`); process-scoped, reset never touches it (§3, CR6)
  mode: 'autonomous' | 'passive';  // startup emission mode; 'passive' fires no ticks + freezes the scenario set (§3/§5). Runtime-flippable via POST /mode (§5; the one field mutable outside reset); `offbook up --ci` boots 'passive' (the determinism gate asserts it). Default 'autonomous'
  // — loader —
  strict: boolean;         // scenario-load failures: true = fatal-at-startup (CI can't false-green), false (default) = skipped-loud to /diagnostics (l2 §7); set by `up --ci` or standalone `up --strict`
  // — limits (bounded buffers; process-scoped) —
  maxViolations: number;   // /validation ring-buffer cap (§5)
  maxEvents: number;       // reserved — inbound-event history (unused in v1)
  // — identity / network (bound once at startup; reset never touches) —
  injectedClientId: string;    // meta.clientId for HTTP-injected publishes (§5, G9)
  brokerWsPort: number;        // MQTT-over-WebSockets listener
  brokerTcpPort: number;       // MQTT-over-TCP listener
  controlPlanePort: number;    // control-plane HTTP API. All three ports are CLI-overridable (--ws-port/--tcp-port/--ctrl-port, §5/P7) so instances run side-by-side
  // — process / run artifacts (CLI launcher; bound once at startup; reset never touches) —
  runDir: string;              // dir for the runfile + offbook.log (§5 process mgmt); cwd-relative, default '.offbook'; up/down/logs/status resolve it identically; init gitignores it
}

// Committed defaults — pinned so a golden snapshot is machine-independent (two checkouts ⇒ identical {{now}} + draws).
const DEFAULT_CONFIG: Config = {
  seed: 1,
  fixedEpoch: 1_700_000_000_000,   // 2023-11-14T22:13:20Z — arbitrary but fixed
  tickIntervalMs: 1000,
  wallClock: false,                // fast-virtual default; interactive `offbook up` flips it on (§3, CR6)
  mode: 'autonomous',              // startup emission mode; `up --ci` boots 'passive'
  strict: false,                   // scenario-load skipped-loud; `up --ci`/`--strict` makes it fatal
  maxViolations: 10_000,
  maxEvents: 0,
  injectedClientId: 'control-plane',
  brokerWsPort: 9001,
  brokerTcpPort: 1883,
  controlPlanePort: 9080,
  runDir: '.offbook',              // cwd-relative run-artifact dir (runfile + offbook.log); init adds it to .gitignore
};
```

## 2. Broker module interface

The de-facto transport adapter. **Everything MQTT lives behind it** — ws subprotocol/path/handshake quirks, 3.1.1 pinning, accept-all auth + credential logging (design §8), `packetId`, the byte codec. **Nothing above this interface imports Aedes.** Do not extract a generic adapter until a second transport exists (n=2, design §3).

```ts
interface BrokerModule {
  start(): Promise<void>;   // bind ws + tcp listeners (3.1.1)
  stop(): Promise<void>;
  onInbound(handler: (event: InboundEvent) => void): void;
  onSubscribe(handler: (sub: { topic: string; clientId: string }) => void): void;
  emit(message: NormalizedMessage): Promise<void>;     // the ONE outbound primitive; publish-NOW; encodes payload
  getState(): Promise<ReadonlyMap<string, NormalizedMessage>>;  // ASYNC out-of-band control-plane read — drains Aedes' retained store (createRetainedStream), no parallel map (R3); peers with the async start/stop/emit above
}
```

- **`emit` is `Promise<void>` for deterministic ordered delivery:** the engine awaits sequential emits so enqueue order = intent. The engine *owns* this guarantee rather than assuming Aedes internals.
- **One outbound primitive.** `retain` is a PUBLISH flag; **clear retained = a zero-byte retained publish** (`emit` with `payload: undefined`, `retain: true`), which **evicts** the key from the retained store — the broker does **not** keep a tombstone, so `getState()` never returns an entry with an empty/`undefined` payload and `StateEntry.retain` is therefore always `true` (§5). There is no `setRetained` (un-MQTT). `getState` is an out-of-band, **async** control-plane read — it **drains Aedes' own retained store** (`persistence.createRetainedStream`, a stream) into a `ReadonlyMap`, never a parallel store (R3): Aedes already implements the MQTT clear-on-empty rule, so a second store can't diverge from what a late subscriber actually receives. (The subscribe/replay hot-path never calls it — wildcard replay rides Aedes' native retained delivery, see the materialization policy below.)
- **Payload-agnostic:** a malformed payload is **never dropped or blocked** — the broker delivers raw bytes and surfaces the event with `payload: undefined` + `meta.decodeError`; the validation engine logs a `decode` violation (observe-and-surface, §5). A decode failure is surfaced **only** via `meta.decodeError` (+ the violation) and is **never written to the retained store**, so a non-decodable retained publish creates no `StateEntry` — this is the other `payload: undefined` case, kept distinct from the clear-retained eviction above.
- **`onSubscribe` & the initial-state materialization policy (G3).** Retained initial state for `toClient` channels is published by the **engine**, which owns materialization end-to-end: it consumes `broker.onSubscribe` and, on a **concrete** subscribe, calls `InstanceRegistry.materialize` then republishes — the broker only *reports* the subscribe, it never materializes (F6). **When** the publish happens depends on whether the channel address is parametrized — these are the **normative rules** (`design.md` §7a elaborates them with examples + rationale):
  - **Non-parametrized** `toClient` channels → published **eagerly at startup** (one concrete topic, nothing to de-wildcard).
  - **Parametrized** `toClient` channels → an instance is **materialized lazily** when a concrete subscribe binds its params **or** a `fromClient` command first references a concrete param; the engine keeps a **materialized-instance set** — the engine-owned `InstanceRegistry` (F1), the single owner of all five rules in this policy.
  - A **wildcard subscribe** (`+`/`#`) replays the **existing retained state for every topic matching the filter** — sourced from **Aedes' own retained store** (R3, the single source of truth) via the broker's **native retained delivery** to the subscribing client (filter tested by `matchesFilter`, F6), **not** a parallel materialized-instance set. It **never invents** params: a topic is replayed iff it currently holds retained state, so a cleared (zero-byte-evicted) topic is excluded and an off-ledger L3/L2 retained publish is included — strictly more correct than a ledger could be.
  - Optional **`seedInstances`** (typed on `ServiceConfig`, §6 — channel address → list of param-maps) pre-materializes a deterministic demo set at startup (so onboarding isn't a blank UI).
  - **`reset`** re-materializes via `InstanceRegistry.restore(snapshot())` — **exactly the recorded set** (seed instances + those materialized since the last reset), re-seeded — so post-`reset` `/state` is deterministic **by construction**, not empty.

```ts
// Engine-owned instance lifecycle (F1) — the ONE owner of the materialization policy above; declared in model/, driven by the engine.
interface InstanceRegistry {            // the materialization LEDGER — NOT a mirror of current retained state (that is Aedes', read via getState / native delivery, R3)
  materialize(channelAddress: string, params: Record<string, string>): void;   // idempotent; records the concrete instance — the engine then publishes its L1 initial state via fake(channel, params) (CR1) so distinct instances differ
  snapshot(): InstanceSnapshot;          // captured at reset
  restore(s: InstanceSnapshot): void;    // re-materializes EXACTLY the snapshot set, re-seeded — post-reset /state deterministic (NOT derivable from getState, momentarily empty after reset)
}
interface InstanceSnapshot { instances: { channelAddress: string; params: Record<string, string> }[]; }
```
- **qos/retain resolution precedence** (**registry-resolved** — the registry already holds the spec binding; config injected at construction; result stored on the `Channel` (§1); the broker just carries the flags): **spec MQTT binding → offbook per-topic override → per-service default → global (qos 1)**. The middle tiers live in `ServiceConfig` (`topicOverrides` / `retainDefault` / `qosDefault`, §6). This chain binds the **Channel's** qos/retain; a per-call **explicit `/publish` body `qos`/`retain`** overrides that resolved value at emit (`body ?? channel`, §3 `resolveEmit` / §5), with an off-spec override surfaced via the §4 divergence warn-log (never silent).

## 3. Behavior engine — registration, dispatch, scheduling

**The scheduler lives here, not the transport.** It owns the virtual clock, applies `delayMs`, guarantees deterministic ordering, and (in v2) injects MQTT-semantic timing faults. `broker.emit` is publish-now.

**Clock model (G5 — virtual/wall split).** Two clocks, never conflated:
- **`now()` is logical**, not wall-clock: `fixedEpoch + Σ(resolved seeded delays applied on the emission timeline)`. This is what `{{now}}` stamps (l2 §5) and what emission ordering uses; it is a pure function of the seed, so it replays byte-identically.
- **Default scheduler = virtual time + a single event-loop yield, NOT real wall delay.** Forcing the client's async code to actually suspend/resume (design §6) needs only *one* yield boundary (`queueMicrotask`/`setImmediate`/`await`), not the literal `delayMs` elapsed in wall time. So the scheduler delivers each emit on the **next task** while advancing logical `now()` by the **full** seeded delay — async-forcing **and** deterministic **and** fast (CI never pays real seconds for a 300 ms step, and no wall-scheduler jitter can reorder anything). This is the DST-faithful default.
- **Real-wall latency is the wall-paced path selected by `config.wallClock`** (default off; `delayMs` of actual elapsed wall time) for human-perceptible/UX timing — never the CI path. `wallClock` is process-scoped (bound at startup, untouched by `reset`), so it can't perturb the determinism guarantee; it is the **one** switch both this emit-delay path and the tick cadence (below) key off, so the two wall behaviors can't diverge.
- **Autonomous `tick`** cadence follows the active scheduler-pacing mode (`config.wallClock`), mirroring how emit `delayMs` is applied (default `tickIntervalMs` `1000`; v1 tick cadence is **fixed** — seeded jitter deferred to v2): **fast-virtual** (`wallClock:false`, the CI/replay default) advances the virtual clock by `tickIntervalMs` per tick with **no** wall delay, so a determinism run over a **fixed virtual-time horizon** sees the same tick *count* and logical timestamps regardless of host load (F10) — this *is* the "**not** a wall `setInterval`" guarantee, scoped to the determinism domain; **wall-paced** (`wallClock:true`, interactive `offbook up`) fires a tick every `tickIntervalMs` of **wall** time (the human-visible ~1s daily-driver cadence) while still stamping logical `now()` for `{{now}}`. "Reproducible autonomous" = same seed + same virtual horizon ⇒ identical tick emissions and timestamps. **`passive` mode fires no ticks** (§5) — and, per G24, also freezes the scenario set (no watcher). **The determinism gate runs in `passive`:** CI boots `passive` via **`offbook up --ci`** (the startup profile that co-sets `mode=passive`, `wallClock=false`, `strict=true`; §1a / design §9) and the determinism test **asserts `GET /mode` is `passive`** before running, refusing (failing loud) otherwise — so the fast-virtual tick rate never reaches CI and the wall cadence never perturbs it (F10).

**Dispatch atomicity (G23 — run-to-completion per event).** The engine processes one event — an inbound publish, a `tick`, or a scheduled `emit` — and the synchronous handler work it triggers, **to completion before dequeuing the next**. Externally-driven inbound and virtual-clock emissions never interleave mid-event. Concurrent arrivals queue in arrival order: inbound by `meta.seq` assignment, emissions by the seeded timeline. This is what keeps `(seq, ordering)` host-load-independent under a fixed seed — without it, the determinism G6 establishes for the *counter* would be reintroduced as a *concurrency* race one layer down.

**Determinism invariant (F7) — no process-global PRNG cursor.** Every seeded draw is reproducible by construction: it is either **(i) keyed by a stable identity** — `mulberry32(hash(seed + <id>))`, where `<id>` is `(scenarioName, stepIndex)` for ranged delays (l2 §6), `(channelAddress[, instanceParams])` for the L1 faker, `(tickIndex)` for tick jitter (**deferred to v2**, but keyed this way when added) — **or (ii) a local counter scoped to a single run-to-completion dispatch unit** (G23): `ctx.random()` advances a per-handler-invocation counter, `{{seq}}` a per-scenario monotonic counter, `{{uuid}}` a per-scenario counter. **No draw reads a long-lived module-global `let rng`** shared across independent events, so an identical seed + inbound script reproduces a byte-identical stream regardless of host load or inbound interleaving. The L1 faker is driven via **json-schema-faker's native `seed` option** (set to `hash(seed + channelAddress + canonicalize(instanceParams))`, where `canonicalize` **serializes the param-map in a stable, sorted key order** (so the same logical instance keys identically regardless of capture-order vs `seedInstances` author-order) and yields the empty string when `instanceParams` is absent/empty — so example-mode reduces to `hash(seed + channelAddress)`), never a second Mulberry32 wrapping it (R4): the preimage widens to key per instance, but it is still **one** integer fed to JSF's native option.

**Two trigger paths** (refines design §4's flat ordering):

| Trigger | Layers (first-match-wins) |
|---|---|
| **Reactive** — client publishes (inbound) | **L3 → L2** (no L1) |
| **Proactive** — subscribe (initial state) / autonomous tick | **L3 → L1** on subscribe (L1 is the floor); tick is **L3-only** in v1 (L1 has no tick leg — D-009) |
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

declare function register(pattern: string, factory: HandlerFactory): void;   // pattern = AsyncAPI channel address w/ {param}; resolved by SpecRegistry.match at DISPATCH (lazy, F19)
```

- L3 **publishes through the engine scheduler**, never `broker.emit` directly (design §3 layering).
- **Emit completion (F13).** Before `broker.emit`, the engine completes every emit through one choke-point `resolveEmit(partial, channel) → NormalizedMessage`: parse `EmitStep.delay` (`"150-300ms"`, §3a) into a **keyed** `delayMs` (F7), resolve `qos`/`retain` as `partial.qos ?? channel.qos ?? 1` / `partial.retain ?? channel.retain ?? false` (an **explicit value wins, the resolved `Channel` fills the gap** — extending F13/CR7's omitted-case fill), default `delayMs` to 0. `HandlerContext.publish` (L3), the L2 scenario runner, **and a matched `toClient` `POST /publish`** all pass through it, so an authored `{topic, payload}` (no qos/retain) always reaches the broker at the channel-resolved QoS/retain; an **explicit** `qos`/`retain` differing from the channel binding is an intentional off-spec emit and fires the §4 / line-261 divergence warn-log so it is never silent.
- L1 is not registered — it's the built-in floor: the canonical **`Faker`** (`type Faker = (channel: Channel, instanceParams?: Record<string, string>) => Promise<unknown>`; declared in `model/`, CR8; **async** since json-schema-faker 0.6.x is async-only — see D-003 for the engine await-within-run-to-completion + `/pending.scheduled` obligations), keyed-seeded (F7: `hash(seed + channelAddress + canonicalize(instanceParams))` via json-schema-faker's native seed, R4) and Ajv-rechecked before emit (drop-and-surface on failure, F5/§4). **Two call modes, one function:** the engine **initial-state/materialization** path calls `fake(channel, params)` with the `InstanceRegistry` instance's params, so distinct instances (`thermostat-1` vs `thermostat-2`) get distinct payloads — the `seedInstances` multi-device demo renders distinct devices; **example generation** — `GET /topics` (channel-level, params unknown) and `POST /publish {example:true}` — calls `fake(channel)` with `instanceParams` **omitted** (example-mode deliberately drops even a concrete `/publish` topic's matched params), so both reduce to `hash(seed + channelAddress)` and stay **byte-equal** (F11). The engine provides the one implementation; **control-plane receives it by injection** (not a direct import), wired at the composition root (`offbook up`). Because the faker is a pure keyed function (no shared cursor, F7; memoizable on `(channelAddress, canonicalize(instanceParams))`, F21), it injects as a plain `Faker` with no lifecycle/state to manage.
- L2 scenarios are loaded per `l2-scenarios.md` (sorted-path → in-file dispatch order).
- *(Deferred: AsyncAPI-3.0 reply-channel auto-response as a future L1 reactive enhancement.)*

**L3 discovery & `register` semantics (G11).** L3 modules are discovered by the glob `handlers/**/*.ts` (mirroring L2's `scenarios/**/*.yaml`); each module calls `register(...)` on import. The first argument is a **channel pattern** — the full AsyncAPI channel address with single-segment `{param}` captures (e.g. `command/{deviceId}/set`), **not** a bare literal prefix and **not** an MQTT `+`/`#` subscribe filter. It is resolved by the **same matcher the registry owns** (the `SpecRegistry.match(topic)` of §1/§2), so a concrete inbound topic routes to the same channel for L3 as for validation and `/publish`. When more than one registered pattern matches a topic, precedence is **identical to that matcher's**: most-specific (a literal segment beats a `{param}`), then sorted module path → registration order — so reordering files never changes the winner. **Resolution timing (F19) is lazy:** `register(pattern, factory)` stores the *raw pattern* and resolves it against `SpecRegistry.match` **at dispatch, against the *current* registry** — so a handler needs no specs loaded at import time and survives a `POST /specs/refresh` hot-swap (§5) without rebinding to a stale channel set.

**`emitSource` provenance (G10).** `broker.emit` is content-only (§2) and carries no layer/scenario/step identity; the **engine** owns emit and therefore knows which layer produced each message. The engine attaches the in-scope `EmitSource` (§4) to any `mock` `Violation` raised by that emit's Ajv recheck: the **L1** floor sets `{ layer: 'L1' }`; the **L2** scenario runner sets `{ layer: 'L2', scenarioName, stepIndex }` (`scenarioName` = the matched `Scenario.name`, `stepIndex` = the 0-based index into its `then[]` — §3a); the **L3** `register` wrapper tags its `ctx.publish` calls `{ layer: 'L3', … }`. So a mock violation is never shipped with `emitSource` permanently `undefined`.

## 3a. Scenario model (L2)

The normalized, parsed shape of an L2 scenario — the type `scenarios/` (dispatch table, matcher, templating) and `control-plane` (`POST /trigger/{name}` → `{ scenario, fired, sinceSeq }`) both import. Transcribed from `l2-scenarios.md` §9 (the authoring format; this is the canonical *type*).

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

import type { ErrorObject } from 'ajv';   // type-only; `ajv` is not a transport package, so transport-isolation holds
// SchemaError IS Ajv 8's ErrorObject minus `data` (the raw offending value — carried separately as Violation.payload) and
// `schema` (the subschema) — both bulky/non-serializable. A DERIVED alias, never a hand-rewrite, so it can't drift from Ajv
// (R5). Keeps: keyword, instancePath, schemaPath, params (REQUIRED), message? (OPTIONAL), propertyName?, parentSchema?
// (itself a schema object — content-stable from the deterministic bundled schema, so the F9 byte-identical projection still
// holds). Crosses the HTTP boundary; consumers read `message` as possibly-undefined and `params` as always-present.
type SchemaError = Omit<ErrorObject, 'data' | 'schema'>;

type EmitSource = { layer: 'L1' | 'L2' | 'L3'; scenarioName?: string; stepIndex?: number };  // engine-populated provenance (§3), present when origin === 'mock'

interface Violation {
  seq: number;                     // UNIQUE, monotonic, per-entry log cursor; reproducible; the sole /validation ordering key (G6)
  observedAt: string;              // ISO8601 wall-clock; human; non-reproducible
  origin: 'client' | 'mock';
  kind: ViolationKind;
  severity: 'error' | 'warning';   // v1: ALWAYS 'error' (pinned per-kind map below); 'warning' reserved for v2 qos-mismatch
  topic: string;
  channel?: string;                // AsyncAPI channel matched / should-match
  detail: string;                  // terse, STABLE machine rendering — for kind:'schema' a derived `<instancePath>: <keyword>` (deterministic; lives in the F9 projection). Human-friendly phrasing is rendered by the CLI/ER2 from `errors[]`+`payload`, NOT stored here, so wording can evolve without breaking byte-identical goldens (EQ6).
  payload?: unknown;               // offending/contextual; raw string for decode; may be truncated
  clientId?: string;               // when origin === 'client'
  errors?: SchemaError[];          // when kind === 'schema'
  emitSource?: EmitSource;          // when origin === 'mock' (engine-populated, §3)
}
```

- Single record with optionals (not a discriminated union) for v1.
- **`severity` is a pinned function of `kind` (v1).** Default-severity map: **`schema` → `error`, `direction` → `error`, `decode` → `error`, `unknown-topic` → `error`** — i.e. **every v1 `Violation` is `error`**, so `ValidationSummary.warnings` is deterministically `0`. The `'warning'` arm of the type is **reserved** for the deferred `qos-mismatch` kind if it is ever promoted from the tier-3 warn-log (the v2 deferral, §7 / line 261). There is **no per-deployment override in v1** — the table *is* the policy, keeping `severity` a pure function of `kind` so the F9 canonical projection (the determinism golden) stays byte-stable across builders. *(Possible v2: a `severityOverrides?: Partial<Record<ViolationKind, 'error' | 'warning'>>` Config field to downgrade a kind — e.g. `unknown-topic` — without a code change; a team needing this in v1 can compute a custom gate from `summary.byKind`.)*
- **`emitSource` is engine-populated (G10):** `broker.emit` is content-only, so the **engine** (which owns emit) stamps the active layer onto any `mock` violation raised by that emit's recheck — `L1` for the faker floor, `L2` with `scenarioName` (= `Scenario.name`, §3a) + `stepIndex` (the `then[]` index) for the scenario runner, `L3` for `register`ed handler `ctx.publish` calls. It is therefore never permanently `undefined` for a `mock` violation.
- **Failed pre-emit recheck = drop-and-surface (F5).** A `mock` payload that fails its pre-emit Ajv recheck is **not emitted**; the engine raises an engine-stamped `mock` `Violation` and **never re-draws on the live cursor or emits the invalid payload**. The proactive L1 floor for that channel stays empty on failure — the loud `mock` violation flags it. Whether to add a **keyed** fallback re-draw (F7-safe) to keep the floor populated is gated on the F8 faker-fidelity spike; "`L1 output always Ajv-valid`" (build-plan) describes the *emitted* stream (invalid drops out), not a guarantee the faker never errs.
- **`seq` is unique per log entry (G6).** It is a strictly-increasing cursor minted as the violation is logged — *not* shared across a group of violations. `/validation` orders by `seq` **alone** (a total order; no `insertion` tiebreak), `?sinceSeq=` is **strictly-greater**, and the `reset` baseline is the last assigned `seq` (so the first post-reset entry is `baseline + 1`). This is exactly what makes `fce44fa`'s `summary.oldestSeq` (lowest still-retained `seq`), FIFO ring-buffer eviction, and the `sinceSeq` boundary mutually coherent: under a non-unique `seq`, a group sharing one value could be split by eviction or dropped/double-counted at the boundary. The two `seq` notions are **separate counters**, never one overloaded field: `Violation.seq` here is the unique per-entry log cursor; `InboundEvent.meta.seq` (§1) is the engine's inbound-arrival ordering counter.
- **Determinism guarantee (precise).** Given a fixed inbound script + seed, the emission/violation stream and its `seq` ordering are byte-identical across runs. The CI harness drives inbound deterministically (`reset` → `publish`/`trigger` → poll), and run-to-completion dispatch (§3) plus the logical clock (§3) make the ordering independent of wall scheduling and host load. **The comparison is over a canonical projection (F9):** `Violation` **minus** `observedAt` (wall-clock) and `clientId` (arbitrary for real ws clients) — i.e. `{ seq, origin, kind, severity, topic, channel, detail, errors, emitSource, payload }`. The harness applies this field-mask before diffing two `/validation` responses, so the wall-clock fields are excluded **by contract**, not by accident.
- **Three-tier surfacing:**
  1. **`/validation`** — structured runtime contract violations (CI-grade; the §5 headline).
  2. **`/diagnostics`** — static config/load issues (scenario-load errors, overlap/shadow warnings).
  3. **warn-level logs** — low-ceremony runtime notices, e.g. a **qos/retain divergence from the spec binding** — observed on real traffic *or* produced by an explicit off-spec `/publish` `qos`/`retain` override (§3/§5) — (surfaced-not-silent; *not* a `Violation`; one-line upgrade to a `qos-mismatch` kind if it ever matters).

## 5. Control-plane HTTP API

**Conventions:** `/v1` prefix · JSON only · error envelope `{ error: { code: ErrorCode, message, details? } }` where `ErrorCode` is the closed union below · **actions return promptly after *injecting*** (a `202` means "injected", never "drained" — uniform across modes); to wait for the emissions an action caused to reach **quiescence**, use `GET /v1/pending?wait` below (the moment-4 synchronous-CI primitive, EC1) · no-auth / no-CORS / localhost bind (dev appliance; the client uses MQTT, not this API).

### Reads
| Endpoint | Returns | Notes |
|---|---|---|
| `GET /v1/topics` | `{ topics: TopicInfo[] }` — or `{ topics: Omit<TopicInfo, 'schema'>[] }` under `?schema=false` | dereferenced **schema + seeded example inline** (via the injected `Faker`, F11); `?direction=` / `?service=` filters; **`?schema=false`** is the slim discovery view — drops the bulky `schema` field **only** (keeps `example` + all else), so `schema` stays **required** on the full `TopicInfo` |
| `GET /v1/state` | `{ state: StateEntry[] }` | lean, **concrete** topics; `?topic=` prefix filter |
| `GET /v1/validation` | `{ violations: Violation[]; summary: ValidationSummary }` | `?sinceSeq=` (strictly-greater) `?origin=` `?severity=` `?kind=`; ordered by `seq` alone (now a total order — G6); violations-only. **Bounded ring buffer** — see note below |
| `GET /v1/specs` | `{ specs: SpecInfo[]; resolutionMode; warnings? }` | `resolutionMode: 'branch' \| 'pinned'` honesty flag (design §7); in **branch** mode `warnings?` carries the version-not-honored notice — "requested versions in `environments.yaml` are recorded but NOT honored; fetching branch tips (serviceA→main, serviceB→dev)", naming each service's actual branch; suppressed under `pinned`/`--frozen` (EQ2) — **both v2; v1's `resolutionMode` is always `'branch'`, so the notice always shows**. Each `SpecInfo` also carries `source` + `fetchedAt` — the **content-axis** trust surface (design §7, Mode 3): validation is against the spec **as fetched**, so age shows **neutrally** (no stale threshold) for the dev to weigh; `offbook status` composes this |
| `GET /v1/diagnostics` | `{ diagnostics: Diagnostic[]; summary: DiagnosticSummary }` | load/hot-reload-populated; dev-time surface |
| `GET /v1/scenarios` | `{ scenarios: ScenarioInfo[] }` | discovery for the authored L2 layer (P8): name · `when` topic (reactive) or trigger-only · `stepCount` · `source` file — from the loaded dispatch table (l2 §3); `offbook scenarios` renders it |
| `GET /v1/mode` | `{ mode, seed, lastResetSeq }` | `lastResetSeq` = the violation-log baseline captured by the most-recent `POST /reset` (`0` before the first) — the server-retained checkpoint `offbook check` reads by default (P8, D-014) |
| `GET /v1/pending` | `{ scheduled: number; settled: boolean }` | **quiescence signal (EC1).** `scheduled` = pending reactive/triggered emits still queued, **excluding** the perpetual `autonomous` tick (else it never reaches 0). `?wait` **blocks server-side until `scheduled === 0`** — the synchronous drain the moment-4 CI loop wants (in `passive`+fast-virtual there's no wall time to pay; in wall-paced it waits the real delays) — bounded by the F10 virtual horizon; `?wait=<ms>` caps the wait. `settled` is `true` when it reached 0, `false` if it returned at the cap. Actions stay prompt-`202`; this is the **explicit** settle step (CLI `--wait` wraps it); no `POST /drain` in v1 |

```ts
interface TopicInfo { topic: string; direction: Direction; service: string;
  title?: string; description?: string; schema: object; example?: unknown; qos?: 0|1|2; retain?: boolean; }
interface StateEntry { topic: string; payload: unknown; qos?: 0|1|2; retain: true; }  // retain is always true — clearing a retained topic EVICTS it (§2), so /state never returns tombstones; a decode-failure (§2) is never stored, so payload is always a successfully-decoded value
interface SpecInfo { service: string; declaredVersion?: string; specVersion?: string; source: string; contentHash: string; channelCount: number; fetchedAt: string; }  // declaredVersion = info.version, read parser-free by ingestion/ (shallow yaml read, G12) — NOT the requested version (they differ in v1 branch mode). specVersion = the AsyncAPI DOCUMENT version (the `asyncapi` field, e.g. '3.1.0'), read in the same parser-free pass — which spec major this service is on (D-018), not the service's own info.version. fetchedAt (ISO8601, propagated from the lockfile `fetched-at`) = spec provenance/age for TRUST CALIBRATION — the tool validates against the spec AS FETCHED, never the live service; surfaced NEUTRALLY (no stale threshold) by GET /specs + status (design §7, Mode 3)
interface ScenarioInfo { name: string; when?: string; stepCount: number; source: string; }  // GET /scenarios discovery (P8): `when` = the reactive trigger topic (absent ⇒ on-demand/trigger-only); source = scenario file path
interface Diagnostic { kind: 'scenario-load' | 'overlap' | 'spec-load' | 'uninstantiated';
  severity: 'error' | 'warning' | 'info'; detail: string; source?: string; scenarioName?: string; }
// 'uninstantiated' (info, EQ5) — emitted at startup for each parametrized toClient channel with ZERO materialized
//   instances, counted from the engine's InstanceRegistry ledger (NOT the async getState() retained store). The channel
//   ADDRESS goes in `source?` (machine-filterable — Diagnostic has no `channel` field); the teaching sentence ("no
//   instances yet — subscribe to a concrete topic, send a matching command, or add seedInstances") goes in `detail`.
//   Cleared once an instance materializes.
// 'spec-load' (warning) — non-fatal spec-QUALITY findings surfaced at load. v1 instance: the VACUOUS-SCHEMA flag — a
//   channel whose schema asserts effectively nothing ({}, true, or type:object with neither properties nor required),
//   so a client publish validates GREEN while the contract checked nothing (false confidence — design §7 Mode 2). Channel
//   ADDRESS goes in `source?`; teaching `detail` ("validates green but its schema constrains nothing — passing here is
//   unverified"). Scoped tight to the unambiguous vacuous shapes — NOT a graded quality score (deferred). FATAL load
//   failures (unreachable/unparseable spec) do NOT appear here — they abort `up` in the foreground (design §7 Mode 1).
//   'spec-load' ALSO carries the REGISTRY-TIME findings of `SpecRegistry.diagnostics()` (§1, D-018): findings only the
//   catalog build can see, so they cannot be recomputed from a Channel. The kind union stays closed (four values, and
//   DiagnosticSummary.byKind keeps exactly those four keys, zero-filled); each finding is instead machine-identified by
//   a stable tag prefix on `detail` (the tag, then `: `, then the sentence): 'binding-on-channel',
//   'binding-invalid-value', 'binding-unknown-key', 'mqtt5-field-ignored', 'dialect-mismatch', 'schema-compile-failed'.
//   Channel ADDRESS in `source?` as above, so filtering by tag and by address both work.

interface ValidationSummary {    // the CI-facing payload of GET /v1/validation
  errors: number;                // count of severity === 'error' violations (within the retained window)
  warnings: number;              // count of severity === 'warning' (0 in v1 — every kind defaults to 'error', §4)
  byOrigin: { client: number; mock: number };  // counts ALL severities, not errors-only
  byKind: Record<ViolationKind, number>;        // ALL kinds always present, zero-filled (schema, direction, unknown-topic, decode)
  oldestSeq: number;             // lowest still-retained seq (bounded ring buffer); 0 when the log is empty
  distinct: { total: number; client: number; mock: number };  // DISTINCT-violation counts (mirrors byOrigin on the distinct axis) — keyed by structural signature (origin + kind + channel + errors[0] instancePath+keyword), NOT the raw payload value. A DERIVED read-side projection: the per-entry log/seq/F9-golden/byOrigin/CI gate are ALL unchanged. `distinct.client` powers the status scoreboard ("caught N distinct breaks"); the `offbook validation` human view collapses repeats to ×N (design §5). Deterministic (pure function of the log)
}

interface DiagnosticSummary {    // mirrors ValidationSummary for GET /v1/diagnostics (F15)
  errors: number; warnings: number; info: number;
  byKind: Record<'scenario-load' | 'overlap' | 'spec-load' | 'uninstantiated', number>;   // all four keys always present, zero-filled
}

// Closed set of error-envelope codes (every non-2xx path returns one); the CLI/CI branch on this union, no ad-hoc strings.
type ErrorCode =                 // closed union; NB there is NO 'unknown-topic' code — an unmatched /publish returns 202 + raises an 'unknown-topic' VIOLATION (§4), not an error envelope; the name lives only as a ViolationKind
  | 'unknown-scenario'           // POST /trigger/{name} with no such scenario
  | 'bad-request'                // malformed body / params (generic 400)
  | 'example-on-unknown-topic'   // POST /publish { example: true } on an unknown topic
  | 'example-and-payload';       // POST /publish with BOTH payload and example present
```

> **Violation-log retention.** The log is a **bounded ring buffer** capped at `config.maxViolations` — a fixed-size **circular buffer with head/tail indices** (O(1) insert + evict, never `push`/`shift`; `seq`/`oldestSeq`/`sinceSeq` map onto ring indices — F21) — so a left-running dev instance has a **memory ceiling, not unbounded growth**. (It is the only unbounded log in v1 — `/state` is the retained store, bounded by topic count; `config.maxEvents` is reserved should inbound-event history ever be retained.) `seq` is **unique per entry**, process-monotonic, and **never reused** (G6), so `?sinceSeq=` (strictly-greater) stays correct even across eviction; `summary.oldestSeq` is the lowest still-retained `seq`, so a caller whose `sinceSeq < oldestSeq` knows older violations were evicted. **The CI loop is unaffected** — its `reset`-checkpoint → poll window holds far fewer than `maxViolations` entries, so nothing it cares about is ever evicted. (`reset` does not clear the log — eviction is by capacity only.)
| Endpoint | Body | Result | Notes |
|---|---|---|---|
| `POST /v1/publish` | `{ topic, payload?, example?, qos?, retain? }` — **`payload` XOR `example`** | `202 { topic, direction: Direction \| null, matched, injected, sinceSeq }` | **direction inferred from the channel** (toClient drives UI / fromClient simulates client + validates); reports resolved `direction` (or `null` when no channel matches). **`matched: boolean`** says whether the topic resolved to a channel; **`direction` is `null` iff `matched === false`** — normative, with the nullability scoped to the `/publish` *response* only (`Channel.direction`/`TopicInfo.direction` stay non-null). **`injected: boolean`** is the body-level confirmation that the publish reached the broker — `true` on this `202` for every path that emits (matched or not; an unmatched topic still publishes raw), **except an F5 example-drop** (§4): when `example: true` produces a payload that fails its pre-emit Ajv recheck, the mock **declines to emit the invalid payload** (F5 drop-and-surface) and returns `injected: false` with an L1 `mock` `Violation` recorded (poll `?sinceSeq=`) — the sole case where `matched: true` pairs with `injected: false` (D-004). On every other `202` it is `true`, mirroring `/trigger`'s `fired` and `/reset`'s `reset`. An unmatched topic still **publishes raw** (observe-and-surface) and raises an **`unknown-topic`** `Violation`; the CLI exits nonzero on it unless `--force` (design §9). `sinceSeq` is the **Violation-log baseline before injecting** (the strictly-greater cursor `?sinceSeq=` consumes, G6) — defined for **both** directions; poll `/validation?sinceSeq=<returned>` for this publish's violations. (A `fromClient` or unknown-topic publish re-enters `onInbound` as `origin: client` with an internal engine-assigned `meta.seq`, G9 — a different number-space, **not** returned; a matched `toClient` publish is a mock emission with no `InboundEvent`.) `payload?: unknown` is an explicit value; `example?: boolean` (`true`) generates a seeded schema-valid payload **at channel level** (`instanceParams` omitted ⇒ byte-equal to `GET /topics`, CR1/F11); **both present → `400 example-and-payload`**; `example: true` on an unknown topic → `400 example-on-unknown-topic`. **Body `qos`/`retain` override** the channel-resolved values (`body.qos ?? channel.qos ?? 1`, §3 `resolveEmit`) — omit them for spec-faithful emit; an explicit value **differing from the channel binding** is an intentional off-spec emit, surfaced via the §4 tier-3 divergence warn-log **and** a CLI heads-up (design §9), never silent |
| `POST /v1/trigger/{name}` | `{ params?, payload? }` (omitted → seed-faked) | `202 { scenario, fired, sinceSeq }` | `params` entries bind the scenario's `{{param}}` captures (e.g. `params.deviceId` → `{{deviceId}}`); `payload` supplies the inbound payload for a reactive scenario fired by hand; `sinceSeq` is the **log baseline before firing** — poll `/validation?sinceSeq=` for the violations this trigger produced (F3; uniform with `/publish` + `/reset`, and universally defined — an on-demand scenario has no inbound `meta.seq` source). `404 unknown-scenario` |
| `POST /v1/reset` | `{ seed? }` | `200 { reset, seed, sinceSeq }` | returns **active seed + the `sinceSeq` log baseline** (feeds `?sinceSeq=`, F3); **non-destructive** — re-seeds PRNG, resets virtual clock, re-instantiates L3 handler **state** (not changed code — code edits need a process restart, e.g. `offbook up --watch`; l2 §8/EH1), republishes initial state, halts autonomous; the log cursor is process-monotonic, log not cleared |
| `POST /v1/mode` | `{ mode: 'autonomous' \| 'passive' }` | `200 { mode, seed }` | default `autonomous` (design §7b); startup flag/env boots `passive` for CI; mode-set ≠ reset |
| `POST /v1/specs/refresh` | — | `200 { specs: SpecInfo[] }` | re-resolves each service but **skips parse + Ajv-recompile + swap for any service whose `content-hash` is unchanged** (short-circuits the entire swap when all hashes match — F21), rewrites `specs.lock`, hot-swaps the running registry, returns the new `SpecInfo[]` — no restart; `offbook specs update` calls this (the running server's registry would otherwise go stale). `up`/`down` are **not** endpoints — see the process-management note below (G14) |

> **`passive` quiesces both the clock *and* the scenario set (G24).** Just as `passive` fires no autonomous ticks (§3), it also **freezes the L2 scenario set**: scenarios are loaded once at startup and the file watcher / hot-reload is **off**, so editing a scenario file between `reset` and an assertion cannot change which scenario matches. Hot-reload (l2 §8) is a dev-only, `autonomous`-mode affordance. This makes the dispatch table as deterministic across a CI window as the emission stream.

- **A `fromClient` `/publish` re-enters the broker's inbound path (G9).** An HTTP-injected publish has no ws client to mint `meta`, so the control-plane synthesizes an `InboundEvent` and feeds it through the **same `onInbound` path the broker uses for real client publishes** — `meta.clientId = 'control-plane'` (configurable via `config.injectedClientId`), `meta.receivedAt = wall now`, `meta.seq` assigned by the engine — so it is validated identically to a real publish and tagged **`origin: 'client'`**. A contract break therefore lands in `byOrigin.client` (never silently in `byOrigin.mock`), so the headline gate below can't false-negative on injected traffic.
- **`up` / `down` are NOT HTTP endpoints — they are process management (G14).** No request can start the server that would serve it; `offbook up` **spawns the server detached, writes a PID + port runfile (`<runDir>/offbook.run`: pid + the three ports + `startedAt`; `<runDir>` = `config.runDir`, cwd-relative, default `.offbook/` — §1a), and probes the control-plane port for readiness**; it also redirects the detached server's stdout/stderr to `<runDir>/offbook.log` (alongside the runfile — **text**, size-capped + one rotation, **appended** across `up --watch` restarts so it stays continuous; it carries the design §8 credential-attribution and l2 §8 hot-reload notices, and `offbook logs`/`status` read it — EO1). `offbook down` reads the runfile and signals the process, leaving the log for post-mortem. (`offbook specs update` *is* HTTP — it hits `POST /v1/specs/refresh` above so the running registry doesn't go stale.)
- **Lifecycle robustness + side-by-side (P7).** Before detaching, `offbook up` **preflights all three ports**; a conflict fails **fast in the foreground** with a named fix (*"port 1883 in use — another broker? set `brokerTcpPort` or `--tcp-port`"*) — never a cryptic detached `EADDRINUSE`. It **refuses to double-start**: if `runDir`'s runfile names a **live** offbook (pid alive **and** the control port answers as offbook) it exits nonzero (*"already running (pid N, ports …) — run `offbook down` first"*); a **stale** runfile (pid dead, or the control port silent — this also covers a reused PID) is **auto-reclaimed** with a one-line note. `offbook down` is **idempotent** — a dead/absent pid cleans the runfile, reports *"not running"*, and exits 0. **Side-by-side:** `--ws-port` / `--tcp-port` / `--ctrl-port` override the `config.*Port` fields (§1a) so two environments run from different `runDir`s without colliding. **Connect target:** `up` and `status` print *"point your MQTT client at `ws://localhost:<brokerWsPort>` (MQTT 3.1.1)"* using the resolved ws port — the exact subprotocol/auth shape is filled in by the connect-capture spike (design §8).
- **`offbook demo` is a third process-management command (not an endpoint).** It boots an **ephemeral** server against a **bundled** demo spec — **no `services.yaml`, no git, nothing written to `runDir`** — over no new HTTP surface (it drives the existing `POST /v1/publish` + `GET /v1/validation`): it seeds populated state, runs a scripted **off-contract** publish, prints the caught `Violation`, and tears down. It exists to show validation (the *lead*) on run #1 (design §1/§9); it ships in the M0 milestone as an **output**, not its acceptance gate (the re-pointed M0 gate is the `mqtt.js`⟷Aedes retained-receipt WS check + `offbook topics` discovery — build-plan §3).

The CI loop reads cleanly: `reset` (checkpoint `sinceSeq`) → `publish`/`trigger` → **`GET /pending?wait`** (settle — one blocking call, no poll-with-timeout, EC1) → read `GET /validation?sinceSeq=<checkpoint>` → assert `summary.byOrigin.client === 0`. **`offbook check` wraps that assertion (P8):** it reads `GET /validation` since the **last `reset` baseline** (the server retains the most-recent `reset` `sinceSeq`, surfaced as `lastResetSeq` on `GET /mode` — D-014; `--since <seq>` overrides) and **exits nonzero iff `summary.byOrigin.client > 0`** — the one-command CI gate (`offbook check || exit 1`), printing the distinct-break count for the human.

## 6. Spec ingestion & config (the design §7 seams, v1)

v1 ships the **branch stopgap** behind design §7's forward-compatible seams; `specs.lock` from day one; semver→ref resolution is v2.

```ts
interface ServiceConfig {
  name: string;
  repo: string;            // full URL (https://… or git@…:…), used as-is; OR an 'org/name' slug resolved against gitHost (G20)
  gitHost?: string;        // per-service base URL override for the slug form; falls back to the global gitHost (G20)
  specPath: string;        // v1: a fixed path
  branch?: string;         // v1 ref selection; default 'main'
  qosDefault?: 0 | 1 | 2;  // per-service default qos — tier 3 of the §2 precedence chain (above the global qos 1 fallback; the last config tier, consulted just before global) (G13)
  retainDefault?: boolean; // per-service default retain — tier 3
  topicOverrides?: Record<string, { qos?: 0 | 1 | 2; retain?: boolean }>;  // per-topic override — tier 2 (above the per-service default, below the spec binding); key = channel address, matched by STRING-EQUALITY against channel.topic (the {param} form) — not routed through SpecRegistry.match, not concrete topics (F14)
  seedInstances?: Record<string, Record<string, string>[]>;  // channel address → list of param-maps; pre-materializes a deterministic demo set at startup (F1; §2 InstanceRegistry). Each map binds ALL of a channel's {params}, so multi-param channels work
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
  specVersion?: string;     // the `asyncapi` document version (e.g. '3.1.0') — same parser-free pass; best-effort (absent ⇒ undefined)
  fetchedAt: string;        // ISO8601
}

interface Resolver      { resolve(repo: string, ref: string, specPath: string): Promise<ResolvedSpec>; }  // v1+v2: GitRefResolver
interface VersionSource { versions(environment: string | null): Promise<Record<string, string>>; }        // v1: StaticManifestSource
```

- **`GitRefResolver` is the only resolver, v1 and v2** — fetching a spec at a git ref is identical regardless of ref kind. The v1↔v2 difference is purely *ref selection*: v1 uses `ref = serviceConfig.branch ?? 'main'` (a moving branch tip, unpinned); v2 resolves a requested semver → a pinned tag/sha via the `versionToSha` strategies. **v1 hands it a branch tip on `up` — the only ref kind v1 uses;** the by-SHA path (v2's `up --frozen`, which passes `ref = lockEntry.resolvedSha`) is deferred. The signature is unchanged — a SHA is just another ref — so v2 slots in behind this seam with no restructure.
- **SHA acquisition (writer side, G4).** v1's writer **shallow-fetches the branch ref** and records the **full SHA of what it fetched** (read post-fetch, e.g. `FETCH_HEAD` — inherently consistent, since it records exactly the bytes it pulled) into `specs.lock`. `<repoUrl>` is `serviceConfig.repo` when it is a full URL, else the `org/name` slug resolved against `gitHost` (G20). **Deferred to v2 (the by-SHA path):** *atomic* acquisition (`git ls-remote <repoUrl> <branch>` → a full SHA, then fetch **that** SHA via `git fetch <repoUrl> <sha>`, relying on `uploadpack.allowAnySHA1InWant`; **not** `git archive --remote`, which hosts refuse for an unadvertised SHA) **and the F17 fallback** (when `allowAnySHA1InWant` is off, shallow-fetch the branch ref + walk history to the locked SHA) — both needed only to fetch a *specific historical* SHA for the v2 `--frozen` reader, never in v1.
- **Lockfile reader (`up --frozen`) — v2 (G4).** v1's `offbook up` always re-fetches each service's **branch tip** (branch mode = liveness, honestly warned) and writes `resolution-mode: branch`. The **v2** `offbook up --frozen` (alias `--locked`) loads `specs.lock` and re-resolves **each service by its `resolvedSha`**, writing `resolution-mode: pinned` — this is what makes the stored SHA load-bearing and the reproducibility guarantee real. So **in v1, `GitRefResolver` only ever receives a branch tip** (the by-SHA path is v2 — no contradiction); v1 *records* `resolvedSha` but never reads it back.
- **`resolvedRef` vs `resolvedSha`:** `resolvedRef` = what we asked git for (branch/tag/sha — provenance, disambiguated by `resolution-strategy`); `resolvedSha` = the full canonical commit it dereferenced to (the pin). When the ref *is* a sha they may be identical. **Always store the full sha** — git auto-expands abbreviations as repos grow, so a short sha is not a stable identifier and would break reproducibility.
- **Spec-load failure is FATAL (design §7, Mode 1).** A service whose spec fails to fetch (unreachable repo, bad creds, missing branch) or parse **aborts `offbook up`** with a named, actionable **foreground** error (`service X: spec fetch failed — <repo>@<branch>: <cause>`) — *before* the server detaches (the §5 / G14 readiness probe is preceded by this spec-load gate) — never a raw git/parse stack trace. This is **independent of `config.strict`**, which governs **scenario**-load only (§1a): the spec is the foundational source of truth, so a missing one is non-negotiable, whereas a bad scenario stays skipped-loud. *(A spec that **parses** but yields zero channels is not a load failure — it is the vacuous/quality path: a `spec-load` Diagnostic, §5 / design §7 Mode 2, not an abort.)*

### Config files (v1 minimal, v2-shaped)
```yaml
# services.yaml — per-service location (v1: repo + fixed specPath + optional branch; strategy machinery is v2)
gitHost: https://git.example.com   # global base URL for slug-form repos — NO built-in default (host-agnostic); a slug with no gitHost is a config error (G20). `offbook init` scaffolds this file with gitHost: <PLACEHOLDER> (EI1)
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
  declaredVersion?: string;        // info.version
  specVersion?: string;            // the `asyncapi` document version
  contentHash: string;                 // "sha256:…"
  fetchedAt: string;                   // ISO8601
  resolvedVersion?: string;            // v2 only — semver after range policy
}
```
```yaml
lockfile-version: 1
environment: default
resolution-mode: branch             # 'branch' | 'pinned' — the warning names the branch (design §7 "never lie about fidelity")
generated-at: 2026-06-23T…
services:
  serviceB:
    requested-version: 2.0.1        # from environments.yaml — recorded, UNHONORED in v1
    resolution-strategy: branch
    resolved-ref: dev               # selection input
    resolved-sha: 9f2c3a1b4d5e6f70819a2b3c4d5e6f7081929a3b   # FULL commit sha
    spec-path: asyncapi.yaml
    declared-version: 2.0.0    # info.version
    spec-version: 3.1.0             # the `asyncapi` document version (optional, best-effort)
    content-hash: sha256:c1d2…      # byte fingerprint
    fetched-at: 2026-06-23T…
    # resolved-version:  (v2 only — semver after range policy)
```

> **Key-casing convention:** hand-authored config (`services.yaml`, `environments.yaml`) uses **camelCase** keys mirroring the TS fields (`specPath`, `branch`); the generated **lockfile uses kebab-case** throughout (`lockfile-version`, `resolution-mode`, `spec-path`, …). A `LockEntry`↔YAML serializer maps camelCase fields → kebab keys uniformly. *(The `resolutionMode` field on the `GET /v1/specs` JSON response stays camelCase — HTTP/JSON DTOs are camelCase; only the on-disk YAML is kebab.)*

- Recording **`resolved-ref` + full `resolved-sha` + `content-hash`** in v1 lays the **data** for reproducibility; the **guarantee itself is realized in v2** by the `up --frozen` reader (§6 GitRefResolver bullet) — rebuild the exact mock even after the branch moves by re-resolving each service at its `resolved-sha`. v1 *writes* the SHA but never reads it back; the byte-identical acceptance test is a **v2** check against a **pinned SHA**, not a live tip (a mutable tip has no operationally-definable byte-identity).
- **`declared-version` is written by `ingestion/`, parser-free (G12).** Ingestion does a **shallow `info.version` read with the `yaml` lib** (already a dependency) on the fetched bytes — **no `@asyncapi/parser` import** — so the lockfile `declared-version` and `SpecInfo.declaredVersion` are populated without serializing ingestion behind `registry/`'s full parse. It is best-effort: absent `info.version` ⇒ the field stays `undefined` (optional on both `ResolvedSpec` and `LockEntry`).
- **`spec-version` rides the same parser-free pass (D-018).** Alongside `info.version`, ingestion reads the document's **`asyncapi`** field and records it as `spec-version` in the lockfile and `SpecInfo.specVersion`, so `GET /v1/specs` answers which spec major each service is on. It is **not** `requested-version` and **not** `declared-version`: those are the service's own release version, this is the AsyncAPI document version (`2.0.0`…`3.1.0`, the supported range). Optional and best-effort on the same terms: an unreadable or absent `asyncapi` field leaves it `undefined` and the key is omitted from the YAML. `offbook doctor` deliberately does **not** report it: doctor's spec checks are network-free, while the spec text lives in a remote repo that only `ingestion/` fetches.
- The declared-vs-requested **drift-check is v2** (v1 always fetches a branch tip, so there's no resolved semver to check).
- **Seam-complete:** `environments.yaml` exists in v1 so `requested-version` is real and the requested-vs-resolved gap is *honestly visible*; v2 swaps `StaticManifestSource → ReleaseToolingSource` with no restructure. *(F20: kept deliberately — the honest requested-vs-resolved provenance is judged worth the v1 carry, over deferring the unused machinery to v2.)*

## 7. v1 / v2 boundary (what these contracts stub)

**In v1, behind these seams:** `GitRefResolver` selecting `ref = branch`; `StaticManifestSource`; single `default` environment; `specs.lock` with `resolved-ref`/`resolved-sha`/`content-hash`.

**Deferred to v2 (no restructure — implementations swap behind the same seams):** `versionToSha` strategy enums + range policy + manual override in `services.yaml`; `resolved-version` + drift-check; the **`up --frozen` by-SHA reader + F17 history-walk** (v1 records `resolved-sha` but never reads it back); `--env` selection; `ReleaseToolingSource`; adversarial-timing step kinds (`duplicate`/`reorder`/`drop`/`redeliver`); `qos-mismatch` violation kind; the open design §7 boundary question (does the mock *call* release tooling or *consume its output*).

---

*Rationale for every decision above — including the alternatives weighed — is in `../archive/decision-logs/contracts-decisions.md`.*
