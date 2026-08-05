# Changed-file mutation gate for PRs: design

**Date**: 2026-08-04
**Status**: approved design, not yet implemented; revised same day after an adversarial agent review (findings folded in below)
**Provenance**: brainstorm dialog 2026-08-04. Engine size figures measured during the dialog (`wc -l`; D-011 campaign counts). Stryker CLI spellings verified against the installed `@stryker-mutator/core` 9.6.1 during the adversarial review: `--mutate`, `--incremental`, `--incrementalFile`, and `--reporters` exist as comma-split CLI options; CLI-supplied arrays replace the conf's wholesale (`@stryker-mutator/util` deepMerge), so the conf file is never modified; the JSON reporter's default output is exactly `reports/mutation/mutation.json`; `thresholds.break` defaults to null, so Stryker exits 0 with survivors, which makes report interpretation (not exit-code gating) mandatory, not merely preferable.

## Problem

Mutation testing is manual and never a gate (D-010), and D-017 excludes it from CI in any form. That leaves test-strength regressions invisible at merge time exactly where they are cheapest to catch: small PRs touching already-clean modules. A full-campaign CI gate is out of the question on GitHub Actions minutes grounds, and large refactors would hold a required check hostage for tens of minutes. Wanted: a PR gate that mutates only what the PR touched, is mandatory for small PRs, steps aside loudly for large ones, and is portable to other StrykerJS projects with minimal ceremony.

## Scope and stances (from the design dialog)

- **Gate width = the project's own `mutate` globs** (engine-only in offbook today). Widening the globs is a deferred, module-by-module follow-up: each module's glob lands only after that module passes a D-011-style kill-or-annotate campaign, so "survivor = red" stays true forever. Repo-wide expansion now was rejected (it would require six-plus campaigns as a prerequisite).
- **Pass = zero undetected mutants over the mutated set** (score 100, the D-011 reading). The break threshold is a knob so adopting projects can gate at 80 or 90 while they climb.
- **Large PRs get a loud skip**: the check goes green, but the job writes a step summary and a sticky PR comment naming the measured size, the threshold, and the nudge to run `bun run mutate` locally before merging. Two label overrides: `mutate-force` (run and block even over the threshold) and `mutate-skip` (a maintainer waves the gate off when the heuristic misfires). Force wins if both are present.
- **Portability shape: two copied files** (script + workflow), dependency-free, no cross-repo `uses:` coupling. A composite action in offbook and a shared-repo reusable workflow were considered and rejected for reachability coupling; either can wrap this script later without rework.
- **Mechanism: changed-file `--mutate` override** (whole files) for offbook, with **Stryker incremental mode as a script mode for adopters** (it also catches test-only weakening, at the price of baseline infrastructure). Changed-line ranges were rejected: weaker assertion (a PR deleting an assertion that covered unchanged neighboring lines would pass), fiddly diff mapping around moves, and unverified multi-range support.

## Components

1. **`scripts/mutation-gate.mjs`** (portable piece 1): single-file, dependency-free, plain JS, runs under Node 18+ or Bun, imports only `node:` builtins and nothing from the repo. All logic lives here. Pure functions are exported for testing; the CLI entry is guarded by comparing `realpath(process.argv[1])` against `fileURLToPath(import.meta.url)`. The guard is explicitly **not** `import.meta.main`: Node below 24 lacks it, and the failure mode is the script silently no-op-ing under `node`, a green gate that ran nothing.
2. **`.github/workflows/mutation.yml`** (portable piece 2): a separate workflow, not a new `ci.yml` job, because it needs `labeled`/`unlabeled` trigger types (label toggles re-evaluate the gate without a push) and because the portable unit should be exactly two files. One job, check name `mutation`, added to the `main` ruleset as a second required check. The `gates` workflow is untouched.
3. **Doc integration (offbook-only)**: new decision **D-027** amending D-010 ("never a gate") and D-017 ("excluded from CI in any form"), plus the AGENTS.md working-notes update. **No new R-###**: like D-017's CI, this is repo infrastructure, decision-only; `check-docs` is unaffected.
4. **`scripts/mutation-gate.test.ts`** (offbook-only): unit tests over the exported functions (glob matcher, diff parsing, sibling derivation, size decision, report interpretation against fixture JSON). The bunfig per-file coverage floors judge the `.mjs` (verified empirically: an imported `.mjs` is instrumented, judged per-file, and a floor miss is exit 1 with zero failed tests and no message), and `functions = 0.64` means most of the script must execute under tests, not just the pure helpers. Therefore `main()` and the I/O edges take injectable seams (spawn, env, fs, output writers) and are unit-tested through them; the un-injected defaults are exercised by the e2e rehearsal.

