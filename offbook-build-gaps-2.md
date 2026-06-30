# Offbook — v1 Pre-Build Gap Resolution, Round 2 (Handoff)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (the **canonical** frozen interfaces — the conflict rule applies: if any other doc disagrees on an interface/API detail, the contract wins and the other doc is the bug), `offbook-build-gaps.md` (the G1–G25 first round), `offbook-build-plan.md`, `offbook-design.md`, `offbook-l2-scenarios.md`.

**Status:** **Resolved (2026-06-27)** — all 26 items (F1–F21 findings + R1–R5 reuse) landed across `offbook-contracts.md` (canonical), `offbook-design.md`, and `offbook-build-plan.md`; see the Decision log. From a **second** logical dry-run of the v1 core build (2026-06-24), run *after* G1–G25 were marked "resolved / execution-complete." **Tier 1 (F1–F6) is the typed-contract layer the parallel fan-out imports.** **F1, F2, F6 are the hard blockers** — there is literally no type/field/owner to import. **F5** is a real fork but narrower than first stated (the two design docs already agree on drop-and-surface; see the reframe below). **F3** (a same-named-`seq` footgun — the canonical loop is already safe) and **F4** (a known one-token rename) are lower-severity contract-hygiene that still belong with the freeze. None can be left to per-resolver choice without re-opening the cross-module collision the freeze exists to prevent. **Tier 2 (F7–F10)** is the determinism gate (the non-negotiable v1 acceptance). **Tier 3 (F11–F15)** blocks a specific consumer. **Tier 4 (F16–F19)** is narrower. **Tier 5 (R1–R5, F20–F21)** is reuse/cleanup — quality, not blocking.

**Why this exists.** G1–G25 were declared decision- *and* execution-complete, but a fresh module-by-module dry-run surfaces a recurring class the first round missed: several "resolved" gaps were fixed in **prose** while the corresponding **type / field / seam never landed in canonical `offbook-contracts.md`** — so the parallel build agents the freeze protects have nothing to import (`seedInstances`, `Config`, `engine.fake`, the `+`/`#` matcher owner, the delay-string→`delayMs` owner, the drop-vs-emit silence on failed-recheck). A second class: the determinism guarantee is asserted but rests on unpinned details (PRNG draw-order, faker internals, wall-clock fields, mode default). Each item below is the same kind of cross-module collision `offbook-contracts.md` line 7 was written to prevent.

**How to use this doc.**
1. Pick an item (start with Tier 1). Each item is self-contained.
2. Make the **Decision owed** — the genuine fork(s) only a lead can settle. A **Recommended resolution** is given; adopt or override it.
3. Resolve it in the **Owner** doc (the conflict rule means `offbook-contracts.md` wins; fix the others to match).
4. Verify against **Acceptance** (self-checkable).
5. Tick the item's `Status` box and add a row to the **Decision log**.

> **Line numbers are anchors as-of HEAD `ff38748` (2026-06-24) and drift once edits land.** Anchor by stable reference (`§N` / type name / heading); treat line numbers as hints.

---

## Summary

| ID | Finding | Tier | Owner / Lands in | Blocks? |
|---|---|---|---|---|
| F1 | `seedInstances` has no typed home — G3 reset/materialization unbuildable | 1 | contracts §1/§6 | ✅ |
| F2 | `Config` interface untyped + no committed `seed`/`fixedEpoch` values | 1 | contracts (new §) / model | ✅ |
| F3 | Action-response `seq` unqualified — a same-named-field footgun (canonical loop already checkpoints `reset.seq`) | 1 | contracts §5 | harden |
| F4 | `register(topicPrefix)` type lags its `pattern` prose — a known one-token edit | 1 | contracts §3 | mechanical |
| F5 | Not a 3-way contradiction: design+build-plan agree (drop-and-surface); contracts §4 silent; L1's on-failure output is the real fork (F8) | 1 | contracts §4 · design §4 · build-plan | ✅ |
| F6 | `+`/`#` subscribe-filter matching has no owner, crosses a tier boundary | 1 | contracts §1/§2 · build-plan | ✅ |
| F7 | Two PRNG architectures conflated (keyed delays vs shared-cursor faker/random/uuid) | 2 | contracts §3 · l2 §5/§6 | gate |
| F8 | L1 floor rests on json-schema-faker 0.6.2's weak spots — the correctness-bar fixture | 2 | build-plan · contracts §1 | gate |
| F9 | "byte-identical" asserted over `Violation` incl. wall-clock `observedAt`/`receivedAt` | 2 | contracts §4 | gate |
| F10 | Determinism only quiesced in `passive`; default is `autonomous`; tick clock-domain unpinned | 2 | contracts §3/§5 | gate |
| F11 | `control-plane → engine.fake` is an undeclared dependency seam | 3 | contracts §3/§5 · build-plan | — |
| F12 | `Resolver.resolve(...)` method vs `GitRefResolver(...)` constructor → can't implement | 3 | contracts §6 · build-plan | — |
| F13 | No owner/carrier completes a `Partial` emit into a `NormalizedMessage` | 3 | contracts §3/§3a | — |
| F14 | `topicOverrides` key *identity* already pinned (channel address); only the *matching mechanism* is open + `qos-overrides.yaml` omitted from the gate | 3 | contracts §6 · build-plan §4 | — |
| F15 | `GET /diagnostics` returns an untyped `summary` | 3 | contracts §5 | — |
| F16 | `declaredVersion` is *renamed* across the lockfile seam, not just re-cased | 4 | contracts §6 | — |
| F17 | By-SHA fetch depends on host `allowAnySHA1InWant`; fallback uncontracted | 4 | contracts §6 · build-plan | — |
| F18 | Hidden Tier-1↔Tier-1 back-edge: `registry/` needs `ingestion/`'s `ServiceConfig` loader | 4 | build-plan §3 | — |
| F19 | `register()` at import-time vs registry hot-swap → init-order unspecified | 4 | contracts §3/§5 | — |
| R1 | `Channel.schema` bundling reinvents the parser stack's `bundle()` | 5 | registry/ | — |
| R2 | `SpecRegistry.match` hand-rolled; `mqtt-pattern` covers it (resolves F6) | 5 | registry/ · build-plan | — |
| R3 | `getState()` rebuilds Aedes' own retained store | 5 | broker/ | — |
| R4 | L1 `fake` runs a second PRNG alongside JSF's native seed (sharpens F7) | 5 | engine/ | — |
| R5 | `SchemaError` re-declares Ajv's `ErrorObject` minus two fields | 5 | model/ · validation/ | — |
| F20 | v2-shaped machinery + kebab serializer + single-value enum have no v1 consumer | 5 | contracts §6 | — |
| F21 | `specs/refresh` full rebuild, serial fetch, O(n) ring-buffer evict | 5 | various | — |

---

## Tier 1 — blocks the parallel build

