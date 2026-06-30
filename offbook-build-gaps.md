---
type: decision-log
status: resolved
summary: Round-1 v1 pre-build gap resolution (G1–G25); resolved.
---

# Offbook — v1 Pre-Build Gap Resolution (Handoff)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (the **canonical** frozen interfaces — almost every fix lands here), `offbook-build-plan.md`, `offbook-design.md`, `offbook-l2-scenarios.md`, `offbook-handoff.md`, `offbook-prework.md`.

**Status:** **Resolved (2026-06-23).** All 25 gaps resolved via the `resolve-build-gaps` workflow (6 cluster-design agents → reconciler → 6 adversarial verifiers — **23 *met*, 2 *plausible*** with their fixes applied) plus a review pass. Patches landed in `offbook-contracts.md` (canonical) and the support docs; fixtures gained `qos-overrides.yaml`. **The fan-out is unblocked.** Small non-blocking residuals are listed before the decision log. *(Originally 25 gaps from a logical dry-run of the v1 core build, before fanning Step 2 out to parallel agents — G1–G22 from the dry-run; G23–G25 + the G9 re-tier folded in on review. **Tier 1 (G1–G6, G9, G23) was the fan-out blocker.** Line-number anchors below are pre-resolution and now historical — the docs have grown; anchor by `§N`/type name.)*