## The script

Configuration is environment variables only (CI-native, no arg parser), prefixed `MUTATION_GATE_`:

| Knob | Default | Meaning |
|---|---|---|
| `MODE` | `changed` | `changed` (offbook) or `incremental` (adopters) |
| `BASE` | `origin/HEAD`, falling back to `main` | base ref; the workflow passes `origin/<base branch>` explicitly, so the default serves local runs |
| `THRESHOLD_LINES` | `800`, provisional | summed whole-file line count of the mutate set, above which the gate loud-skips; re-derived from the measured rehearsal rate (see Threshold rationale) |
| `BREAK` | `100` | minimum mutation score over the mutated set; below it the gate fails |
| `CONFIG` | `stryker.conf.json` | Stryker config path, read for `mutate` globs |
| `GLOBS` | the conf's `mutate` | explicit glob override for projects whose patterns exceed the supported subset |
| `TEST_SIBLINGS` | `true` | a changed **or deleted** `X.test.ts`/`X.spec.ts` pulls in sibling `X.ts` when it exists and matches the globs |
| `FORCE` / `SKIP` | unset | set by the workflow from PR labels; `FORCE` wins if both. (`FORCE` is the gate's label override; it is unrelated to Stryker's own `--force` incremental-rebuild flag) |
| `REQUIRE_BASELINE` | `true` | incremental mode only: missing incremental file means loud-skip, never a surprise full campaign |
| `STRYKER_CMD` | `node_modules/.bin/stryker run` | how to spawn Stryker |
| `EXTRA_ARGS` | empty | appended to the Stryker invocation (e.g. `--concurrency 4` once measured; see Threshold rationale) |
| `REPORT` | `reports/mutation/mutation.json` | where the JSON report lands (the reporter's verified default) |

**Flow, `changed` mode:**

1. Resolve the diff base as `git merge-base $BASE HEAD` and take `git diff --name-status -z <merge-base> HEAD`. Kept for mutation: added, modified, and renamed (new path) files. Deleted paths are retained for step 3 before being dropped from the mutate set. Rename records in `-z` output are three-field (`R<score>\0old\0new\0`); the parser handles them explicitly and a rename fixture is a required test case, since a status/path-alternating parser silently mis-pairs everything after the first rename.
2. Intersect with the `mutate` globs via a built-in matcher supporting `**`, `*`, `?`, `{a,b}`, and leading-`!` negation. That subset covers offbook's globs exactly. An unsupported pattern (e.g. Stryker's extglob defaults) is detected and refused with "set `MUTATION_GATE_GLOBS`", never silently mismatched. Path normalization must match Stryker's minimatch behavior (repo-relative POSIX paths, `dot: false`).
3. Apply the test-sibling rule to changed **and deleted** test files (strip the `.test`/`.spec` segment, include the sibling if it exists **at HEAD, i.e. in the PR's tree**, and matches the globs). Existence-at-HEAD is what keeps a legitimately removed module honest: a PR deleting both `X.test.ts` and `X.ts` derives a sibling that no longer exists, so nothing is included and Stryker is never handed a nonexistent path. Deleting `src/engine/scheduler.test.ts` is the maximal test-weakening event, and it must pull `scheduler.ts` into the mutate set; the adversarial review confirmed the earlier drop-deletions-first ordering let it evade the gate entirely. An empty resulting set passes green ("no mutable files changed").
4. Size decision: sum the files' line counts. Over `THRESHOLD_LINES` (or `SKIP` set) is a loud skip, green with a notice. Under (or `FORCE` set) proceeds.
5. Run `$STRYKER_CMD --mutate <comma-joined list>` with reporters `clear-text,progress,json,html`. The CLI `--mutate` overrides the conf's globs; the conf file is never modified (verified: CLI arrays replace conf arrays wholesale).
6. Interpret the JSON report in the script, over the full status enum (`Killed`, `Survived`, `NoCoverage`, `Timeout`, `CompileError`, `RuntimeError`, `Ignored`, `Pending`): **detected = Killed + Timeout; undetected = Survived + NoCoverage; valid = detected + undetected; score = 100 x detected / valid, defined as 100 when valid = 0.** This is Stryker's own metric, and the D-011 reading (its 100% includes 2 timeouts). `Ignored`, `CompileError`, `RuntimeError`, and `Pending` never enter the verdict but are counted in the summary, so an error-heavy run is visible without red-ing an innocent PR. Score below `BREAK` fails; the failure output lists each undetected mutant as `file:line mutatorName` plus the kill-or-annotate instruction. A nonzero Stryker exit with no report is an infra failure, reported distinctly from a gate verdict.

**Flow, `incremental` mode:** steps 1-4 run identically (the diff still drives the size decision and labels), but step 5 becomes `$STRYKER_CMD --incremental --incrementalFile <path>` (default `reports/stryker-incremental.json`, the verified Stryker default) with no `--mutate` override: Stryker's own change detection picks the mutants, which also catches test-only weakening. Missing baseline with `REQUIRE_BASELINE=true` loud-skips. The break threshold then applies to the full-scope score, so incremental adopters set `BREAK` to their earned level. Two documented caveats for adopters: Stryker documents incremental as an approximation (schedule periodic full runs), and **the line-count skip heuristic does not bound incremental work**: Stryker's invalidation is its own diffing, so a small change to a shared test helper can invalidate arbitrarily many mutants and run toward the timeout under a tiny-diff green light. Baseline production (a main-push or scheduled job saving the incremental file via `actions/cache`) ships as a commented-out job in the workflow file.

**Outputs:** exit 0 (pass or loud skip), 1 (gate failure), 2 (infra failure). The script writes a Markdown block to `GITHUB_STEP_SUMMARY` and sets `decision`/`summary` via `GITHUB_OUTPUT` for the comment step. Local preflight: `node scripts/mutation-gate.mjs` on a branch (the `BASE` default resolves `origin/HEAD`).

## The workflow

Condensed sketch; exact action majors verified at implementation time:

```yaml
name: mutation
on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, labeled, unlabeled]
concurrency:
  group: mutation-${{ github.event.pull_request.number }}
  cancel-in-progress: true
permissions:
  contents: read
  pull-requests: write   # sticky comment
jobs:
  mutation:
    runs-on: ubuntu-latest
    timeout-minutes: 15   # backstop against a mispredicted run
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha }}  # the PR as authored, not the synthetic merge ref
          fetch-depth: 0                                  # all branches: merge-base needs the real base branch
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.3.14" } # same pin rationale as gates
      - uses: actions/setup-node@v5
        with: { node-version: "24" }    # Stryker CLI host (D-010; engines >=20, but 20 is EOL and local practice is 24)
      - run: bun install --frozen-lockfile
      - name: gate
        id: gate
        env:
          MUTATION_GATE_BASE: origin/${{ github.event.pull_request.base.ref }}  # the branch, never the payload SHA
          MUTATION_GATE_FORCE: ${{ contains(github.event.pull_request.labels.*.name, 'mutate-force') && '1' || '' }}
          MUTATION_GATE_SKIP:  ${{ contains(github.event.pull_request.labels.*.name, 'mutate-skip')  && '1' || '' }}
        run: node scripts/mutation-gate.mjs
      - name: sticky comment
        if: always() && steps.gate.outputs.decision != ''
        continue-on-error: true   # fork PRs get a read-only token; the verdict is the gate step's alone
        env: { GH_TOKEN: ${{ github.token }} }
        run: # upsert one comment marked <!-- mutation-gate -->, via gh api
      - name: report artifact
        if: failure()
        uses: actions/upload-artifact@v7
        with: { name: mutation-report, path: reports/mutation/, retention-days: 14, if-no-files-found: ignore }
```

Notes:

- **Diff-base correctness is a design decision, not an implementation accident.** `pull_request.base.sha` in the event payload can be stale when the base branch has moved, and the default checkout is the synthetic merge ref; the adversarial review demonstrated that combination making the gate see base-branch commits as PR changes, inflating the size sum and failing open via loud-skip exactly when main is busy. Hence: check out the PR **head SHA**, fetch all branches, and merge-base against `origin/<base branch>`. Testing the PR as authored (not merged with latest main) is safe here because the D-017 ruleset already requires branches to be up to date with main before merging.
- The decision logic runs inside an always-starting job, so the required check always reports one of: pass, loud-skip (green), gate-fail, infra-fail. No job-level `if:`, no skipped-check ambiguity. A green loud-skip satisfying a required check is standard GitHub semantics (verified).
- **Accepted cost**: any label add or remove, including unrelated labels, re-runs the job, and `cancel-in-progress` kills an in-flight campaign. A label-name filter was considered and rejected: the always-report property is load-bearing, and offbook's label traffic is negligible. Adopters with chatty label automation are pointed at this note.
- The sticky comment is upserted (found by the HTML sentinel, edited in place): posted on skip or fail, updated to the pass state if it already exists, never duplicated across `synchronize` events. The step never carries the verdict (`continue-on-error: true`), so a fork PR's read-only token cannot red the check for infra reasons.
- The report artifact uploads only on failure (that is when the HTML drill-down earns its keep; the full engine report is ~850 KB, a scoped run smaller). Adopters wanting it on every run flip the step to `if: always()`; the step is self-contained and deletable.
- For adopters, the file carries a header comment: replace the toolchain setup steps (a Node-only project drops setup-bun and uses `npm ci`), keep the rest; set the env knobs as needed.
- One-time setup: add `mutation` to the `main` ruleset's required checks alongside `gates` (admin bypass unchanged), and create the `mutate-force`/`mutate-skip` labels.

## Threshold rationale

Engine's mutable source is 917 lines across 7 files and produced 461 mutants in the D-011 campaign (427 non-ignored + 34 ignored), about 0.5 mutants per line. The largest single file (`index.ts`, 363 lines) bounds the smallest usable threshold: below ~400, a single-file PR to the biggest engine file could never be gated.

The conf pins `concurrency: 1`, and the gate inherits it unless overridden, so the naive arithmetic (800 lines ≈ 400 mutants inside 15 minutes) is over an unmeasured **serial** pipeline: one fresh `bun test` process per mutant plus the initial dry run. The old coverage-tooling design note ("requires `--concurrency 1`") predates the installed runner 1.3.8, whose README documents parallel workers, but perTest coverage under parallel workers has never been verified in this repo. Resolution: the e2e rehearsal measures mutants-per-minute at concurrency 1 **and** 4 on the actual runner; the winning setting (applied via `MUTATION_GATE_EXTRA_ARGS`) and the re-derived `THRESHOLD_LINES` default are recorded in D-027. `THRESHOLD_LINES=800` and `timeout-minutes: 15` are provisional until that measurement. The timeout stays the hard backstop either way.

## Edge cases

- **Shallow history** (no merge-base): infra-fail naming the fix (`fetch-depth: 0`), never a false pass.
- **Renames** gate the new path; the three-field `-z` record is parsed explicitly (see flow step 1).
- **Deleted test files** pull their sibling source into the mutate set (see flow step 3); other deletions are dropped.
- **Zero mutants in the selected files** (everything annotated): pass, with a "0 mutants" note. The script never invokes Stryker with an empty `--mutate` list (the empty set passes before spawning).
- **Test helpers, config, `package.json` changes** do not trigger the gate. Accepted residual risk, documented; incremental mode is the answer for projects that care.
- **Stryker crash vs. clean run** is distinguished by report presence; the verdict is computed from the JSON report and exit codes only, never from printed text.
- **Unsupported glob pattern** in the conf: refused loudly with the `MUTATION_GATE_GLOBS` remedy.
- **Windows runners**: out of scope, documented (the script assumes POSIX paths from git and a POSIX spawn of `node_modules/.bin/stryker`).

## Repo integration

- `DECISIONS.md`: new **D-027** recording the gate (mechanism, diff-base decision, score formula, thresholds and the measured runner rate, labels, artifact policy, portability intent), amending D-010's "never a gate" and D-017's "excluded from CI in any form". Two explicit caveat sentences: the gate excludes `Ignored`, so a `// Stryker disable` annotation silences a survivor and annotation *quality* (the unobservability argument, D-011) remains human review; and a Stryker or runner bump can change the mutant set, so a full D-011 campaign runs after any such bump before engine PRs resume, else the next innocent PR inherits the drift.
- `AGENTS.md` working notes: the "manual and never a gate" line becomes "manual full campaigns plus a changed-file PR gate"; labels, the loud-skip behavior, and the post-bump full-campaign rule get one line each.
- `bun run mutate` and the local full-campaign workflow (D-011 hygiene) are untouched.
- No new `R-###`; no `check-docs` changes. (Verified during review: `check-docs` is green with this spec referencing D-027, which is the contiguous next id.)
- Biome excludes `scripts/` entirely (`biome.json`), so the `.mjs` gets no lint coverage; correctness relies on its unit tests and the e2e rehearsal, and `bun run lint` makes no claim about it.

## Out of scope

- Widening offbook's `mutate` globs beyond `src/engine/` (module-by-module follow-ups, each behind its own campaign).
- An offbook-side incremental baseline or scheduled full mutation runs (documented as adopter opt-ins only).
- Changed-line mutation ranges.
- Non-GitHub CI and Windows support.
- Any change to the `gates` workflow, the coverage floors, or Biome's `scripts/` exclusion.

## Verification

- Unit tests green under full `bun test` (per-file coverage floors judge the `.mjs`; gate on exit code, not printed counts). Required fixtures: a rename record (`R100`, three-field), a deleted-test-file diff that must pull the sibling source, its counterpart deleting both test and source that must pull nothing (existence-at-HEAD), and a report JSON exercising every status in the enum including the zero-valid case.
- E2E rehearsal on a scratch branch: plant a surviving mutant in an engine file; the `mutation` check goes red naming exactly that mutant; kill it; the check goes green. Set `THRESHOLD_LINES=1` on a test run to exercise the loud-skip path cheaply; toggle `mutate-force`/`mutate-skip` and confirm the decision flips without a push. Measure mutants-per-minute at concurrency 1 and 4 (see Threshold rationale) and record both in D-027.
- Sticky comment: exactly one comment across multiple pushes; artifact appears on the red run only.
- `bun scripts/check-docs.ts`, `bun run typecheck`, and full `bun test` all green after the doc and script edits (`bun run lint` is unaffected by design: Biome excludes `scripts/`).
- Ruleset: PR merge blocked while `mutation` is red; loud-skip satisfies the check; admin bypass still works.
