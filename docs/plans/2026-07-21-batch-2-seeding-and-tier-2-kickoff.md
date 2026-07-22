# Batch-2+ Seeding + Tier-2 Kickoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed R-010..R-031 + D-007 per the approved carve, then reconcile the three entries with existing M0 traces (R-011, R-015, R-026) and run the JSF-fidelity spike (R-027).

**Architecture:** One doc-only seeding commit (registry entries, ledger entry, build-plan anchors, intake archive), then per-entry reconcile commits that verify existing tests against the full seeded statement and add only the missing sliver, then the R-027 spike as a measure-then-pin harness whose verdict lands in D-008. The engine build chain (R-010 → R-012 → R-013 → R-014) is **out of scope**: it gets its own plan once D-008 exists, because the spike verdict is a design input to it.

**Tech Stack:** Bun, TypeScript, `bun:test`, the repo doc-system (`scripts/check-docs.ts`), `json-schema-faker@0.6.2`, `mqtt-pattern`, `@asyncapi/parser`.

## Global Constraints

- Spec: `docs/intake/2026-07-21-batch-2-seeding-carve.md` (forks a–g). On any interface detail, `docs/specs/contracts.md` wins.
- `bun scripts/check-docs.ts` AND `bun test` must both pass before **every** commit.
- Never run `git config user.*`. Commit messages follow repo style (`area: summary`); **no Co-Authored-By or AI-attribution trailers**.
- All 22 new entries seed `STATUS: specified` in Task 1; a status flips to `tested` only in a later task that adds the verified `IMPL`/`TEST` trace lines.
- Statuses stay honest: if a reconcile task finds a statement clause NOT covered by the existing tests beyond the named sliver, stop and report the gap instead of flipping the status.
- Transport isolation: no new file imports `aedes` or any MQTT transport package (the spike script imports only `registry/`, `engine/`, `config/`).

---

### Task 1: The seeding commit (doc-only)

**Files:**
- Modify: `docs/specs/build-plan.md` (4 heading lines: 90, 94, 98, 104)
- Modify: `REQUIREMENTS.md` (append 22 entries; replace trailing comment)
- Modify: `DECISIONS.md` (append D-007)
- Move: `docs/intake/2026-07-21-batch-2-seeding-carve.md` → `docs/archive/intake/`

**Interfaces:**
- Consumes: the intake spec's fork-e table.
- Produces: R-010..R-031 entries (Tasks 2–5 edit R-011, R-015, R-026, R-027 in place), D-007, anchors `tier-2`/`tier-3`/`tier-4`/`v1-gate`.

- [ ] **Step 1: Add the four anchor comments to `docs/specs/build-plan.md`**

Four single-line edits (exact old → new):

```
### Tier 2 — depend on Tier 1
→ ### Tier 2 — depend on Tier 1 <!-- anchor: tier-2 -->

### Tier 3 — depend on Tier 2
→ ### Tier 3 — depend on Tier 2 <!-- anchor: tier-3 -->

### Tier 4 — thin
→ ### Tier 4 — thin <!-- anchor: tier-4 -->

## 4. Acceptance gate for v1 (the scope line, from the handoff)
→ ## 4. Acceptance gate for v1 (the scope line, from the handoff) <!-- anchor: v1-gate -->
```

- [ ] **Step 2: Append the 22 entries to `REQUIREMENTS.md`**

Insert the following block between the end of the R-009 entry (its statement paragraph) and the trailing `<!--` comment, verbatim:

```markdown
#### engine/ deterministic scheduler core
**UID**: R-010
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-2
A single virtual-clock event loop schedules all emissions and awaits `broker.emit` for ordered delivery, seeded by a Mulberry32 PRNG so the same seed yields the same event order, with a wall-paced interactive path gated on `config.wallClock` for emit delays + tick cadence (CR6) that is exercised only outside the determinism gate (which stays `passive`, F10).

#### engine/ L1 faker floor
**UID**: R-011
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-2
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
```

- [ ] **Step 3: Replace the trailing HTML comment in `REQUIREMENTS.md`**

Replace the entire existing `<!-- ... -->` block (the "Seeding is staged…" comment) with:

