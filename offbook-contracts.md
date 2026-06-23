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
  meta: { clientId: string; seq: number; receivedAt: number; decodeError?: string };  // decodeError set when the payload failed to decode (§2); packetId reserved for v2
}

interface Channel {     // produced by the Spec Registry
  topic: string;        // address / pattern (may contain {params})
  direction: Direction; // normalized ONCE here (§5): v3 send→toClient · receive→fromClient; v2 subscribe→toClient · publish→fromClient
  validate: (payload: unknown) => SchemaError[];  // compiled from the channel schema
}
```

- **Direction is derived, not stored on messages:** flow position (`onInbound` vs `emit`) gives inbound/outbound; the topic→`Channel` lookup gives the spec-declared direction. In v1 it's a clean bijection (the client only publishes `fromClient`; the mock only emits `toClient`).
- **`delayMs`** is resolved in the engine (seeded Mulberry32 draw — see §3 Behavior engine, this doc) and consumed by the engine scheduler; the broker ignores it.
- **Clocks:** the **virtual seeded clock** is the *emission* timeline only (drives `{{now}}` and `delayMs`) — reproducible. **Inbound** is externally driven, so `meta.receivedAt` is **wall-clock** (human) and `meta.seq` is a **logical counter** (reproducible ordering).
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
- **One outbound primitive.** `retain` is a PUBLISH flag; **clear retained = a zero-byte retained publish** (`emit` with `payload: undefined`, `retain: true`). There is no `setRetained` (un-MQTT). `getState` is an out-of-band control-plane read.
- **Payload-agnostic:** a malformed payload is **never dropped or blocked** — the broker delivers raw bytes and surfaces the event with `payload: undefined` + `meta.decodeError`; the validation engine logs it (observe-and-surface, §5).
- **`onSubscribe`** exists for lazy initial-state of parametrized `toClient` topics (§7a); the policy lives in the engine.
- **qos/retain resolution precedence** (engine-resolved, broker just carries the flags): **spec MQTT binding → offbook per-topic override → per-service default → global (qos 1)**.

## 3. Behavior engine — registration, dispatch, scheduling

**The scheduler lives here, not the transport.** It owns the virtual clock, applies `delayMs`, guarantees deterministic ordering, and (in v2) injects MQTT-semantic timing faults. `broker.emit` is publish-now.

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
  now(): number;      // virtual clock
}

declare function register(topicPrefix: string, factory: HandlerFactory): void;
```

- L3 **publishes through the engine scheduler**, never `broker.emit` directly (§3 layering).
- L1 is not registered — it's the built-in floor: `fake(channel, seed) → payload`, seeded and Ajv-rechecked before emit.
- L2 scenarios are loaded per `offbook-l2-scenarios.md` (sorted-path → in-file dispatch order).
- *(Deferred: AsyncAPI-3.0 reply-channel auto-response as a future L1 reactive enhancement.)*

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

- Single record with optionals (not a discriminated union) for v1.
- **Three-tier surfacing:**
  1. **`/validation`** — structured runtime contract violations (CI-grade; the §5 headline).
  2. **`/diagnostics`** — static config/load issues (scenario-load errors, overlap/shadow warnings).
  3. **warn-level logs** — low-ceremony runtime notices, e.g. a **qos/retain divergence from the spec binding** (surfaced-not-silent; *not* a `Violation`; one-line upgrade to a `qos-mismatch` kind if it ever matters).

## 5. Control-plane HTTP API

**Conventions:** `/v1` prefix · JSON only · error envelope `{ error: { code, message, details? } }` · **actions return promptly after *injecting*** (CI polls `/state` + `/validation` for effects) · no-auth / no-CORS / localhost bind (dev appliance; the client uses MQTT, not this API).

### Reads
| Endpoint | Returns | Notes |
|---|---|---|
| `GET /v1/topics` | `{ topics: TopicInfo[] }` | dereferenced **schema + seeded example inline**; `?direction=` / `?service=` filters; `?schema=false` slim mode |
| `GET /v1/state` | `{ state: StateEntry[] }` | lean, **concrete** topics; `?topic=` prefix filter |
| `GET /v1/validation` | `{ violations: Violation[]; summary }` | `summary { errors, warnings, byOrigin{client,mock}, byKind }`; `?sinceSeq=` `?origin=` `?severity=` `?kind=`; ordered by `(seq, insertion)`; violations-only |
| `GET /v1/specs` | `{ specs: SpecInfo[]; resolutionMode; warnings? }` | `resolutionMode: 'branch' \| 'pinned'` honesty flag (§7) |
| `GET /v1/diagnostics` | `{ diagnostics: Diagnostic[]; summary }` | load/hot-reload-populated; dev-time surface |
| `GET /v1/mode` | `{ mode, seed }` | |

```ts
interface TopicInfo { topic: string; direction: Direction; service: string;
  title?: string; description?: string; schema: object; example?: unknown; qos?: 0|1|2; retain?: boolean; }
interface StateEntry { topic: string; payload: unknown; qos?: 0|1|2; retain: true; }
interface SpecInfo { service: string; declaredVersion?: string; source: string; contentHash: string; channelCount: number; }  // declaredVersion = info.version from the parsed spec — NOT the requested version (they differ in v1 branch mode)
interface Diagnostic { kind: 'scenario-load' | 'overlap' | 'spec-load';
  severity: 'error' | 'warning' | 'info'; detail: string; source?: string; scenarioName?: string; }
```

