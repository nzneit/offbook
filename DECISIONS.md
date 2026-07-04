# Offbook — Decision Ledger

*Knows every line. Needs no cast.*

Append-only. Each decision has a stable never-reused `D-###` id, what was decided, why, where it came from, and which spec section it folded into. This ledger is authoritative **from 2026-07-03 forward**. Historical decisions predating it live under their original IDs (G/F/R/S/P/EQ/EI/EC/ER/EO/EH) in `docs/archive/decision-logs/`; a forward decision that must cite one maps that single item to a `D-###` on demand (no bulk back-fill).

## Ledger

### D-001: Adopt the homegrown documentation-system design
**Date**: 2026-07-03
**What**: Replace the INDEX.md + frontmatter scaffold with an `R-###` registry, a `D-###` ledger, a standing intake convention, and a validating checker; bind to StrictDoc grammar format-only (ReqIF exit kept open, no Python dependency).
**Why**: Enumerable requirements, durable decision provenance, a single agent entry point, and a standing intake path that ends the per-round ID alphabets, at low ceremony and zero present tool cost.
**From**: docs/specs/doc-system.md (this design)
**Folds into**: docs/specs/doc-system.md

### D-002: Seed M0 as the week's prototype target; defer the batch-2+ pass
**Date**: 2026-07-03
**What**: Seed R-008 (the M0 walking-skeleton gate) now as the enumerable end-of-week deliverable and defer writing the rest of batches 2-4. The deferred pass's shape is decided (hybrid module carve, spikes 4/5 as their own entries, the §4 items as cross-cutting gate entries) but is post-prototype enrichment work.
**Why**: Seeding the engine/cli/control-plane/contract entries buys nothing the M0 prototype needs and costs build hours; build-plan §M0 is already the complete spec for the slice, so the pragmatic move is one tracked target plus build.
**From**: planning dialog (2026-07-03)
**Folds into**: REQUIREMENTS.md (R-008 + the staged-seeding note), docs/specs/build-plan.md#m0

### D-003: Make `Faker` async; keep json-schema-faker 0.6.2
**Date**: 2026-07-04
**What**: Change the frozen `Faker` type from `(channel, params?) => unknown` to `(channel, params?) => Promise<unknown>` and keep the `json-schema-faker@0.6.2` pin. The 0.6.x rewrite is async-only (exposes only `generate(schema, {seed}) => Promise<unknown>`; no sync entry point), so "sync Faker + 0.6.2" was not a real option. The alternative (re-pin to sync 0.5.x, keep `Faker` sync) was declined.
**Why**: Owner chose json-schema-faker's async direction and its JSON-Schema-2020-12 composition over downgrading to the 0.5.x line. A multi-agent analysis confirmed the async ripple is not end-user-observable at runtime — every consumer boundary (HTTP API, CLI, MQTT delivery, and the L2/L3 authoring surface) already awaits before producing output; the cost is second-order implementation discipline, mitigated below.
**Mitigations (M0)**: seed per-call via `generate(schema, {seed})` (no module-global `option("random")` mutation, so concurrent generation cannot race the seed); `l1Floor` catches a faker rejection and drop-and-surfaces it as a `mock`/L1 violation (closes the unhandled-rejection tail); the topics test asserts the example's SHAPE, not just `/topics`↔`/publish` byte-equality, so a missed `await` serializing to `{}` fails red.
**Obligations (post-M0, engine/scheduler + control-plane)**: the run-to-completion atomicity rule (§3, "synchronous handler work") must be re-scoped to span the `await faker()` suspension, and `GET /pending.scheduled` (§5) must count in-flight faker promises — else an emit enqueued only after `await faker()` resolves lets `?wait` return `settled:true` prematurely and breaks the F9 determinism gate in autonomous mode. Faker call sites must `await` sequentially, never `Promise.all`.
**From**: design dialog (2026-07-04), informed by the faker-async-ripple analysis
**Folds into**: docs/specs/contracts.md §3 (Faker type + obligations), src/model/index.ts, docs/plans/2026-07-03-m0-walking-skeleton.md (Tasks 7–9)

### D-004: F5 drop on `POST /v1/publish {example}` returns `injected: false`; discovery omits an unfakeable example silently
**Date**: 2026-07-04
**What**: Wire the L1 floor (`l1Floor`, Ajv-recheck-then-drop-and-surface, F5/§4) into the control-plane's two faker call sites. On `POST /v1/publish {example:true}`, a generated payload that fails its pre-emit recheck (or a rejecting faker) is **not emitted**; the endpoint records an L1 `mock` `Violation` and returns `202 { matched:true, injected:false, sinceSeq }`. This is the **sole** case where `matched:true` pairs with `injected:false`. On `GET /v1/topics`, the same floor failure yields `example` **omitted** (not surfaced to the log) so one unfakeable channel can't 500 the whole discovery response. Amend the frozen `contracts.md` `/publish` row's `injected` clause (was "always `true` on this `202`") to carve out this F5 exception.
**Why**: `injected`'s own definition is "confirmation the publish reached the broker"; an F5 drop means it did not, so `false` is the only truthful value — the prior "always true" claim predated a `/publish` drop path existing. Staying **`202` + a recorded violation** (not a `4xx`) keeps observe-and-surface and mirrors the existing unmatched-topic-is-`202` philosophy, so **no new `ErrorCode`** is added (the closed union at §5 is untouched). Discovery omits-without-recording because `GET /topics` is idempotent — recording on every fetch would spam the log; the `/publish` emit path owns the F5 surface. Chosen over deferring the `/publish` wiring to the engine-split batch (option B) to complete F5 on the live emit path now; option A ratifies the truthful behavior rather than shipping it silently.
**Mitigations / notes**: F11 byte-equality (GET /topics example ↔ `/publish {example}` payload) is preserved — both still reduce to `faker(channel)` with params omitted, and both omit any payload on floor failure. No double-recording on the success path (the post-emit recheck finds the already-validated payload clean). Covered by `src/control-plane/index.test.ts` (buildTopicInfo omit; `/publish` drop-and-surface) and `src/engine/faker.test.ts` (l1Floor unit tests).
**Obligations (post-M0, engine-split batch)**: F11 mandates control-plane receive engine capabilities **by injection**, not by direct import — M0 imports `l1Floor` from `engine/` directly (a legal tier-3→tier-2 forward edge, not a back-edge); move it behind injection (or to `model/`) when the engine composition root lands. Whether an unfakeable schema should also surface at discovery time (vs the current silent omission) is revisited when `GET /topics` gains caching/dedup.
**From**: M0 hardening dialog (2026-07-04) + a 3-lens adversarial verification (F5-correctness, test-integrity, contract-fidelity), owner chose option A (ratify)
**Folds into**: docs/specs/contracts.md §5 (`/publish` row `injected` clause), src/control-plane/index.ts (`buildTopicInfo` + `/publish` example path)