**Why this exists.** The contracts are decision-complete but not yet *execution-complete*: the freeze pinned the interfaces *between* named modules but left several mechanisms that cross *every* module unspecified (concrete-topic↔channel matching; the channel record's contents; parametrized-topic initial state; the determinism clock/`seq` model). That is exactly the collision the freeze meant to prevent (`offbook-contracts.md` line 7).

**How to use this doc.**
1. Pick a gap (start with Tier 1). Each item is self-contained.
2. Make the **Decision owed** — the one or two choices only a human/lead can settle. A **Recommended resolution** is given for each; adopt or override it.
3. Patch the **Owner doc** (the conflict rule means `offbook-contracts.md` wins; fix the others to match).
4. Verify against **Acceptance** (written to be self-checkable).
5. Tick the item's `Status` box and add a row to the **Decision log** at the foot.

> **Line numbers are anchors as-of HEAD `2d27b17` (2026-06-23) and will drift once edits land** — e.g. `fce44fa` (the violation-log retention cap) already shifted `offbook-contracts.md` §5, so the §5 line refs in G9/G14/G15/G16–G18 now read a few lines low. Anchor primarily by `§N` / type name; treat line numbers as hints.

---

## Summary

| ID | Gap | Tier | Owner doc | Blocks fan-out |
|---|---|---|---|---|
| G1 | No concrete-topic→`Channel` matcher owned by a core module | 1 | contracts §1/§2 | ✅ |
| G2 | `Channel` record too thin for its consumers | 1 | contracts §1 | ✅ |
| G3 | Parametrized-topic initial state unbuildable + eager-vs-lazy contradiction | 1 | contracts §2/§3 · design §7a | ✅ |
| G4 | Lockfile reproducibility unwired (no reader) + SHA acquisition unspecified | 1 | contracts §6 · build-plan | ✅ |
| G5 | Clock model (virtual vs wall vs real-delay) + tick cadence unspecified | 1 | contracts §3 · l2 §6 | ✅ |
| G6 | Shared `seq` not reproducible across clock domains + `sinceSeq` off-by-one | 1 | contracts §1/§4/§5 | ✅ |
| G7 | `Scenario` model type never defined | 2 | contracts (new §) | — |
| G8 | `/trigger` body contradiction (L2 vs contracts) | 2 | l2 §8 (fix) · contracts §5 | — |
| G9 | `fromClient` `/publish` `InboundEvent.meta` + origin tagging → CI false-negative | **1** | contracts §5/§2 | ✅ |
| G10 | `Violation.emitSource` has no carrier from layer→emit | 2 | contracts §3/§4 | — |
| G11 | L3 discovery + `register(topicPrefix)` semantics + match order | 2 | contracts §3 · build-plan | — |
| G12 | `declaredVersion` back-fill couples ingestion↔registry | 2 | contracts §6 · build-plan | — |
| G13 | qos/retain precedence has no config home + tier-ownership conflict | 3 | contracts §6/§2 | — |
| G14 | CLI `up`/`down` + `specs update` map to no endpoint | 3 | contracts §5 · build-plan | — |
| G15 | `/validation` `summary` object never typed | 3 | contracts §4/§5 | — |
| G16 | `/publish` `example` flag-vs-value ambiguity | sec | contracts §5 | — |
| G17 | `StateEntry`/`getState` tombstones + `undefined`-payload ambiguity | sec | contracts §2 | — |
| G18 | Error envelope `code` never enumerated | sec | contracts §5 | — |
| G19 | Support docs contradict canonical (Resolver return type; design §7 v2 lockfile) | sec | design/handoff/prework (fix) | — |
| G20 | `repo: org/service-a` host/transport ambiguous | sec | contracts §6 | — |
| G21 | Two acceptance criteria not self-checkable (DUP-on-redelivery; mqtt.js proxy) | sec | build-plan §3/§5 | — |
| G22 | Spike→broker ordering hazard (build-plan vs handoff) | sec | build-plan §5 · handoff | — |
| G23 | Dispatch reentrancy / atomicity (run-to-completion?) unspecified | 1 | contracts §3 | ✅ |
| G24 | Scenario hot-reload not quiesced in passive/CI → non-determinism | 2 | l2 · contracts §5 | — |
| G25 | `Channel.schema` bundled-vs-ref-retaining form unpinned | 2 | contracts §1 (G2) | — |

---

## Tier 1 — blocks the fan-out

### G1 — No concrete-topic→`Channel` matcher is owned by any core module
- **Where:** `offbook-contracts.md` §1 lines 33–37 (`Channel`), line 40 ("the topic→`Channel` lookup gives the spec-declared direction"), line 164 (`/publish` "direction inferred from the channel"); `offbook-l2-scenarios.md` §4 (the only specced matcher — `fromClient`-only, Tier 3).
- **Problem:** `NormalizedMessage.topic` is fully concrete; `Channel.topic` "may contain {params}". No interface turns a concrete topic into its `Channel`. Four core consumers need it **before** Tier-3 `scenarios/`: `/publish` direction inference, `unknown-topic`/`schema` validation, `Violation.channel` stamping (line 123), and `onSubscribe` initial state.
- **If unaddressed:** broker/registry/engine/validation/control-plane each hand-roll an MQTT `{param}`/`+`/`#` matcher with divergent semantics → a concrete publish resolves to different channels (or "unknown") across modules; `/publish` says `fromClient` while validation logs `unknown-topic` for the same `seq`; the CI gate is non-deterministic.
- **Decision owed:** (a) the precedence rule when more than one channel matches (recommend most-specific / literal-segment-over-`{param}`, then declaration order); (b) does `match` also return captured params (yes — initial state and templating need them).
- **Recommended resolution:** add one matcher to `registry/`, imported everywhere; pin `{param}`/`+`/`#` to the MQTT rules already in l2 §4:
  ```ts
  interface SpecRegistry {
    match(topic: string): { channel: Channel; params: Record<string, string> } | undefined;
    channels(): readonly Channel[];
  }
  ```
- **Acceptance:** exactly one matcher implementation exists; `match('command/thermostat-1/set')` returns the `command/{deviceId}/set` channel with `{ deviceId: 'thermostat-1' }`; two channels matching the same concrete topic resolve to the same winner on every run.
- **Status:** ☑ resolved (2026-06-23)

### G2 — The `Channel` record is too thin for everything that consumes it
- **Where:** `offbook-contracts.md` §1 lines 33–37 (`Channel`); line 99 (L1 `fake(channel, seed)`); §5 lines 153–154 (`TopicInfo` needs `schema`,`example`,`qos`,`retain`,`service`,`title`,`description`); line 156 (`SpecInfo.channelCount`/`service`).
- **Problem:** `{ topic, direction, validate }` can feed none of: the L1 faker (needs the **raw** dereferenced schema, not a `validate` closure), `GET /topics` (all 7 extra fields), service-tagged DTOs/filters (`?service=`), or resolved qos/retain.
- **If unaddressed:** `control-plane`/`engine` reach past the frozen type into `@asyncapi/parser` internals (coupling + duplicate dereference/binding logic), or `registry` silently widens `Channel` with undocumented fields — a frozen-type change mid-build.
- **Decision owed:** is `example` stored on the channel (seeded once at registry build) or computed on demand by `/topics` via the L1 faker? (Recommend: computed on demand, and declare the `control-plane → engine.fake` dependency edge; keeps `Channel` pure data.)
- **Recommended resolution:** enrich the frozen type:
  ```ts
  interface Channel {
    topic: string;
    direction: Direction;
    service: string;                 // owning service (services.yaml key) — see G12/G13
    schema: object;                  // dereferenced JSON Schema — feeds L1 faker + /topics
    validate: (payload: unknown) => SchemaError[];
    qos?: 0 | 1 | 2;                 // resolved per precedence (G13)
    retain?: boolean;                // resolved per precedence (G13)
    title?: string;
    description?: string;
  }
  ```
- **Acceptance:** `engine` builds L1 payloads from `channel.schema` without importing the parser; `GET /topics` populates every `TopicInfo` field from a `Channel` (+ on-demand example); `tsc` clean.
- **Status:** ☑ resolved (2026-06-23)

### G3 — Parametrized `toClient` initial state is unbuildable, and the docs contradict each other on *when* it publishes
- **Where:** `offbook-design.md` §7a line 177 ("a retained message **must already exist**… L1/L3 publish initial state with `retain:true` at **startup**/first-subscribe"); `offbook-contracts.md` §2 line 63 ("**lazy** initial-state of parametrized toClient topics"); §1 line 21 (topic "fully concrete (no wildcards)"); §3 line 86 (`initialState?(topic, ctx)`); §5 line 166 (`reset` "republishes initial state").
- **Problem:** startup-eager vs subscribe-lazy are mutually exclusive yet both asserted. And neither is implementable for a parametrized channel: `state/{deviceId}` has no concrete instances (the spec declares the param, never enumerates values), and a wildcard `SUBSCRIBE state/#` carries no binding to de-wildcard. `reset` then has no record of which concrete instances to republish, and no re-SUBSCRIBE fires.
- **If unaddressed:** the engine emits nothing for parametrized `toClient` channels (blank UI — defeats "works day one", line 78) or invents `deviceId`s with no policy; post-`reset` `/state` is empty, breaking the moment-4 CI primitive.
- **Decision owed:** the materialization policy for concrete instances of parametrized `toClient` topics (the core choice).
- **Recommended resolution (write as a policy paragraph in contracts §2/§3 and reconcile design §7a):**
  - **Non-parametrized** `toClient` channels: retained initial state published **eagerly at startup**.
  - **Parametrized** `toClient` channels: an instance is **materialized lazily** when (i) a concrete subscribe binds its params, or (ii) a `fromClient` command first references a concrete param (the reactive path publishes state for that id). The engine keeps a **materialized-instance set**.
  - **Wildcard subscribe** (`+`/`#`): emit retained for all *already-materialized* instances matching the filter; **never invent** params. (Optionally: a per-channel `seedInstances: [...]` config to pre-materialize a deterministic demo set so onboarding isn't blank.)
  - **`reset`:** re-materialize exactly the recorded set, re-seeded.
- **Acceptance:** subscribe to concrete `state/thermostat-1` → retained appears; a command on `command/thermostat-1/set` materializes `state/thermostat-1`; `state/#` returns retained for all known instances and none invented; `reset` returns the same set deterministically.
- **Status:** ☑ resolved (2026-06-23)

### G4 — The lockfile's reproducibility guarantee is unwired (nothing reads it back), and the writer can't reliably obtain the pin
- **Where:** `offbook-contracts.md` §6 line 259 ("rebuild the exact mock even after the branch moves"), line 199 ("v1 only ever hands it a branch tip"), lines 188–193 (`ResolvedSpec`); `offbook-build-plan.md` line 73 ("specs.lock writer"), line 25 ("shallow-fetch / `git archive` one file at a ref").
- **Problem:** `ingestion/` is a **writer only** — no loader/reader exists, and v1 has no by-`resolvedSha` path, so the stored SHA is never consumed and re-running after the branch moves rebuilds a *different* mock. Separately, `git archive` doesn't report a commit SHA, so obtaining the full `resolvedSha` needs an extra step (`git ls-remote`/`rev-parse`); if the branch advances between that and the fetch, the SHA pins a tree ≠ the bytes fetched (a silently-wrong pin). "Re-run with the same HEAD is byte-identical" isn't operationally definable for a mutable tip.
- **If unaddressed:** the headline §6 guarantee silently does not hold — exactly the "works on my machine" drift the lockfile exists to kill — and `content-hash` auditing can mis-fire.
- **Decision owed:** does v1 wire a lockfile **reader** that re-resolves by `resolved-sha`? (Recommend yes — it's what makes the stored SHA load-bearing.)
- **Recommended resolution:**
  - **SHA acquisition (atomic):** resolve the branch to a SHA once via `git ls-remote <repo> <branch>`, then fetch **that SHA** (`git archive`/shallow-fetch by SHA), so tip movement can't desync bytes from pin.
  - **Reader:** add a load path — default `offbook up` re-fetches the branch tip (branch mode = liveness), and `offbook up --frozen` (or `--locked`) re-resolves each service by the lockfile's `resolved-sha` (the resolver already takes a ref — pass the SHA). Frozen mode is the reproducibility guarantee made real.
- **Acceptance:** write a lock, advance the branch, `up --frozen` rebuilds **byte-identical** specs (every `content-hash` matches the lock); the byte-identical acceptance test runs against a pinned SHA, not a live tip.
- **Status:** ☑ resolved (2026-06-23)

### G5 — The clock model the whole tool rests on is unspecified
- **Where:** `offbook-contracts.md` §3 line 68 (engine "owns the virtual clock, applies delayMs"), line 75 (`tick`); `offbook-l2-scenarios.md` §5 line 113 (`{{now}}` = "virtual seeded clock… advances by the seeded delays"), §6 line 123 (delays in real `ms`/`s`); `offbook-design.md` §6 line 156 (delay must "force the browser's async code to actually run as async"), line 178 (autonomous "seeded for run-to-run reproducibility").
- **Problem:** async-realism needs **real wall delay** (promises resolve off the synchronous tick) while `{{now}}` must be a **pure function of seeded delays** to replay. These reconcile only via a split that no doc writes. The autonomous `tick()` has no interval, clock source, or jitter rule, yet is claimed reproducible.
- **If unaddressed:** a builder implements `now()` as `epoch + (Date.now()-start)` (breaks replay) or fires a pure virtual clock instantly (breaks the async-forcing purpose); autonomous ticks fire on wall `setInterval` → emission count between `reset` and assert varies under CI load.
- **Decision owed:** confirm the virtual/wall split and the tick cadence config.
- **Recommended resolution (write into contracts §3 + l2 §6 + design §6):**
  - `now()` returns a **logical** timestamp = `fixedEpoch + Σ(resolved seeded delays applied on the emission timeline)`. It is **not** wall-clock; it is what `{{now}}` stamps and what ordering uses.
  - **Default = virtual time + a single event-loop yield, not real wall delay.** Forcing the client's async code to actually suspend/resume needs only *one* yield boundary (`queueMicrotask`/`setImmediate`/`await`), not the literal `delayMs` elapsed in wall time. So the scheduler delivers each emit on the **next task** while advancing logical `now()` by the **full** seeded delay — async-forcing **and** deterministic **and** fast (CI never pays real seconds for a 300 ms step, and wall-scheduler jitter can't reorder anything). This is the DST-faithful default; **real-wall latency (`delayMs` of actual elapsed time) becomes an opt-in interactive mode** for human-perceptible/UX timing, never the CI path. *(Revises the original "deliver after a real wall delay equal to `delayMs`" line — see the fold-in note.)*
  - **Tick:** a config `tickIntervalMs` (default e.g. `1000`) with optional seeded jitter; `passive` mode fires no ticks. "Reproducible autonomous" = same seed ⇒ same sequence of tick emissions and their logical timestamps, independent of wall scheduling.
- **Acceptance:** a `delay: 150-300ms` emit's `{{now}}` value is byte-identical across two seeded runs and advances by the seeded delay; the emit still arrives in a *later* task (the client's async path runs), yet a 1000-step seeded suite finishes in well under the wall-sum of its delays; in `passive` mode no autonomous emission occurs between `reset` and an assertion. *(Real-wall-latency assertions belong to the opt-in interactive mode.)*
- **Status:** ☑ resolved (2026-06-23)

### G6 — The shared `seq` counter isn't reproducible where wall-clock inbound meets the virtual emission stream, and `sinceSeq` is off-by-one
- **Where:** `offbook-contracts.md` §4 line 117 (`seq` "engine-wide event counter; reproducible; NOT unique per violation"), §1 line 42 (`meta.receivedAt` wall-clock, inbound "externally driven"), §5 line 147 (`/validation` "ordered by `(seq, insertion)`"), line 166–169 (`reset` baseline feeds `?sinceSeq=`); `offbook-build-plan.md` line 92 ("violation ordering" is a non-negotiable determinism guarantee).
- **Problem:** one `seq` is incremented by both externally-driven inbound and virtual-clock emissions; when a client publish and a delayed mock ack race, their relative `seq` flips run-to-run, and `(seq, insertion)` has no clock-domain-independent tiebreak (`observedAt` is "non-reproducible"). Because `seq` is **non-unique**, `?sinceSeq=baseline` with `>` drops, or `>=` double-counts, a violation sharing the baseline `seq`.
- **If unaddressed:** the `(seq, insertion)` order of a paired client+mock violation is non-deterministic, and `summary.byOrigin.client === 0` can yield a false negative at the headline assertion.
- **Decision owed:** unify or separate the two `seq` notions; pick the `sinceSeq` boundary.
- **Recommended resolution:**
  - Make the violation-log `seq` a **unique, monotonic, per-entry** value (a strictly increasing log cursor). If an "engine event counter" is needed elsewhere, name it separately (e.g. `eventSeq`) — don't overload one field for ordering *and* grouping.
  - Order `/validation` by `seq` alone (now total). Drop reliance on "insertion".
  - Define the determinism guarantee precisely: *given a fixed inbound script + seed, the emission/violation stream and its `seq` ordering are byte-identical.* The CI harness already drives inbound deterministically (`reset → publish → poll`).
  - `?sinceSeq=baseline` = strictly-greater; `reset` baseline = the last assigned `seq`, so the first post-reset entry is `baseline + 1`.
  - **Reconcile with `fce44fa` (retention cap).** That commit already shipped `summary.oldestSeq` + a strictly-greater `?sinceSeq=` over a **bounded ring buffer** — semantics that presume *this* unique-`seq` model. Adopting unique-per-entry `seq` is exactly what makes `oldestSeq`, FIFO eviction, and the `sinceSeq` boundary mutually coherent; under the current non-unique `seq`, a group sharing one value can be split by eviction (the drop/double-count hazard above). **§4 line 117 must change** from "NOT unique per violation" to unique-per-entry as part of this gap (then name any separate grouping counter `eventSeq`).
- **Acceptance:** replay the same inbound script + seed twice ⇒ identical `(seq, ordering)`; a violation produced immediately after `reset` is included by `?sinceSeq=baseline`; no entry is dropped or double-counted at the boundary.
- **Status:** ☑ resolved (2026-06-23)

### G9 — A `fromClient` `/publish` has no spec for `InboundEvent.meta`, and can produce a CI false-negative
*(Promoted from Tier 2 on review: it spans control-plane + broker + validation — three parallel modules must agree on how an injected publish is synthesized and origin-tagged — and a mis-tag silently passes the headline gate.)*
- **Where:** `offbook-contracts.md` §5 (`/publish` "simulates client + validates"), §1 line 30 (`meta { clientId, seq, receivedAt }`), §4 (`clientId` set "when origin === client"), the gate asserts `byOrigin.client === 0`.
- **Problem:** an HTTP-injected publish has no ws client to mint `meta`; nothing says whether it routes through `broker.onInbound` or calls validation directly, nor how it's origin-tagged. If tagged `origin:'mock'`, a real client contract break is counted under `byOrigin.mock` and the gate passes.
- **If unaddressed:** the headline guarantee (`byOrigin.client === 0`) yields a **false negative** — the tool reports "contract OK" while a real client break shipped. That is the tool's reason to exist, so the bug is gate-fatal, not consumer-local.
- **Decision owed:** does an injected `fromClient` publish re-enter the inbound path, and what `clientId` does it carry?
- **Recommended resolution:** route it through the **same inbound path** the broker feeds — synthesize an `InboundEvent` with `meta.clientId = 'control-plane'` (or a configurable injected-client id), `receivedAt = wall now`, `seq` from the engine — so it is validated identically to a real publish and tagged `origin:'client'`. Document this in §5.
- **Acceptance:** a known-bad `fromClient` `/publish` produces a `schema`/`client` `Violation` with `clientId` set, and `summary.byOrigin.client` increments.
- **Status:** ☑ resolved (2026-06-23)

### G23 — The dispatch concurrency model (reentrancy / atomicity) is unspecified
- **Where:** `offbook-contracts.md` §3 lines 66–98 (engine dispatch, `tick`, `HandlerContext.publish`), §2 line 60 (`emit` awaited sequentially); pairs with G5/G6 (the determinism cluster this completes).
- **Problem:** when an externally-driven inbound publish arrives **while** the scheduler is awaiting a delayed `emit` (or mid-`tick`), no rule says whether event processing is **run-to-completion** or may interleave. G6 pins the `seq` *counter* but not the *concurrency* that decides which event increments it first — two modules can assume opposite models and the determinism gate flakes under load.
- **If unaddressed:** inbound-vs-emit interleaving makes `(seq, ordering)` host-load-dependent even with a fixed seed — the same non-determinism G6 set out to kill, reintroduced one layer down.
- **Decision owed:** the dispatch atomicity model.
- **Recommended resolution:** dispatch is **run-to-completion per event** — the engine processes one inbound / tick / emit event (and the synchronous handler work it triggers) to completion before dequeuing the next; concurrent arrivals queue in arrival order (inbound by `meta.seq` assignment, emissions by the seeded timeline). State this in §3 beside the G5 clock split.
- **Acceptance:** an inbound publish delivered during a pending delayed emit yields identical `(seq, ordering)` across repeated seeded runs under artificial load.
- **Status:** ☑ resolved (2026-06-23)

---

## Tier 2 — block a specific consumer / mislead a builder

### G7 — The normalized `Scenario` type is never defined
- **Where:** `offbook-l2-scenarios.md` §9 line 165 ("Feeds P1 — the parsed/normalized scenario type"); `offbook-contracts.md` §1–§6 (absent); `offbook-build-plan.md` lines 40–41 (`model/` list stops at `Handler, HandlerContext`).
- **Problem:** `scenarios/` (dispatch table, matcher, templating) and `control-plane` (`POST /trigger/{name}` → `{ scenario, fired }`) must agree on `name`/`when`/`then`/`emit`/`delay` with no shared type.
- **Decision owed:** none structural — transcribe the l2 §9 field reference.
- **Recommended resolution:** add to `model/` + a new contracts § (derived from l2 §9):
  ```ts
  interface Scenario { name: string; when?: WhenClause; then: EmitStep[]; }
  interface WhenClause { topic: string; payloadMatch?: Record<string, unknown>; }
  interface EmitStep { emit: { topic: string; payload: unknown; delay?: string }; }
  ```
- **Acceptance:** `scenarios/` and `control-plane` import the same `Scenario` type; `tsc` clean; `Violation.emitSource.scenarioName` keys to `Scenario.name`.
- **Status:** ☑ resolved (2026-06-23)

### G8 — The `/trigger` request body contradicts itself across canonical and authoring docs
- **Where:** `offbook-contracts.md` §5 line 165 (`{ params?, payload? }`, params nested) vs `offbook-l2-scenarios.md` §8 line 145 (`{ "deviceId": "t1", "payload": {…} }`, params top-level).
- **Problem:** authors read the L2 doc and POST top-level params; the control-plane parses `body.params.*`; `{{deviceId}}` silently resolves to a seed-faked value and the trigger fires against the wrong device with no error.
- **Decision owed:** confirm canonical (`{ params?, payload? }`) — yes per the conflict rule.
- **Recommended resolution:** fix l2 §8 to `{ "params": { "deviceId": "t1" }, "payload": {…} }`; add a note in contracts §5 that `params` entries bind the scenario's `{{param}}` captures.
- **Acceptance:** the l2 example matches the contract; a trigger with `params.deviceId` substitutes `{{deviceId}}` end-to-end.
- **Status:** ☑ resolved (2026-06-23)

### G10 — `Violation.emitSource` has no carrier from the emitting layer to the emit
- **Where:** `offbook-contracts.md` §4 line 128 (`emitSource { layer, scenarioName?, stepIndex? }`), §3 line 90 (`HandlerContext.publish`), §2 line 55 (`broker.emit(NormalizedMessage)` — content only).
- **Problem:** the only publish primitives strip layer/scenario/step identity, so when the Ajv recheck fails there's nowhere for provenance to come from → mock violations ship with `emitSource` permanently `undefined`.
- **Decision owed:** where the engine tracks the current emit's source.
- **Recommended resolution:** keep `broker.emit` content-only. The **engine** owns emit and therefore knows the active layer: L1 floor sets `{layer:'L1'}`; the L2 scenario runner sets `{layer:'L2', scenarioName, stepIndex}`; the L3 `register` wrapper tags `ctx.publish` calls `{layer:'L3', ...}`. The engine attaches the in-scope `EmitSource` to any violation raised by that emit's recheck. State this in §3/§4.
- **Acceptance:** an L2-emitted off-spec payload yields a `Violation` with `emitSource.layer === 'L2'` and the correct `scenarioName`/`stepIndex`.
- **Status:** ☑ resolved (2026-06-23)

### G11 — L3 has no discovery mechanism and no defined match order
- **Where:** `offbook-contracts.md` §3 line 95 (`register(topicPrefix, factory)`); `offbook-l2-scenarios.md` §3 line 73 (L2's explicit glob + sorted-path total order); `offbook-build-plan.md` line 76 ("L3 factory registry").
- **Problem:** no glob/convention loads L3 modules; `topicPrefix` semantics (literal prefix vs channel pattern vs MQTT filter) are undefined (`register('state', …)` could collide with `stateful/x`); and "first-match-wins" across multiple registered prefixes has no defined order.
- **If unaddressed:** two authors guess different conventions and never match the same messages; L3→L2→L1 precedence becomes filesystem-/import-order-dependent — breaking the determinism gate.
- **Decision owed:** discovery glob, `topicPrefix` semantics, multi-match order.
- **Recommended resolution:** discover via `handlers/**/*.ts` (mirror L2); modules call `register(...)` on import. `register` takes a **channel pattern** (full address with `{param}` capture) and reuses the **G1 matcher**; multiple matches resolve by the same precedence as G1 (most-specific, then sorted module path → registration order).
- **Acceptance:** two overlapping handlers resolve to the same winner across runs; reordering files doesn't change the winner; the L3-registry acceptance test has a defined discovery glob.
- **Status:** ☑ resolved (2026-06-23)

### G12 — `declaredVersion` back-fill couples two "parallel" Tier-1 modules
- **Where:** `offbook-contracts.md` §6 line 192 (`ResolvedSpec.declaredVersion` = `info.version` "back-filled from the parsed spec"), line 233 (`specDeclaredVersion`); `offbook-build-plan.md` line 70 (`ingestion/` depends "only on `model/` + libs"), line 72 (`registry/` owns the parser).
- **Problem:** extracting `info.version` requires parsing, which lives in `registry/`, but `ingestion/` is supposed to be parser-free and is the one writing the lockfile. Ownership is unassigned → both leave it blank → `/specs` `declaredVersion` always `undefined` and the v2 drift-check loses its only v1 input.
- **Decision owed:** who reads `info.version`.
- **Recommended resolution:** `ingestion/` does a **shallow `info.version` read** with the `yaml` lib (already a dep) — no `@asyncapi/parser` import, no tier violation, no duplicate full-parse. (Alternative: finalize the lockfile *after* `registry` parse; rejected — it serializes the two Tier-1 modules.)
- **Acceptance:** lockfile `spec-declared-version` and `SpecInfo.declaredVersion` are populated; `ingestion/` imports no parser.
- **Status:** ☑ resolved (2026-06-23)

### G24 — Scenario hot-reload is not quiesced for determinism
- **Where:** `offbook-l2-scenarios.md` (glob + hot-reload); `offbook-contracts.md` §5 (`passive` mode); G5 ("`passive` fires no ticks").
- **Problem:** L2 scenarios hot-reload on file change, mutating the dispatch table mid-run. A reload between `reset` and an assertion changes which scenario matches → non-reproducible, exactly as autonomous ticks would. `passive` mode is specced to quiesce *ticks* but nothing says it quiesces *hot-reload*.
- **Decision owed:** does `passive` / CI mode freeze the dispatch table?
- **Recommended resolution:** in `passive` mode the scenario set is **loaded once at startup and frozen** (no watcher); hot-reload is a dev-only affordance. Mirror the §5 "`passive` fires no ticks" language for the loader.
- **Acceptance:** in `passive` mode, editing a scenario file between `reset` and an assertion does not change the matched scenario.
- **Status:** ☑ resolved (2026-06-23)

### G25 — `Channel.schema` form (bundled vs ref-retaining) is unpinned
- **Where:** G2 (`schema: object` = "dereferenced JSON Schema"); `offbook-contracts.md` §5 (the §5 correctness bar); `fixtures/asyncapi/external-ref.yaml` + `shared/common.yaml` (the test).
- **Problem:** "dereferenced" is ambiguous — a schema that still carries `$ref`/`$id` or relies on the parser's external registry can't be handed to Ajv or the L1 faker standalone. G2's acceptance ("`engine` builds L1 from `channel.schema` without importing the parser") *implies* self-containment but doesn't require it, so a builder may store a partially-resolved schema and `external-ref.yaml` fails end-to-end.
- **Decision owed:** the canonical stored form.
- **Recommended resolution:** `Channel.schema` is **fully bundled** — every `$ref` inlined or rewritten to internal `$defs`, no dangling external refs, with the 2020-12 dialect declared so Ajv compiles it standalone. The registry produces this once; everything downstream consumes plain JSON Schema. Fold into the G2 `Channel` patch.
- **Acceptance:** `external-ref.yaml`'s message schema, taken as `channel.schema` alone, compiles under Ajv and seeds the L1 faker with no parser/registry present.
- **Status:** ☑ resolved (2026-06-23)

---

## Tier 3 — narrower but real

### G13 — qos/retain precedence has no config home for its middle tiers, and tier-ownership is contradicted
- **Where:** `offbook-contracts.md` §2 line 64 (precedence "spec binding → per-topic override → per-service default → global", "engine-resolved"), §6 lines 176–182 (`ServiceConfig` = `name`/`repo`/`specPath`/`branch` only); `offbook-build-plan.md` line 72 (assigns resolution to Tier-1 `registry/`).
- **Problem:** the binding-vs-global tier is fine — `qos-retain.yaml` already exercises it **non-vacuously** (`qos: 2` / `retain: true`, both ≠ global). The gap is the **middle tiers**: no config schema holds the per-topic override or per-service default, so tiers 2–3 of the precedence chain can be neither expressed nor tested. Compounding it, ownership is **contradicted** — build-plan line 72 says `registry`, contracts §2 line 64 says **"engine-resolved."**
- **Decision owed:** config shape for the overrides, and the single resolving owner.
- **Recommended resolution:** extend `ServiceConfig` with `qosDefault?: 0|1|2`, `retainDefault?: boolean`, `topicOverrides?: Record<string, { qos?: 0|1|2; retain?: boolean }>`; surface these in `services.yaml`. Assign resolution to **`registry`** (it already holds the spec binding), config injected at construction, result stored on the enriched `Channel` (G2). **This overrides §2's "engine-resolved" — pick one owner and patch the loser**; registry is recommended.
- **Acceptance:** the spec binding (tier 1) outranks a per-topic override outranks the per-service default outranks global `qos 1` — exercised by a **new middle-tier fixture + `services.yaml` override**: since `qos-retain.yaml` already covers the binding tier, the new fixture declares **no** binding, so the config tiers (per-topic override beats per-service default beats global) are what resolve qos/retain.
- **Status:** ☑ resolved (2026-06-23)

### G14 — CLI `up`/`down` and `specs update` map to no endpoint
- **Where:** `offbook-build-plan.md` line 49 (CLI "thin client over the HTTP API"), line 84 (each verb "hits the right endpoint"); `offbook-design.md` line 289 (`up`/`down`), line 296 (`specs update`), line 301 ("the server **is** the process"); `offbook-contracts.md` §5 (no lifecycle or specs-mutation endpoint).
- **Problem:** `up`/`down` must spawn/kill a process (no HTTP endpoint can start the server), and `specs update` has no `POST /specs` to call; shelling out leaves the running server's registry stale.
- **Decision owed:** the process-management mechanism, and adding a specs-refresh action.
- **Recommended resolution:** `up` spawns the server detached, writes a PID + port runfile, probes the control-plane port for readiness; `down` reads the runfile and signals. Add `POST /v1/specs/refresh` → re-resolve + rewrite lock + hot-swap the registry, returning the new `SpecInfo[]`; `offbook specs update` calls it. Note in contracts §5 that `up`/`down` are process management, not HTTP.
- **Acceptance:** `offbook up` then `offbook topics` works against a fresh process; `offbook specs update` refreshes specs without restart and `GET /topics` reflects the new spec.
- **Status:** ☑ resolved (2026-06-23)

### G15 — The `/validation` `summary` object — the CI-facing payload — is never typed
- **Where:** `offbook-contracts.md` §5 (`summary { errors, warnings, byOrigin{client,mock}, byKind, oldestSeq }` — `oldestSeq` added by `fce44fa`; still no interface), the gate (`reset → poll`) reads `summary.byOrigin.client`.
- **Problem:** `byKind`'s key domain (all `ViolationKind`s vs only-seen?), zero-count inclusion, and whether `byOrigin` counts errors-only or all severities are undefined; producer and CI consumer diverge → `undefined` crashes at the headline assertion.
- **Decision owed:** zero-fill policy + `byOrigin` severity scope.
- **Recommended resolution:**
  ```ts
  interface ValidationSummary {
    errors: number; warnings: number;
    byOrigin: { client: number; mock: number };  // counts all severities
    byKind: Record<ViolationKind, number>;        // all 4 kinds always present, zero-filled
    oldestSeq: number;                            // lowest still-retained seq (ring buffer, fce44fa); 0 when empty
  }
  ```
- **Acceptance:** `tsc` clean; `summary.byKind` always has all four keys; a CI consumer asserting `summary.byKind.direction === 0` never sees `undefined`; `oldestSeq` is present so a caller can detect a `sinceSeq` that predates the retention window.
- **Status:** ☑ resolved (2026-06-23)

---

## Secondary — quick fixes / by-design clarifications

### G16 — `/publish` `example` flag-vs-value ambiguity
- **Where:** `offbook-contracts.md` §5 line 164 ("`example:true` on unknown → 400" implies a boolean flag) vs line 154 (`TopicInfo.example?: unknown` is a value) and `offbook-design.md` line 291 (`--example` "generates a schema-valid payload").
- **Recommended resolution:** split into two mutually-exclusive fields on the `/publish` body: `payload?: unknown` (explicit value) **xor** `example?: boolean` (generate). Reject both-present.
- **Acceptance:** `{ topic, example: true }` generates a seeded valid payload; `{ topic, payload: {…} }` sends the literal; `{ topic, payload, example }` → `400`.
- **Status:** ☑ resolved (2026-06-23)

### G17 — `StateEntry`/`getState` tombstones + `undefined`-payload ambiguity
- **Where:** `offbook-contracts.md` §5 line 155 (`StateEntry.retain: true`) vs §1 line 25 (`NormalizedMessage.retain?` optional); §2 line 61 (clear-retained = zero-byte retained publish, `payload: undefined`), line 43 (decode-failure also `payload: undefined`).
- **Recommended resolution:** the broker **evicts** a key on a zero-byte retained publish, so `getState()` never returns tombstones and `StateEntry.retain: true` always holds; a decode-failure is surfaced only via `InboundEvent.meta.decodeError` + a `decode` violation and is **never** written to the retained map. (This also disambiguates the two `undefined` cases.)
- **Acceptance:** clearing a retained topic removes it from `GET /state`; a decode-failure publish creates no retained entry.
- **Status:** ☑ resolved (2026-06-23)

### G18 — Error envelope `code` never enumerated
- **Where:** `offbook-contracts.md` §5 line 140 (`{ error: { code, message, details? } }`), referenced by every action (`400`/`404`).
- **Recommended resolution:** enumerate a closed `ErrorCode` union (e.g. `'unknown-topic' | 'unknown-scenario' | 'bad-request' | 'example-on-unknown-topic' | 'example-and-payload'`). The Tier-4 CLI (built early against the contract) branches on the closed set.
- **Acceptance:** every non-2xx path returns an enumerated `code`; the CLI/CI key off the union with no ad-hoc strings.
- **Status:** ☑ resolved (2026-06-23)

### G19 — Support docs contradict the canonical contract
- **Where:** Resolver return type — `offbook-design.md` line 254, `offbook-handoff.md` line 33, `offbook-prework.md` line 33 all say `resolve(...) → spec content` vs `offbook-contracts.md` line 195 (`Promise<ResolvedSpec>`). Lockfile — `offbook-design.md` §7 lines 232–242 uses v2-only `resolved-version`, `resolution-strategy: git-tag`, and a 7-char SHA that contracts §6 forbids.
- **Recommended resolution (pure doc fix):** edit design/handoff/prework to `resolve(...) → Promise<ResolvedSpec>`; replace design §7's lockfile snippet with the v1 contracts §6 shape, or explicitly label it "v2-rich illustration."
- **Acceptance:** no support doc contradicts `offbook-contracts.md` §6 on the Resolver or the v1 lockfile.
- **Status:** ☑ resolved (2026-06-23)

### G20 — `repo: org/service-a` host/transport ambiguous
- **Where:** `offbook-contracts.md` §6 line 206 (`repo: org/service-a`), line 190 (`source: "dev@org/service-b:asyncapi.yaml"`); `offbook-build-plan.md` line 25 ("host-agnostic; reuses existing creds").
- **Recommended resolution:** add a `gitHost`/base-URL config (global, per-service override); `repo` may be a full URL **or** an `org/name` slug resolved against the base. Default the base to the adopter's host.
- **Acceptance:** a slug + configured host fetches; a full URL also fetches; the default doesn't hardcode `github.com`.
- **Status:** ☑ resolved (2026-06-23)

### G21 — Two acceptance criteria are not self-checkable
- **Where:** `offbook-build-plan.md` line 71 ("QoS-1… DUP-on-redelivery contract intact" — needs a non-acking/forced-redelivery harness, never specified; and "a browser-style `mqtt.js` client connects" — defaults↔defaults can't detect the fork-specific WS divergence the project exists to catch).
- **Recommended resolution:** for DUP — add a harness that suppresses PUBACK (custom client or Aedes hook) to force redelivery and assert `DUP=1`, **or** scope the criterion to "QoS-1 round-trip + retained" and move DUP to known-limitations/the spike. For connect-fidelity — keep `mqtt.js` as the dev/CI smoke test but mark the **real-browser WS-fidelity spike** as the authoritative gate (it already is, §12.1).
- **Acceptance:** each criterion is executable exactly as written, or explicitly delegated to the spike.
- **Status:** ☑ resolved (2026-06-23)

### G22 — Spike→broker ordering hazard
- **Where:** `offbook-build-plan.md` §5 lines 96–98 (spikes "runnable in parallel now… not on the module critical path… may adjust broker/") vs `offbook-handoff.md` line 20 (items 1–2 "still gate Step 2", whose first task is the broker).
- **Recommended resolution:** state the reconciliation: `broker/` **may start** in parallel against Aedes defaults, but the WS-fidelity spike result is a **gate on the broker's listener config being final** — the broker is buildable; its WS subprotocol/path/auth config is provisional until the spike returns.
- **Acceptance:** build-plan §5 and handoff agree on the ordering; an orchestrator reading either reaches the same plan.
- **Status:** ☑ resolved (2026-06-23)

---

## Cross-cutting note

G1, G2, and G3 are one interlocking knot: the matcher (G1) needs the enriched `Channel` (G2), and the initial-state policy (G3) consumes both. Resolve them together as a small **contracts patch** before fanning out — it's the highest-leverage edit. **G5 + G6 + G23 are the determinism cluster** (clock split, `seq` uniqueness, dispatch atomicity) — settle them together with the engine owner; G6 also pins the §4 `seq` text the `fce44fa` retention cap already presumed. **G9 was promoted to Tier 1** on review — it spans control-plane + broker + validation and a mis-tag silently passes the headline gate. Everything else can be resolved independently once these land.

## Residual follow-ups (post-resolution, non-blocking)

Surfaced by the adversarial verifiers; none block the fan-out, all are builder-time or host-config items:

- **G11 — identifier rename deferred.** Contracts §3 still literally declares `register(topicPrefix: string, …)`; the prose redefines arg 0 as a channel *pattern*. Rename `topicPrefix → pattern` (a one-token edit) when wiring the `SpecRegistry.match` import, so the type line can't be misread as bare-prefix matching.
- **G4 — host capability dependency.** By-SHA fetch (`git fetch <repoUrl> <sha>`) requires the target host's `uploadpack.allowAnySHA1InWant`. Confirm against the adopter's real host; if disabled, fall back to fetching the branch ref and walking to the locked SHA.
- **G1 — precedence rule not fixtured.** The "two channels matching one concrete topic resolve to the same winner" rule is specified but no fixture has an overlapping literal-vs-`{param}` pair (e.g. `state/all` + `state/{deviceId}`). Add one, or cover it with a `registry/` unit test, when building.
- **Action-response `seq` unqualified.** After the G6 split, `/publish` and `/trigger` `202 { …, seq }` don't state whether `seq` is the inbound `meta.seq` or the `Violation` log cursor. Low-stakes (CI checkpoints off `/reset`); pin it when implementing the control plane.
- **`config/` is untyped.** `config.injectedClientId` (G9), `maxViolations`/`maxEvents` (`fce44fa`), and `tickIntervalMs` (G5) are referenced but no `Config` interface is declared in contracts. Predates this round; worth a typed `config/` schema in `model/`.
- **`GET /v1/diagnostics` summary still bare.** `/validation`'s summary is now `ValidationSummary`; the `diagnostics` `summary` placeholder remains untyped (out of G15's scope) — type it for symmetry if/when it matters.

## Decision log

*(One row per resolved gap. Resolver = the `resolve-build-gaps` workflow + review pass; date 2026-06-23.)*

| ID | Decision taken | Doc(s) patched |
|---|---|---|
| G1 | `SpecRegistry.match(topic) → {channel, params}` added to §1; one impl in `registry/`; precedence most-specific → declaration order; `{param}` = address capture, `+`/`#` = subscribe-side only | contracts §1; build-plan model/ + registry/ |
| G2 | `Channel` enriched (`service`, bundled `schema`, `qos?`/`retain?`, `title?`/`description?`); `example` computed on-demand by `/topics`, not stored | contracts §1; build-plan registry/ |
| G3 | Materialization policy made **canonical in contracts §2** (eager non-param / lazy param / wildcard replays-only / `seedInstances` / reset re-materializes); design §7a reframed as elaboration | contracts §2; design §7a |
| G4 | Lockfile **reader** wired (`up --frozen` re-resolves by `resolvedSha`); atomic `ls-remote` → fetch-that-SHA (`git fetch <sha>`, not `git archive --remote`) | contracts §6; build-plan |
| G5 | `now()` = logical (`fixedEpoch + Σ` seeded); default scheduler = virtual-time + single event-loop yield (real-wall = opt-in); `tickIntervalMs`; passive = no ticks | contracts §3; l2 §5/§6; design §6 |
| G6 | `Violation.seq` = unique monotonic per-entry cursor; order by `seq` alone; `?sinceSeq=` strictly-greater; `meta.seq` is the separate inbound-arrival counter | contracts §1/§4/§5 |
| G7 | New contracts §3a `Scenario` / `WhenClause` / `EmitStep` (from l2 §9); added to build-plan `model/` | contracts §3a; build-plan |
| G8 | l2 §8 trigger body → nested `{ params, payload }` matching contracts §5; `params` bind `{{param}}` captures | contracts §5; l2 §8 |
| G9 | Injected `fromClient` `/publish` re-enters `onInbound`; `meta.clientId = 'control-plane'`; tagged `origin: 'client'` (gate-correct) | contracts §5 |
| G10 | `broker.emit` stays content-only; the engine stamps `emitSource` (L1 / L2 `{scenarioName, stepIndex}` / L3) | contracts §3/§4; build-plan engine/ |
| G11 | L3 discovery `handlers/**/*.ts`; `register(pattern)` reuses the G1 matcher + precedence; `topicPrefix → pattern` rename deferred (residual) | contracts §3; build-plan engine/ |
| G12 | `declaredVersion` via ingestion shallow `yaml` read (no parser); swept the two stale "from the parsed spec" comments | contracts §5/§6; build-plan ingestion/ |
| G13 | qos/retain config tiers on `ServiceConfig`; **registry-resolved** (patched §2 "engine-resolved"); new `qos-overrides.yaml` (override pinned to `qos 0`) | contracts §2/§6; build-plan; fixtures |
| G14 | `up`/`down` = process management (not HTTP); added `POST /v1/specs/refresh` to the **Actions** table | contracts §5 |
| G15 | `ValidationSummary` typed (`byOrigin` all-severities; `byKind` zero-filled all kinds; `oldestSeq`) | contracts §5 |
| G16 | `/publish` body = `payload` **XOR** `example: boolean`; both-present → `400` | contracts §5 |
| G17 | Broker evicts on zero-byte retained (no tombstone); decode-failures never enter the retained store | contracts §2/§5; build-plan broker/ |
| G18 | Closed `ErrorCode` union in §5, wired into the error envelope + `/publish`/`/trigger` codes | contracts §5 |
| G19 | design/prework Resolver return → `Promise<ResolvedSpec>`; design §7 lockfile relabelled "v2-rich illustration"; handoff needed no edit | design §7; prework |
| G20 | `gitHost` base-URL config (global + per-service); `repo` = full URL or `org/name` slug; no hardcoded default (slug w/o host = config error) | contracts §6; build-plan ingestion/ |
| G21 | Broker DUP acceptance via a PUBACK-suppressing harness (else delegated to spike); `mqtt.js` = smoke test, WS-fidelity spike = authoritative gate | build-plan broker/ |
| G22 | Broker may start on Aedes defaults; the WS-fidelity spike gates the listener config being final — stated in both build-plan §5 and handoff | build-plan §5; handoff |
| G23 | Dispatch is run-to-completion per event; concurrent arrivals queue in arrival order (inbound by `meta.seq`, emissions by the seeded timeline) | contracts §3; design §6 |
| G24 | `passive` freezes the scenario set (loaded once, no watcher), mirroring "passive fires no ticks" | contracts §5; l2 §8 |
| G25 | `Channel.schema` is fully bundled (2020-12, no dangling `$ref`); `external-ref.yaml` + `shared/common.yaml` is the bar | contracts §1; build-plan registry/ |