### Actions
| Endpoint | Body | Result | Notes |
|---|---|---|---|
| `POST /v1/publish` | `{ topic, payload?, example?, qos?, retain? }` | `202 { topic, direction, injected, seq }` | **direction inferred from the channel** (toClient drives UI / fromClient simulates client + validates); reports resolved `direction`; unknown topic → raw publish + flag; `example:true` on unknown → `400` |
| `POST /v1/trigger/{name}` | `{ params?, payload? }` (omitted → seed-faked) | `202 { scenario, fired, seq }` | `404` on unknown scenario |
| `POST /v1/reset` | `{ seed? }` | `200 { reset, seed, seq }` | returns **active seed + `seq` baseline** (feeds `?sinceSeq=`); **non-destructive** — re-seeds PRNG, resets virtual clock, re-instantiates L3 handlers, republishes initial state, halts autonomous; `seq` is process-monotonic, log not cleared |
| `POST /v1/mode` | `{ mode: 'autonomous' \| 'passive' }` | `200 { mode, seed }` | default `autonomous` (§7b); startup flag/env boots `passive` for CI; mode-set ≠ reset |

The CI loop reads cleanly: `reset` (checkpoint `seq`) → `publish`/`trigger` → poll `GET /validation?sinceSeq=<checkpoint>` → assert `summary.byOrigin.client === 0`.

## 6. Spec ingestion & config (the §7 seams, v1)

v1 ships the **branch stopgap** behind §7's forward-compatible seams; `specs.lock` from day one; semver→ref resolution is v2.

```ts
interface ServiceConfig {
  name: string;
  repo: string;
  specPath: string;        // v1: a fixed path
  branch?: string;         // v1 ref selection; default 'main'
  // v2: versionToSha strategy, specPath glob strategy, range policy, manual override
}

interface ResolvedSpec {
  content: string;          // raw spec text (YAML/JSON)
  contentHash: string;      // "sha256:…" — our byte fingerprint
  specPath: string;
  resolvedRef: string;      // the selection input (branch in v1; tag/sha in v2)
  resolvedSha: string;      // FULL canonical commit sha (40 hex sha-1 / 64 hex sha-256) — the pin, never abbreviated
  source: string;           // human origin, e.g. "dev@org/service-b:asyncapi.yaml"
  declaredVersion?: string; // info.version, back-filled from the parsed spec
  fetchedAt: string;        // ISO8601
}

interface Resolver      { resolve(repo: string, ref: string, specPath: string): Promise<ResolvedSpec>; }  // v1+v2: GitRefResolver
interface VersionSource { versions(environment: string | null): Promise<Record<string, string>>; }        // v1: StaticManifestSource
```

- **`GitRefResolver` is the only resolver, v1 and v2** — fetching a spec at a git ref is identical regardless of ref kind. The v1↔v2 difference is purely *ref selection*: v1 uses `ref = serviceConfig.branch ?? 'main'` (a moving branch tip, unpinned); v2 resolves a requested semver → a pinned tag/sha via the `versionToSha` strategies. **v1 only ever hands it a branch tip.**
- **`resolvedRef` vs `resolvedSha`:** `resolvedRef` = what we asked git for (branch/tag/sha — provenance, disambiguated by `resolution-strategy`); `resolvedSha` = the full canonical commit it dereferenced to (the pin). When the ref *is* a sha they may be identical. **Always store the full sha** — git auto-expands abbreviations as repos grow, so a short sha is not a stable identifier and would break reproducibility.

### Config files (v1 minimal, v2-shaped)
```yaml
# services.yaml — per-service location (v1: repo + fixed specPath + optional branch; strategy machinery is v2)
services:
  serviceA: { repo: org/service-a, specPath: asyncapi.yaml }              # branch defaults to main
  serviceB: { repo: org/service-b, specPath: asyncapi.yaml, branch: dev } # deploys from dev

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

- Recording **`resolved-ref` + full `resolved-sha` + `content-hash`** gives v1 the **full reproducibility guarantee** immediately (rebuild the exact mock even after the branch moves).
- The declared-vs-requested **drift-check is v2** (v1 always fetches a branch tip, so there's no resolved semver to check).
- **Seam-complete:** `environments.yaml` exists in v1 so `requested-version` is real and the requested-vs-resolved gap is *honestly visible*; v2 swaps `StaticManifestSource → ReleaseToolingSource` with no restructure.

## 7. v1 / v2 boundary (what these contracts stub)

**In v1, behind these seams:** `GitRefResolver` selecting `ref = branch`; `StaticManifestSource`; single `default` environment; `specs.lock` with `resolved-ref`/`resolved-sha`/`content-hash`.

**Deferred to v2 (no restructure — implementations swap behind the same seams):** `versionToSha` strategy enums + range policy + manual override in `services.yaml`; `resolved-version` + drift-check; `--env` selection; `ReleaseToolingSource`; adversarial-timing step kinds (`duplicate`/`reorder`/`drop`/`redeliver`); `qos-mismatch` violation kind; the open §7 boundary question (does the mock *call* release tooling or *consume its output*).

---

*Rationale for every decision above — including the alternatives weighed — is in `offbook-contracts-decisions.md`.*
