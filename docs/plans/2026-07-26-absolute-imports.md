# Absolute Internal Imports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every upward-reaching relative import (`../…`) with Node subpath imports (`#src/…`, `#scripts/…`) declared in `package.json`, enforced by a grep-gate test.

**Architecture:** One `imports` field in `package.json` maps `#src/*` and `#scripts/*` to the real directories; Bun, tsc (`moduleResolution: "bundler"`), and the Stryker sandbox all resolve it by spec, so no other config changes. A new `test/import-style.test.ts` (same shape as `test/transport-isolation.test.ts`) makes the convention a gate. The 54 existing parent-relative import lines are rewritten mechanically.

**Tech Stack:** Bun (runtime + test), TypeScript 5.6 (`tsc --noEmit`), Biome 1.9, Stryker (manual verification only).

**Spec:** `docs/superpowers/specs/2026-07-26-absolute-imports-design.md` (approved 2026-07-26).

## Global Constraints

- Bun is the only runtime: tests via `bun test`, scripts via `bun scripts/<file>.ts`, CLI via `bun bin/offbook`. Node (via `nvm use default`) exists only to host the Stryker CLI in Task 4.
- The aliases are exactly `"#src/*": "./src/*"` and `"#scripts/*": "./scripts/*"` in the `package.json` `imports` field. Do NOT touch `tsconfig.json`; never add tsconfig `paths` (one alias system only, per spec).
- Convention: imports that reach upward (anything that would need `../`) use the alias; same-directory and downward imports stay relative (`./scheduler.ts`, `./sub/helper.ts`). Explicit `.ts` extensions everywhere, unchanged.
- Full `bun test` is the authoritative gate. A focused run (`bun test <one-file>`) may exit 1 with ZERO test failures because of the per-file coverage floor in `bunfig.toml`; on focused runs trust the printed fail count, gate on full runs only.
- `bun scripts/check-docs.ts` must pass before every commit (it is the pre-commit gate).
- Commit exactly at the plan's commit steps, no others. Never run `git config user.*`. Do NOT add any Co-Authored-By or AI-attribution trailer to commits.
- Do not modify the transport-isolation rules (Biome `noRestrictedImports` for `aedes`, `test/transport-isolation.test.ts`); they match the `aedes` specifier string and are unaffected by internal aliases.

## File Structure

- Create: `test/import-style.test.ts` (the grep gate; only new source file)
- Modify: `package.json` (add `imports` field)
- Modify (mechanical rewrite, 29 files / 54 lines): 25 files under `src/`, `test/m0-acceptance.test.ts`, `test/spikes/jsf-fidelity.test.ts`, `scripts/spike-jsf-fidelity.ts`, `bin/offbook`
- Modify: `DECISIONS.md` (append D-013), `AGENTS.md` (one working-notes line), possibly `docs/specs/*.md` (sweep)

---

### Task 1: Guardrail test (red)

**Files:**
- Create: `test/import-style.test.ts`

**Interfaces:**
- Consumes: nothing (reads the repo tree with `node:fs`; no project imports).
- Produces: the failing gate that Task 2 turns green. Test name: `"no parent-relative imports outside the subpath aliases"`. Task 2 commits this file; do not commit in this task (the suite must stay green on main).

- [ ] **Step 1: Write the failing test**

Create `test/import-style.test.ts` (tab-indented, matching `test/transport-isolation.test.ts`):

```ts
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

// Upward-reaching imports must use the #src/ or #scripts/ aliases from
// package.json "imports"; same-directory and downward ./ stay relative.
const PARENT_RELATIVE = /from ["']\.\.\//;

test("no parent-relative imports outside the subpath aliases", () => {
	const offenders = ["src", "test", "scripts", "bin"]
		.flatMap(walk)
		.filter((p) => p.endsWith(".ts") || p.startsWith("bin/"))
		.filter((p) => PARENT_RELATIVE.test(readFileSync(p, "utf8")));
	expect(offenders).toEqual([]);
});
```

Notes: `bun test` runs with cwd at the repo root (transport-isolation relies on this too). The `bin/` branch of the filter exists because `bin/offbook` has no `.ts` extension but does contain an internal import. The regex does not match this file's own source (after `from ` in the regex literal comes `[`, not a quote).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/import-style.test.ts`
Expected: 1 fail, exit 1. The assertion diff lists 29 offender paths: 25 under `src/`, plus `test/m0-acceptance.test.ts`, `test/spikes/jsf-fidelity.test.ts`, `scripts/spike-jsf-fidelity.ts`, `bin/offbook`. If the offender list differs, STOP and re-check the filter, do not proceed.

