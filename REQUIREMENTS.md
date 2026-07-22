# Offbook — Requirements Registry

*Knows every line. Needs no cast.*

The enumerable list of v1 requirements. Each entry is an atomic statement, a stable never-reused `R-###` UID, a lifecycle `STATUS`, and a `COVERS` anchor into the spec that holds the normative text. This registry is an **index into the specs, not a source of truth**: on any interface detail, `docs/specs/contracts.md` wins (the conflict rule).

**STATUS values:** `specified` (in a spec, not built) · `built` (has an implementation trace) · `tested` (has a covering test) · `deferred` (v2) · `retired` (withdrawn, kept in place so its ID is never reused). `built` and `tested` are **validated** by `scripts/check-docs.ts`: a hand-set `built`/`tested` STATUS must be backed by an `IMPL`/`TEST` trace, or the checker errors.

**Entry format:** each entry is a `####` title line, then `**UID**:`, `**STATUS**:`, and `**COVERS**:` meta lines, then a one-sentence statement. See `docs/specs/doc-system.md` §4.3 for a worked example. (Do not paste a worked example into this file: `scripts/check-docs.ts` parses `####`+`**UID**:` and would count it as a real requirement.)

## Registry

#### model/ contract types present and exported
**UID**: R-001
**STATUS**: tested
**COVERS**: docs/specs/build-plan.md#tier-0
**IMPL**: src/model/
**TEST**: src/model/index.test.ts
Every type in contracts.md §1–6 is transcribed, `tsc`-clean, and exported from `src/model/` — with the sole exception of `BrokerModule`, homed in `broker/` as the transport module's own interface (build-plan §2); a compile-time exhaustiveness guard in the test fails `tsc` if any §1–6 type is missing or renamed.

#### config/ loads services + environments to typed objects
**UID**: R-002
**STATUS**: tested
**COVERS**: docs/specs/build-plan.md#tier-0
**IMPL**: src/config/, src/model/
**TEST**: src/config/index.test.ts
`config/` loads a `services.yaml` (including a `topicOverrides` entry) and `environments.yaml` into typed objects, and `registry/`'s qos test runs against it with no `ingestion/` import (the F18 no-sibling-back-edge).

#### broker/ ws connect, retained receipt, QoS-1 round-trip
**UID**: R-003
**STATUS**: tested
**COVERS**: docs/specs/build-plan.md#tier-1
**IMPL**: src/broker/
**TEST**: src/broker/index.test.ts
A browser-style `mqtt.js` client connects to the Aedes ws listener over MQTT 3.1.1, subscribes, receives a retained message, and a QoS-1 publish round-trips. (The fuller tier-1 broker bar — wildcard-retained replay, DUP-on-redelivery, raw delivery of a non-JSON publish — is beyond this statement and stays enumerable in the R-009+ batch, not implied by this flip.)

#### registry/ parses fixtures, matches topics, resolves qos/retain
**UID**: R-004
**STATUS**: tested
**COVERS**: docs/specs/build-plan.md#tier-1
**IMPL**: src/registry/
**TEST**: src/registry/index.test.ts
`registry/` parses every `fixtures/asyncapi/*` (including external-ref, qos-retain, qos-overrides), resolves channel direction (v2 + v3) and the qos/retain precedence chain, and its `match`/`matchesFilter` behave per the §5 correctness bar (the 2020-12 `$ref`-sibling edge is carved out to D-005, pinned by a tripwire test).

#### ingestion/ branch-tip fetch and lockfile writer
**UID**: R-005
**STATUS**: tested
**COVERS**: docs/specs/build-plan.md#tier-1
**IMPL**: src/ingestion/, src/model/
**TEST**: src/ingestion/index.test.ts
`ingestion/` resolves a fixture spec at a branch tip, records the post-fetch SHA + content-hash + declared-version to `specs.lock`, and imports no AsyncAPI parser.

#### WS-fidelity spike is the authoritative connect gate
**UID**: R-006
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#spikes
The real browser application's `mqtt.js` connects+subscribes+receives-retained against a bare Aedes ws listener, finalizing the broker's listener config (subprotocol/path/auth).