```markdown
<!--
Seeding is staged (doc-system.md §7). Batch 1 (R-001..R-007) + R-008 (M0) + R-009 (broker tier-1 residual): seeded and reconciled. Batch 2+ (R-010..R-031): the full module/spike/gate carve per D-007 and docs/archive/intake/2026-07-21-batch-2-seeding-carve.md.
What remains unseeded resolves case by case (not bulk):
  - Contract obligations and hard constraints (contracts.md, AGENTS.md): additive `anchor: NAME` markers only when an entry needs one; no change to frozen interface content.
  - design.md §1-12 rationale: mostly D-###, not R-###.
Allocate the next id = max existing + 1; never reuse. Run `bun scripts/check-docs.ts` after each batch.
-->
```

- [ ] **Step 4: Append D-007 to `DECISIONS.md`**

Append after D-006, verbatim:

```markdown
### D-007: Batch-2+ carve refinements — a fifth engine entry (scheduler core) and a split control-plane
**Date**: 2026-07-21
**What**: Execute the D-002-deferred batch-2+ seeding as R-010..R-031, refining the recorded shape in two places: (1) `engine/` gets a fifth entry, the deterministic scheduler core (R-010: virtual-clock loop, Mulberry32 seeding, wallClock path), rather than folding the substrate into the §4 determinism gate entry; (2) `control-plane/` splits into endpoints + envelope (R-017) and the EC1 CI settlement flow (R-018). All 22 entries seed `specified`; reconciliation against existing M0 traces is follow-on work, per the batch-1 precedent.
**Why**: The gate entries are thin and cross-referencing by design, so the determinism gate (R-029) needs a module entry to point at — and the scheduler is the first buildable unit of tier 2. The settlement flow leans on engine scheduler semantics and lands later than the plain endpoint contract tests, so splitting lets R-017 go `tested` without being held by its hardest clause. Statuses stay honest by seeding `specified` and flipping only with verified traces.
**From**: docs/archive/intake/2026-07-21-batch-2-seeding-carve.md (forks a–f), dialog 2026-07-21
**Folds into**: REQUIREMENTS.md (R-010..R-031 + the staged-seeding note), docs/specs/build-plan.md (anchors tier-2/tier-3/tier-4/v1-gate)
```

- [ ] **Step 5: Run the checker with the intake still open**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 31 requirements, 7 decisions, 1 intake file(s).`

- [ ] **Step 6: Resolve + archive the intake file**

In `docs/intake/2026-07-21-batch-2-seeding-carve.md`: change `**Status**: open` to `**Status**: resolved`, and replace the sentence "All forks below were resolved in dialog on 2026-07-21; the file stays `open` until the seeding commit allocates the ids and archives it." with "Resolved 2026-07-21: allocated R-010..R-031 + D-007 in the seeding commit." Then:

```bash
mkdir -p docs/archive/intake
git mv docs/intake/2026-07-21-batch-2-seeding-carve.md docs/archive/intake/
```

- [ ] **Step 7: Re-run both gates**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 31 requirements, 7 decisions, 0 intake file(s).`
Run: `bun test`
Expected: all pass (no source changed).

- [ ] **Step 8: Commit**

```bash
git add REQUIREMENTS.md DECISIONS.md docs/specs/build-plan.md docs/intake docs/archive/intake
git commit -m "req: seed R-010..R-031 — batch-2+ carve (D-007); archive the intake"
```

---

### Task 2: Reconcile R-011 (L1 faker floor) → tested

No code changes. Verify the clause↔test mapping, then flip the status.

**Files:**
- Modify: `REQUIREMENTS.md` (R-011 entry only)

**Interfaces:**
- Consumes: R-011 entry from Task 1; `src/engine/faker.test.ts` (existing).
- Produces: R-011 `tested` with traces.

- [ ] **Step 1: Verify each statement clause has a covering test**

Read `src/engine/faker.test.ts` and confirm this mapping (test names as they exist today):

