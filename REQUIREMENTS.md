# Offbook — Requirements Registry

*Knows every line. Needs no cast.*

The enumerable list of v1 requirements. Each entry is an atomic statement, a stable never-reused `R-###` UID, a lifecycle `STATUS`, and a `COVERS` anchor into the spec that holds the normative text. This registry is an **index into the specs, not a source of truth**: on any interface detail, `docs/specs/contracts.md` wins (the conflict rule).

**STATUS values:** `specified` (in a spec, not built) · `built` (has an implementation trace) · `tested` (has a covering test) · `deferred` (v2) · `retired` (withdrawn, kept in place so its ID is never reused). `built` and `tested` are **derived** by `scripts/check-docs.ts` from trace fields, not asserted by hand.

**Entry format:** each entry is a `####` title line, then `**UID**:`, `**STATUS**:`, and `**COVERS**:` meta lines, then a one-sentence statement. See `docs/specs/doc-system.md` §4.3 for a worked example. (Do not paste a worked example into this file: `scripts/check-docs.ts` parses `####`+`**UID**:` and would count it as a real requirement.)

## Registry

#### model/ contract types present and exported
**UID**: R-001
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-0
Every type in contracts.md §1–6 is transcribed, `tsc`-clean, and exported from `src/model/`.

#### config/ loads services + environments to typed objects
**UID**: R-002
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-0
`config/` loads a `services.yaml` (including a `topicOverrides` entry) and `environments.yaml` into typed objects with no `ingestion/` import.

#### broker/ ws connect, retained receipt, QoS-1 round-trip
**UID**: R-003
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-1
A browser-style `mqtt.js` client connects to the Aedes ws listener over MQTT 3.1.1, subscribes, receives a retained message, and a QoS-1 publish round-trips.

#### registry/ parses fixtures, matches topics, resolves qos/retain
**UID**: R-004
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-1
`registry/` parses every `fixtures/asyncapi/*` (including external-ref, qos-retain, qos-overrides), resolves channel direction and the qos/retain precedence chain, and its `match`/`matchesFilter` behave per the §5 correctness bar.

#### ingestion/ branch-tip fetch and lockfile writer
**UID**: R-005
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-1
`ingestion/` resolves a fixture spec at a branch tip, records the post-fetch SHA + content-hash + declared-version to `specs.lock`, and imports no AsyncAPI parser.

#### WS-fidelity spike is the authoritative connect gate
**UID**: R-006
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#spikes
The real browser application's `mqtt.js` connects+subscribes+receives-retained against a bare Aedes ws listener, finalizing the broker's listener config (subprotocol/path/auth).

#### capture the browser application's connect()
**UID**: R-007
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#spikes
The client's `connect()` auth fields, ws URL/path, subprotocol, protocol level, and any QoS-2 use are captured into a config fixture + broker ws port default.

<!--
Seeding is staged (doc-system.md §7). Batch 1 (R-001..R-007): Tier 0/1 + spikes.
Next batches, allocated in order from R-008:
  - Tier 2 (engine/, validation/), Tier 3 (scenarios/, control-plane/), Tier 4 (cli/) acceptance criteria — build-plan.md §3.
  - The v1 acceptance gate items — build-plan.md §4 (add an anchor per section covered).
  - Contract obligations and hard constraints — contracts.md, AGENTS.md (add explicit <!-- anchor: NAME --> markers; contract markers are additive and do not alter frozen interface content).
Allocate the next id = max existing + 1; never reuse. Run `bun scripts/check-docs.ts` after each batch.
-->
