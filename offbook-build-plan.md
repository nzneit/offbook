# Offbook — v1 Build Plan (P2)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (frozen interfaces — the synchronization point), `offbook-l2-scenarios.md` (L2 authoring), `offbook-design.md` (rationale). This is the scaffold + parallelization + acceptance plan for building v1. Fixtures live in `fixtures/asyncapi/` (P3).

**Status:** ready to build. The contracts are frozen, so the modules below fan out to independent agents behind their interfaces.

---

## 1. Tech stack (decided)

| Concern | Choice | Notes |
|---|---|---|
| Runtime / toolchain | **Bun** | server + CLI from one toolchain, native TS, no build step (§9) |
| Language | **TypeScript** | strict |
| Test runner | **`bun test`** | built-in, zero-dep |
| Lint / format | **Biome** | single fast tool |
| Control-plane HTTP | **Hono** | tiny, typed routing, Bun-native |
| Broker | **Aedes** | ws + tcp, MQTT 3.1.1 (§3) |
| AsyncAPI | **`@asyncapi/parser`** (3.x) | parse + validate; dereferences `$ref` before validating (§5) |
| Schema validation | **Ajv** 8 + `ajv-formats` | runtime payload validation |
| Fake data | **`json-schema-faker@0.6.2`** | pinned exact; seeded via its **native `seed`** option (Mulberry32-based; no second PRNG wraps it — R4); Ajv-recheck before emit (§4) |
| YAML | **`yaml`** | config + scenario + spec parsing |
| Topic matching | **`mqtt-pattern`** | `exec` for `{param}` capture + `matches` for `+`/`#` filter; pure-string, no transport dep; powers `registry/`'s `match` + `matchesFilter` (F6/R2). Parity-spiked vs AsyncAPI single-segment (§5) |
| Git fetch | **shell out to `git`** | host-agnostic; reuses existing creds. **Atomic by-SHA acquisition:** `git ls-remote <repoUrl> <branch>` → a full SHA, then fetch **that SHA**. *Branch-tip* mode: shallow-fetch the branch ref + read the file. *By-SHA* (frozen) mode: `git fetch <repoUrl> <sha>` into a temp repo (server `uploadpack.allowAnySHA1InWant`) + read the file — **not** `git archive --remote <sha>`, which GitHub/most hosts refuse for an unadvertised SHA. |

> Pin exact versions at scaffold time; `json-schema-faker` is pinned to **0.6.2** per §4 (the rewrite is recent — lean on the Ajv recheck). `json-schema-faker`'s `faker`/`chance` are optional extensions and **not** needed (the Mulberry32 seed covers determinism).

## 2. Repo scaffold

Single package, separate repo (§3). **Two structural disciplines enforce the architecture:**
1. **`src/model/` holds the P1 contract types**; every other module imports from it. It is Tier 0 — land it first, then freeze.
2. **`src/broker/` is the only module permitted to import `aedes`** (or any MQTT/transport package). A lint rule (Biome `noRestrictedImports`, or a CI grep) forbids `aedes` imports anywhere else — this is §3's transport-isolation made mechanical.

```
offbook/
  package.json  tsconfig.json  biome.json  Dockerfile  .dockerignore  README.md
  bin/offbook                      # CLI entry (shebang → Bun)
  src/
    model/        # NormalizedMessage, InboundEvent, Channel, SpecRegistry, Direction, Violation, SchemaError,
                  #   Config (+DEFAULT_CONFIG), InstanceRegistry, InstanceSnapshot, ServiceConfig, ResolvedSpec,
                  #   Resolver, VersionSource, Handler, HandlerContext, Scenario, WhenClause, EmitStep … (P1)
    broker/       # BrokerModule over Aedes — ONLY importer of aedes
    registry/     # SpecRegistry: @asyncapi/parser → Channel[] (+ compiled Ajv validators), direction normalize
    ingestion/    # GitRefResolver, StaticManifestSource, lockfile reader/writer
    engine/       # scheduler (virtual clock + seeded PRNG), dispatch (trigger paths), L1 faker, L3 registry
    scenarios/    # L2: loader, sorted-path dispatch table, matcher, templating, author-time validation
    validation/   # Violation production, three-tier surfacing (/validation, /diagnostics, warn logs)
    control-plane/# Hono app: /v1/* endpoints, error envelope
    cli/          # thin client over the control plane
    config/       # Tier-0 file→config loading: `Config` (model/ §1a) over `DEFAULT_CONFIG`, + `ServiceConfig`/`services.yaml`/`environments.yaml` loaders (pure yaml, no parser) — imported by BOTH registry/ and ingestion/ so neither has a sibling edge (F18); seed, ports, mode defaults, file paths, violation-log cap
  fixtures/asyncapi/   # P3 sample specs (test material)
  scenarios/           # example L2 scenarios (sample, hot-reloaded)
  test/                # or co-located *.test.ts
```