### F1 — `seedInstances` has no typed home; G3's reset/materialization is unbuildable
- **Where:** `offbook-contracts.md` §2 (materialization policy + `reset` rule, lines ~83–84); `offbook-design.md` §7a (line ~182). `seedInstances` is normative ("pre-materializes a deterministic demo set"; `reset` re-materializes "seed instances + those materialized since"), but it is a field on **no** interface — not `Channel` (§1), not `ServiceConfig` (§6), not any config schema.
- **Problem:** the engine's initial-state path reads a per-channel `seedInstances` list that has no declared location, key, or casing. Compounding it, `offbook-design.md` §7a's bolded headline — "On subscribe, a retained message **must already exist**" — reads as absolute, even though the section immediately partitions it (eager for non-parametrized channels, lazy materialization for parametrized ones). It is *not* a flat contradiction; the headline just overstates before the qualifier resolves it, so a skim-reader takes "must already exist" as universal and mis-implements the parametrized path.
- **If unaddressed:** for a spec whose `toClient` channels are all parametrized, `reset → GET /state` (before any subscribe) returns empty — breaking the moment-4 CI primitive (§2: "post-reset `/state` is deterministic, not empty") that G3 was created to protect. Whoever adds the field invents an off-contract shape, and a second module reads it from a different place ⇒ `undefined`.
- **Decision owed:** where `seedInstances` lives — a per-channel field on `Channel`, a `ServiceConfig.channelOverrides` map keyed by channel address, or a new `scenarios`-adjacent config — and (altitude) whether the 5 stacked materialization special-cases (eager / lazy / wildcard-replay / `seedInstances` / reset) should collapse into one first-class instance-lifecycle entity.
- **Recommended resolution:** give the materialized-instance set a named home and a typed config carrier. Minimum viable:
  ```ts
  // model/ — a first-class instance registry the engine owns (collapses the 5 special cases)
  interface InstanceRegistry {
    materialize(channelAddress: string, params: Record<string, string>): void;
    // list(filter?) REMOVED (↻ CR11): wildcard replay reads Aedes' retained store + matchesFilter, not a parallel set
    snapshot(): InstanceSnapshot;   // captured at reset for deterministic re-materialization
    restore(s: InstanceSnapshot): void;
  }
  // ServiceConfig (or a sibling channelConfig) gains the seed set:
  interface ServiceConfig { /* …existing… */ seedInstances?: Record<string, Record<string, string>[]>; } // channel address → list of param-maps (multi-param; the landed canonical shape — see contracts §6 + Decision-log row F1; the early `Record<string,string[]>` sketch was superseded)
  ```
  Then soften `offbook-design.md` §7a's headline so it stops reading as universal: scope it to "the engine guarantees retained state exists for any *materialized* instance — eager for non-parametrized channels, lazy on first concrete subscribe for parametrized ones." Keep the existing eager/lazy partition; only stop the bolded sentence from implying every channel pre-exists.
- **Acceptance:** `grep -rn seedInstances` resolves to exactly one declared field; `tsc` compiles the engine's `for (const id of channel…seedInstances)` access; an integration test with a parametrized-only spec does `reset → GET /state` *before any subscribe* and gets the seeded set (non-empty, deterministic); `offbook-design.md` §7a's headline no longer reads as universal pre-existence (the eager/lazy partition is stated up-front, before any "must already exist" phrasing).
- **Relates to:** F6 (the `+`/`#` filter semantics — *↻ CR11: now via `matchesFilter` over Aedes' retained store; the `list(filter)` method was dropped, L67*), F2 (where the config type lives).
- **Status:** ☑ **resolved** (2026-06-26) — see Decision log.

### F2 — `Config` is untyped, and `seed`/`fixedEpoch` have no committed values
- **Where:** `offbook-build-gaps.md` residuals (line ~324, "`config/` is untyped"); consumers: `config.maxViolations`/`maxEvents` (contracts §5 line ~244), `config.injectedClientId` (§5 line ~255), `tickIntervalMs` (§3 line ~95), plus `seed`, `fixedEpoch` (§3 line ~92), ports. `model/` (Tier 0) is told to "transcribe every type in §1–6" but there is no `Config` to transcribe, and it is frozen first.
- **Problem:** every Tier-1/Tier-2 module reads `config.*` fields, but no `Config` interface exists, so each declares its own shape and defaults. Separately, `fixedEpoch` and the default run `seed` are referenced as the base of the logical clock and the faker but are never assigned **concrete committed values** — two implementers pick different epochs/seeds.
- **If unaddressed:** `maxViolations === undefined` makes `arr.length > undefined` always false ⇒ the ring buffer grows unbounded (the exact ceiling it exists to impose), with no `tsc` error because `config` is implicitly `any`; `injectedClientId` defaults diverge between control-plane and engine; and the determinism "golden snapshot" is unreproducible across machines because the epoch/seed aren't pinned.
- **Decision owed:** (a) the field set + defaults for `Config`; (b) the concrete committed `fixedEpoch` constant and default `seed` (e.g. `fixedEpoch = 1_700_000_000_000`, `seed = 0x9E3779B9`).
- **Recommended resolution:** add to `model/` and a new contracts §:
  ```ts
  interface Config {
    seed: number;                 // default run seed; reset re-seeds to this
    fixedEpoch: number;           // logical-clock base for now() = fixedEpoch + Σ delays
    tickIntervalMs: number;       // default 1000
    maxViolations: number;        // ring-buffer cap; default e.g. 10_000
    maxEvents: number;            // reserved (inbound-event history); default 0/unused in v1
    injectedClientId: string;     // default 'control-plane' (G9)
    brokerWsPort: number;         // default 9001
    brokerTcpPort: number;        // default 1883
    controlPlanePort: number;     // default 9080
  }
  export const DEFAULT_CONFIG: Config = { /* the committed constants above */ };
  ```
- **Acceptance:** `tsc` clean across validation/engine/control-plane against the shared `Config`; `grep -rn 'config\.' src/` shows every access keyed to a declared field; two fresh checkouts produce the **same** `{{now}}` value for the same scripted run (the committed `fixedEpoch`+`seed` make the snapshot machine-independent).
- **Relates to:** F1, F9, F10.
- **Status:** ☑ **resolved** (2026-06-26) — see Decision log.

### F3 — Action-response `seq` is unqualified — a same-named-field footgun (the canonical CI loop is already safe)
- **Where:** `offbook-contracts.md` §5 — `POST /publish` `202 {…, seq}`, `POST /trigger` `202 {scenario, fired, seq}`, `POST /reset` `200 {reset, seed, seq}` (lines ~247–249); `offbook-build-gaps.md` residual (line ~323). G6 split `seq` into `InboundEvent.meta.seq` (inbound-arrival) and `Violation.seq` (unique log cursor) — two disjoint number-spaces.
- **Problem:** each `202`/`200` returns a field literally named `seq`, but `/reset`'s is the **log cursor** that feeds `?sinceSeq=`, while `/publish` synthesizes an `InboundEvent` and has `meta.seq` in scope. No action response says which counter it returns. **But the live false-negative is already designed out:** contracts §5 line ~249 states `/reset.seq` is the "`seq` baseline (feeds `?sinceSeq=`)" and the canonical CI loop (line ~258) checkpoints off `reset`, never `/publish`. What remains is a **footgun** — `/publish`/`/trigger` still expose a same-named `seq` (the inbound `meta.seq`) a careless author could checkpoint off instead — so this is hardening, not a blocker.
- **If unaddressed:** a CI client that checkpoints off `/publish.seq` then polls `/validation?sinceSeq=<that>` is comparing two number-spaces that drift (the inbound counter advances only on inbound; the log cursor advances on every violation incl. mock) ⇒ it skips the just-injected violation ⇒ `summary.byOrigin.client === 0` passes while a real client break shipped. That is the exact false-negative G6 set out to kill.
- **Decision owed:** which counter each action response returns — recommend **rename the field per endpoint** so it can't be confused.
- **Recommended resolution:** in §5, replace the bare `seq` in every action response: `/publish` and `/trigger` return `{ …, meta: { seq } }` (the inbound-arrival `meta.seq`); `/reset` returns `{ …, sinceSeq }` (the `Violation`-log baseline that `?sinceSeq=` consumes). Document that the CI loop checkpoints off `/reset.sinceSeq`, never off `/publish`. *(↻ CR4, 2026-06-27: `/publish` now returns **`sinceSeq`**, not `meta:{seq}` — `meta.seq` is `undefined` for a `toClient` publish (no `InboundEvent`) and a different number-space from `?sinceSeq=`; `/publish`+`/trigger`+`/reset` are now uniform. `meta.seq` stays internal (G9). See Round-3 follow-ons.)*
- **Acceptance:** the canonical CI loop (`reset` → `publish` known-bad → `poll /validation?sinceSeq=<reset.sinceSeq>` → assert `byOrigin.client === 1`) returns the injected violation; no action response carries a field named `seq` whose counter is ambiguous (grep: every `seq` in §5 is qualified `meta.seq` or `sinceSeq`).
- **Relates to:** F9, F10.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F4 — `register(topicPrefix: string)` — the frozen type lags its `pattern` prose (a known one-token edit, not a blocker)
- **Where:** `offbook-contracts.md` §3 — `declare function register(topicPrefix: string, factory)` (line ~124) vs the prose redefining arg0 as a channel **pattern** resolved by `SpecRegistry.match` (line ~132); `offbook-build-gaps.md` residual defers the rename (line ~320).
- **Problem:** the frozen signature names arg0 `topicPrefix: string`; the spec behavior is a single-segment `{param}` channel address resolved by the registry matcher. A builder reading only the `.d.ts` line in isolation implements `topic.startsWith(topicPrefix)`. **This is the only doc where the old name survives** — `offbook-build-plan.md` already uses `register(pattern, …)` throughout, and contracts §3's own adjacent prose already says "read it as `pattern`" and calls the rename "a one-token edit." So it's contract-hygiene with no open decision, not a load-bearing blocker.
- **If unaddressed:** only bites an agent who reads the frozen `.d.ts` line in isolation and skips §3's adjacent "read it as `pattern`" note — then `register('state', factory)` under prefix semantics also captures `stateful/x`, while under pattern semantics it returns "no channel" (`state` isn't a valid address), `tsc` stays green, and L3 routing diverges from validation/publish routing. Landing the edit removes the trap.
- **Decision owed:** none — mechanical. The rename was already decided (G11); it just never landed in the canonical type.
- **Recommended resolution:** edit the frozen line:
  ```ts
  declare function register(pattern: string, factory: HandlerFactory): void; // pattern = AsyncAPI channel address w/ {param}; resolved by SpecRegistry.match
  ```
