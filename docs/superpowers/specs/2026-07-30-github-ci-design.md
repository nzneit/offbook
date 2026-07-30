# GitHub CI pipeline: design

**Date**: 2026-07-30
**Status**: implemented 2026-07-30 (workflow + typecheck: 946833f; ruleset live; docs via gated PR: b0c3ef4; see D-017)
**Provenance**: brainstorm dialog 2026-07-30. Action versions and both compile findings below were verified live during the dialog (GitHub releases API; local `bun build --compile` runs on Bun 1.3.14).

## Problem

The repo has a full local gate set (doc-system checker, Biome lint with transport-isolation enforcement, `tsc --noEmit`, and the coverage-floored `bun test` including the executable doc gates), but nothing enforces any of it on GitHub. There is no `.github/` directory and no branch protection: a PR can merge red, and main has no post-merge build record.

## Scope

PR gates plus a main-branch build after every push to main. The main build re-runs the same gates and uploads build artifacts. No release automation.

## Decisions (from the design dialog)

- **Main builds produce artifacts, not releases**: the demo-app bundle and the coverage report. Chosen over gates-only (loses proof-of-build) and over release automation (premature for a private 0.0.0 package).
- **No compiled `offbook` binary artifact for now.** See Known limitations; single-binary offbook is its own future project.
- **Mutation testing stays out of CI entirely**, consistent with repo policy (manual, never a gate). Not even a `workflow_dispatch` trigger.
- **One workflow, one job.** The full gate set runs serially in about 40 seconds locally (`bun test` 33 s, everything else under a second each), so parallel jobs would only add per-job runner boot, checkout, and install overhead. One job also means one required check name. Two-workflow and reusable-workflow topologies were considered and rejected as more YAML for the same behavior; splitting later is mechanical if main-side builds grow.
- **Bun pinned to 1.3.14 exactly.** The bunfig.toml coverage-gate semantics (per-file floors, silent exit-1 signal) were empirically verified on 1.3.14, and a floating version could silently change what the test gate means. Bumping Bun becomes a deliberate one-line PR that the gates themselves validate.
- **Branch ruleset with Repository-admin bypass and strict up-to-date.** PRs are gated; the repo owner keeps the ability to push directly to main. Merges require the branch to be current with main, so two-green-PRs-that-conflict are caught at PR time; the main-push run is belt-and-braces.
- **README gets a CI badge.**

## The workflow: `.github/workflows/ci.yml`

```yaml
name: ci
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}  # never cancel main runs
permissions:
  contents: read
jobs:
  gates:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14"  # pinned: coverage-gate semantics verified on this version (see bunfig.toml)
      - run: bun install --frozen-lockfile
      - run: bun scripts/check-docs.ts   # doc-system gate
      - run: bun run lint                # Biome, incl. transport isolation
      - run: bun run typecheck           # tsc --noEmit (new package.json script)
      - run: bun run demo-app:build
      - run: bun test                    # authoritative full run; carries the coverage floors
      - if: github.event_name == 'push'
        uses: actions/upload-artifact@v7
        with: { name: demo-app-dist, path: demo-app/dist/, retention-days: 14 }
      - if: github.event_name == 'push'
        uses: actions/upload-artifact@v7
        with: { name: coverage, path: coverage/, retention-days: 14 }
```

Design notes:

- Steps are ordered fast-to-slow so cheap failures kill the run early: check-docs (~20 ms), lint (~40 ms), typecheck (seconds), demo-app build (sub-second), then the test suite.
- `--frozen-lockfile` fails on a stale `bun.lock` instead of papering over it.
- No dependency cache initially: install takes seconds, and cache YAML is complexity to add only if it ever matters.
- Action majors verified current as of 2026-07-30: `actions/checkout` v7.0.1, `actions/upload-artifact` v7.0.1, `oven-sh/setup-bun` v2.2.0.
- The 10-minute timeout only catches hangs; the pipeline is expected to finish in well under 2 minutes.
- Artifact uploads run only on push events (i.e. on main), with 14-day retention.

## Branch ruleset (one-time setup via `gh api`)

A branch ruleset on `main`: enforcement `active`, targeting `~DEFAULT_BRANCH`, with

- rule `required_status_checks`: context `gates`, `strict_required_status_checks_policy: true` (branch must be up to date with main to merge);
- bypass actor: Repository admin (`actor_type: RepositoryRole`, role id 5, `bypass_mode: always`), so the owner can still push directly to main.

Note the consequence for everyone else (and for the owner, absent the bypass): required status checks block direct pushes to main, because pushed commits carry no passing check. The exact request JSON is validated against `gh api` during implementation and recorded in the implementation plan.

## Repo integration

- `package.json`: new script `"typecheck": "tsc --noEmit"` (verified passing on the current tree), so CI and humans run the same spelling.
- `DECISIONS.md`: new `D-017` entry recording this decision set (topology, Bun pin rationale, binary deferral, mutation-testing exclusion). Must keep `bun scripts/check-docs.ts` green (contiguous ids).
- `AGENTS.md` working notes: a short line on what CI runs and that the Bun pin is bumped deliberately.
- `README.md`: badge at the top, linking to the workflow:
  `[![ci](https://github.com/nzneit/offbook/actions/workflows/ci.yml/badge.svg)](https://github.com/nzneit/offbook/actions/workflows/ci.yml)`

## Known limitations

**A compiled-binary artifact was dropped from scope after two verified findings** (Bun 1.3.14, 2026-07-30):

1. `bin/offbook` has no `.ts` extension, so `bun build --compile bin/offbook` silently treats the entry as a non-module: it reports "1 modules", and the resulting binary prints nothing and exits 0 for every invocation (the real CLI prints usage and exits 1).
2. With the entry fixed (a `.ts` copy with a resolvable import), the bundle grows to 1021 modules but the binary still fails at startup: `Cannot find module './impl/format'`. The AsyncAPI parser's validation stack (Spectral and its `nimma` dependency) performs dynamic `require()` calls that `bun build --compile` cannot statically bundle.

Making `offbook` a single binary is therefore real bundling work (shim entrypoint plus taming the dynamic-require stack), and is deferred as its own future project. If it lands, the artifact job gains a compile step and a smoke test that runs the binary and asserts on its output; finding 1 shows why the smoke test is load-bearing, not ceremonial.

## Out of scope

- Release automation (tags, GitHub Releases, npm publish).
- Mutation testing in any CI form.
- Dependency caching (revisit if install time ever matters).
- The compiled binary (above).
- The two empirical spikes R-006/R-007: they need the real browser application and cannot run on a GitHub runner.

## Verification

- Local, before pushing: `bun scripts/check-docs.ts`, `bun run lint`, `bun run typecheck`, and full `bun test` all green (the D-017, AGENTS.md, and README edits touch checked docs).
- Open a test PR: the `gates` check appears, runs all gate steps, and skips the artifact steps.
- Push (or merge) to main: `gates` runs again and uploads `demo-app-dist` and `coverage` artifacts with 14-day retention.
- Ruleset behavior: PR merge blocked until `gates` passes and the branch is up to date; admin direct push still works via the bypass.
- README badge renders and links to the workflow run history.
