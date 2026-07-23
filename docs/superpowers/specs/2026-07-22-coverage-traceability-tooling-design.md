# Coverage gate + tag-verified traceability — design

**Date**: 2026-07-22
**Status**: draft, pending user review
**Provenance**: two deep-research rounds (2026-07-22) on Bun-era coverage tooling and requirements-traceability tooling; all load-bearing tool claims below were adversarially verified against live primary sources in those rounds.

## Problem

The repo has two coverage stories, both weaker than the rest of its discipline:

1. **No code-coverage measurement at all.** `bun test` runs with no coverage, no thresholds, no lcov artifact. Bun also cannot measure branch coverage (oven-sh/bun#7100, open since 2023), so line/function coverage alone overstates test strength.
2. **Requirement traceability is honor-system past file existence.** `check-docs.ts` verifies that a `tested` requirement names a `TEST:` file, but not that the file has anything to do with the requirement. A stale or wrong trace passes the gate.

## Decisions already taken (via brainstorm dialog)

- Scope: code coverage + test strength, and requirement traceability. AsyncAPI contract coverage is out of scope.
- Constraint: Bun-first, pragmatic. Node-based dev-dependencies acceptable where Bun has no equivalent.
- Approach: Bun-native gate + extended custom checker. Full OpenFastTrace adoption rejected (JVM dependency, mandatory `type~name~revision` ID grammar, and it cannot express the `specified`/`built`/`tested` lifecycle, so `check-docs.ts` would survive anyway).
- Trace mark: **OFT-style arrow tags only** (`// [utest->R-014]`). Test titles may keep `R-###:` prefixes for readability but do not count as evidence.

## 1. Coverage gate (Bun-native, local-first)

New `bunfig.toml`:

- `[test]` with `coverage = true` (always-on: with no CI, the local run is the gate).
- `coverageSkipTestFiles = true`.
- `coverageReporter = ["text", "lcov"]`; lcov lands in `coverage/` (gitignored), ready for octocov or editor gutters later.
- `coverageThreshold = { lines = <floor>, functions = <floor> }`.

Implementation notes:

- **Measure before gating.** Whether `coverageThreshold` applies per-file or repo-wide on Bun 1.3.x is unresolved (oven-sh/bun#17028; the research repro was single-file). First step of implementation: run the suite with coverage, observe the actual numbers and the threshold behavior empirically, then set the floor just below current reality.
- **Ratchet policy** (documented as a comment in `bunfig.toml`): raise the floor as coverage grows; never lower it to admit a regression.
- **Footguns** (documented as comments): plural keys only (`lines`, not `line`; singular keys are silently ignored and gate nothing); a failing gate prints no message, only exit 1; the `statements` key exists but no statement metric is computed, so it is not used.
- **Version floor**: requires Bun >= 1.3.0 (earlier lcov output understates coverage; fixed in v1.3.0). Already satisfied.

## 2. Tag-verified traceability (`check-docs.ts` extension)

**Convention.** Every test that covers a requirement carries an arrow-tag comment; by convention it sits directly above the covering `test(...)`, though the checker enforces presence at file level only:

```ts
// [utest->R-014]
test("R-014: reset restores replay-identical state", ...)
```

- Artifact types: `utest` (module unit tests), `itest` (cross-module/acceptance, e.g. `test/m0-acceptance.test.ts`), `stest` (spikes/system). The checker treats all three equally; the type is documentation.
- The tag carries the UID **verbatim** (`R-014`, not `req~r-014~1`): one grep finds the registry entry and every covering test. Full OFT grammar is deliberately not used; it would add revision bookkeeping now, and a later OpenFastTrace migration is a mechanical rewrite of these tags.
- One tag per requirement per covering test; a test covering two requirements carries two tags (OFT 4.6.0's multi-ID tags are not mimicked).

**New checker pass, `checkTestTraces`.** For every requirement with `STATUS: tested`:

- each `TEST:`-listed path must exist (today only existence of the *field* is checked), and
- each listed file must contain at least one arrow tag for that UID. A listed file that never mentions the requirement is an **error**: that is the honor system dying.

**Reverse sweep.** All `*.test.ts` under `src/`, `test/`, and `scripts/` are scanned for arrow tags:

- a tag whose UID does not exist in `REQUIREMENTS.md` is an **error** (dangling tag);
- a tag pointing at a `built`/`specified` requirement is **fine** (early coverage, no complaint);
- a tag pointing at a `retired` requirement is an **error** (the test outlived the requirement; retire or retarget it).

**Tag grammar** (checker regex): `\[(u|i|s)test->R-\d{3}\]` inside a `//` or `/* */` comment. Anything arrow-shaped that fails this grammar inside a comment (e.g. `[utest->R-14]`, `[test->R-014]`) is an **error**, not silently ignored, so typos cannot leak coverage claims.

**Retrofit.** Existing R-###-titled tests (`R-009`, `R-013`, `R-015` references in `src/broker/index.test.ts`, `src/engine/index.test.ts`, `test/m0-acceptance.test.ts`, and any others a sweep finds) get tags added. All `tested`-status requirements must pass the new checks in the same change that lands the checker, so the gate never knowingly ships red.

## 3. Mutation testing (experimental, not a gate)

- Dev-deps: `@stryker-mutator/core` + `@hughescr/stryker-bun-runner` (v1.3.x; the only actively maintained Stryker-on-Bun runner as of 2026-07; requires Bun >= 1.3.7 and `--concurrency 1`).
- `stryker.conf.json` scoped to `src/engine/` first: the deterministic core, where test strength matters most and where Bun's missing branch coverage hurts most.
- Run manually via `bun run mutate`. Explicitly **not** wired into any gate until the runner proves stable here (it is a young, single-maintainer project).
- Documented fallback if the runner misbehaves: Stryker's official command runner (`coverageAnalysis: "off"`, slower but boring).

## 4. Deferred, with triggers

| Item | Trigger to revisit |
|---|---|
| octocov (PR comments, badges, report deltas) | the repo gains a remote + CI |
| JUnit XML per-test harvesting (`--reporter=junit`) | a need to map per-test *results* (not just presence) to R-### IDs |
| Per-test coverage attribution spike: verify a tagged test actually executes its requirement's `IMPL` lines via Bun's Inspector Protocol TestReporter events (the mechanism the Stryker runner uses for perTest analysis) | tag-verified traces prove insufficient, or the spike becomes cheap because the Stryker runner integration already exercises the same events |
| OpenFastTrace adoption | the trace graph outgrows one registry (multi-level specs, compliance-style reporting) |

## 5. Process fit

- The adopted conventions (arrow tags, coverage ratchet, mutation scope) are recorded as a `D-###` entry in `DECISIONS.md` (dev-tooling decision, forward-authoritative).
- `AGENTS.md` gains one line under the doc-system gate paragraph noting the arrow-tag convention.
- New checker logic gets unit tests in `scripts/check-docs.test.ts` alongside the existing ones: tag parsing, a passing trace, a `TEST:` file with no tag (error), a dangling tag (error), a malformed tag (error), a tag on a `built` requirement (ok).
- `.gitignore` gains `coverage/`.

## 6. Out of scope

- No CI workflows and no octocov config in this change.
- No AsyncAPI contract coverage.
- No change to `REQUIREMENTS.md` semantics: `TEST:` fields stay; tags make them verifiable rather than replacing them.
- No coverage thresholds on mutation score.

## Acceptance

1. `bun test` computes coverage on every run, writes `coverage/lcov.info`, and exits 1 when below the configured floor (verified by temporarily raising the floor).
2. `bun scripts/check-docs.ts` errors on: a `tested` requirement whose `TEST:` file lacks its tag, a dangling tag, a malformed tag; and passes on the retrofitted repo.
3. `bun run mutate` produces a mutation report for `src/engine/` (or the documented command-runner fallback does).
4. All existing tests and the doc gate stay green.
