# Changed-file mutation gate for PRs: design

**Date**: 2026-08-04
**Status**: approved design, not yet implemented
**Provenance**: brainstorm dialog 2026-08-04. Engine size figures measured during the dialog (`wc -l`; D-011 campaign counts). Stryker CLI spellings (`--mutate` override, `--incremental`, `--incrementalFile`, JSON reporter output path) are to be verified against the installed `@stryker-mutator/core` 9.6.1 during implementation.

## Problem

Mutation testing is manual and never a gate (D-010), and D-017 excludes it from CI in any form. That leaves test-strength regressions invisible at merge time exactly where they are cheapest to catch: small PRs touching already-clean modules. A full-campaign CI gate is out of the question on GitHub Actions minutes grounds, and large refactors would hold a required check hostage for tens of minutes. Wanted: a PR gate that mutates only what the PR touched, is mandatory for small PRs, steps aside loudly for large ones, and is portable to other StrykerJS projects with minimal ceremony.

## Scope and stances (from the design dialog)

- **Gate width = the project's own `mutate` globs** (engine-only in offbook today). Widening the globs is a deferred, module-by-module follow-up: each module's glob lands only after that module passes a D-011-style kill-or-annotate campaign, so "survivor = red" stays true forever. Repo-wide expansion now was rejected (it would require six-plus campaigns as a prerequisite).
- **Pass = zero undetected mutants over the mutated set** (score 100, the D-011 reading). The break threshold is a knob so adopting projects can gate at 80 or 90 while they climb.
- **Large PRs get a loud skip**: the check goes green, but the job writes a step summary and a sticky PR comment naming the measured size, the threshold, and the nudge to run `bun run mutate` locally before merging. Two label overrides: `mutate-force` (run and block even over the threshold) and `mutate-skip` (a maintainer waves the gate off when the heuristic misfires). Force wins if both are present.
- **Portability shape: two copied files** (script + workflow), dependency-free, no cross-repo `uses:` coupling. A composite action in offbook and a shared-repo reusable workflow were considered and rejected for reachability coupling; either can wrap this script later without rework.
- **Mechanism: changed-file `--mutate` override** (whole files) for offbook, with **Stryker incremental mode as a script mode for adopters** (it also catches test-only weakening, at the price of baseline infrastructure). Changed-line ranges were rejected: weaker assertion (a PR deleting an assertion that covered unchanged neighboring lines would pass), fiddly diff mapping around moves, and unverified multi-range support.

## Components

1. **`scripts/mutation-gate.mjs`** (portable piece 1): single-file, dependency-free, plain JS, runs under Node 18+ or Bun, imports only `node:` builtins and nothing from the repo. All logic lives here. Pure functions are exported for testing; the CLI entry is guarded so importing runs nothing.
2. **`.github/workflows/mutation.yml`** (portable piece 2): a separate workflow, not a new `ci.yml` job, because it needs `labeled`/`unlabeled` trigger types (label toggles re-evaluate the gate without a push) and because the portable unit should be exactly two files. One job, check name `mutation`, added to the `main` ruleset as a second required check. The `gates` workflow is untouched.
3. **Doc integration (offbook-only)**: new decision **D-027** amending D-010 ("never a gate") and D-017 ("excluded from CI in any form"), plus the AGENTS.md working-notes update. **No new R-###**: like D-017's CI, this is repo infrastructure, decision-only; `check-docs` is unaffected.
4. **`scripts/mutation-gate.test.ts`** (offbook-only): unit tests over the exported functions (glob matcher, diff parsing, sibling derivation, size decision, report interpretation against fixture JSON). Must clear the bunfig per-file coverage floors, so the CLI entry stays thin (a tested `main()` behind the import guard).

## The script

Configuration is environment variables only (CI-native, no arg parser), prefixed `MUTATION_GATE_`:

| Knob | Default | Meaning |
|---|---|---|
| `MODE` | `changed` | `changed` (offbook) or `incremental` (adopters) |
| `BASE` | `origin/HEAD`, falling back to `main` | base ref/SHA; the workflow passes the PR base SHA explicitly, so the default serves local runs |
| `THRESHOLD_LINES` | `800` | summed whole-file line count of the mutate set, above which the gate loud-skips |
| `BREAK` | `100` | minimum mutation score over the mutated set; below it the gate fails |
| `CONFIG` | `stryker.conf.json` | Stryker config path, read for `mutate` globs |
| `GLOBS` | the conf's `mutate` | explicit glob override for projects whose patterns exceed the supported subset |
| `TEST_SIBLINGS` | `true` | a changed `X.test.ts`/`X.spec.ts` pulls in sibling `X.ts` when it exists and matches the globs |
| `FORCE` / `SKIP` | unset | set by the workflow from PR labels; `FORCE` wins if both |
| `REQUIRE_BASELINE` | `true` | incremental mode only: missing incremental file means loud-skip, never a surprise full campaign |
| `STRYKER_CMD` | `node_modules/.bin/stryker run` | how to spawn Stryker |
| `EXTRA_ARGS` | empty | appended to the Stryker invocation (e.g. `--concurrency 4`) |
| `REPORT` | `reports/mutation/mutation.json` | where the JSON report lands |

**Flow, `changed` mode:**

1. `git merge-base $BASE HEAD`, then `git diff --name-status -z <merge-base> HEAD`. Added, modified, and renamed (new path) files kept; deletions dropped.
2. Intersect with the `mutate` globs via a built-in matcher supporting `**`, `*`, `?`, `{a,b}`, and leading-`!` negation. That subset covers offbook's globs exactly. An unsupported pattern (e.g. Stryker's extglob defaults) is detected and refused with "set `MUTATION_GATE_GLOBS`", never silently mismatched.
3. Apply the test-sibling rule (strip the `.test`/`.spec` segment, include the sibling if it exists and matches the globs). An empty resulting set passes green ("no mutable files changed").
4. Size decision: sum the files' line counts. Over `THRESHOLD_LINES` (or `SKIP` set) is a loud skip, green with a notice. Under (or `FORCE` set) proceeds.
5. Run `$STRYKER_CMD --mutate <comma-joined list>` with reporters `clear-text,progress,json,html`. The CLI `--mutate` overrides the conf's globs; the conf file is never modified.
6. Interpret the JSON report in the script, not via Stryker's exit code: `Survived` + `NoCoverage` count as undetected, `Ignored` is excluded, score below `BREAK` fails. The failure output lists each undetected mutant as `file:line mutatorName` plus the kill-or-annotate instruction. A nonzero Stryker exit with no report is an infra failure, reported distinctly from a gate verdict.

**Flow, `incremental` mode:** steps 1–4 run identically (the diff still drives the size decision and labels), but step 5 becomes `$STRYKER_CMD --incremental --incrementalFile <path>` with no `--mutate` override: Stryker's own change detection picks the mutants, which also catches test-only weakening. Missing baseline with `REQUIRE_BASELINE=true` loud-skips. The break threshold then applies to the full-scope score, so incremental adopters set `BREAK` to their earned level. Stryker documents incremental as an approximation; adopters are advised to schedule periodic full runs. Baseline production (a main-push or scheduled job saving the incremental file via `actions/cache`) ships as a commented-out job in the workflow file.

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
        with: { fetch-depth: 0 }        # merge-base needs history
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.3.14" } # same pin rationale as gates
      - uses: actions/setup-node@v5
        with: { node-version: "20" }    # Stryker CLI host (D-010)
      - run: bun install --frozen-lockfile
      - name: gate
        id: gate
        env:
          MUTATION_GATE_BASE: ${{ github.event.pull_request.base.sha }}
          MUTATION_GATE_FORCE: ${{ contains(github.event.pull_request.labels.*.name, 'mutate-force') && '1' || '' }}
          MUTATION_GATE_SKIP:  ${{ contains(github.event.pull_request.labels.*.name, 'mutate-skip')  && '1' || '' }}
        run: node scripts/mutation-gate.mjs
      - name: sticky comment
        if: always() && steps.gate.outputs.decision != ''
        env: { GH_TOKEN: ${{ github.token }} }
        run: # upsert one comment marked <!-- mutation-gate -->, via gh api
      - name: report artifact
        if: failure()
        uses: actions/upload-artifact@v7
        with: { name: mutation-report, path: reports/mutation/, retention-days: 14, if-no-files-found: ignore }