| R-011 clause | Covering test |
|---|---|
| seeded draw (deterministic per seed) | "faker is deterministic for a given seed + channel" |
| seed is causal, not ignored | "faker output varies with the seed (config.seed is causal, not ignored)" |
| output always Ajv-valid | "l1Floor returns a schema-valid payload for a real channel" |
| recheck failure drops + surfaces `mock`/L1 | "l1Floor drops and surfaces an L1 mock violation when the recheck fails" |
| rejecting faker drops + surfaces `mock`/L1 | "l1Floor catches a rejecting faker and surfaces an L1 mock violation" |

If any row has no covering test, STOP and report the gap (Global Constraints).

- [ ] **Step 2: Run the test file**

Run: `bun test src/engine/faker.test.ts`
Expected: 5 pass, 0 fail.

- [ ] **Step 3: Flip R-011 in `REQUIREMENTS.md`**

Change `**STATUS**: specified` to `**STATUS**: tested` and insert after the COVERS line:

```markdown
**IMPL**: src/engine/
**TEST**: src/engine/faker.test.ts
```

- [ ] **Step 4: Run both gates**

Run: `bun scripts/check-docs.ts` — Expected: ok (R-011 tested has traces).
Run: `bun test` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add REQUIREMENTS.md
git commit -m "req: reconcile R-011 → tested (L1 floor covered by faker tests)"
```

---

### Task 3: Reconcile R-015 (validation full bar) — add the delivered-while-flagged sliver

The ring-buffer bar is covered by `src/validation/index.test.ts`; all four kinds over a real transport are covered by the M0 real-client test. The one uncovered clause is "never blocks delivery": nothing asserts a subscriber still receives an off-contract publish. Add that assertion to the existing M0 real-client test, then flip.

**Files:**
- Modify: `test/m0-acceptance.test.ts` (inside the test at line 106, "M0: a real mqtt.js client's off-contract publishes flow through onInbound → validateClientPublish and surface as client violations")
- Modify: `REQUIREMENTS.md` (R-015 entry only)

**Interfaces:**
- Consumes: existing `bootFullStack`, `connectAsync`, `cleanups` idioms in `test/m0-acceptance.test.ts`; R-015 entry from Task 1.
- Produces: R-015 `tested` with traces.

- [ ] **Step 1: Add the observer subscriber to the real-client test**

In `test/m0-acceptance.test.ts`, directly after the existing `client` setup block (after its `cleanups.push(() => client.endAsync());`, before the "exercise every branch" comment), insert:

```ts
	// observe-and-surface (R-015): a subscriber must still receive the
	// off-contract publishes below — validation never blocks delivery
	const observer = await connectAsync(`ws://localhost:${config.brokerWsPort}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		clientId: "observer-1",
	});
	observer.on("error", () => {});
	cleanups.push(() => observer.endAsync());
	const observed: string[] = [];
	observer.on("message", (_topic, payload) => {
		observed.push(payload.toString());
	});
	await observer.subscribeAsync("command/thermostat-1/set", { qos: 1 });
```

And at the end of the same test (after the existing per-kind `expect` loop), append:

```ts
	// both the schema-invalid JSON and the undecodable bytes were delivered
	// raw to the subscriber while their violations surfaced above
	for (let i = 0; i < 80 && observed.length < 2; i++) await Bun.sleep(25);
	expect(observed).toContain(JSON.stringify({ mode: "broil", target: 20 }));
	expect(observed).toContain("not-json{");
```

- [ ] **Step 2: Run the test file**

Run: `bun test test/m0-acceptance.test.ts`
Expected: PASS. (If the new assertions FAIL, delivery is being blocked somewhere: that is a real observe-and-surface defect. STOP and report it; do not flip R-015.)

- [ ] **Step 3: Flip R-015 in `REQUIREMENTS.md`**

Change `**STATUS**: specified` to `**STATUS**: tested` and insert after the COVERS line:

```markdown
**IMPL**: src/validation/, src/control-plane/
**TEST**: src/validation/index.test.ts, test/m0-acceptance.test.ts
```

(IMPL spans both directories because the four-kind classification currently lives in `src/control-plane/index.ts` per M0 wiring; the ring buffer lives in `src/validation/`. The F11 injection cleanup is R-017's business, not R-015's.)

- [ ] **Step 4: Run both gates**

Run: `bun scripts/check-docs.ts` — Expected: ok.
Run: `bun test` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add test/m0-acceptance.test.ts REQUIREMENTS.md
git commit -m "validation: delivered-while-flagged coverage; reconcile R-015 → tested"
```

---

### Task 4: Reconcile R-026 (mqtt-pattern parity) — add the zero-trailing-levels sliver

Existing coverage: capture fidelity ("match() resolves a concrete topic to its channel and captures params": `command/thermostat-1/set` → `{ deviceId: 'thermostat-1' }`) and two filter cases (`state/#` one-level true; `state/+` two-level false). Missing: `#` matching **zero** trailing levels, and its `+` counterpart.

**Files:**
- Modify: `src/registry/index.test.ts` (add one test)
- Modify (contingency only): `src/registry/index.ts` (`matchesFilter`)
- Modify: `REQUIREMENTS.md` (R-026 entry only)

**Interfaces:**
- Consumes: `demoRegistry()` helper in `src/registry/index.test.ts`; `reg.matchesFilter(filter, topic): boolean`.
- Produces: R-026 `tested` with traces.

- [ ] **Step 1: Write the parity test**

Add to `src/registry/index.test.ts` after the existing "matchesFilter implements MQTT + / #" test:

```ts
test("matchesFilter: '#' matches zero trailing levels; '+' requires exactly one", async () => {
	const reg = await demoRegistry();
	// MQTT-3.1.1 §4.7.1.2: "sport/#" also matches "sport" — '#' includes the parent level
	expect(reg.matchesFilter("state/#", "state")).toBe(true);
	expect(reg.matchesFilter("state/+", "state")).toBe(false);
});
```

- [ ] **Step 2: Run it — this is the spike's go/no-go**

Run: `bun test src/registry/index.test.ts`
Expected: PASS → the rewrite + mqtt-pattern combination is a **go**; skip Step 3.
If the `state/#`↔`state` case FAILS → mqtt-pattern does not implement the zero-trailing-levels rule; proceed to Step 3 (this is the anticipated "hand-rolled fallback" carve-out, minimal form).

- [ ] **Step 3 (contingency): shim the zero-trailing case in `matchesFilter`**

In `src/registry/index.ts`, in the registry's `matchesFilter` implementation, before delegating to mqtt-pattern's `matches`, add:

```ts
			// MQTT-3.1.1 §4.7.1.2: 'a/#' matches 'a' itself; mqtt-pattern misses this edge
			if (filter.endsWith("/#") && topic === filter.slice(0, -2)) return true;
```

Re-run: `bun test src/registry/index.test.ts` — Expected: PASS.

- [ ] **Step 4: Flip R-026 in `REQUIREMENTS.md`**

Change `**STATUS**: specified` to `**STATUS**: tested` and insert after the COVERS line:

```markdown
**IMPL**: src/registry/
**TEST**: src/registry/index.test.ts
```

If Step 3 fired, also append this sentence to the R-026 statement: `(The zero-trailing-levels edge is shimmed ahead of mqtt-pattern, which misses it; the rewrite itself held.)`

- [ ] **Step 5: Run both gates**

Run: `bun scripts/check-docs.ts` — Expected: ok.
Run: `bun test` — Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/registry/index.test.ts src/registry/index.ts REQUIREMENTS.md
git commit -m "registry: '#' zero-trailing-levels parity; reconcile R-026 → tested"
```

(Drop `src/registry/index.ts` from the `git add` if Step 3 did not fire.)

---

### Task 5: R-027 — the JSF-fidelity spike (measure, pin, decide)

A harness measures per-fixture Ajv-recheck failure rates for seeded JSF draws; a tripwire test pins the measured state; D-008 records the keyed-fallback verdict. The decision rule is mechanical (spec fork g): nonzero rate on a §5-bar fixture (`external-ref`, `qos-retain`, `qos-overrides`) ⇒ keyed-fallback needed; else drop-and-surface stands.

**Files:**
- Create: `scripts/spike-jsf-fidelity.ts`
- Create: `test/spikes/jsf-fidelity.test.ts`
- Modify: `DECISIONS.md` (append D-008), `REQUIREMENTS.md` (R-027 entry only)

**Interfaces:**
- Consumes: `buildRegistry({ specText, service, config, source })` from `src/registry/index.ts`; `createFaker(config)` from `src/engine/faker.ts`; `loadConfig({ seed })` from `src/config/index.ts`.
- Produces: `measureFixture(path, seeds): Promise<FixtureReport>` and `SPIKE_FIXTURES: string[]` exported from `scripts/spike-jsf-fidelity.ts` (the test imports both); D-008.

- [ ] **Step 1: Write the harness**

Create `scripts/spike-jsf-fidelity.ts`:

```ts
// R-027 (F8): measure json-schema-faker fidelity — per-fixture Ajv-recheck
// failure rates for seeded draws over every bundled channel.schema.
// Verdict rule (D-008): nonzero on a §5-bar fixture ⇒ F5 keyed-fallback needed.
import { loadConfig } from "../src/config/index.ts";
import { createFaker } from "../src/engine/faker.ts";
import { buildRegistry } from "../src/registry/index.ts";

export const SPIKE_FIXTURES = [
	"composition.yaml",
	"external-ref.yaml",
	"qos-overrides.yaml",
	"qos-retain.yaml",
	"thermostat.yaml",
	"v2-pubsub.yaml",
];

export interface FixtureReport {
	fixture: string;
	draws: number;
	failures: number;
	byChannel: Record<string, { draws: number; failures: number }>;
}

const FIXTURE_DIR = `${import.meta.dir}/../fixtures/asyncapi`;

export async function measureFixture(
	fixture: string,
	seeds: number[],
): Promise<FixtureReport> {
	const path = `${FIXTURE_DIR}/${fixture}`;
	const specText = await Bun.file(path).text();
	const reg = await buildRegistry({
		specText,
		service: "spike",
		config: loadConfig(),
		source: path,
	});
	const report: FixtureReport = {
		fixture,
		draws: 0,
		failures: 0,
		byChannel: {},
	};
	for (const ch of reg.channels()) {
		const per = { draws: 0, failures: 0 };
		report.byChannel[ch.topic] = per;
		for (const seed of seeds) {
			const faker = createFaker(loadConfig({ seed }));
			per.draws++;
			report.draws++;
			try {
				const payload = await faker(ch);
				if (ch.validate(payload).length > 0) {
					per.failures++;
					report.failures++;
				}
			} catch {
				// a rejecting faker counts as a failed draw (F5 treats both the same)
				per.failures++;
				report.failures++;
			}
		}
	}
	return report;
}

if (import.meta.main) {
	const seeds = Array.from({ length: 25 }, (_, i) => i + 1);
	for (const fixture of SPIKE_FIXTURES) {
		const r = await measureFixture(fixture, seeds);
		const rate = r.draws ? ((100 * r.failures) / r.draws).toFixed(1) : "n/a";
		console.log(`${fixture}: ${r.failures}/${r.draws} failed (${rate}%)`);
		for (const [topic, per] of Object.entries(r.byChannel)) {
			if (per.failures > 0)
				console.log(`  ${topic}: ${per.failures}/${per.draws}`);
		}
	}
}
```

- [ ] **Step 2: Run the measurement and record the table**

Run: `bun scripts/spike-jsf-fidelity.ts`
Expected: one line per fixture, e.g. `thermostat.yaml: 0/75 failed (0.0%)` (failure counts are the measurement — record the full printed table verbatim; it feeds Steps 3 and 4).

- [ ] **Step 3: Write the tripwire test pinning the measured state**

Create `test/spikes/jsf-fidelity.test.ts`. Set `EXPECTED_FAILURES` to exactly what Step 2 measured **re-measured over seeds 1..10** (the test uses 10 seeds to stay fast; run `bun test test/spikes/jsf-fidelity.test.ts` once with an empty object to read the actual counts from the failure diff if any fixture is nonzero):

```ts
import { expect, test } from "bun:test";
import {
	measureFixture,
	SPIKE_FIXTURES,
} from "../../scripts/spike-jsf-fidelity.ts";

// R-027 tripwire: pins the measured per-fixture recheck-failure counts so a
// JSF/schema regression is loud, not silent. Update EXPECTED_FAILURES only
// with a re-measurement + a D-### note (the D-008 verdict rests on these).
const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
const EXPECTED_FAILURES: Record<string, number> = {
	"composition.yaml": 0,
	"external-ref.yaml": 0,
	"qos-overrides.yaml": 0,
	"qos-retain.yaml": 0,
	"thermostat.yaml": 0,
	"v2-pubsub.yaml": 0,
};

test("JSF recheck-failure rates match the D-008 measurement", async () => {
	const measured: Record<string, number> = {};
	for (const fixture of SPIKE_FIXTURES) {
		measured[fixture] = (await measureFixture(fixture, SEEDS)).failures;
	}
	expect(measured).toEqual(EXPECTED_FAILURES);
});
```

The `0` values above are the *presumed* measurement; replace any that Step 2 showed as nonzero with the measured count for seeds 1..10.

- [ ] **Step 4: Run the tripwire**

Run: `bun test test/spikes/jsf-fidelity.test.ts`
Expected: PASS with EXPECTED_FAILURES matching the measurement.

- [ ] **Step 5: Append D-008 to `DECISIONS.md`**

Fill the two bracketed slots from the Step 2 table (everything else verbatim):

```markdown
### D-008: JSF-fidelity spike verdict — [drop-and-surface stands | F5 keyed-fallback needed]
**Date**: 2026-07-21
**What**: Ran the R-027 (F8) spike: json-schema-faker 0.6.2 seeded draws over every bundled `channel.schema` in `fixtures/asyncapi/*`, Ajv-rechecked per draw (25 seeds per channel). Measured per-fixture recheck-failure rates: [paste the Step 2 table]. Verdict per the mechanical rule: [no §5-bar fixture failed ⇒ F5's drop-and-surface stands and the L1 floor needs no keyed-fallback re-draw | `<fixture>` failed at `<rate>` ⇒ F5's keyed-fallback re-draw is needed and must be designed into the engine-chain plan (R-010..R-014)].
**Why**: F5 tolerates an empty floor only if recheck failures are rare enough not to hollow out L1's CI reliance; the §5-bar fixtures are the correctness floor, so any failure there means the floor must re-draw rather than drop. The tripwire test pins the measured counts so drift is loud.
**From**: R-027 spike run (2026-07-21), scripts/spike-jsf-fidelity.ts
**Folds into**: REQUIREMENTS.md (R-027), test/spikes/jsf-fidelity.test.ts (tripwire), docs/specs/build-plan.md#spikes (spike 5 resolved)
```

- [ ] **Step 6: Flip R-027 in `REQUIREMENTS.md`**

Change `**STATUS**: specified` to `**STATUS**: tested` and insert after the COVERS line:

```markdown
**IMPL**: scripts/spike-jsf-fidelity.ts
**TEST**: test/spikes/jsf-fidelity.test.ts
```

Also append to the R-027 statement: `(Measured; verdict in D-008.)`

- [ ] **Step 7: Run both gates**

Run: `bun scripts/check-docs.ts` — Expected: `check-docs: ok — 31 requirements, 8 decisions, 0 intake file(s).`
Run: `bun test` — Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add scripts/spike-jsf-fidelity.ts test/spikes/jsf-fidelity.test.ts DECISIONS.md REQUIREMENTS.md
git commit -m "spike: JSF fidelity harness + tripwire; R-027 → tested, verdict in D-008"
```

---

### Task 6: Final verification + handoff state

No commit; this task confirms the plan's end state and names the follow-on.

- [ ] **Step 1: Full-corpus check**

Run: `bun scripts/check-docs.ts && bun test`
Expected: checker ok (31 requirements, 8 decisions, 0 intake); full suite green.

- [ ] **Step 2: Confirm the status ledger**

Run: `grep -A2 "R-01[01256]\|R-027" REQUIREMENTS.md | grep STATUS`
Expected: R-010 `specified` · R-011 `tested` · R-012 `specified` · R-015 `tested` · R-026 `tested` · R-027 `tested`.

- [ ] **Step 3: Handoff**

The next plan is the engine build chain, in dependency order R-010 (scheduler core) → R-012 (L3 dispatch) → R-013 (emit-completion) → R-014 (reset), designed with the D-008 verdict as input (keyed-fallback in scope iff D-008 says so). R-016..R-025 and the gate entries R-028..R-031 stay `specified` for later enrichment rounds.
