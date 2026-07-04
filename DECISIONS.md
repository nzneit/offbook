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