### Port map (all configurable; defaults)
| Listener | Default | Notes |
|---|---|---|
| Broker **ws** (browser app connects) | `9001` | **must match the browser application's connect URL** — confirm in the §12.2 spike |
| Broker **tcp** | `1883` | standard MQTT |
| Control plane (side port) | `9080` | HTTP `/v1/*`; localhost only |

## 3. Work breakdown & dependency graph

Behind the frozen contracts, work fans out in tiers. Each task lists its **dependencies** and a **self-checkable acceptance criterion**.

### Tier 0 — foundation (land first, then freeze)
- **`model/`** — transcribe the P1 contract types verbatim. *Accept:* `tsc` clean; every type in `offbook-contracts.md` §1–6 present and exported. *(One agent, fast. Everything below imports this.)*
- **`config/`** — file→config loading (pure yaml, no spec parser): `Config`+`DEFAULT_CONFIG` (§1a) and the `ServiceConfig`/`services.yaml`/`environments.yaml` loaders. **Tier 0 so `registry/` and `ingestion/` both import it without a sibling back-edge** (F18). *Accept:* loads a `services.yaml` (incl. a `topicOverrides` entry) + `environments.yaml` to typed objects; `registry/`'s qos test runs against it with no `ingestion/` import.

### Tier 1 — parallel (depend only on `model/` + `config/` + libs)
- **`broker/`** — Aedes ws+tcp bootstrap; `onInbound`/`onSubscribe`/`emit`/`getState`/lifecycle; accept-all auth + credential log (§8); byte codec; decode-failure → `payload:undefined`+`meta.decodeError`; **clear-retained evicts the key** (no tombstone), decode-failures never enter the retained store (contracts §2); `getState` reads Aedes' retained stream, not a parallel map (R3). *Accept:* a browser-style `mqtt.js` client connects over ws (MQTT 3.1.1), subscribes, and **receives a retained message; a QoS-1 publish round-trips** (these are the self-checkable core criteria) — and a non-JSON publish surfaces (not crashes) and is still delivered raw. **DUP-on-redelivery** is exercised by a dedicated harness that **suppresses PUBACK** (an Aedes hook or a custom non-acking client) to force redelivery and assert `DUP=1`; absent that harness the DUP contract is delegated to the WS-fidelity spike / known-limitations. The `mqtt.js` connect is a **dev/CI smoke test** — the **real-browser WS-fidelity spike (§12.1) is the authoritative connect-fidelity gate** (defaults↔defaults cannot detect the fork-specific WS divergence the tool exists to catch).
- **`registry/`** — `@asyncapi/parser` → enriched `Channel[]` (§1: `service`, **fully-bundled** `schema`, `validate`, resolved `qos`/`retain`, `title`/`description`) with **direction normalized onto the channel** (v3 `send`→`toClient`, `receive`→`fromClient`; v2 `subscribe`→`toClient`, `publish`→`fromClient` — i.e. `publish` = the service *receives* ⇒ the client publishes; see §5) + compiled Ajv validators + the **`SpecRegistry.match`** concrete-topic→`Channel` matcher **and the `matchesFilter` `+`/`#` filter test** (both delegating to `mqtt-pattern`; most-specific then declaration order; returns captured `{param}`s; §1, F6/R2) + qos/retain resolved across the full §2 precedence chain (spec binding → `topicOverrides` → per-service default → global). *Accept:* parses **all** `fixtures/asyncapi/*` including `external-ref` + `qos-retain` + `qos-overrides`; `match('command/thermostat-1/set')` returns the `command/{deviceId}/set` channel with `{ deviceId: 'thermostat-1' }`; `matchesFilter('state/#', 'state/thermostat-1')` is `true` and `matchesFilter('state/+', 'state/a/b')` is `false`; two channels matching one concrete topic pick the same winner every run; `external-ref`'s `channel.schema` compiles under Ajv standalone (no parser present), the bundling coming from the parser's `bundle()` not hand-rolled `$ref`-walking (R1); channel directions correct for both v2 and v3 fixtures; a per-topic / per-service override beats the per-service default beats global qos 1 (the `qos-overrides` fixture + a `services.yaml` override); validators reject known-bad payloads — **this is the §5 correctness bar**.
- **`ingestion/`** — `new GitRefResolver(config)` (host/creds only) exposing per-ref `resolve(repo, ref, specPath)` to match the frozen `Resolver` interface (F12; one stateless instance serves branch-tip then locked-SHA). Atomic SHA: `git ls-remote` → SHA, then fetch **that** SHA — `git fetch <sha>` + file read, never `git archive --remote <sha>`), repo-URL resolution (full URL used as-is, or `org/name` slug resolved against `gitHost`), per-service fetches via a bounded `Promise.all` pool (not serial — F21), shallow `info.version` read via the `yaml` lib (no `@asyncapi/parser` import, see G12), `StaticManifestSource`, `specs.lock` **writer** (full `resolved-sha`, `declared-version`, `content-hash`, `resolution-mode`) **and reader** (frozen-mode re-resolve by `resolved-sha`, see G4). *Accept:* default fetch resolves a fixture spec at a branch tip and records full sha + content-hash + `declared-version`; honesty warning names the branch; **`--frozen` re-resolves by `resolved-sha` and rebuilds byte-identical specs after the branch has moved** (every `content-hash` matches the lock); against a host with `allowAnySHA1InWant` **off**, the branch-ref + history-walk fallback still rebuilds byte-identical specs (F17); `ingestion/` imports no parser; a slug fetches against the configured `gitHost` and a full-URL `repo` also fetches.

