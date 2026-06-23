# Offbook — P1 Contract Decisions (working log)

*Knows every line. Needs no cast.*

**What this is:** the running decision log for **P1 (freeze interface & API contracts)**, worked through as a dialog. It feeds the eventual `offbook-contracts.md`. Section refs (e.g. §5) point to `offbook-design.md`.

**Status:** ✅ **All of P1 (D1–D6) decided and compiled into `offbook-contracts.md`** (now the authoritative spec; this file is the dialog/rationale record). Doc-debts cleared across the design + L2 docs. D6 added `GitRefResolver` (ref-agnostic; v1 selects `ref = branch`, default `main`), `resolved-ref` + full `resolved-sha` in `specs.lock`, and seam-complete config (both `services.yaml` + `environments.yaml` in v1).

**Vocabulary lock (applies throughout):** the connecting party under development = **`client`** (this adopter's client is the SPA; docs keep saying "the SPA"). The tool's own emissions = **`mock`**. Channel/flow direction = **`toClient` / `fromClient`**. MQTT terms (`topic`, `qos`, `retain`, bindings) stay concrete — de-SPA-ify, do **not** de-MQTT-ify (transport abstraction is the n=2 fork, §3).

---

## P1.D1 — Normalized message model

```ts
type Direction = 'toClient' | 'fromClient';   // on the Channel record, NOT the message (§5 normalize-once)

interface NormalizedMessage {
  topic: string;        // fully concrete (no wildcards)
  payload: unknown;     // DECODED value; broker owns byte<->value
  qos?: 0 | 1 | 2;      // full 3.1.1; default 1; v2 duplicate-faults stay QoS-1-specific
  retain?: boolean;
  delayMs?: number;     // engine-consumed scheduling hint; default 0
}

interface InboundEvent {
  message: NormalizedMessage;                 // flow ⇒ fromClient
  meta: { clientId: string; seq: number; receivedAt: number };  // packetId reserved for v2
}
```

- **Direction is derived, not stored on the message** — it lives on the Spec Registry `Channel` record; flow position (`onInbound` vs `emit`) gives inbound/outbound. (Refines §3's literal field list — `direction` removed.)
- `delayMs` is **resolved in the engine** (seeded Mulberry32 draw), engine-consumed; broker ignores it.
- Broker **owns the codec**; a decode failure is **never dropped/blocked** (broker is payload-agnostic) — surfaced as `payload: undefined` + `meta.decodeError` + raw bytes → validation logs it.
- **No outbound envelope** (engine knows emission origin itself). Inbound envelope carries provenance.
- **Clocks:** virtual seeded clock = emission timeline only (`{{now}}`, `delayMs`), reproducible. Inbound = wall-clock `receivedAt` (human) + logical `seq` (reproducible ordering).

## P1.D2 — Broker module interface

```ts
interface BrokerModule {
  start(): Promise<void>;   // bind ws + tcp (3.1.1); ws subprotocol/path/handshake quirks live HERE
  stop(): Promise<void>;
  onInbound(handler: (event: InboundEvent) => void): void;
  onSubscribe(handler: (sub: { topic: string; clientId: string }) => void): void;
  emit(message: NormalizedMessage): Promise<void>;     // ONE outbound primitive; publish-NOW; encodes
  getState(): ReadonlyMap<string, NormalizedMessage>;  // control-plane read of the retained store
}
```

- `emit` is **`Promise<void>` for deterministic ordered delivery** — the engine awaits sequential emits so enqueue order = intent (not backpressure). The engine owns the guarantee, not Aedes internals (§3).
- **One outbound primitive.** `retain` is a PUBLISH flag; **clear retained = zero-byte retained publish** (`payload: undefined`). `setRetained` dropped (un-MQTT). `getState` is an out-of-band control-plane read.
- **Scheduler lives in the engine** (corrects D1's "broker schedules"): `broker.emit` = publish-now; v2 MQTT-semantic faults are engine-side (§6).
- **qos/retain precedence:** spec MQTT binding (authoritative) → offbook per-topic override → per-service default → global (qos 1). **Engine-resolved**; broker carries the flags.
- **Everything MQTT lives behind this module** (ws quirks, 3.1.1 pinning, accept-all auth + credential logging §8, `packetId`, codec). Nothing above imports Aedes. De-facto TransportAdapter; do not extract a generic adapter until n=2 (§3).
- `onSubscribe` exists for lazy initial-state of parametrized toClient topics (§7a); policy is engine behavior.

## P1.D3 — Behavior engine: registration + dispatch

**Two trigger paths** (refines §4's flat "L3→L2→L1"):

| Trigger | Layers (first-match-wins) |
|---|---|
| Reactive — client publishes (inbound) | **L3 → L2** (no L1) |
| Proactive — subscribe (initial state) / autonomous tick | **L3 → L1** (L1 = the floor) |
| Explicit — `POST /trigger/{name}` | the named **L2** scenario (or L3 action) |

So **L1 = proactive floor, L2 = reactive/triggered, L3 = both.** "Works day one" = UI renders from L1 initial state; behavior authored on top.

```ts
type HandlerFactory = () => Handler;   // FACTORY — re-instantiated on reset for clean deterministic state
interface Handler {
  onInbound?(event: InboundEvent, ctx: HandlerContext): void;    // reactive
  initialState?(topic: string, ctx: HandlerContext): void;       // proactive (on subscribe)
  tick?(ctx: HandlerContext): void;                              // autonomous mode
}
interface HandlerContext {
  publish(msg: Partial<NormalizedMessage> & { topic: string }): void;  // goes through the engine scheduler
  random(): number;   // seeded PRNG (deterministic)
  now(): number;      // virtual clock
}
register(topicPrefix: string, factory: HandlerFactory): void;
```

- L3 **publishes through the engine scheduler**, never `broker.emit` directly.
- *(Deferred: AsyncAPI-3.0 reply-channel auto-response as a future L1 reactive enhancement.)*

## P1.D4 — Validation-result shape

```ts
type ViolationKind = 'schema' | 'direction' | 'unknown-topic' | 'decode';  // qos-mismatch deferred → tier-3 warn log

interface SchemaError {            // OUR shape, not Ajv's — crosses the HTTP boundary
  instancePath: string; schemaPath: string; keyword: string; message: string;
  params?: Record<string, unknown>;
}

interface Violation {
  seq: number;                     // engine-wide event counter; reproducible; NOT unique per violation
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
  emitSource?: { layer: 'L1' | 'L2' | 'L3'; scenarioName?: string; stepIndex?: number };  // when origin === 'mock'
}
```

- **Single record with optionals** (not a discriminated union) for v1.
- **Three-tier surfacing:** `/validation` (structured runtime violations, CI-grade) · `/diagnostics` (static config/load issues) · **warn-level logs** (low-ceremony runtime notices, e.g. **qos/retain divergence from the spec binding** — surfaced-not-silent, not a `Violation`; one-line upgrade to a `qos-mismatch` kind if it ever matters).

## P1.D5 — Control-plane HTTP API

**Conventions:** `/v1` prefix · JSON only · error envelope `{ error: { code, message, details? } }` · **actions return promptly after *injecting*** (CI polls `/state` + `/validation` for effects) · no-auth / no-CORS / localhost (dev appliance; the client uses MQTT, not this API).

**Reads:**
- `GET /v1/topics` → `{ topics: TopicInfo[] }`. `TopicInfo { topic, direction, service, title?, description?, schema, example?, qos?, retain? }` — dereferenced **schema + seeded example inline**; `?direction=`/`?service=` filters; `?schema=false` slim mode.
- `GET /v1/state` → `{ state: StateEntry[] }`. `StateEntry { topic, payload, qos?, retain: true }` — lean, **concrete** topics; optional `?topic=` prefix. (No `updatedAt` in v1.)
- `GET /v1/validation` → `{ violations: Violation[]; summary }`. `summary { errors, warnings, byOrigin{client,mock}, byKind }`. Filters `?sinceSeq=` / `?origin=` / `?severity=` / `?kind=`. Ordered by `(seq, insertion)`. Violations-only.
- `GET /v1/specs` → `{ specs: SpecInfo[]; resolutionMode: 'branch' | 'pinned'; warnings? }`. `SpecInfo { service, declaredVersion?, source, contentHash, channelCount }`. **`resolutionMode` honesty flag** per §7 (v1 reports `branch`, naming the branch). *(Superseded by D6: `GitRefResolver`/`branch` replaced the earlier `main-branch` value.)*

**Actions:**
- `POST /v1/publish` `{ topic, payload?, example?, qos?, retain? }` → `202 { topic, direction, injected, seq }`. **Direction inferred from the channel** (toClient → drives UI; fromClient → simulates client + runs validation/dispatch); response reports resolved `direction`. Unknown topic → raw publish + flag; `example:true` on unknown → `400`.
- `POST /v1/trigger/{name}` `{ params?, payload? }` (omitted → seed-faked) → `202 { scenario, fired, seq }` | `404`.
- `POST /v1/reset` `{ seed? }` → `200 { reset, seed, seq }`. Returns **active seed + `seq` baseline** (feeds `/validation?sinceSeq=`). **Non-destructive:** re-seeds PRNG, resets virtual clock, re-instantiates L3 handlers, republishes initial state, halts autonomous; **`seq` is process-monotonic and the log is not cleared**.

**Mode & diagnostics:**
- `GET /v1/mode` → `{ mode, seed }`; `POST /v1/mode { mode: 'autonomous' | 'passive' }` → `200 { mode, seed }`. **`autonomous | passive`** (refines §9's misleading "deterministic" — both modes are seeded-deterministic). Default `autonomous`; startup flag/env to boot `passive` for CI. Mode-set ≠ reset.
- `GET /v1/diagnostics` → `{ diagnostics: Diagnostic[]; summary }`. `Diagnostic { kind: 'scenario-load'|'overlap'|'spec-load', severity: 'error'|'warning'|'info', detail, source?, scenarioName? }`. Load/hot-reload-populated; dev-time surface (strict CI fails at startup).

---

## Doc-debts — reconcile when compiling `offbook-contracts.md`

- **Vocabulary sweep:** `toSpa`/`fromSpa` → `toClient`/`fromClient`, `spa` → `client` across **P0 (`offbook-l2-scenarios.md`)** and **design §5**.
- **§3** — drop `direction` from the normalized-message field list (moved to the Channel record).
- **§4** — record the two-trigger-path refinement (L1 proactive floor / L2 reactive·triggered / L3 both).
- **§6** — scheduler lives in the engine; `broker.emit` = publish-now.
- **L2 doc (D6)** — scenario-load errors surface in `/diagnostics`, not `/validation`.
- **§9** — emission modes are `autonomous | passive` (not "deterministic").
- **§12.2 spike** — add: does the SPA/services use QoS 2 anywhere? (latent capacity) + qos/retain-mismatch warn-log.
- **§5** — parser → Spectral → Ajv wording (already applied to the design doc).

---

## P1.D6 — RESOLVED (compiled into `offbook-contracts.md` §6)

Config-file schemas + resolution seams, as decided:
- `environments.yaml` (v1 `StaticManifestSource`: `environment → { service: version }`)
- `specs.lock` (formalized — content-hashed, full `resolved-sha` + `resolved-ref`; the reproducibility + debug surface)
- `services.yaml` (v1: `repo` + `specPath` + optional `branch`; per-service strategy machinery is v2)
- `Resolver.resolve(repo, ref, specPath) → ResolvedSpec` — **`GitRefResolver` in both v1 and v2** (v1 selects `ref = branch ?? 'main'`); `VersionSource (environment) → { service: version }` (v1 = `StaticManifestSource`) — the §7 forward-compatible seams.