- **Acceptance:** `grep -n 'topicPrefix' offbook-contracts.md` returns nothing; the L3 acceptance test registers `command/{deviceId}/set` and a publish to `command/thermostat-1/set` routes to it while `commandX/...` does not.
- **Relates to:** F6, R2.
- **Status:** ☑ **resolved** (2026-06-26) — see Decision log.

### F5 — On a failed mock Ajv-recheck the two design docs already agree (drop-and-surface); contracts §4 is silent, and what L1 emits *instead* is the open fork
- **Where:** `offbook-design.md` §4 (line ~113: recheck "makes any non-conforming output **fail loudly instead of silently emitting** invalid mock data"); `offbook-build-plan.md` §3 engine acceptance (line ~77: "**L1 output always Ajv-valid (oneOf edge caught by recheck → `mock` violation, never silent)**"); `offbook-contracts.md` §4 (line ~197: the engine stamps a `mock` `Violation` on the recheck, but never says whether the payload is then dropped or emitted).
- **Problem:** *not* a three-way contradiction. Design §4 and build-plan §3 **agree** — a non-conforming payload is **caught and surfaced as a `mock` violation, not emitted** ("fail loudly instead of emitting" *is* "caught by recheck → violation, never silent"; the build-plan parenthetical is the mechanism behind the design headline). Contracts §4 is merely **silent** on emit-vs-drop. Two genuine gaps remain, neither of them the asserted contradiction: **(a)** contracts §4 should state the drop-and-surface behavior explicitly so the engine author doesn't default to emit-anyway; **(b)** the **real open fork** — once the bad payload is dropped, *what does L1 emit in its place?* Drop-only leaves the proactive floor empty (blank UI), fighting "L1 = works day one"; the alternative is a valid fallback (a **keyed** re-draw or a schema-default skeleton). That fork is F8's territory (faker fidelity), not a recheck-policy contradiction.
- **If unaddressed:** an engine author reading only contracts §4 (silent) picks emit-anyway and ships known-invalid mock data, contradicting design §4's explicit "instead of emitting"; **or** picks drop-only and a parametrized fixture renders blank on first subscribe with no fallback. A naïve re-fake on failure perturbs the PRNG stream (breaks replay — F7).
- **⚠️ Correction to the prior recommendation:** the earlier "emit the payload anyway + raise a violation" resolution **reversed** the settled design decision, justified by the "observe-and-surface, never block-at-broker" hard constraint — but that constraint governs **the broker delivering a *client's* bytes** (a real MQTT broker is payload-agnostic), not the **engine vetting its *own* generated output** before it ever reaches the broker. Blocking your own known-bad output is a different layer from blocking a client's payload; don't conflate them.
- **Decision owed (the genuine fork — for the lead):** on a dropped L1 payload, does the floor stay **empty** (fine for a deliberately-adversarial schema) or does L1 emit a **valid fallback** — and if so, a *keyed* re-draw (F7-safe) or a schema-default skeleton? Settle it **with F8** (whether the §5 bar fixtures even trip the recheck).
- **Recommended resolution:** (1) keep design §4 + build-plan §3 as-is (already aligned). (2) In contracts §4, make drop-and-surface explicit in one place: "a payload that fails its pre-emit recheck is **not emitted**; the engine raises an engine-stamped `mock` `Violation` and never re-draws on the live cursor." (3) Leave the empty-vs-fallback choice to the Decision owed above, resolved alongside F8.
- **Acceptance:** a fixture whose schema defeats json-schema-faker (an adversarial `oneOf`) produces a `mock` `Violation` and the invalid payload is **not** delivered to a subscriber; contracts §4 states drop-and-surface in exactly one place; no doc recommends emitting the known-invalid payload; the empty-vs-fallback choice is recorded as a decision, not left implicit.
- **Relates to:** F7 (keying any fallback re-draw), F8 (does the bar fixture trip the recheck at all — the same decision).
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F6 — `+`/`#` subscribe-filter matching has no owner and crosses a tier boundary
- **Where:** `offbook-contracts.md` §1 (line ~52: `SpecRegistry.match` "never interprets" `+`/`#`); §2 (line ~82: wildcard subscribe replays retained for "already-materialized instances matching the filter"); §3a (line ~149: `WhenClause.topic` carries `+`/`#`); `offbook-l2-scenarios.md` §4 (lines ~84–86: the only specced `+`/`#` algorithm, inside `scenarios/`).
- **Problem:** `SpecRegistry.match` is explicitly an address matcher that refuses `+`/`#`. But the **engine** (Tier 2) must test "does materialized `state/thermostat-1` fall under `SUBSCRIBE state/#`?" and **scenarios/** (Tier 3) must match `when.topic` with `+`/`#`. The only `+`/`#` implementation lives in Tier-3 `scenarios/`, which Tier-2 `engine/` cannot import — so the engine hand-rolls a *second* matcher.
- **If unaddressed:** the divergent-semantics duplication G1 forbade is reintroduced on the subscribe-filter side G1 never covered → wildcard replay and `when`-matching can disagree → non-deterministic routing. Plus, on a *concrete* subscribe, "who materializes" is unpinned (broker emits the event, §2 says the engine publishes) — if each assumes the other initiates, first-subscribe retained never appears (blank UI).
- **Decision owed:** which module owns subscribe-filter (`+`/`#`) matching, and whether to adopt a library (see R2) so it is shared rather than duplicated.
- **Recommended resolution:** add a second matcher to `registry/` beside `match` (or adopt `mqtt-pattern`, R2): `SpecRegistry.matchesFilter(filter: string, topic: string): boolean` for `+`/`#`, imported by both engine (wildcard replay) and scenarios (`when.topic`). Pin in §2 that the **engine** owns concrete-subscribe materialization, triggered by `broker.onSubscribe`.
- **Acceptance:** exactly one `+`/`#` filter implementation exists (`grep -rn "split('/')" src/` shows no second hand-rolled matcher); `state/#` replays retained for all materialized instances and invents none; a concrete `SUBSCRIBE state/thermostat-1` materializes and the subscriber receives retained state on first subscribe.
- **Relates to:** F1, R2.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

---

## Tier 2 — the determinism gate (non-negotiable v1 acceptance)

### F7 — Two PRNG architectures are conflated as "the same Mulberry32"
- **Where:** `offbook-l2-scenarios.md` §6 (line ~125: L2 delays = `mulberry32(hash(runSeed+scenarioName+stepIndex))`, "keyed by a stable identity, not a shared stream cursor"); §5 (line ~111: `{{uuid}}` = "run seed + counter"); line ~149 ("L1, ranged delays, and helpers all draw from it"); `offbook-contracts.md` §3 (line ~120: `ctx.random()` "seeded PRNG draw").
- **Problem:** L2 delays are order-independent (keyed-hash), but `ctx.random()`, the L1 faker, tick jitter, and `{{uuid}}` merely "draw from" the seed with **no keying discipline stated**. The contract never says which consumers share a cursor vs. are keyed, nor pins the `{{uuid}}` counter's scope (global/per-scenario/per-step).
- **If unaddressed:** if L1 and `ctx.random()` share one cursor, the value at any draw depends on how many prior draws occurred — load/interleaving-dependent. It is *only* safe under scripted-inbound passive CI; autonomous mode or any reordering yields a byte-different emission stream from an identical seed.
- **Decision owed:** the global determinism invariant — recommend "every seeded draw is keyed by a stable identity (channel/scenario/step), never a shared mutable cursor."
- **Recommended resolution:** state in contracts §3: "All seeded draws use `mulberry32(hash(runSeed + <stable-id>))`, never a long-lived shared cursor. `ctx.random()` is keyed by `(handlerPattern, callIndex)`; L1 `fake` by `(channelAddress)`; `{{uuid}}`/`{{seq}}` by `(scenarioName, stepIndex, fieldPath)`; tick jitter by `(tickIndex)`." Make the rule a checked invariant, not a per-feature patch. *(↻ CR10, 2026-06-27: contracts §3 landed `{{uuid}}`/`{{seq}}` as per-scenario **counters** (category ii), **not** keyed `(scenarioName,stepIndex,fieldPath)` draws — a keyed UUID would repeat on every firing and break `{{seq}}`'s monotonicity. Do not re-propose keying these two; see Round-3 follow-ons.)*
- **Acceptance:** a stress test that reorders independent inbound publishes (preserving the logical script) produces a byte-identical `/validation` stream under a fixed seed; no engine PRNG is a module-global mutable `let rng`.
- **Relates to:** F8, F10, R4.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F8 — The L1 floor rests on json-schema-faker 0.6.2's documented weak spots — which are the chosen correctness-bar fixture
- **Where:** `offbook-build-plan.md` §1 (line ~23, pinned `json-schema-faker@0.6.2`); `offbook-design.md` §4 (line ~113: weak spots on `allOf`/`oneOf`/`anyOf`, external `$ref`, unusual `format`; "thin track record," v0.6.2 published 2026-05-25); `offbook-contracts.md` §1 (line ~54: `external-ref.yaml` + `shared/common.yaml` is *the* §5 correctness bar).
- **Problem:** JSF runs its *own* seeded RNG; its weak spots are exactly the composition/`$ref` shapes the bar fixture exercises. The engine acceptance ("L1 output always Ajv-valid") and the recheck-failure behavior (F5) are both undefined for the case JSF most likely mis-generates.
- **If unaddressed:** on the very fixture chosen to prove correctness, JSF may emit a non-conforming payload → the recheck fires with undefined behavior (F5) and "always valid" can't hold. The de-risking spike for this risk is absent.
- **Decision owed:** confirm the JSF pin + the recheck contract (F5), and whether to add a faker-fidelity spike against `external-ref.yaml`/`qos-overrides.yaml` before relying on L1 in CI.
- **Recommended resolution:** (1) resolve F5 (emit-and-surface). (2) Add a spike (mirroring §12 spikes): run JSF 0.6.2 against every fixture's bundled `channel.schema`, count recheck failures; if the bar fixtures fail, either bound the criterion to "non-`oneOf` channels" + known-limitations, or add a bounded re-draw with a *keyed* fallback seed (not the live cursor — see F7).
- **Acceptance:** a `bun test` over `fixtures/asyncapi/*` reports the JSF-vs-Ajv recheck failure rate per fixture; `external-ref.yaml`'s bundled schema either generates a valid instance or its failure is an explicitly-asserted, surfaced `mock` violation (never a silent invalid emit).
- **Relates to:** F5, F7, R1, R4.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F9 — "byte-identical" is asserted over the whole `Violation`, which contains wall-clock fields
- **Where:** `offbook-contracts.md` §4 (line ~199, the determinism guarantee over the emission/violation stream) vs `Violation.observedAt` "ISO8601 wall-clock; non-reproducible" (line ~182) and `meta.receivedAt` wall-clock (§1 line ~58); `offbook-build-plan.md` §4 (line ~93, "identical … violation ordering").
- **Problem:** the guarantee covers the `Violation` record, but two of its fields are wall-clock and explicitly non-reproducible, and no doc states they are excluded from the comparison.
- **If unaddressed:** the obvious CI implementation — byte-compare two `/validation` JSON responses — fails on *every* entry of a perfectly deterministic engine, because `observedAt` differs by the wall-ms between runs.
- **Decision owed:** the precise comparison contract — recommend define determinism over a **canonical projection** that excludes wall-clock fields.
- **Recommended resolution:** state in §4: "Determinism is over `Violation` **minus** `observedAt` (wall-clock) **and** `clientId` (arbitrary for real ws clients) — i.e. the projection `{seq, origin, kind, severity, topic, channel, detail, errors, emitSource, payload}`. (The inbound stream is likewise compared with `InboundEvent.meta.receivedAt` excluded — that wall-clock field lives on `meta`, **not** on `Violation`, so it is not part of *this* projection.) CI applies this field-mask before diffing two `/validation` responses." Optionally provide a `GET /validation?canonical=true` mode or document the field-mask the harness applies.
- **Acceptance:** the determinism test diffs the canonical projection across two runs and gets zero differences; the doc names exactly which fields are excluded.
- **Relates to:** F3, F10.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F10 — Determinism is only quiesced in `passive`, but the default mode is `autonomous`; tick clock-domain is unpinned
- **Where:** `offbook-contracts.md` §5 (line ~250: default `autonomous`; "startup flag/env boots `passive` for CI"); §3 (line ~95: ticks "fire on a config `tickIntervalMs` (default 1000)"); G24 (`passive` freezes ticks + hot-reload).
- **Problem:** nothing *forces* CI into `passive`; and `tickIntervalMs` reads as a wall interval, not a virtual-clock horizon. The seed fixes each tick's *content*, not how many ticks land in a wall poll-window.
- **If unaddressed:** a determinism test run against defaults gets autonomous ticks firing between `reset` and assert; the tick *count* in a wall window is host-load-dependent even with a fixed seed ⇒ divergent `seq` stream ⇒ flaky gate.
- **Decision owed:** (a) make `passive` the implicit mode whenever the harness drives a scripted run, or require an explicit assertion that CI booted `passive`; (b) pin whether ticks are scheduled in virtual time against a fixed virtual horizon.
- **Recommended resolution:** state in §3/§5: "Reproducible-autonomous requires ticks scheduled on the **virtual clock**; the harness reads a fixed *virtual-time horizon*, not a wall window. CI must boot `passive` (no ticks, no hot-reload); the determinism acceptance asserts `GET /mode` is `passive` before running." Add `mode` to the determinism test's preconditions.
- **Acceptance:** with the server booted `autonomous`, the determinism test refuses to run (asserts `passive`) rather than flaking; with virtual-scheduled ticks, two runs over the same virtual horizon emit the same tick count.
- **Relates to:** F7, F9.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

---

## Tier 3 — seam & type defects (block a specific consumer)

### F11 — `control-plane → engine.fake` is an undeclared dependency seam
- **Where:** `offbook-contracts.md` §5 (line ~212, `GET /topics` inlines a "seeded example"; `POST /publish {example:true}` generates one) vs §3 (line ~128, L1 `fake(channel, seed) → payload` is bare prose, not a method on any exported interface); `offbook-build-plan.md` §3 lists no `control-plane → engine` edge.
- **Problem:** two control-plane endpoints need the L1 faker, but it is not an exported surface and the dependency edge isn't declared. (G2 decided `example` is "computed on demand by `/topics`," but never said *by which exported function*.)
- **If unaddressed:** control-plane re-implements JSF seeding independently ⇒ `/topics` examples differ byte-for-byte from what `/publish {example:true}` emits (two faker instances, divergent draw order); or it re-stores `example` on `Channel`, re-freezing the type G2 kept pure.
- **Decision owed:** export the faker as a declared seam vs. inject it — recommend export `fake` from `engine/` and declare the edge.
- **Recommended resolution:** add to the engine's public interface: `fake(channel: Channel): unknown` (keyed-seeded per F7, memoized per F21), and declare `control-plane depends on engine.fake` in build-plan §3. `/topics` example and `/publish {example:true}` both call it. *(↻ CR1, 2026-06-27: the signature widened to `fake(channel: Channel, instanceParams?: Record<string,string>): unknown` and the memo key to `(channelAddress, canonicalize(instanceParams))` so per-instance materialization renders distinct devices; example-mode omits `instanceParams`. See contracts §3 + Round-3 follow-ons.)*
- **Acceptance:** `GET /topics` `example` for a channel is byte-equal to the payload `POST /publish {topic, example:true}` injects for the same channel; exactly one faker implementation exists.
- **Relates to:** F7, F21, R4.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F12 — `Resolver.resolve(repo, ref, specPath)` (method) vs `GitRefResolver(repo, ref, specPath)` (constructor)
- **Where:** `offbook-contracts.md` §6 (line ~288: `interface Resolver { resolve(repo, ref, specPath): Promise<ResolvedSpec> }`) vs `offbook-build-plan.md` (line ~74: `GitRefResolver(repo, ref, specPath)` constructor).
- **Problem:** the interface binds the three args on the `resolve` *method*; the build-plan constructs them. A class taking them in the constructor exposes `resolve()` with the wrong arity and does not satisfy `Resolver`.
- **If unaddressed:** `class GitRefResolver implements Resolver` → `tsc` TS2420; or callers split between `new GitRefResolver(repo, sha, …).resolve()` and `resolver.resolve(repo, ref, …)`, one of which silently fetches the wrong ref.
- **Decision owed:** args-per-call (stateless resolver) vs args-at-construction — recommend per-call to match the frozen interface and the `up`/`up --frozen` reuse (same instance, different ref).
- **Recommended resolution:** fix `offbook-build-plan.md` to construct `new GitRefResolver(config)` (host/creds only) and call `resolver.resolve(repo, ref, specPath)` per service/ref. Keep the frozen interface as-is.
- **Acceptance:** `class GitRefResolver implements Resolver` compiles; `up --frozen` calls `resolve(repo, lockEntry.resolvedSha, specPath)` on the *same* instance used for branch-tip resolution.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F13 — No owner/carrier completes a `Partial` emit into a `NormalizedMessage`
- **Where:** `offbook-contracts.md` §3a (`EmitStep.emit.delay: string`, "150-300ms", line ~156) vs `NormalizedMessage.delayMs: number` (§1 line ~26); `HandlerContext.publish(msg: Partial<NormalizedMessage> & { topic: string })` (§3 line ~119) with no declared step filling `qos`/`retain`/`delayMs` from the resolved `Channel`.
- **Problem:** two completion steps exist only in prose with no typed owner: (a) parse the `delay` range string + seeded-draw into `delayMs: number`; (b) fill `qos`/`retain`/`delayMs` defaults from the resolved `Channel` when L3 omits them.
- **If unaddressed:** the scenario runner forwards `delayMs: "150-300ms"` → `tsc` TS2322, or after a cast `now() + "150-300ms"` → `NaN` clock; L3's `ctx.publish({topic, payload})` reaches `broker.emit` with `qos: undefined` → Aedes publishes QoS 0 instead of the channel-resolved QoS, and a `StateEntry.retain: true` is produced from `retain: undefined`.
- **Decision owed:** which module owns "complete a partial/authored emit into a full `NormalizedMessage`" — recommend the engine's emit path (single choke-point), since it already owns `delayMs` resolution and the channel lookup.
- **Recommended resolution:** declare in §3: "Before `broker.emit`, the engine completes every emit: parse `EmitStep.delay` → seeded `delayMs` (F7-keyed); fill `qos`/`retain` from the resolved `Channel`; default `delayMs` to 0. `HandlerContext.publish` and the L2 runner both pass through this completion." Add a `resolveEmit(partial, channel): NormalizedMessage` helper signature.
- **Acceptance:** an L3 handler calling `ctx.publish({topic, payload})` emits at the channel-resolved QoS (asserted via `getState`/a subscriber); a scenario `delay: "150-300ms"` yields a numeric `delayMs` and a finite `now()`.
- **Relates to:** F7.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F14 — `topicOverrides` key *identity* is already pinned (channel address); only the *matching mechanism* is open — plus the override fixture is excluded from the gate
- **Where:** `offbook-contracts.md` §6 (`topicOverrides`, line ~273 — the field comment already reads `key = channel address`; example `telemetry/{deviceId}` line ~312); `offbook-build-plan.md` §4 (line ~92, the "non-negotiable" §5 correctness gate names only `external-ref` + `qos-retain`).
- **Problem:** the key *identity* is **not** unpinned — contracts §6 line ~273 already states `key = channel address`, and the example uses the `{param}` address form (`telemetry/{deviceId}`), not a concrete topic or an AsyncAPI channel-key id. What genuinely remains open is the **matching mechanism**: is the override key compared by **string equality** against `channel.topic`, or routed through `SpecRegistry.match`? And how does a `{param}` in an override key interact with the §1 most-specific-wins precedence? Separately, `qos-overrides.yaml` (the only fixture exercising config tiers 2–3 that G13 added) is omitted from the headline gate.
- **If unaddressed:** pick the wrong *matching mechanism* (matcher-routed when the contract intends literal string-equality on the address, or vice-versa) and tier-2 silently fails to bind ⇒ `telemetry` stays at the per-service default (QoS 2) instead of the override (QoS 0); and a registry that resolves the tiers wrong ships green because CI never runs the fixture that would catch it.
- **Decision owed:** the override-key **matching mechanism** (string-equality on `channel.topic` vs matcher-routed) and the `{param}`-precedence interaction; and adding `qos-overrides.yaml` to the gate.
- **Recommended resolution:** in §6, keep `key = channel address` and pin the mechanism: "matched by **string equality** against `channel.topic` (the `{param}` form) — not routed through `SpecRegistry.match`, not concrete topics, not AsyncAPI channel keys." Add `qos-overrides.yaml` to build-plan §4's non-negotiable list.
- **Acceptance:** the registry test resolves `telemetry/{deviceId}` to QoS 0 (override) — distinct from global (1) and the per-service default (2); the CI gate fails if `qos-overrides.yaml` middle-tier resolution is wrong.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F15 — `GET /diagnostics` returns an untyped `summary`
- **Where:** `offbook-contracts.md` §5 (line ~216: `{ diagnostics: Diagnostic[]; summary }`); `offbook-build-gaps.md` residual (line ~325). `Diagnostic[]` is typed; the wrapper's `summary` is a bare placeholder, while sibling `/validation` returns a typed `ValidationSummary`.
- **Problem:** `/diagnostics` is a real v1 surface (L2 author-time validation, overlap/shadow warnings) but its `summary` has no contract.
- **If unaddressed:** the route handler is implicit-`any` (TS7008 with `noImplicitAny`) or ships `summary: undefined`; the CLI/CI reads `diagnostics.summary.errors` → `undefined` crash — the exact failure G15 fixed for `/validation`, left live on the sibling.
- **Decision owed:** none structural — mirror `ValidationSummary`.
- **Recommended resolution:**
  ```ts
  interface DiagnosticSummary { errors: number; warnings: number; info: number;
    byKind: Record<'scenario-load' | 'overlap' | 'spec-load', number>; } // all keys zero-filled
  ```
- **Acceptance:** `tsc` clean on the `/diagnostics` handler return type; a consumer reading `diagnostics.summary.errors` never sees `undefined`; `byKind` always has all three keys.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

---

## Tier 4 — narrower but real

### F16 — `declaredVersion` is *renamed* across the lockfile seam, not just re-cased
- **Where:** `offbook-contracts.md` §6 — `ResolvedSpec.declaredVersion` / `SpecInfo.declaredVersion` (camelCase) vs `LockEntry.specDeclaredVersion` ↔ `spec-declared-version` (kebab YAML); the "uniform camelCase→kebab serializer" note (line ~363).
- **Problem:** the same datum is `declaredVersion` on two types but `specDeclaredVersion` on `LockEntry` — a field **rename**, not a casing transform the "uniform serializer" framing covers.
- **If unaddressed:** a uniform mapper writes `declared-version`, but the lockfile schema/reader expects `spec-declared-version` ⇒ `up --frozen` reads `undefined` ⇒ `SpecInfo.declaredVersion` is always blank and the v2 drift-check loses its only v1 input.
- **Decision owed:** rename `LockEntry.specDeclaredVersion → declaredVersion` (uniform), or document the special-case mapping explicitly.
- **Recommended resolution:** rename to `LockEntry.declaredVersion` (kebab `declared-version`) so the uniform serializer is actually uniform; or add an explicit field-map entry and a round-trip test.
- **Acceptance:** write a lock → `up --frozen` reads it back → `SpecInfo.declaredVersion` is populated (not `undefined`); a serializer round-trip test asserts key equality.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F17 — By-SHA fetch depends on host `allowAnySHA1InWant`; the fallback is uncontracted
- **Where:** `offbook-contracts.md` §6 (line ~293, `git fetch <repoUrl> <sha>` "relying on the host's `uploadpack.allowAnySHA1InWant`"); `offbook-build-gaps.md` residual (line ~321, "if disabled, fall back to fetching the branch ref and walking to the locked SHA").
- **Problem:** the headline §6 reproducibility guarantee (`up --frozen`) hard-codes the by-SHA path, but the fallback exists only as a non-blocking residual — no interface, no acceptance, not in the `ingestion/` task.
- **If unaddressed:** on a host with `allowAnySHA1InWant` disabled (common on GitHub Enterprise / internal hosts), `up --frozen` fails to fetch at all ⇒ the reproducibility guarantee — the whole reason the lockfile reader was wired (G4) — is inoperative, rediscovered per-adopter.
- **Decision owed:** make ref-acquisition strategy part of the `Resolver` contract (by-SHA with a declared branch-walk fallback).
- **Recommended resolution:** `GitRefResolver.resolve` tries `git fetch <sha>`; on refusal, falls back to shallow-fetching the branch ref and walking history to the locked SHA (or fetching with increasing depth). Document both paths in §6 and add the fallback to the `ingestion/` acceptance.
- **Acceptance:** against a host fixture with `allowAnySHA1InWant` *off*, `up --frozen` still rebuilds byte-identical specs (every `content-hash` matches) via the fallback.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F18 — Hidden Tier-1↔Tier-1 back-edge: `registry/` needs `ingestion/`'s `ServiceConfig` loader
- **Where:** `offbook-build-plan.md` §3 (line ~73: `registry/`'s qos-resolution acceptance needs "a `services.yaml` override"; `registry/` and `ingestion/` both declared "Tier 1 — parallel, depend only on `model/` + libs"); the `services`/`environments` loaders are assigned to `ingestion/` (line ~74).
- **Problem:** `registry/` resolves qos/retain from `ServiceConfig` (§2 "config injected at construction"), but the `services.yaml → ServiceConfig` loader lives in sibling `ingestion/`. The two are declared independent, yet `registry/`'s own acceptance test can't run without `ingestion/`'s loader.
- **If unaddressed:** `registry/` either duplicates the `services.yaml` loader (a second, divergent config parser) or the two agents must coordinate mid-tier — the collision the frozen seams meant to prevent.
- **Decision owed:** make the edge explicit (`registry` depends on a `ConfigLoader` from `ingestion`/`config`), or move `ServiceConfig` loading into Tier-0 `config/`/`model/`.
- **Recommended resolution:** put the `ServiceConfig`/`services.yaml` loader in Tier-0 `config/` (it's pure data, no parser), so both `registry/` and `ingestion/` import it without a sibling edge; update the dependency graph.
- **Acceptance:** the build-plan dependency graph shows where `ServiceConfig` is loaded; `registry/`'s qos test runs in isolation (no `ingestion/` import); exactly one `services.yaml` loader exists.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F19 — `register()` at import-time vs registry hot-swap → init-order unspecified
- **Where:** `offbook-contracts.md` §3 (line ~132, "each module calls `register(...)` on import") resolving against `SpecRegistry.match`; §5 (line ~251, `POST /specs/refresh` "hot-swaps the running registry").
- **Problem:** handlers are imported (running `register()` at module top-level) to be discovered, but the registry they resolve patterns against may not exist yet at import time, and is replaced on `/specs/refresh`.
- **If unaddressed:** an eager `register` that resolves the pattern immediately throws/returns `undefined` before specs load, or binds to the stale pre-refresh channel set and routes to the wrong channel after a hot-swap; two agents pick opposite (eager vs lazy) strategies.
- **Decision owed:** eager-resolve-at-register vs lazy-resolve-at-dispatch — recommend **lazy** (the only swap-safe choice).
- **Recommended resolution:** state in §3: "`register(pattern, factory)` stores the raw pattern; resolution against `SpecRegistry.match` happens **at dispatch**, against the *current* registry — so handlers survive `/specs/refresh` and don't require specs to be loaded at import time."
- **Acceptance:** after `POST /specs/refresh` changes a channel, an inbound publish routes to the handler via the *new* registry (not a stale binding); registering a handler before specs load does not throw.
- **Relates to:** F4, F6.
- **Status:** ☑ **resolved** (2026-06-26) — see Decision log.

---

## Tier 5 — reuse / cleanup (quality, non-blocking)

### R1 — `Channel.schema` bundling reinvents the parser stack's `bundle()`
- **Where:** `offbook-contracts.md` §1 (lines ~37/54, G25 "fully bundled — every `$ref` inlined or rewritten to internal `$defs`, 2020-12, Ajv-standalone").
- **Recommended resolution:** don't hand-roll deref. `@asyncapi/parser` already dereferences/bundles before validating and depends on `@apidevtools/json-schema-ref-parser`, whose `$RefParser.bundle(schema)` produces the self-contained internal-`$ref` form (dedups rather than fully inlining — avoids blow-up). Use the parser's resolved payload output (or call `bundle()` directly), then only stamp `$schema: ".../2020-12/schema"`.
- **Acceptance:** `external-ref.yaml`'s bundled `channel.schema` compiles under Ajv standalone with no bespoke `$ref`-walking code in `registry/` (the bundling comes from the library).
- **Relates to:** F8.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### R2 — `SpecRegistry.match` is hand-rolled; `mqtt-pattern` covers it (and resolves F6)
- **Where:** `offbook-contracts.md` §1 (line ~45, `SpecRegistry.match`); `offbook-build-plan.md` registry/ acceptance.
- **Recommended resolution:** matcher correctness is a determinism-critical gate, yet the plan hand-rolls `split('/')`. `mqtt-pattern` provides exactly this: `exec(pattern, topic)` → single-segment `{param}` captures, `matches(pattern, topic)` → `+`/`#` wildcard boolean, `fill()` the inverse. Use `exec` for the channel-address `{param}` capture and `matches` for the §2/§7a subscribe-side `+`/`#` filter — one tested library covers **both** matchers, directly closing F6's "no owner for `+`/`#`."
- **Acceptance:** `match` and the subscribe-filter matcher both delegate to `mqtt-pattern`; the F6 + G1 precedence tests pass with no bespoke segment-splitting logic.
- **Relates to:** F6, F4.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### R3 — `getState()` rebuilds Aedes' own retained store
- **Where:** `offbook-contracts.md` §2 (lines ~72/77, custom retained-store + zero-byte-evicts-key / no-tombstone logic).
- **Recommended resolution:** Aedes already maintains a retained store via `aedes-persistence` (in-memory default), exposes `persistence.createRetainedStream(pattern)`, and already implements the MQTT 3.1.1 rule that a zero-length retained PUBLISH clears the stored message. `getState()` should read Aedes' retained stream rather than maintaining a parallel `ReadonlyMap` and re-implementing clear-on-empty — a parallel store risks diverging from what Aedes actually delivers to a late subscriber (the behavior the WS-fidelity spike must trust).
- **Acceptance:** `getState()` returns the same retained set Aedes delivers to a fresh subscriber for the same topics; clearing a retained topic evicts it from both with no separate eviction code.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### R4 — L1 `fake` runs a second PRNG alongside JSF's native seed
- **Where:** `offbook-contracts.md` §3 (line ~128, "`fake(channel, seed)`, seeded and Ajv-rechecked"); `offbook-build-plan.md` §1 (JSF `seed` option uses Mulberry32).
- **Recommended resolution:** drive JSF via its **native** `seed` option rather than a parallel engine Mulberry32 feeding it. Two RNGs (`HandlerContext.random` + JSF's) whose interleaving must be kept byte-identical by hand is the F7 hazard self-inflicted; let JSF own its seeded draw (keyed per F7), keep the Ajv recheck as the backstop.
- **Acceptance:** the engine has no second RNG wrapping JSF; `fake` is deterministic via JSF's `seed` alone; F7's keying rule is satisfied.
- **Relates to:** F7, F8.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### R5 — `SchemaError` re-declares Ajv's `ErrorObject` minus two fields
- **Where:** `offbook-contracts.md` §4 (line ~170, `SchemaError` "OUR shape — not Ajv's").
- **Recommended resolution:** `instancePath`/`schemaPath`/`keyword`/`message`/`params` is Ajv 8's `ErrorObject` minus `data`/`schema`. A DTO at the HTTP boundary is justified, but build it as a structural **pick** from Ajv's `ErrorObject[]` (strip the two non-serializable fields), not a re-derived shape — re-derivation drifts from Ajv (e.g. the old `dataPath`→`instancePath` rename, per-keyword `params` keys).
- **Acceptance:** `SchemaError` is defined as `Omit<ErrorObject, 'data' | 'schema'>` (or an explicit pick) and the mapping is a field-strip, not a hand-rewrite.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F20 — v2-shaped machinery has no v1 consumer
- **Where:** `offbook-contracts.md` §6 — `environments.yaml` + `VersionSource`/`StaticManifestSource` + `LockEntry.requestedVersion` ("UNHONORED in v1," lines ~334/352); `resolutionStrategy: 'branch'` single-value enum (line ~335); the camel-config/kebab-lockfile serializer (line ~363).
- **Recommended resolution:** consider deferring to v2 the parts with no v1 reader: `requestedVersion`/`environments.yaml`/`VersionSource` (the drift-check that consumes them is v2; v1 reproducibility rests on `resolvedSha` + `contentHash`), the single-value `resolutionStrategy` enum (`resolution-mode: branch|pinned` already carries the only v1 distinction), and the dual key-casing (a camelCase lockfile round-trips with zero mapping code, like `services.yaml`). Keep the *seam* (`Resolver`/`VersionSource` interfaces) — drop only the unused v1 *implementations/fields*. **Override this if the seam-visibility ("requested-vs-resolved honestly visible") is judged worth the carry.**
- **Acceptance:** for each deferred item, no v1 code path reads it (`grep` shows only writes); the v2 swap still lands behind the same interface with no restructure. *(Decided the other way — see Decision log: seam-visibility kept, nothing deferred.)*
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

### F21 — Wasted work: `specs/refresh` full rebuild, serial fetch, O(n) ring-buffer evict
- **Where:** `offbook-contracts.md` §5 (line ~251, `/specs/refresh`); `offbook-build-plan.md` (line ~74, per-service fetch on `up`); `offbook-contracts.md` §5 (line ~244, FIFO ring buffer).
- **Recommended resolution:** (a) `/specs/refresh` — compare the new `content-hash` per service against the lock and skip parse+Ajv-recompile+swap for unchanged services (short-circuit the whole swap if all hashes match). (b) `up` — `Promise.all` the independent per-service `git` fetches with a bounded pool (O(N) serial RTTs → ~1 RTT). (c) ring buffer — a fixed-size circular buffer with head/tail indices (O(1) insert+evict) instead of `push`+`shift` (O(n) per evict at steady state); `seq`/`oldestSeq`/`sinceSeq` map cleanly onto ring indices.
- **Acceptance:** a `/specs/refresh` with no upstream change recompiles zero Ajv validators; `up` startup latency ≈ max(fetch RTT), not sum; the violation log sustains continuous emission at the cap with no per-insert O(n) shift.
- **Status:** ☑ **resolved** (2026-06-27) — see Decision log.

---

## Cross-cutting note

**F1 + F2 + F6 are one interlocking knot** (the highest-leverage starting point): the missing `seedInstances` home (F1) and the missing `Config` type (F2) are both "land the type the prose already assumes," and F6's `+`/`#` owner is consumed by F1's wildcard-replay path. Resolve them as **one small contracts patch** — the same pattern that made G1+G2+G3 the highest-leverage edit in round 1. R2 (`mqtt-pattern`) can *close* F6 outright, so decide R2 before hand-rolling F6.

**F5 + F7 + F8 are the determinism/faker cluster** — settle them together with the engine owner: F5 and F8 are two halves of one question (on a failed recheck the payload is dropped-and-surfaced — already agreed — and what L1 emits *instead* is the open fork F8 informs), and any fallback re-draw must obey F7's keying rule (sharpened by R4). F3 + F9 + F10 are the **CI-harness-contract cluster** (which `seq`, which fields, which mode) — pin them together so the canonical `reset → publish → poll` loop is unambiguous end-to-end.

**Independent / parallelizable:** F11, F12, F13, F14, F15, F16, F17, F18, F19, R1, R3, R5, F20, F21 can each be resolved on their own once the Tier-1 knot lands.

## Decision log

*(Append one row per resolved item: ID · decision taken · file(s) patched · resolver · date.)*

| ID | Decision taken | File(s) patched | Resolver | Date |
|---|---|---|---|---|
| F1 | `seedInstances` → `ServiceConfig` field, typed `Record<string,Record<string,string>[]>` (multi-param); engine-owned `InstanceRegistry` subsumes all 5 materialization cases, `reset` = `restore(snapshot())` | offbook-contracts.md §2 (InstanceRegistry/InstanceSnapshot + policy bullets), §6 (ServiceConfig) | CodeReviewJoe | 2026-06-26 |
| F4 | Rename frozen `register` arg `topicPrefix`→`pattern`; drop the obsolete "read it as pattern" note | offbook-contracts.md §3 | CodeReviewJoe | 2026-06-26 |
| F19 | `register` resolution is **lazy at dispatch** (swap-safe): stores raw pattern, resolves against the current registry | offbook-contracts.md §3 | CodeReviewJoe | 2026-06-26 |
| F2 | Flat `Config` (grouped-by-lifecycle comments) + `DEFAULT_CONFIG`; `seed=1`, `fixedEpoch=1_700_000_000_000`; only `seed` is reset-varied (`POST /reset {seed?}`) | offbook-contracts.md §1a (new) | CodeReviewJoe | 2026-06-26 |
| F6 | `registry/` owns `matchesFilter` (`+`/`#`) beside `match`, both via `mqtt-pattern` (R2), spike-gated; precedence stays our sort; engine owns concrete-subscribe materialization via `broker.onSubscribe`→`InstanceRegistry.materialize` | offbook-contracts.md §1/§2; offbook-build-plan.md §1/§3/§5 | CodeReviewJoe | 2026-06-27 |
| R2 | Adopt `mqtt-pattern` for both matchers (closes with F6); parity spike before reliance | offbook-contracts.md §1; offbook-build-plan.md §1/§5 | CodeReviewJoe | 2026-06-27 |
| F7 | Determinism invariant: no process-global PRNG cursor — every draw keyed by stable identity OR a local counter within one run-to-completion unit (G23); `{{seq}}` stays a per-scenario monotonic counter | offbook-contracts.md §3 | CodeReviewJoe | 2026-06-27 |
| F8 | Add a JSF-0.6.2 fidelity spike (recheck-failure rate per fixture) before L1 CI reliance; result decides F5's fallback | offbook-build-plan.md §5 | CodeReviewJoe | 2026-06-27 |
| F5 | Drop-and-surface pinned in contracts §4 (never emit invalid; engine-stamped `mock` violation; no live-cursor re-draw); keyed-fallback re-draw gated on the F8 spike | offbook-contracts.md §4 | CodeReviewJoe | 2026-06-27 |
| R4 | L1 `fake` uses JSF's **native** `seed` (= `hash(seed+channelAddress)`), no second Mulberry32 wrapping it (implements F7's L1 keying) *(↻ CR1: seed widened to `hash(seed+channelAddress+canonicalize(instanceParams))`)* | offbook-contracts.md §3 | CodeReviewJoe | 2026-06-27 |
| F3 | Action-response `seq` renamed per endpoint: /publish → `meta:{seq}` (inbound arrival); /trigger + /reset → `sinceSeq` (log baseline `?sinceSeq=` consumes — trigger's is universally defined incl. on-demand) *(↻ CR4: /publish → `sinceSeq` too; `meta.seq` undefined for `toClient`, kept internal)* | offbook-contracts.md §3a/§5 | CodeReviewJoe | 2026-06-27 |
| F9 | Determinism defined over a canonical projection (`Violation` minus `observedAt`+`clientId`); harness applies the documented field-mask before diffing | offbook-contracts.md §4 | CodeReviewJoe | 2026-06-27 |
| F10 | Ticks scheduled on the **virtual** clock over a fixed virtual horizon; determinism gate runs in `passive` and **asserts `GET /mode==passive`** (assert-and-refuse) | offbook-contracts.md §3 | CodeReviewJoe | 2026-06-27 |
| F11 | Control-plane reaches the L1 faker by **injection** (engine owns the one `Faker = (channel)=>unknown`; composition root wires it) — not a direct import; `/topics` example == `/publish {example:true}` *(↻ CR1/CR8: `Faker = (channel, instanceParams?)=>unknown`, homed in model/)* | offbook-contracts.md §3/§5; offbook-build-plan.md §3 | CodeReviewJoe | 2026-06-27 |
| F14 | `topicOverrides` matched by **string-equality** on `channel.topic` (`{param}` form), not via `SpecRegistry.match`; `qos-overrides` added to the §4 gate | offbook-contracts.md §6; offbook-build-plan.md §4 | CodeReviewJoe | 2026-06-27 |
| F17 | `GitRefResolver` by-SHA fetch gains a contracted fallback: branch-ref fetch + history-walk to the locked SHA when `allowAnySHA1InWant` is off | offbook-contracts.md §6; offbook-build-plan.md §3 | CodeReviewJoe | 2026-06-27 |
| F20 | **Keep** seam-visibility (override the defer rec): `environments.yaml` + `requested-version` + `VersionSource` stay for honest requested-vs-resolved provenance | offbook-contracts.md §6 (reaffirmed) | CodeReviewJoe | 2026-06-27 |
| F12 | `Resolver` is per-call (stateless): `new GitRefResolver(config)` then `resolve(repo,ref,specPath)` per ref; build-plan corrected to match the frozen interface | offbook-build-plan.md §3 | CodeReviewJoe | 2026-06-27 |
| F13 | Engine owns emit-completion via one `resolveEmit(partial, channel)→NormalizedMessage` choke-point (parse delay→keyed delayMs, fill qos/retain from Channel) | offbook-contracts.md §3 | CodeReviewJoe | 2026-06-27 |
| F15 | Add `DiagnosticSummary` mirroring `ValidationSummary` (errors/warnings/info + zero-filled byKind) | offbook-contracts.md §5 | CodeReviewJoe | 2026-06-27 |
| F16 | Rename `LockEntry.specDeclaredVersion → declaredVersion` (kebab `declared-version`) — matches ResolvedSpec/SpecInfo, serializer stays uniform | offbook-contracts.md §6; offbook-build-plan.md §3 | CodeReviewJoe | 2026-06-27 |
| F18 | `config/` promoted to **Tier 0**, owns all file→config loading (Config + ServiceConfig/services/environments); registry/ + ingestion/ both import it — back-edge removed | offbook-build-plan.md §2/§3 | CodeReviewJoe | 2026-06-27 |
| R1 | `Channel.schema` bundling from the parser stack (`$RefParser.bundle()`), no hand-rolled `$ref`-walking | offbook-contracts.md §1; offbook-build-plan.md §3 | CodeReviewJoe | 2026-06-27 |
| R3 | `getState()` reads Aedes' retained store (`createRetainedStream`), no parallel ReadonlyMap | offbook-contracts.md §2; offbook-build-plan.md §3 | CodeReviewJoe | 2026-06-27 |
| R5 | `SchemaError` = `Omit<ErrorObject,'data'\|'schema'>` (structural pick), not a hand-rewrite | offbook-contracts.md §4 | CodeReviewJoe | 2026-06-27 |
| F21 | Adopt all three efficiencies: refresh content-hash short-circuit, bounded-parallel `up` fetch, O(1) circular ring buffer | offbook-contracts.md §5; offbook-build-plan.md §3 | CodeReviewJoe | 2026-06-27 |

### Round 3 — code-review follow-ons (2026-06-27)

A fresh `/code-review` of all design docs (12 findings, **CR1–CR12**, xhigh effort) caught defects in the round-2 resolutions above — every one **REAL**, adversarially re-verified before landing. `offbook-contracts.md` stays canonical. Where a round-2 decision is reversed/sharpened the original entry is kept for provenance and superseded here (look for the inline `↻ CRn` markers).

| CR | Finding & resolution | Supersedes / sharpens | File(s) patched |
|---|---|---|---|
| CR1 | L1 `Faker` keys per instance: `(channel: Channel, instanceParams?: Record<string,string>)`, JSF seed `hash(seed+channelAddress+canonicalize(instanceParams))` — `seedInstances` renders **distinct** devices; example-mode omits params ⇒ byte-equal to `/topics` (F11). Memo key `(channelAddress, canonicalize(instanceParams))`; `Channel` stays pure | R4 (361), F11 (365) `Faker=(channel)=>unknown` / `hash(seed+channelAddress)` | contracts §3/§5; build-plan §2; design §7a |
| CR2 | `match` rewrites `{p}`→`+p` before `mqtt-pattern.exec` (mqtt-pattern matches `{param}` *literally*); `matchesFilter`/`matches` needs no rewrite; spike = rewrite round-trip fidelity. L2 `when` matcher declared a separate **permitted** matcher | F6 (356)/R2 (357) — "via mqtt-pattern" omitted the rewrite | contracts §1; build-plan §1/§5 |
| CR3 | `SchemaError = Omit<ErrorObject,'data'\|'schema'>` made a **real derived alias** (type-only `ajv` import) — the body had been a hand-rewrite with inverted optionality (`message` req / `params` opt); now genuinely can't drift (R5) | R5 (376) — claimed, but the body never landed | contracts §4; build-plan §2 |
| CR4 | `/publish` returns **`sinceSeq`** (not `meta:{seq}` — `undefined` for `toClient`, wrong number-space); uniform with `/trigger`+`/reset`; `meta.seq` stays internal (G9) | F3 (362) `/publish → meta:{seq}` | contracts §5 |
| CR5 | `getState(): Promise<ReadonlyMap<…>>` — drains Aedes' async `createRetainedStream`; the sync signature was unimplementable without the parallel map R3 forbids | R3 (375) — now lands as async | contracts §2; build-plan §3 |
| CR6 | Tick **and** emit pacing key off a new `config.wallClock` (false=fast-virtual CI/replay default; true=wall-paced interactive `offbook up`); F10's virtual-only ticks are the *determinism-domain* rule, not a ban on wall-pacing the UI | F10 (364) — interactive wall path was unspecified | contracts §1a/§3; design §6; build-plan §3 |
| CR7 | Build-plan engine acceptance now asserts emit-completion (F13): authored `ctx.publish({topic,payload})` reaches `broker.emit` with channel-resolved qos/retain (**never** `undefined`) + keyed `delayMs` via `resolveEmit` | F13 (370) — had no build-plan gate | build-plan §3 |
| CR8 | `Faker` added to the model/ scaffold list — control-plane imports the **type** (impl injected from engine/), so the F11 tier boundary is importable | F11 (365) tier boundary | build-plan §2 |
| CR9 | `StaticManifestSource.versions()` reads `environments.yaml` **through config/'s loader** (no 2nd parser); F18 single-loader guarantee broadened to the environments side + a testable acceptance | F18 (373) — scoped to services.yaml only | build-plan §3 |
| CR10 | l2 §5 `{{uuid}}` pinned to a per-scenario **counter** (category ii), **not** a keyed-by-step draw — aligns L2 to canonical §3 F7 | F7 rec (156) `(scenarioName,stepIndex,fieldPath)` | l2 §5/§8 |
| CR11 | `InstanceRegistry.list()` **dropped** (parallel-set desync = R3 one layer up); wildcard replay = Aedes-native retained delivery + `matchesFilter`; the ledger (`materialize`/`snapshot`/`restore`) is kept (reset-restore isn't derivable from `getState`) | F1 (352) stub `list(filter)` | contracts §2; design §7a; build-plan §3 |
| CR12 | gaps2 F9 recommended-resolution prose corrected to "`Violation` minus `observedAt` **and `clientId`**" + `receivedAt` is a `meta`-only field — now matches canonical §4 and the F9 decision row (363) | F9 rec (176) — under-enumerated `clientId`, conflated `receivedAt` | this doc (176) |