Do not commit yet; Task 2's commit includes this file so main never carries a red test.

---

### Task 2: Alias mapping, migration, green gate

**Files:**
- Modify: `package.json` (after the `"bin"` block)
- Modify: the 29 offender files from Task 1 (mechanical rewrite)
- Test: `test/import-style.test.ts` (from Task 1, turns green)

**Interfaces:**
- Consumes: Task 1's test (name above) as the red/green signal.
- Produces: the `#src/*` and `#scripts/*` specifiers used everywhere from now on; Task 3 documents them, Task 4 exercises them in the Stryker sandbox.

- [ ] **Step 1: Add the imports field to package.json**

In `package.json`, insert the `imports` field between the `"bin"` block and `"scripts"`:

```json
	"bin": {
		"offbook": "bin/offbook"
	},
	"imports": {
		"#src/*": "./src/*",
		"#scripts/*": "./scripts/*"
	},
	"scripts": {
```

- [ ] **Step 2: Rewrite the 44 src/ lines**

All parent-relative imports under `src/` are exactly one level up (`../<mod>/…`), so one substitution suffices:

Run: `grep -rl 'from "\.\./' src --include='*.ts' | xargs sed -i 's|from "\.\./|from "#src/|g'`

(The repo is Biome-formatted: every import uses double quotes, so the double-quote-only pattern is complete.)