#### Capture the browser application's connect()
**UID**: R-007
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#spikes
The client's `connect()` auth fields, ws URL/path, subprotocol, protocol level, and any QoS-2 use are captured into a config fixture + broker ws port default.

#### M0 walking-skeleton prototype: retained receipt + topic discovery
**UID**: R-008
**STATUS**: tested
**COVERS**: docs/specs/build-plan.md#m0
**IMPL**: src/broker/, src/registry/, src/validation/, src/engine/, src/control-plane/, src/cli/
**TEST**: test/m0-acceptance.test.ts
The thinnest dogfoodable slice ships: a browser-style `mqtt.js` client connects to the Aedes ws listener and receives a retained message, and `offbook topics` lists every topic/shape/direction from the bundled demo spec (with `offbook demo` booting and surfacing an off-contract publish as an output, not the gate).

#### broker/ fuller tier-1 acceptance: wildcard replay, raw non-JSON delivery, DUP-on-redelivery
**UID**: R-009
**STATUS**: tested
**COVERS**: docs/specs/build-plan.md#tier-1
**IMPL**: src/broker/
**TEST**: src/broker/index.test.ts
Beyond R-003's connect/retained/QoS-1 core: a wildcard subscribe (`state/+`, `state/#`) replays retained state for every matching topic straight from Aedes' store (the same set `getState()` returns), never a parallel ledger (R3/F6/CR11); and a non-JSON publish surfaces (`payload: undefined` + `decodeError`) yet is still **delivered raw** to subscribers — both covered. DUP-on-redelivery is a **known limitation (D-006)**: the PUBACK-suppressing harness (persistent session + `manualAcks` + resume) confirms the session resumes but Aedes' default in-memory persistence does not redeliver the in-flight QoS-1 message, so `DUP=1` is delegated to the WS-fidelity spike / a redelivering persistence, pinned by a tripwire test.

#### engine/ deterministic scheduler core
**UID**: R-010
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-2
A single virtual-clock event loop schedules all emissions and awaits `broker.emit` for ordered delivery, seeded by a Mulberry32 PRNG so the same seed yields the same event order, with a wall-paced interactive path gated on `config.wallClock` for emit delays + tick cadence (CR6) that is exercised only outside the determinism gate (which stays `passive`, F10).