### Tier 2 — depend on Tier 1
- **`engine/`** — deterministic scheduler (single virtual-clock event loop, awaits `broker.emit` for ordered delivery), seeded Mulberry32 PRNG, two-trigger-path dispatch (§3), L1 faker (json-schema-faker seeded + Ajv-recheck), L3 factory registry: discover handlers via glob `handlers/**/*.ts`, each module calls `register(pattern, factory)` on import where `pattern` is a **channel address with `{param}` captures** resolved by the **registry's `SpecRegistry.match` matcher** (G1), multi-match precedence = G1's (most-specific → sorted module path → registration order). The engine stamps each emit's `Violation.emitSource` (`L1` / `L2` `{scenarioName, stepIndex}` / `L3`) since `broker.emit` is content-only (contracts §3a/§4, G10). *Accept:* same seed ⇒ byte-identical emission stream + timings (determinism compared over the F9 projection, in `passive` per F10); L1 output always Ajv-valid — a recheck failure **drops + surfaces** a `mock` violation, never silent (F5; the floor may be empty, the F8 spike decides on a keyed fallback); two overlapping L3 handlers resolve to the same winner across runs and reordering files doesn't change it; an L2-emitted off-spec payload yields a `mock` `Violation` with `emitSource.layer === 'L2'` and the correct `scenarioName`/`stepIndex`; `reset` restores known state + re-seeds + re-instantiates L3.
- **`validation/`** — produce `Violation` records (kinds, `client`/`mock` origin, structured `SchemaError`); three-tier surfacing; the violation log is a **bounded ring buffer** (`config.maxViolations`, FIFO eviction, `seq` stays process-monotonic — never reused). *Accept:* a client off-contract publish → a `schema`/`client` `Violation` with correct `errors[]` while **delivery is not blocked** (observe-and-surface); a malformed payload → `decode` violation; a wrong-direction publish → `direction` violation; past the cap, the **oldest** violations evict while `seq` keeps climbing and `summary.oldestSeq` advances (a left-running session has a memory ceiling, not unbounded growth).