- [ ] **Step 3: Rewrite test/, scripts/, bin/**

Run (deeper pattern first so `../../scripts/` is not half-eaten by the `../src/` rule):

```bash
sed -i 's|from "\.\./\.\./scripts/|from "#scripts/|g' test/spikes/jsf-fidelity.test.ts
sed -i 's|from "\.\./src/|from "#src/|g' test/m0-acceptance.test.ts scripts/spike-jsf-fidelity.ts bin/offbook
```

- [ ] **Step 4: Verify zero parent-relative imports remain**

Run: `grep -rn 'from "\.\./' src test scripts bin/offbook`
Expected: no output, exit code 1 (grep found nothing).

- [ ] **Step 5: Run the guardrail test to verify it passes**

Run: `bun test test/import-style.test.ts`
Expected: 1 pass, 0 fail, exit 0. (This focused run imports no `src/` files, so the per-file coverage floor has nothing to judge.)

- [ ] **Step 6: Full test suite**

Run: `bun test`
Expected: 0 fail, exit 0. This is the authoritative run: every rewritten import resolves here or the suite errors with `Could not resolve: "#src/…"`. The coverage gate prints nothing on failure; exit 0 is the signal.

- [ ] **Step 7: Format and lint**

Run: `bunx biome check --write . && bun run lint`
Expected: both exit 0. Biome's import organizer may reorder the new `#…` specifiers; `--write` settles it. (Biome ignores `scripts/`, and `bin/offbook` has no extension, so neither is touched; that is fine.)

- [ ] **Step 8: Type-check**

Run: `bunx tsc --noEmit`
Expected: no output, exit 0. (`resolvePackageJsonImports` is on by default under `moduleResolution: "bundler"`.)

- [ ] **Step 9: Runtime smoke for bin/offbook**

`bin/offbook` is outside tsc's reach (no `.ts` extension) and no test executes it, so prove its rewritten import at runtime:

Run: `bun bin/offbook topics`
Expected: the thermostat demo topic listing (topics like `state/thermostat-1` with field lines and an example), exit 0. Failure mode being ruled out: `Could not resolve: "#src/cli/index.ts"`.

- [ ] **Step 10: Doc gate**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 32 requirements, 12 decisions, 0 intake file(s).`

- [ ] **Step 11: Commit**

```bash
git add package.json test/import-style.test.ts src test scripts bin/offbook
git commit -m "refactor: adopt subpath imports (#src, #scripts) for upward-reaching internal imports"
```

No trailers.

---

### Task 3: Ledger entry, AGENTS.md note, spec sweep

**Files:**
- Modify: `DECISIONS.md` (append after D-012)
- Modify: `AGENTS.md` (one line in `## Working notes`)
- Modify: any `docs/specs/*.md` hit by the sweep in Step 3 (possibly none)

**Interfaces:**
- Consumes: the convention and gate shipped in Tasks 1 and 2 (referenced by name in the doc text below).
- Produces: D-013, cited by any future import-related decision.

- [ ] **Step 1: Append D-013 to DECISIONS.md**

The ledger is append-only; add this after the D-012 entry, matching the existing entry format exactly:

```markdown
### D-013: Absolute internal imports via package.json subpath imports
**Date**: 2026-07-26
**What**: Internal imports that reach upward (anything that would need `../`) use Node subpath imports declared in the `package.json` `imports` field: `#src/*` → `./src/*`, `#scripts/*` → `./scripts/*`. Same-directory and downward imports stay relative, with explicit `.ts` extensions as before. Applies across `src/`, `test/`, `scripts/`, and `bin/offbook`; enforced by the grep gate `test/import-style.test.ts`. tsconfig `paths` is permanently excluded alongside this: one alias system only.
**Why**: Refactor safety (moving an importing file no longer breaks that file's own imports) and one uniform, exactly-greppable specifier per file. Subpath imports are resolved by spec in every Node-compatible resolver the repo uses (Bun runtime and `bun test`, tsc under `moduleResolution: "bundler"`, and the Stryker sandbox, where `#` resolves against the sandbox's copied `package.json`); tsconfig `paths` would couple runtime module resolution to tsconfig-aware tools and was rejected.
**From**: docs/superpowers/specs/2026-07-26-absolute-imports-design.md (design dialog, 2026-07-26)
**Folds into**: AGENTS.md (working notes)
```

- [ ] **Step 2: Add the AGENTS.md working note**

Append this bullet to the `## Working notes` list in `AGENTS.md`:

```markdown
- **Internal imports**: upward reaches (anything needing `../`) use `#src/…`/`#scripts/…` (package.json `imports`); same-directory and downward stay relative, explicit `.ts` extensions. Enforced by `test/import-style.test.ts` (D-013).
```

- [ ] **Step 3: Sweep docs/specs/ for stale relative-import examples**

Run: `grep -rn "from [\"']\.\./" docs/specs`
Expected: likely no output. If a hit is a code example depicting an internal project import, rewrite it with the Task 2 rules (`../<mod>/…` → `#src/<mod>/…`); if it depicts something else (third-party or illustrative non-Offbook code), leave it. `docs/superpowers/specs/` is exempt: the design spec's migration section intentionally shows the old form.

- [ ] **Step 4: Doc gate**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 32 requirements, 13 decisions, 0 intake file(s).` (decision count now 13; anything else means the D-013 entry is malformed).

- [ ] **Step 5: Commit**

```bash
git add DECISIONS.md AGENTS.md docs/specs
git commit -m "docs: D-013 subpath-import convention; AGENTS.md working note"
```

No trailers.

---

### Task 4: Stryker sandbox resolution check (manual, no commit)

**Files:** none modified. Do NOT commit anything from this task (`reports/` and `.stryker-tmp/` stay out of git).

**Interfaces:**
- Consumes: the migrated imports from Task 2.
- Produces: evidence that `#` specifiers resolve inside the `.stryker-tmp` sandbox, the one resolver no normal test run exercises. This is verification only; mutation testing stays manual and non-gating (D-010/D-011 unchanged).

- [ ] **Step 1: Put a Node >= 20 on PATH**

Run: `nvm use default`
Expected: Node 24 active (`node --version` → `v24.x`). The Stryker CLI process needs Node; the test runner plugin still drives `bun test`.

- [ ] **Step 2: Focused mutation run**

Run: `./node_modules/.bin/stryker run --mutate "src/engine/prng.ts"`
Expected: the run completes with a clear-text mutation table for `prng.ts` (a few minutes; `concurrency` is 1). Success criterion is ONLY resolution: the initial dry run must pass and no test-run output may contain `Could not resolve` / `Cannot find module` for a `#src/` or `#scripts/` specifier. Mutant kill/survive counts are informational here, not this task's concern.

If the process seems stalled, do not wait on stdout: check that `reports/mutation/` or the Stryker log file is still getting fresh mtimes.

- [ ] **Step 3: Confirm clean tree**

Run: `git status --porcelain`
Expected: no output (nothing to commit; `reports/`/`.stryker-tmp/` are untracked-ignored). The plan is complete.
