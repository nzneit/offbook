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