### Tier 3 — depend on Tier 2
- **`scenarios/`** (L2) — per `offbook-l2-scenarios.md`: glob+sorted-path dispatch table, `{param}` matcher + `payloadMatch`, `{{…}}` templating + seeded helpers + L1 autofill, author-time validation → `/diagnostics`, hot-reload. *Accept:* the running-example scenario matches, binds params, templates a response with a seeded ranged delay reproducibly; an overlapping scenario emits a `/diagnostics` overlap warning; a malformed scenario is skipped-loud in dev / fatal in strict.
- **`control-plane/`** — Hono `/v1/*` per `offbook-contracts.md` §5; error envelope; reads + actions + `/mode` + `/diagnostics`. Receives lower-layer capabilities (the engine's `Faker`, state read, validation query, scenario trigger) **by injection** at the composition root — it does not import engine/broker modules directly (F11). *Accept:* contract test per endpoint; the `reset → publish → poll /validation?sinceSeq=` CI flow returns the expected violation slice; `/publish` infers direction from the channel; **`GET /topics` `example` is byte-equal to `POST /publish {example:true}` for the same channel** (one injected faker).

### Tier 4 — thin
- **`cli/`** — Bun CLI, thin client over the HTTP API. **Can start early against the API contract** (stub the server). *Accept:* `offbook up/down/topics/publish/state/scenario/reset/mode/validation/specs update` each hit the right endpoint and render the response.

### Cross-cutting (any time)
- `config/`, the `aedes`-import lint rule, the Dockerfile (`oven/bun` base), CI wiring (lint + `bun test` + the §5 fixture suite).

## 4. Acceptance gate for v1 (the scope line, from the handoff)
All of the handoff's v1 checklist, each with a passing test. The **non-negotiable** ones:
- **§5 validation correctness** — registry + validation green against `external-ref`, `qos-retain`, **and `qos-overrides`** fixtures (false-positive/false-negative are tool-killers; `qos-overrides` guards the tier-2 `topicOverrides` string-equality resolution, F14).
- **Determinism** — same seed ⇒ identical emission stream + timings + violation ordering, compared over the **F9 canonical projection** (`Violation` minus wall-clock `observedAt`/`clientId`); the gate boots **`passive`** and asserts `GET /mode == passive` (F10) so no autonomous tick perturbs the window (`bun test` re-run stable).
- **Transport isolation** — the `aedes`-import rule passes (no module but `broker/` imports it).
- **Observe-and-surface** — no validation path ever blocks delivery.

## 5. The de-risking spikes (P4 — runnable in parallel now)
These gate/scope the build and are **not** on the module critical path — run them first/alongside (§12.1–2, §12.6):
1. **WS-fidelity spike** — point the real browser application's `mqtt.js` at a bare Aedes ws listener; confirm connect+subscribe+retained receipt at the browser application's actual protocol level/path/subprotocol/auth. *Artifact:* go/no-go + any Aedes listener config; feeds `broker/`. **Ordering (reconciles handoff Step-1 Gate):** `broker/` **may start in parallel against Aedes defaults** — it is buildable now — but this spike is a **gate on the broker's listener config (ws subprotocol/path/auth) being final**: that config is **provisional** until the spike returns. The spike is the **authoritative connect-fidelity gate** (the `broker/` `mqtt.js` acceptance is only a smoke test).
2. **Capture the browser application's `connect()`** — auth fields, ws URL/path, subprotocol, protocol level; note any **QoS 2** use. *Artifact:* a config fixture + the broker ws port default.
3. **Adopt-vs-build** — already resolved (build justified, §12.6); the residual is an ergonomic fit check against the real specs, not a blocker.
4. **`mqtt-pattern` parity spike (F6/R2)** — confirm `mqtt-pattern`'s `{param}` capture == AsyncAPI single-segment semantics and that `matches` implements MQTT `+`/`#` exactly (incl. `#` matching zero trailing levels) on the fixture channel addresses; it is pure-string with no transport deps. *Artifact:* go/no-go for R2; on failure `registry/` falls back to a hand-rolled matcher. Gates `registry/`'s matcher only.
5. **json-schema-faker fidelity spike (F8)** — run JSF 0.6.2 against every `fixtures/asyncapi/*` bundled `channel.schema` and count Ajv-recheck failures per fixture (esp. `external-ref`'s `oneOf`/external-`$ref`, and `qos-overrides`). *Artifact:* a per-fixture recheck-failure rate; if a §5 bar fixture fails, it decides whether F5's keyed-fallback re-draw is needed (else drop-and-surface stands). Gates L1's CI reliance.

---

*Fixtures (P3): see `fixtures/asyncapi/README.md` for what each spec exercises.*
