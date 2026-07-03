# Offbook — Requirements Registry

*Knows every line. Needs no cast.*

The enumerable list of v1 requirements. Each entry is an atomic statement, a stable never-reused `R-###` UID, a lifecycle `STATUS`, and a `COVERS` anchor into the spec that holds the normative text. This registry is an **index into the specs, not a source of truth**: on any interface detail, `docs/specs/contracts.md` wins (the conflict rule).

**STATUS values:** `specified` (in a spec, not built) · `built` (has an implementation trace) · `tested` (has a covering test) · `deferred` (v2) · `retired` (withdrawn, kept in place so its ID is never reused). `built` and `tested` are **derived** by `scripts/check-docs.ts` from trace fields, not asserted by hand.

**Entry format:** each entry is a `####` title line, then `**UID**:`, `**STATUS**:`, and `**COVERS**:` meta lines, then a one-sentence statement. See `docs/specs/doc-system.md` §4.3 for a worked example. (Do not paste a worked example into this file: `scripts/check-docs.ts` parses `####`+`**UID**:` and would count it as a real requirement.)

## Registry

<!-- entries seeded in the build phase; see docs/specs/doc-system.md §7 -->
