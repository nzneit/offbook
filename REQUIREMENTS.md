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
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-1
Beyond R-003's connect/retained/QoS-1 core: a wildcard subscribe (`state/+`, `state/#`) replays retained state for every matching topic straight from Aedes' store (the same set `getState()` returns), never a parallel ledger (R3/F6/CR11); a non-JSON publish surfaces (not crashes) and is still **delivered raw** to subscribers; and DUP-on-redelivery is exercised by a harness that suppresses PUBACK to force redelivery and assert `DUP=1` — absent that harness the DUP contract is delegated to the WS-fidelity spike / known-limitations (build-plan#tier-1). Raw delivery + wildcard replay largely ride the existing broker + Aedes-native behavior and need covering tests; DUP needs the dedicated PUBACK-suppressing harness.

<!--
Seeding is staged (doc-system.md §7). Batch 1 (R-001..R-007): Tier 0/1 modules + the two empirical spikes.
R-008 (M0): the walking-skeleton prototype target, seeded ahead of the batch-2+ pass so the week's deliverable is enumerable. Build against build-plan.md#m0; rationale in DECISIONS.md D-002.
R-009 (broker tier-1 residual): the fuller broker acceptance beyond R-003's core (wildcard replay, raw non-JSON delivery, DUP-on-redelivery), seeded ahead of the batch-2+ pass so the untested tier-1 broker surface stays enumerable. Build against build-plan.md#tier-1.

The batch-2+ pass is decided in shape but deferred to post-prototype enrichment, allocated in order from R-010:
  - Hybrid module carve of build-plan.md §3: validation/ and scenarios/ one entry each; engine/ split by layer (L1 floor, L3 dispatch, emit-completion, reset); control-plane/ (endpoints + envelope, plus the CI settlement flow if split); cli/ split along the ergonomics clusters (dispatch backbone, publish/scenario input, topics/validation rendering, up/ports, status/check, watch, init).
  - Spikes 4 and 5 (mqtt-pattern parity, json-schema-faker fidelity) as their own `specified` entries under build-plan.md#spikes; spike 3 (adopt-vs-build) stays out, resolved.
  - The v1 acceptance-gate items (build-plan.md §4: §5 correctness, determinism, transport isolation, observe-and-surface) as thin cross-cutting entries that cross-reference the module entries rather than restate them; add an `anchor: NAME` marker per section covered.
  - Contract obligations and hard constraints (contracts.md, AGENTS.md); additive `anchor: NAME` markers only, no change to frozen interface content.
  - design.md §1-12 rationale resolves case by case (mostly D-###, not R-###), not a bulk sweep.
Allocate the next id = max existing + 1; never reuse. Run `bun scripts/check-docs.ts` after each batch.
-->