```

Notes:

- The decision logic runs inside an always-starting job, so the required check always reports one of: pass, loud-skip (green), gate-fail, infra-fail. No job-level `if:`, no skipped-check ambiguity.
- The sticky comment is upserted (found by the HTML sentinel, edited in place): posted on skip or fail, updated to the pass state if it already exists, never duplicated across `synchronize` events.
- The report artifact uploads only on failure (that is when the HTML drill-down earns its keep; the full engine report is ~850 KB, a scoped run smaller). Adopters wanting it on every run flip the step to `if: always()`; the step is self-contained and deletable.
- For adopters, the file carries a header comment: replace the toolchain setup steps (a Node-only project drops setup-bun and uses `npm ci`), keep the rest; set the env knobs as needed.
- One-time setup: add `mutation` to the `main` ruleset's required checks alongside `gates` (admin bypass unchanged), and create the `mutate-force`/`mutate-skip` labels.

## Threshold rationale

Engine's mutable source is 917 lines across 7 files and produced 461 mutants in the D-011 campaign (427 non-ignored + 34 ignored), about 0.5 mutants per line. The largest single file (`index.ts`, 363 lines) bounds the smallest usable threshold: below ~400, a single-file PR to the biggest engine file could never be gated. Default `THRESHOLD_LINES=800` (~400 estimated mutants). The e2e rehearsal during implementation measures mutants-per-minute on the actual runner; the measured rate and any threshold adjustment are recorded in D-027. `timeout-minutes: 15` remains the hard backstop.

## Edge cases

- **Shallow history** (no merge-base): infra-fail naming the fix (`fetch-depth: 0`), never a false pass.
- **Renames** gate the new path; deletions are dropped.
- **Zero mutants in the selected files** (everything annotated): pass, with a "0 mutants" note. The script never invokes Stryker with an empty `--mutate` list (the empty set passes before spawning).
- **Test helpers, config, `package.json` changes** do not trigger the gate. Accepted residual risk, documented; incremental mode is the answer for projects that care.
- **Stryker crash vs. clean run** is distinguished by report presence; the verdict is computed from the JSON report and exit codes only, never from printed text.
- **Unsupported glob pattern** in the conf: refused loudly with the `MUTATION_GATE_GLOBS` remedy.
- **Windows runners**: out of scope, documented (the script assumes POSIX paths from git and a POSIX spawn of `node_modules/.bin/stryker`).

## Repo integration

- `DECISIONS.md`: new **D-027** recording the gate (mechanism, thresholds, labels, artifact policy, portability intent, measured runner rate), amending D-010's "never a gate" and D-017's "excluded from CI in any form". Keeps `bun scripts/check-docs.ts` green (contiguous ids).
- `AGENTS.md` working notes: the "manual and never a gate" line becomes "manual full campaigns plus a changed-file PR gate"; labels and the loud-skip behavior get one line each.
- `bun run mutate` and the local full-campaign workflow (D-011 hygiene) are untouched.
- No new `R-###`; no `check-docs` changes.

## Out of scope

- Widening offbook's `mutate` globs beyond `src/engine/` (module-by-module follow-ups, each behind its own campaign).
- An offbook-side incremental baseline or scheduled full mutation runs (documented as adopter opt-ins only).
- Changed-line mutation ranges.
- Non-GitHub CI and Windows support.
- Any change to the `gates` workflow or the coverage floors.

## Verification

- Unit tests green under full `bun test` (per-file coverage floors judge the `.mjs`; gate on exit code, not printed counts).
- E2E rehearsal on a scratch branch: plant a surviving mutant in an engine file; the `mutation` check goes red naming exactly that mutant; kill it; the check goes green. Set `THRESHOLD_LINES=1` on a test run to exercise the loud-skip path cheaply; toggle `mutate-force`/`mutate-skip` and confirm the decision flips without a push.
- Sticky comment: exactly one comment across multiple pushes; artifact appears on the red run only.
- `bun scripts/check-docs.ts`, `bun run lint`, `bun run typecheck`, full `bun test` all green after the doc and script edits.
- Ruleset: PR merge blocked while `mutation` is red; loud-skip satisfies the check; admin bypass still works.