#### engine/ L1 faker floor
**UID**: R-011
**STATUS**: tested
**COVERS**: docs/specs/build-plan.md#tier-2
**IMPL**: src/engine/
**TEST**: src/engine/faker.test.ts
L1 emissions come from a seeded json-schema-faker draw that is Ajv-rechecked before emit — output is always Ajv-valid, and a recheck failure (or a rejecting faker) drops the emit and surfaces a `mock` violation with `emitSource.layer === 'L1'`, never silent (F5; the floor may be empty pending the F8 spike's keyed-fallback verdict, R-027).

#### engine/ L3 dispatch
**UID**: R-012
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-2
L3 handlers are discovered via glob `handlers/**/*.ts`, each module calling `register(pattern, factory)` on import where `pattern` is a channel address with `{param}` captures resolved by the registry's `SpecRegistry.match` (G1), and multi-match precedence (most-specific → sorted module path → registration order) picks the same winner across runs and file reordering.

#### engine/ emit-completion choke-point
**UID**: R-013
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-2
Every emission passes the single `resolveEmit(partial, channel)` choke-point (contracts §3): an authored L3 `ctx.publish` with no qos/retain reaches `broker.emit` carrying the channel-resolved qos/retain (F13 — never `undefined`, so Aedes never falls back to QoS 0 and no `StateEntry.retain` is minted from `undefined`), an L2 step `delay: '150-300ms'` parses to a finite `delayMs` seeded by `(scenarioName, stepIndex)` (F7) yielding a finite `now()`, and each emit is stamped with `Violation.emitSource` (`L1` / `L2 {scenarioName, stepIndex}` / `L3`) since `broker.emit` is content-only (G10).

#### engine/ reset
**UID**: R-014
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-2
`reset` restores known state, re-seeds the PRNG, and re-instantiates L3 handler factories, so a post-reset run with the same seed reproduces the same emission stream.

#### validation/ full bar
**UID**: R-015
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-2
Validation produces `Violation` records for all four kinds (`schema` with structured `SchemaError[]`, `decode`, `direction`, `unknown-topic`) with `client`/`mock` origin, stores them in a bounded ring buffer (`config.maxViolations`, FIFO eviction, process-monotonic `seq` never reused, `summary.oldestSeq` advancing past the cap), and never blocks delivery (observe-and-surface).

#### scenarios/ (L2) authoring runtime
**UID**: R-016
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-3
Per `l2-scenarios.md`: a glob+sorted-path dispatch table with the `{param}` matcher + `payloadMatch`, `{{…}}` templating with seeded helpers + L1 autofill, author-time validation surfacing to `/diagnostics` (overlap warnings included), hot-reload, and a malformed scenario skipped-loud to `/diagnostics` when `config.strict` is false (dev default) but fatal-at-startup when strict (`up --ci` or `--strict`).

#### control-plane/ endpoints + envelope
**UID**: R-017
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-3
Every `/v1/*` endpoint behaves per contracts §5 with a contract test each, errors use the §5 envelope, lower-layer capabilities (the engine's `Faker`, state read, validation query, scenario trigger) arrive by injection at the composition root (F11 — no direct engine/broker import), `GET /topics` `example` is byte-equal to `POST /publish {example:true}` for the same channel (one injected faker), and an explicit `/publish` `qos`/`retain` overriding the channel binding emits at the override while firing the tier-3 divergence warn-log (off-spec never silent).

#### control-plane/ CI settlement flow
**UID**: R-018
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-3
The `reset → publish → GET /pending?wait → GET /validation?sinceSeq=` CI flow returns the expected violation slice with no poll loop (EC1): `GET /pending?wait` for a multi-step reactive scenario returns only once `/state` reflects every emit (`scheduled: 0, settled: true` — counting in-flight faker promises, D-003) and reports nonzero `scheduled` mid-chain in wall-paced mode.

#### cli/ dispatch backbone
**UID**: R-019
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-4
The Bun CLI is a thin client over the HTTP API: every verb (`init/demo/up/down/topics/publish/state/scenarios/scenario/reset/mode/validation/check/diagnostics/logs/status/specs update`) hits its endpoint (or does its local file/process work) and renders the response, resolving the runfile where needed.

#### cli/ publish + scenario input ergonomics
**UID**: R-020
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-4
`publish` accepts `--example | --payload <json> | --payload-file <path> | --payload -` (mutually exclusive; bare = `--example`) and exits nonzero on an unmatched topic unless `--force` (EQ1), and `scenario` accepts repeatable `--param k=v` plus the same `--payload*` family (EQ4).

#### cli/ topics + validation rendering
**UID**: R-021
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-4
`topics` default output prints no raw JSON-Schema fragment (a `grep '"type":'` finds nothing), lists each topic's fields with required-ness + the seeded example, flattens `allOf`/marks `oneOf`·`anyOf` (`--compact`/`--no-examples`/`--schema` toggles; `--receives`/`--sends` filters; `--json` round-trips `TopicInfo[]`), rendering direction as "client receives/sends" in human output (EQ3/ER1); `validation` default prints one line per distinct violation (repeats collapsed to `×N`; distinct key = origin·kind·channel·error-location; composed headline from `errors[0]`+`payload`@instancePath for `kind:'schema'`; first…last `#seq`) plus a summary footer showing `summary.distinct` and no raw Ajv object, with `-v` expanding `errors[]`/`channel`/`clientId`/payload and `--json` matching `GET /v1/validation` (EQ6/ER2).

#### cli/ up boot profiles + ports
**UID**: R-022
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-4
`up` resolves two boot profiles — interactive default (`wallClock=true`, `mode=autonomous`, `strict=false`) vs `--ci` (co-sets `mode=passive`, `wallClock=false`, `strict=true`, `--watch` off) with `--strict` an independent flag (`--frozen` is v2) — preflights the three ports (foreground error on conflict), refuses a live double-start, auto-reclaims a stale runfile, honors `--ws-port`/`--tcp-port`/`--ctrl-port` overrides, prints the `ws://localhost:<wsPort>` connect target (P7), and `down` is idempotent.

#### cli/ status + check
**UID**: R-023
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-4
`status` resolves the runfile and prints running/ports/mode/specs+SHAs/violation-summary including the caught-N-distinct-breaks scoreboard (`summary.distinct.client`, design §5), the `/diagnostics` error/warn counts, the connect target + spec age (P7/P8/P2), exiting nonzero when down; `check` exits nonzero iff `summary.byOrigin.client > 0` since the last `reset` (P8); and `up --seed`/`reset --seed` set and echo the seed.

#### cli/ watch modes
**UID**: R-024
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-4
`up --watch` (autonomous-only) restarts the server on `handlers/**/*.ts` changes and is off in `passive` so CI never restarts mid-window (EH1), while `validation --watch` and `diagnostics --watch` poll `?sinceSeq=` and render new entries within one interval (EO1–EO4).

#### cli/ init scaffold
**UID**: R-025
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-4
`init` writes `services.yaml`/`environments.yaml`/`scenarios/00-example.yaml`/empty `handlers/`/`.gitignore` only when absent (re-run refuses, nonzero), never scaffolds `specs.lock`, and `init && <set gitHost> && up` reaches a running server with no other hand-authored YAML — on a fresh project `up` prints the L1-floor orientation banner, suppressed once a scenario or handler loads (EI1–EI2).

#### spike: mqtt-pattern parity (F6/R2)
**UID**: R-026
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#spikes
The `{p}`→`+p` rewrite reproduces AsyncAPI single-segment capture exactly (mqtt-pattern reads `{param}` literally, so captures ride the rewrite with an identity back-map) and `matchesFilter` implements MQTT `+`/`#` exactly — including `#` matching zero trailing levels — on the fixture channel addresses, pure-string with no transport deps; the go/no-go artifact is the covering test, with a hand-rolled matcher as the fallback on no-go.

#### spike: json-schema-faker fidelity (F8)
**UID**: R-027
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#spikes
JSF 0.6.2 runs against every `fixtures/asyncapi/*` bundled `channel.schema` and the per-fixture Ajv-recheck failure rate is recorded; a nonzero rate on a §5-bar fixture (`external-ref`, `qos-retain`, `qos-overrides`) decides that F5's keyed-fallback re-draw is needed, else drop-and-surface stands (the verdict lands in the ledger).

#### gate: §5 validation correctness
**UID**: R-028
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#v1-gate
Registry + validation are green against the `external-ref`, `qos-retain`, and `qos-overrides` fixtures (false-positive/false-negative are tool-killers; `qos-overrides` guards the tier-2 `topicOverrides` string-equality resolution, F14) — the module bars live in R-004 and R-015; this entry is the cross-cutting v1 gate over them.

#### gate: determinism
**UID**: R-029
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#v1-gate
Same seed ⇒ identical emission stream + timings + violation ordering, compared over the F9 canonical projection (`Violation` minus wall-clock `observedAt`/`clientId`), with the gate booting `passive` via `offbook up --ci` and asserting `GET /mode == passive` (F10) so no autonomous tick perturbs the window (`bun test` re-run stable) — the scheduler substrate is R-010; this entry is the cross-cutting v1 gate over it.

#### gate: transport isolation
**UID**: R-030
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#v1-gate
The `aedes`-import lint rule passes repo-wide: no module but `broker/` imports `aedes` or any MQTT/transport package, everything else operating on the normalized message model.

#### gate: observe-and-surface
**UID**: R-031
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#v1-gate
No validation path ever blocks delivery — validation observes and surfaces loudly at every tier while the broker stays payload-agnostic — the module bar lives in R-015; this entry is the cross-cutting v1 gate over it.

<!--
Seeding is staged (doc-system.md §7). Batch 1 (R-001..R-007) + R-008 (M0) + R-009 (broker tier-1 residual): seeded and reconciled. Batch 2+ (R-010..R-031): the full module/spike/gate carve per D-007 and docs/archive/intake/2026-07-21-batch-2-seeding-carve.md.
What remains unseeded resolves case by case (not bulk):
  - Contract obligations and hard constraints (contracts.md, AGENTS.md): additive `anchor: NAME` markers only when an entry needs one; no change to frozen interface content.
  - design.md §1-12 rationale: mostly D-###, not R-###.
Allocate the next id = max existing + 1; never reuse. Run `bun scripts/check-docs.ts` after each batch.
-->
