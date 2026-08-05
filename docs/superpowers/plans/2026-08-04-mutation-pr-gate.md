# Changed-File Mutation PR Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A required `mutation` PR check that runs StrykerJS over exactly the files a PR touched, fails on any undetected mutant, loud-skips over a size threshold with label overrides, and ships as two copy-able files for other StrykerJS projects.

**Architecture:** One dependency-free `scripts/mutation-gate.mjs` (pure functions + an orchestrating `main(deps)` with injected I/O) invoked by a self-contained `.github/workflows/mutation.yml`. The verdict comes from Stryker's JSON report, never its exit code. Spec: `docs/superpowers/specs/2026-08-04-mutation-pr-gate-design.md` (read it before starting; it is the authority on "why").

**Tech Stack:** Bun 1.3.14 (tests, CI), Node 24 (Stryker CLI host), `@stryker-mutator/core` 9.6.1 + `@hughescr/stryker-bun-runner` (already installed), GitHub Actions + `gh`.

## Global Constraints

- Branch: all work on `mutation-pr-gate` (already exists, has the spec commits).
- `scripts/mutation-gate.mjs` is dependency-free: imports only `node:` builtins, nothing from the repo; runs under Node 18+ and Bun; assumes POSIX paths and repo-root cwd; `MUTATION_GATE_STRYKER_CMD` is split on spaces (no spaces in paths).
- The CLI entry guard is `realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)`. Never `import.meta.main` (absent before Node 24; the failure mode is a silent no-op green gate).
- Score formula (fixed by spec): detected = `Killed` + `Timeout`; undetected = `Survived` + `NoCoverage`; valid = detected + undetected; score = 100 × detected / valid; score = 100 when valid = 0. `Ignored`, `CompileError`, `RuntimeError`, `Pending` never enter the verdict but are counted. Unknown status = throw.
- Defaults: `MUTATION_GATE_BREAK=100`, `MUTATION_GATE_THRESHOLD_LINES=800` (provisional until Task 10's measurement), report at `reports/mutation/mutation.json`, incremental file at `reports/stryker-incremental.json`.
- Exit codes: 0 pass/skip, 1 gate failure, 2 infra failure.
- No new packages. No changes to `stryker.conf.json`, `bunfig.toml`, `biome.json`, `.github/workflows/ci.yml`, or the coverage floors.
- **Focused `bun test scripts/mutation-gate.test.ts` may exit 1 with ZERO failing tests** (the bunfig per-file coverage floor judges partially-imported files). For the red/green TDD steps below, judge by the printed fail count. Gate every commit on full `bun test` exit 0 (`bun test; echo "exit=$?"`), which is authoritative (AGENTS.md).
- Stryker's CLI host needs Node >= 20 on PATH locally: run `nvm use default` (Node 24) once per shell before any step that spawns Stryker.
- Doc edits must keep `bun scripts/check-docs.ts` exit 0.
- Commits: imperative house style (`feat: ...`, `docs: ...`, `ci: ...`). Never add Co-Authored-By or any AI-attribution trailer.
- `scripts/` is excluded from Biome and from tsconfig `include`; do not "fix" that. Lint/typecheck make no claims about these files; the tests and rehearsal are the safety net.

---

### Task 1: Diff parsing and line counting

**Files:**
- Create: `scripts/mutation-gate.mjs`
- Create: `scripts/mutation-gate.test.ts`

**Interfaces:**
- Produces: `parseNameStatusZ(raw: string) -> { changed: string[], deleted: string[] }` (throws on unhandled status); `countLines(content: string) -> number`. Task 7 consumes both.

- [ ] **Step 1: Write the failing tests**

Create `scripts/mutation-gate.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseNameStatusZ, countLines } from "./mutation-gate.mjs";

test("parseNameStatusZ splits adds/modifies from deletes", () => {
  const raw = "A\0src/engine/new.ts\0M\0src/engine/dispatch.ts\0D\0src/engine/old.test.ts\0";
  expect(parseNameStatusZ(raw)).toEqual({
    changed: ["src/engine/new.ts", "src/engine/dispatch.ts"],
    deleted: ["src/engine/old.test.ts"],
  });
});

test("parseNameStatusZ reads the three-field rename record and keeps the new path", () => {
  const raw = "R100\0src/engine/a.ts\0src/engine/b.ts\0M\0src/engine/c.ts\0";
  expect(parseNameStatusZ(raw)).toEqual({ changed: ["src/engine/b.ts", "src/engine/c.ts"], deleted: [] });
});

test("parseNameStatusZ handles copies and typechanges as changes", () => {
  const raw = "C75\0src/a.ts\0src/b.ts\0T\0src/c.ts\0";
  expect(parseNameStatusZ(raw)).toEqual({ changed: ["src/b.ts", "src/c.ts"], deleted: [] });
});

test("parseNameStatusZ throws on an unhandled status instead of mis-pairing the rest", () => {
  expect(() => parseNameStatusZ("U\0src/conflicted.ts\0")).toThrow('unhandled diff status "U"');
});

test("parseNameStatusZ of an empty diff is empty", () => {
  expect(parseNameStatusZ("")).toEqual({ changed: [], deleted: [] });
});

test("countLines counts content lines with and without trailing newline", () => {
  expect(countLines("")).toBe(0);
  expect(countLines("a\n")).toBe(1);
  expect(countLines("a\nb")).toBe(2);
  expect(countLines("a\nb\n")).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: failures (module `./mutation-gate.mjs` not found). Judge by printed failures, not exit code.

- [ ] **Step 3: Write the implementation**

Create `scripts/mutation-gate.mjs`:

```js
// mutation-gate: a changed-file StrykerJS mutation gate for PRs.
// Portable unit: this file + .github/workflows/mutation.yml (copy both).
// Spec: docs/superpowers/specs/2026-08-04-mutation-pr-gate-design.md
//
// Configuration (env, all optional):
//   MUTATION_GATE_MODE             changed (default) | incremental
//   MUTATION_GATE_BASE             base ref; default origin/HEAD, then main
//   MUTATION_GATE_THRESHOLD_LINES  loud-skip above this summed line count (800)
//   MUTATION_GATE_BREAK            minimum score, fail below it (100)
//   MUTATION_GATE_CONFIG           stryker config path (stryker.conf.json)
//   MUTATION_GATE_GLOBS            comma-separated mutate globs, overrides config
//   MUTATION_GATE_TEST_SIBLINGS    changed/deleted X.test.ts pulls X.ts (true)
//   MUTATION_GATE_FORCE            run + block even over threshold (labels)
//   MUTATION_GATE_SKIP             loud-skip regardless of size (labels; FORCE wins)
//   MUTATION_GATE_REQUIRE_BASELINE incremental: skip when baseline missing (true)
//   MUTATION_GATE_INCREMENTAL_FILE reports/stryker-incremental.json
//   MUTATION_GATE_STRYKER_CMD      node_modules/.bin/stryker run (split on spaces)
//   MUTATION_GATE_EXTRA_ARGS       appended to the stryker invocation
//   MUTATION_GATE_REPORT           reports/mutation/mutation.json
// Exit codes: 0 pass/skip, 1 gate failure (undetected mutants), 2 infra failure.

export function parseNameStatusZ(raw) {
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const changed = [];
  const deleted = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      changed.push(tokens[i + 2]);
      i += 3;
    } else if (kind === "D") {
      deleted.push(tokens[i + 1]);
      i += 2;
    } else if (kind === "A" || kind === "M" || kind === "T") {
      changed.push(tokens[i + 1]);
      i += 2;
    } else {
      throw new Error(`mutation-gate: unhandled diff status "${status}"`);
    }
  }
  return { changed, deleted };
}

export function countLines(content) {
  if (content === "") return 0;
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: 6 pass, 0 fail (exit code may still be 1 from the coverage floor; that is fine on focused runs).

- [ ] **Step 5: Full-suite gate and commit**

```bash
bun test; echo "exit=$?"    # expect exit=0
git add scripts/mutation-gate.mjs scripts/mutation-gate.test.ts
git commit -m "feat: mutation-gate diff parsing and line counting"
```

---

### Task 2: Glob subset matcher with loud refusal

**Files:**
- Modify: `scripts/mutation-gate.mjs` (append)
- Modify: `scripts/mutation-gate.test.ts` (append)

**Interfaces:**
- Produces: `UnsupportedGlobError` (Error subclass); `globToRegExp(pattern: string) -> RegExp` (throws `UnsupportedGlobError`); `matchesMutateGlobs(path: string, globs: string[]) -> boolean` (ordered, `!`-negation unsets). Tasks 3 and 7 consume `matchesMutateGlobs`.

- [ ] **Step 1: Write the failing tests** (append to `scripts/mutation-gate.test.ts`; extend the first import line with the new names)

```ts
import { globToRegExp, matchesMutateGlobs, UnsupportedGlobError } from "./mutation-gate.mjs";

test("offbook's real globs: engine source in, engine tests out, broker out", () => {
  const globs = ["src/engine/**/*.ts", "!src/engine/**/*.test.ts"];
  expect(matchesMutateGlobs("src/engine/scheduler.ts", globs)).toBe(true);
  expect(matchesMutateGlobs("src/engine/sub/dir/x.ts", globs)).toBe(true);
  expect(matchesMutateGlobs("src/engine/scheduler.test.ts", globs)).toBe(false);
  expect(matchesMutateGlobs("src/broker/index.ts", globs)).toBe(false);
});

test("** matches zero segments", () => {
  expect(globToRegExp("src/**/*.ts").test("src/index.ts")).toBe(true);
});

test("* stays inside one segment; ? matches exactly one char", () => {
  expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
  expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
});

test("single-level braces expand", () => {
  const re = globToRegExp("{src,lib}/a.ts");
  expect(re.test("src/a.ts")).toBe(true);
  expect(re.test("lib/a.ts")).toBe(true);
  expect(re.test("bin/a.ts")).toBe(false);
});

test("negation is ordered unset-on-match, later patterns win", () => {
  expect(matchesMutateGlobs("src/a.test.ts", ["src/**/*.ts", "!src/**/*.test.ts"])).toBe(false);
  expect(matchesMutateGlobs("src/a.test.ts", ["!src/**/*.test.ts", "src/**/*.ts"])).toBe(true);
});

test("extglobs, character classes, escapes, wildcards-in-braces are refused, never mis-matched", () => {
  for (const bad of ["src/!(*.test).ts", "src/[ab].ts", "src/a\\*.ts", "{src/*,lib}/a.ts"]) {
    expect(() => globToRegExp(bad)).toThrow(UnsupportedGlobError);
  }
});

test("regex metacharacters in glob literals are escaped (a dot is a dot)", () => {
  expect(globToRegExp("src/a.ts").test("src/axts")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: the 7 new tests fail (exports missing); the Task 1 tests still pass.

- [ ] **Step 3: Write the implementation** (append to `scripts/mutation-gate.mjs`)

```js
export class UnsupportedGlobError extends Error {
  constructor(pattern) {
    super(
      `mutation-gate: glob "${pattern}" uses syntax outside the supported subset ` +
        `(**, *, ?, {a,b}, leading !). Set MUTATION_GATE_GLOBS to equivalent simple globs.`,
    );
    this.name = "UnsupportedGlobError";
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function globToRegExp(pattern) {
  if (/[()[\]\\]/.test(pattern)) throw new UnsupportedGlobError(pattern);
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern.startsWith("**/", i)) {
        out += "(?:[^/]+/)*";
        i += 3;
      } else if (pattern.startsWith("**", i)) {
        out += ".*";
        i += 2;
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      const body = end === -1 ? "" : pattern.slice(i + 1, end);
      if (end === -1 || /[*?{]/.test(body)) throw new UnsupportedGlobError(pattern);
      out += `(?:${body.split(",").map(escapeRegExp).join("|")})`;
      i = end + 1;
    } else {
      out += escapeRegExp(ch);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesMutateGlobs(path, globs) {
  let included = false;
  for (const glob of globs) {
    const negated = glob.startsWith("!");
    const pattern = negated ? glob.slice(1) : glob;
    if (globToRegExp(pattern).test(path)) included = !negated;
  }
  return included;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: 13 pass, 0 fail.

- [ ] **Step 5: Full-suite gate and commit**

```bash
bun test; echo "exit=$?"    # expect exit=0
git add scripts/mutation-gate.mjs scripts/mutation-gate.test.ts
git commit -m "feat: mutation-gate glob subset matcher with loud refusal"
```

---

### Task 3: Sibling rule and mutate-set selection

**Files:**
- Modify: `scripts/mutation-gate.mjs` (append)
- Modify: `scripts/mutation-gate.test.ts` (append)

**Interfaces:**
- Consumes: `matchesMutateGlobs` (Task 2).
- Produces: `siblingOf(path: string) -> string | null`; `selectMutateSet({ changed, deleted, globs, testSiblings, exists }) -> string[]` (sorted, deduped; `exists: (path) => boolean` is existence **at HEAD**). Task 7 consumes `selectMutateSet`.

- [ ] **Step 1: Write the failing tests** (append; extend the import with `siblingOf, selectMutateSet`)

```ts
test("siblingOf derives the source next to a test file", () => {
  expect(siblingOf("src/engine/scheduler.test.ts")).toBe("src/engine/scheduler.ts");
  expect(siblingOf("src/engine/faker.spec.tsx")).toBe("src/engine/faker.tsx");
  expect(siblingOf("src/engine/scheduler.ts")).toBe(null);
});

const ENGINE_GLOBS = ["src/engine/**/*.ts", "!src/engine/**/*.test.ts"];

test("selectMutateSet keeps matching changed sources, drops the rest", () => {
  const files = selectMutateSet({
    changed: ["src/engine/dispatch.ts", "src/broker/index.ts", "README.md"],
    deleted: [],
    globs: ENGINE_GLOBS,
    testSiblings: true,
    exists: () => true,
  });
  expect(files).toEqual(["src/engine/dispatch.ts"]);
});

test("a changed test file pulls its existing sibling source", () => {
  const files = selectMutateSet({
    changed: ["src/engine/scheduler.test.ts"],
    deleted: [],
    globs: ENGINE_GLOBS,
    testSiblings: true,
    exists: (p) => p === "src/engine/scheduler.ts",
  });
  expect(files).toEqual(["src/engine/scheduler.ts"]);
});

test("a deleted test file pulls its surviving sibling (the test-deletion evasion)", () => {
  const files = selectMutateSet({
    changed: [],
    deleted: ["src/engine/scheduler.test.ts"],
    globs: ENGINE_GLOBS,
    testSiblings: true,
    exists: (p) => p === "src/engine/scheduler.ts",
  });
  expect(files).toEqual(["src/engine/scheduler.ts"]);
});

test("deleting module and test together pulls nothing (existence-at-HEAD)", () => {
  const files = selectMutateSet({
    changed: [],
    deleted: ["src/engine/gone.ts", "src/engine/gone.test.ts"],
    globs: ENGINE_GLOBS,
    testSiblings: true,
    exists: () => false,
  });
  expect(files).toEqual([]);
});

test("testSiblings=false disables the rule; output is deduped and sorted", () => {
  expect(
    selectMutateSet({
      changed: ["src/engine/scheduler.test.ts"],
      deleted: [],
      globs: ENGINE_GLOBS,
      testSiblings: false,
      exists: () => true,
    }),
  ).toEqual([]);
  expect(
    selectMutateSet({
      changed: ["src/engine/b.ts", "src/engine/a.ts", "src/engine/a.test.ts"],
      deleted: [],
      globs: ENGINE_GLOBS,
      testSiblings: true,
      exists: () => true,
    }),
  ).toEqual(["src/engine/a.ts", "src/engine/b.ts"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: the 6 new tests fail; all earlier tests pass.

- [ ] **Step 3: Write the implementation** (append to `scripts/mutation-gate.mjs`)

```js
export function siblingOf(path) {
  const m = path.match(/^(.*)\.(test|spec)(\.[^./]+)$/);
  return m ? `${m[1]}${m[3]}` : null;
}

export function selectMutateSet({ changed, deleted, globs, testSiblings, exists }) {
  const set = new Set();
  for (const path of changed) {
    if (matchesMutateGlobs(path, globs)) set.add(path);
  }
  if (testSiblings) {
    for (const path of [...changed, ...deleted]) {
      const sibling = siblingOf(path);
      if (sibling && exists(sibling) && matchesMutateGlobs(sibling, globs)) set.add(sibling);
    }
  }
  return [...set].sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: 19 pass, 0 fail.

- [ ] **Step 5: Full-suite gate and commit**

```bash
bun test; echo "exit=$?"    # expect exit=0
git add scripts/mutation-gate.mjs scripts/mutation-gate.test.ts
git commit -m "feat: mutation-gate sibling rule and mutate-set selection"
```

---

### Task 4: Env configuration and the size decision

**Files:**
- Modify: `scripts/mutation-gate.mjs` (append)
- Modify: `scripts/mutation-gate.test.ts` (append)

**Interfaces:**
- Produces: `DEFAULTS` (frozen object); `readConfig(env: Record<string, string | undefined>) -> cfg` with fields `mode, base, thresholdLines, breakScore, configPath, globsOverride, testSiblings, force, skip, requireBaseline, incrementalFile, strykerCmd (string[]), extraArgs (string[]), reportPath` (throws on non-numeric numbers); `decide({ files, totalLines, thresholdLines, force, skip }) -> "pass-empty" | "skip-label" | "skip-size" | "run"`. Task 7 consumes both.

- [ ] **Step 1: Write the failing tests** (append; extend the import with `DEFAULTS, readConfig, decide`)

```ts
test("decide: empty set passes, labels and threshold act, force wins over both", () => {
  expect(decide({ files: [], totalLines: 0, thresholdLines: 800, force: false, skip: false })).toBe("pass-empty");
  expect(decide({ files: ["a"], totalLines: 10, thresholdLines: 800, force: false, skip: false })).toBe("run");
  expect(decide({ files: ["a"], totalLines: 900, thresholdLines: 800, force: false, skip: false })).toBe("skip-size");
  expect(decide({ files: ["a"], totalLines: 10, thresholdLines: 800, force: false, skip: true })).toBe("skip-label");
  expect(decide({ files: ["a"], totalLines: 900, thresholdLines: 800, force: true, skip: true })).toBe("run");
});

test("readConfig defaults", () => {
  const cfg = readConfig({});
  expect(cfg.mode).toBe("changed");
  expect(cfg.base).toBeUndefined();
  expect(cfg.thresholdLines).toBe(800);
  expect(cfg.breakScore).toBe(100);
  expect(cfg.configPath).toBe("stryker.conf.json");
  expect(cfg.globsOverride).toBeUndefined();
  expect(cfg.testSiblings).toBe(true);
  expect(cfg.force).toBe(false);
  expect(cfg.skip).toBe(false);
  expect(cfg.requireBaseline).toBe(true);
  expect(cfg.incrementalFile).toBe("reports/stryker-incremental.json");
  expect(cfg.strykerCmd).toEqual(["node_modules/.bin/stryker", "run"]);
  expect(cfg.extraArgs).toEqual([]);
  expect(cfg.reportPath).toBe("reports/mutation/mutation.json");
});

test("readConfig parses overrides", () => {
  const cfg = readConfig({
    MUTATION_GATE_MODE: "incremental",
    MUTATION_GATE_BASE: "origin/develop",
    MUTATION_GATE_THRESHOLD_LINES: "200",
    MUTATION_GATE_BREAK: "90",
    MUTATION_GATE_GLOBS: "lib/**/*.js, !lib/**/*.spec.js",
    MUTATION_GATE_TEST_SIBLINGS: "false",
    MUTATION_GATE_FORCE: "1",
    MUTATION_GATE_EXTRA_ARGS: "--concurrency 4",
  });
  expect(cfg.mode).toBe("incremental");
  expect(cfg.base).toBe("origin/develop");
  expect(cfg.thresholdLines).toBe(200);
  expect(cfg.breakScore).toBe(90);
  expect(cfg.globsOverride).toEqual(["lib/**/*.js", "!lib/**/*.spec.js"]);
  expect(cfg.testSiblings).toBe(false);
  expect(cfg.force).toBe(true);
  expect(cfg.extraArgs).toEqual(["--concurrency", "4"]);
});

test("readConfig treats 0/false/no/empty as false for flags and rejects non-numbers", () => {
  expect(readConfig({ MUTATION_GATE_FORCE: "false" }).force).toBe(false);
  expect(readConfig({ MUTATION_GATE_SKIP: "0" }).skip).toBe(false);
  expect(readConfig({ MUTATION_GATE_TEST_SIBLINGS: "" }).testSiblings).toBe(true);
  expect(() => readConfig({ MUTATION_GATE_THRESHOLD_LINES: "many" })).toThrow("not a number");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: the 4 new tests fail; all earlier tests pass.

- [ ] **Step 3: Write the implementation** (append to `scripts/mutation-gate.mjs`)

```js
export const DEFAULTS = Object.freeze({
  mode: "changed",
  thresholdLines: 800,
  breakScore: 100,
  configPath: "stryker.conf.json",
  incrementalFile: "reports/stryker-incremental.json",
  strykerCmd: "node_modules/.bin/stryker run",
  reportPath: "reports/mutation/mutation.json",
});

const FALSY = new Set(["0", "false", "no"]);
const asBool = (v, dflt) => (v === undefined || v === "" ? dflt : !FALSY.has(v.toLowerCase()));
const asFlag = (v) => v !== undefined && v !== "" && !FALSY.has(v.toLowerCase());
const asNum = (v, dflt) => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`mutation-gate: not a number: "${v}"`);
  return n;
};
const asList = (v) =>
  v === undefined
    ? undefined
    : v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

export function readConfig(env) {
  return {
    mode: env.MUTATION_GATE_MODE || DEFAULTS.mode,
    base: env.MUTATION_GATE_BASE || undefined,
    thresholdLines: asNum(env.MUTATION_GATE_THRESHOLD_LINES, DEFAULTS.thresholdLines),
    breakScore: asNum(env.MUTATION_GATE_BREAK, DEFAULTS.breakScore),
    configPath: env.MUTATION_GATE_CONFIG || DEFAULTS.configPath,
    globsOverride: asList(env.MUTATION_GATE_GLOBS),
    testSiblings: asBool(env.MUTATION_GATE_TEST_SIBLINGS, true),
    force: asFlag(env.MUTATION_GATE_FORCE),
    skip: asFlag(env.MUTATION_GATE_SKIP),
    requireBaseline: asBool(env.MUTATION_GATE_REQUIRE_BASELINE, true),
    incrementalFile: env.MUTATION_GATE_INCREMENTAL_FILE || DEFAULTS.incrementalFile,
    strykerCmd: (env.MUTATION_GATE_STRYKER_CMD || DEFAULTS.strykerCmd).split(" ").filter(Boolean),
    extraArgs: (env.MUTATION_GATE_EXTRA_ARGS || "").split(" ").filter(Boolean),
    reportPath: env.MUTATION_GATE_REPORT || DEFAULTS.reportPath,
  };
}

export function decide({ files, totalLines, thresholdLines, force, skip }) {
  if (files.length === 0) return "pass-empty";
  if (force) return "run";
  if (skip) return "skip-label";
  if (totalLines > thresholdLines) return "skip-size";
  return "run";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: 23 pass, 0 fail.

- [ ] **Step 5: Full-suite gate and commit**

```bash
bun test; echo "exit=$?"    # expect exit=0
git add scripts/mutation-gate.mjs scripts/mutation-gate.test.ts
git commit -m "feat: mutation-gate env config and size decision"
```

---

### Task 5: Report interpretation (the verdict)

**Files:**
- Modify: `scripts/mutation-gate.mjs` (append)
- Modify: `scripts/mutation-gate.test.ts` (append)

**Interfaces:**
- Produces: `interpretReport(report, breakScore) -> { counts, undetected: [{file, line, mutator}], score, verdict: "pass" | "fail" }`. `report` is mutation-testing-report-schema JSON (`files.<path>.mutants[].{status, mutatorName, location.start.line}`). Task 7 consumes it. The test-file fixture builder `makeReport` is reused by Task 7's tests.

- [ ] **Step 1: Write the failing tests** (append; extend the import with `interpretReport`)

```ts
type FixtureMutant = { mutator: string; status: string; line?: number };
export function makeReport(mutantsByFile: Record<string, FixtureMutant[]>) {
  return {
    schemaVersion: "2",
    thresholds: { high: 80, low: 60 },
    files: Object.fromEntries(
      Object.entries(mutantsByFile).map(([file, mutants]) => [
        file,
        {
          language: "typescript",
          source: "",
          mutants: mutants.map((m, i) => ({
            id: String(i),
            mutatorName: m.mutator,
            status: m.status,
            location: { start: { line: m.line ?? 1, column: 1 }, end: { line: m.line ?? 1, column: 2 } },
          })),
        },
      ]),
    ),
  };
}

test("all killed passes at break 100; Timeout counts as detected (the D-011 reading)", () => {
  const r = interpretReport(
    makeReport({ "src/engine/a.ts": [{ mutator: "X", status: "Killed" }, { mutator: "X", status: "Timeout" }] }),
    100,
  );
  expect(r.score).toBe(100);
  expect(r.verdict).toBe("pass");
});

test("a survivor fails at break 100 and is listed as file:line mutator", () => {
  const r = interpretReport(
    makeReport({
      "src/engine/a.ts": [
        { mutator: "EqualityOperator", status: "Survived", line: 12 },
        { mutator: "StringLiteral", status: "Killed" },
      ],
    }),
    100,
  );
  expect(r.verdict).toBe("fail");
  expect(r.score).toBe(50);
  expect(r.undetected).toEqual([{ file: "src/engine/a.ts", line: 12, mutator: "EqualityOperator" }]);
});

test("NoCoverage is undetected; Ignored/CompileError/RuntimeError/Pending stay out of the verdict", () => {
  const r = interpretReport(
    makeReport({
      "a.ts": [
        { mutator: "X", status: "Killed" },
        { mutator: "X", status: "NoCoverage", line: 3 },
        { mutator: "X", status: "Ignored" },
        { mutator: "X", status: "CompileError" },
        { mutator: "X", status: "RuntimeError" },
        { mutator: "X", status: "Pending" },
      ],
    }),
    100,
  );
  expect(r.score).toBe(50);
  expect(r.verdict).toBe("fail");
  expect(r.undetected).toEqual([{ file: "a.ts", line: 3, mutator: "X" }]);
  expect(r.counts).toEqual({
    Killed: 1, Survived: 0, NoCoverage: 1, Timeout: 0, CompileError: 1, RuntimeError: 1, Ignored: 1, Pending: 1,
  });
});

test("an errors-only run scores 100 (zero valid mutants is a pass, not NaN)", () => {
  const r = interpretReport(makeReport({ "a.ts": [{ mutator: "X", status: "RuntimeError" }] }), 100);
  expect(r.score).toBe(100);
  expect(r.verdict).toBe("pass");
});

test("break below 100 tolerates survivors down to the threshold, exact score passes", () => {
  const twoOfThree = makeReport({
    "a.ts": [
      { mutator: "X", status: "Killed" },
      { mutator: "X", status: "Killed" },
      { mutator: "X", status: "Survived" },
    ],
  });
  expect(interpretReport(twoOfThree, 66).verdict).toBe("pass");
  expect(interpretReport(twoOfThree, 67).verdict).toBe("fail");
});

test("an unknown status throws (schema drift surfaces loudly)", () => {
  expect(() => interpretReport(makeReport({ "a.ts": [{ mutator: "X", status: "Vanished" }] }), 100)).toThrow(
    'unknown mutant status "Vanished"',
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: the 6 new tests fail; all earlier tests pass.

- [ ] **Step 3: Write the implementation** (append to `scripts/mutation-gate.mjs`)

```js
export function interpretReport(report, breakScore) {
  const counts = {
    Killed: 0, Survived: 0, NoCoverage: 0, Timeout: 0, CompileError: 0, RuntimeError: 0, Ignored: 0, Pending: 0,
  };
  const undetected = [];
  for (const [file, data] of Object.entries(report.files ?? {})) {
    for (const mutant of data.mutants) {
      if (!(mutant.status in counts)) {
        throw new Error(`mutation-gate: unknown mutant status "${mutant.status}"`);
      }
      counts[mutant.status] += 1;
      if (mutant.status === "Survived" || mutant.status === "NoCoverage") {
        undetected.push({ file, line: mutant.location.start.line, mutator: mutant.mutatorName });
      }
    }
  }
  const detected = counts.Killed + counts.Timeout;
  const valid = detected + counts.Survived + counts.NoCoverage;
  const score = valid === 0 ? 100 : (100 * detected) / valid;
  return { counts, undetected, score, verdict: score < breakScore ? "fail" : "pass" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: 29 pass, 0 fail.

- [ ] **Step 5: Full-suite gate and commit**

```bash
bun test; echo "exit=$?"    # expect exit=0
git add scripts/mutation-gate.mjs scripts/mutation-gate.test.ts
git commit -m "feat: mutation-gate report interpretation over the full status enum"
```

---

### Task 6: Summaries and GitHub outputs

**Files:**
- Modify: `scripts/mutation-gate.mjs` (append)
- Modify: `scripts/mutation-gate.test.ts` (append)

**Interfaces:**
- Consumes: `interpretReport`'s result shape (Task 5).
- Produces: `renderSkip({ decision, files, totalLines, thresholdLines }) -> string`; `renderResult({ files, result, breakScore }) -> string`; `renderInfra(message: string) -> string`; `formatGithubOutputs(outputs: Record<string, string>) -> string` (heredoc format). Task 7 consumes all four.

- [ ] **Step 1: Write the failing tests** (append; extend the import with the four names)

```ts
test("renderSkip names the numbers, the labels, and the local command", () => {
  const md = renderSkip({ decision: "skip-size", files: ["src/engine/index.ts"], totalLines: 950, thresholdLines: 800 });
  expect(md).toContain("skip-size");
  expect(md).toContain("950");
  expect(md).toContain("800");
  expect(md).toContain("bun run mutate");
  expect(md).toContain("mutate-force");
  expect(renderSkip({ decision: "pass-empty", files: [], totalLines: 0, thresholdLines: 800 })).toContain(
    "no mutable files changed",
  );
  expect(
    renderSkip({ decision: "skip-no-baseline", files: ["a.ts"], totalLines: 1, thresholdLines: 800 }),
  ).toContain("baseline");
});

test("renderResult on failure lists each undetected mutant with the kill-or-annotate instruction", () => {
  const result = {
    counts: { Killed: 1, Survived: 1, NoCoverage: 0, Timeout: 0, CompileError: 0, RuntimeError: 0, Ignored: 0, Pending: 0 },
    undetected: [{ file: "src/engine/a.ts", line: 12, mutator: "EqualityOperator" }],
    score: 50,
    verdict: "fail" as const,
  };
  const md = renderResult({ files: ["src/engine/a.ts"], result, breakScore: 100 });
  expect(md).toContain("fail");
  expect(md).toContain("50.00");
  expect(md).toContain("src/engine/a.ts:12");
  expect(md).toContain("EqualityOperator");
  expect(md).toContain("Stryker disable next-line");
});

test("renderResult on pass reports the score and mutant counts", () => {
  const result = {
    counts: { Killed: 3, Survived: 0, NoCoverage: 0, Timeout: 1, CompileError: 0, RuntimeError: 0, Ignored: 2, Pending: 0 },
    undetected: [],
    score: 100,
    verdict: "pass" as const,
  };
  const md = renderResult({ files: ["src/engine/a.ts"], result, breakScore: 100 });
  expect(md).toContain("pass");
  expect(md).toContain("100.00");
  expect(md).toContain("3 killed");
});

test("renderInfra says it is not a verdict", () => {
  expect(renderInfra("boom")).toContain("boom");
  expect(renderInfra("boom")).toContain("not a verdict");
});

test("formatGithubOutputs emits the heredoc form for each key", () => {
  expect(formatGithubOutputs({ decision: "fail", summary: "line1\nline2" })).toBe(
    "decision<<__MUTATION_GATE_EOF__\nfail\n__MUTATION_GATE_EOF__\n" +
      "summary<<__MUTATION_GATE_EOF__\nline1\nline2\n__MUTATION_GATE_EOF__\n",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: the 5 new tests fail; all earlier tests pass.

- [ ] **Step 3: Write the implementation** (append to `scripts/mutation-gate.mjs`)

```js
const SKIP_REASONS = {
  "pass-empty": "no mutable files changed; nothing to mutate.",
  "skip-size": "the change is over the size threshold for a CI mutation run.",
  "skip-label": "the mutate-skip label is set.",
  "skip-no-baseline": "incremental mode has no baseline incremental file; refusing a surprise full campaign.",
};

export function renderSkip({ decision, files, totalLines, thresholdLines }) {
  const lines = [`## mutation gate: ${decision}`, "", SKIP_REASONS[decision] ?? decision];
  if (decision !== "pass-empty") {
    lines.push(
      "",
      `Mutable files in this change: ${files.length} (${totalLines} lines; threshold ${thresholdLines}).`,
      "The gate did not run. Before merging, run the mutation check locally: `bun run mutate`",
      "(or `MUTATION_GATE_BASE=<base> node scripts/mutation-gate.mjs` for the changed-file run).",
      "Labels: `mutate-force` runs the gate anyway; `mutate-skip` waves it off.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderResult({ files, result, breakScore }) {
  const c = result.counts;
  const lines = [
    `## mutation gate: ${result.verdict} (score ${result.score.toFixed(2)}, break ${breakScore})`,
    "",
    `Mutated ${files.length} file(s): ${files.join(", ")}`,
    `Mutants: ${c.Killed} killed, ${c.Timeout} timeout, ${c.Survived} survived, ${c.NoCoverage} no-coverage; ` +
      `${c.Ignored} ignored, ${c.CompileError + c.RuntimeError} errored, ${c.Pending} pending.`,
  ];
  if (result.undetected.length > 0) {
    lines.push("", "Undetected mutants (kill each with a test, or annotate with a reasoned", 
      "`// Stryker disable next-line <Mutator>: <why it is unobservable>`):", "");
    for (const m of result.undetected) {
      lines.push(`- \`${m.file}:${m.line}\` ${m.mutator}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderInfra(message) {
  return `## mutation gate: infra failure\n\n${message}\n\nThis is an infrastructure error, not a verdict on the PR's tests.\n`;
}

export function formatGithubOutputs(outputs) {
  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    lines.push(`${key}<<__MUTATION_GATE_EOF__`, String(value), "__MUTATION_GATE_EOF__");
  }
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: 34 pass, 0 fail.

- [ ] **Step 5: Full-suite gate and commit**

```bash
bun test; echo "exit=$?"    # expect exit=0
git add scripts/mutation-gate.mjs scripts/mutation-gate.test.ts
git commit -m "feat: mutation-gate summaries and GitHub output formatting"
```

---

### Task 7: `main()` orchestration (changed mode), real deps, CLI entry

**Files:**
- Modify: `scripts/mutation-gate.mjs` (append)
- Modify: `scripts/mutation-gate.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 1-6, plus `makeReport` from the Task 5 test block.
- Produces: `EXIT` (`{ ok: 0, gateFail: 1, infra: 2 }`); `resolveDefaultBase(deps) -> string`; `readMutateGlobs(deps, configPath) -> string[]`; `main(deps?) -> number` (exit code); `realDeps() -> deps`. Deps shape: `{ env, exec(argv, opts?) -> { code, stdout }, readFile(p) -> string, exists(p) -> boolean, writeSummary(md), writeOutputs(obj), log(msg) }`. Task 8 extends `main` for incremental mode.

- [ ] **Step 1: Write the failing tests** (append; extend the import with `EXIT, resolveDefaultBase, readMutateGlobs, main, realDeps`)

```ts
const CONF = JSON.stringify({ mutate: ["src/engine/**/*.ts", "!src/engine/**/*.test.ts"] });

function fakeDeps({
  files = {} as Record<string, string>,
  execs = [] as Array<{ code: number; stdout: string }>,
  env = {} as Record<string, string>,
} = {}) {
  const calls: string[][] = [];
  const outputs: Array<Record<string, string>> = [];
  const summaries: string[] = [];
  const deps = {
    env,
    exec(argv: string[], _opts?: { inherit?: boolean }) {
      calls.push(argv);
      const next = execs.shift();
      if (!next) throw new Error(`unexpected exec: ${argv.join(" ")}`);
      return next;
    },
    readFile(p: string) {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    },
    exists: (p: string) => p in files,
    writeSummary: (md: string) => summaries.push(md),
    writeOutputs: (o: Record<string, string>) => outputs.push(o),
    log: (_msg: string) => {},
  };
  return { deps, calls, outputs, summaries };
}

const MB_OK = { code: 0, stdout: "abc123\n" };
const diffOf = (raw: string) => ({ code: 0, stdout: raw });

test("main: missing merge-base is an infra failure naming fetch-depth", () => {
  const { deps, outputs } = fakeDeps({ execs: [{ code: 128, stdout: "" }], env: { MUTATION_GATE_BASE: "origin/main" } });
  expect(main(deps)).toBe(EXIT.infra);
  expect(outputs[0].decision).toBe("infra");
  expect(outputs[0].summary).toContain("fetch-depth: 0");
});

test("main: no mutable changes passes empty without spawning stryker", () => {
  const { deps, calls, outputs } = fakeDeps({
    files: { "stryker.conf.json": CONF },
    execs: [MB_OK, diffOf("M\0README.md\0")],
    env: { MUTATION_GATE_BASE: "origin/main" },
  });
  expect(main(deps)).toBe(EXIT.ok);
  expect(outputs[0].decision).toBe("pass-empty");
  expect(calls.length).toBe(2);
});

test("main: over-threshold loud-skips green without spawning stryker; force runs it", () => {
  const bigFile = "x\n".repeat(900);
  const base = {
    files: { "stryker.conf.json": CONF, "src/engine/index.ts": bigFile },
    execs: [MB_OK, diffOf("M\0src/engine/index.ts\0")],
  };
  const skip = fakeDeps({ ...base, env: { MUTATION_GATE_BASE: "origin/main" } });
  expect(main(skip.deps)).toBe(EXIT.ok);
  expect(skip.outputs[0].decision).toBe("skip-size");
  expect(skip.calls.length).toBe(2);

  const forced = fakeDeps({
    files: {
      "stryker.conf.json": CONF,
      "src/engine/index.ts": bigFile,
      "reports/mutation/mutation.json": JSON.stringify(makeReport({ "src/engine/index.ts": [{ mutator: "X", status: "Killed" }] })),
    },
    execs: [MB_OK, diffOf("M\0src/engine/index.ts\0"), { code: 0, stdout: "" }],
    env: { MUTATION_GATE_BASE: "origin/main", MUTATION_GATE_FORCE: "1" },
  });
  expect(main(forced.deps)).toBe(EXIT.ok);
  expect(forced.outputs[0].decision).toBe("pass");
});

test("main: a clean run passes and the stryker argv carries --mutate and --reporters", () => {
  const { deps, calls, outputs } = fakeDeps({
    files: {
      "stryker.conf.json": CONF,
      "src/engine/dispatch.ts": "a\nb\n",
      "reports/mutation/mutation.json": JSON.stringify(
        makeReport({ "src/engine/dispatch.ts": [{ mutator: "X", status: "Killed" }] }),
      ),
    },
    execs: [MB_OK, diffOf("M\0src/engine/dispatch.ts\0"), { code: 0, stdout: "" }],
    env: { MUTATION_GATE_BASE: "origin/main" },
  });
  expect(main(deps)).toBe(EXIT.ok);
  expect(outputs[0].decision).toBe("pass");
  const stryker = calls[2];
  expect(stryker.slice(0, 2)).toEqual(["node_modules/.bin/stryker", "run"]);
  expect(stryker).toContain("--mutate");
  expect(stryker[stryker.indexOf("--mutate") + 1]).toBe("src/engine/dispatch.ts");
  expect(stryker[stryker.indexOf("--reporters") + 1]).toBe("clear-text,progress,json,html");
});

test("main: survivors fail the gate with exit 1 and the mutant named", () => {
  const { deps, outputs } = fakeDeps({
    files: {
      "stryker.conf.json": CONF,
      "src/engine/dispatch.ts": "a\n",
      "reports/mutation/mutation.json": JSON.stringify(
        makeReport({ "src/engine/dispatch.ts": [{ mutator: "EqualityOperator", status: "Survived", line: 7 }] }),
      ),
    },
    execs: [MB_OK, diffOf("M\0src/engine/dispatch.ts\0"), { code: 0, stdout: "" }],
    env: { MUTATION_GATE_BASE: "origin/main" },
  });
  expect(main(deps)).toBe(EXIT.gateFail);
  expect(outputs[0].decision).toBe("fail");
  expect(outputs[0].summary).toContain("src/engine/dispatch.ts:7");
});

test("main: stryker exiting without a report is infra, not a verdict", () => {
  const { deps, outputs } = fakeDeps({
    files: { "stryker.conf.json": CONF, "src/engine/dispatch.ts": "a\n" },
    execs: [MB_OK, diffOf("M\0src/engine/dispatch.ts\0"), { code: 1, stdout: "" }],
    env: { MUTATION_GATE_BASE: "origin/main" },
  });
  expect(main(deps)).toBe(EXIT.infra);
  expect(outputs[0].decision).toBe("infra");
  expect(outputs[0].summary).toContain("without writing");
});

test("main: an unsupported conf glob is refused with the GLOBS remedy", () => {
  const { deps, outputs } = fakeDeps({
    files: { "stryker.conf.json": JSON.stringify({ mutate: ["src/!(*.test).ts"] }) },
    execs: [MB_OK, diffOf("M\0src/a.ts\0")],
    env: { MUTATION_GATE_BASE: "origin/main" },
  });
  expect(main(deps)).toBe(EXIT.infra);
  expect(outputs[0].summary).toContain("MUTATION_GATE_GLOBS");
});

test("main: skip label loud-skips a small PR", () => {
  const { deps, outputs } = fakeDeps({
    files: { "stryker.conf.json": CONF, "src/engine/dispatch.ts": "a\n" },
    execs: [MB_OK, diffOf("M\0src/engine/dispatch.ts\0")],
    env: { MUTATION_GATE_BASE: "origin/main", MUTATION_GATE_SKIP: "1" },
  });
  expect(main(deps)).toBe(EXIT.ok);
  expect(outputs[0].decision).toBe("skip-label");
});

test("resolveDefaultBase prefers origin/HEAD, falls back to main", () => {
  const viaHead = fakeDeps({ execs: [{ code: 0, stdout: "refs/remotes/origin/trunk\n" }] });
  expect(resolveDefaultBase(viaHead.deps)).toBe("origin/trunk");
  const noHead = fakeDeps({ execs: [{ code: 1, stdout: "" }] });
  expect(resolveDefaultBase(noHead.deps)).toBe("main");
});

test("readMutateGlobs reads the conf and rejects a missing mutate array", () => {
  const ok = fakeDeps({ files: { "stryker.conf.json": CONF } });
  expect(readMutateGlobs(ok.deps, "stryker.conf.json")).toEqual(["src/engine/**/*.ts", "!src/engine/**/*.test.ts"]);
  const bad = fakeDeps({ files: { "stryker.conf.json": "{}" } });
  expect(() => readMutateGlobs(bad.deps, "stryker.conf.json")).toThrow("MUTATION_GATE_GLOBS");
});

test("realDeps exec runs a real command and captures stdout", () => {
  const d = realDeps();
  const r = d.exec(["git", "--version"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("git version");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: the 11 new tests fail; all earlier tests pass.

- [ ] **Step 3: Write the implementation**

Add these imports to `scripts/mutation-gate.mjs`, immediately after the header comment block (before the first export):

```js
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
```

Append at the bottom:

```js
export const EXIT = Object.freeze({ ok: 0, gateFail: 1, infra: 2 });

export function resolveDefaultBase(deps) {
  const head = deps.exec(["git", "symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim() !== "") {
    return head.stdout.trim().replace(/^refs\/remotes\//, "");
  }
  return "main";
}

export function readMutateGlobs(deps, configPath) {
  const conf = JSON.parse(deps.readFile(configPath));
  if (!Array.isArray(conf.mutate) || conf.mutate.length === 0) {
    throw new Error(`mutation-gate: no "mutate" array in ${configPath}; set MUTATION_GATE_GLOBS`);
  }
  return conf.mutate;
}

function finish(deps, decision, summaryMd, exitCode) {
  deps.log(summaryMd);
  deps.writeSummary(summaryMd);
  deps.writeOutputs({ decision, summary: summaryMd });
  return exitCode;
}

export function main(deps) {
  const d = deps ?? realDeps();
  try {
    const cfg = readConfig(d.env);
    if (cfg.mode !== "changed" && cfg.mode !== "incremental") {
      throw new Error(`mutation-gate: unknown MUTATION_GATE_MODE "${cfg.mode}"`);
    }
    const base = cfg.base ?? resolveDefaultBase(d);
    const mb = d.exec(["git", "merge-base", base, "HEAD"]);
    if (mb.code !== 0) {
      return finish(d, "infra", renderInfra(
        `no merge-base between "${base}" and HEAD. In CI, check out with fetch-depth: 0 so the base branch history is present.`,
      ), EXIT.infra);
    }
    const diff = d.exec(["git", "diff", "--name-status", "-z", "-M", mb.stdout.trim(), "HEAD"]);
    if (diff.code !== 0) {
      return finish(d, "infra", renderInfra("git diff --name-status failed"), EXIT.infra);
    }
    const { changed, deleted } = parseNameStatusZ(diff.stdout);
    const globs = cfg.globsOverride ?? readMutateGlobs(d, cfg.configPath);
    const files = selectMutateSet({ changed, deleted, globs, testSiblings: cfg.testSiblings, exists: d.exists });
    const totalLines = files.reduce((n, f) => n + countLines(d.readFile(f)), 0);
    const decision = decide({ files, totalLines, thresholdLines: cfg.thresholdLines, force: cfg.force, skip: cfg.skip });
    if (decision !== "run") {
      return finish(d, decision, renderSkip({ decision, files, totalLines, thresholdLines: cfg.thresholdLines }), EXIT.ok);
    }
    let strykerArgs;
    if (cfg.mode === "incremental") {
      if (cfg.requireBaseline && !d.exists(cfg.incrementalFile)) {
        return finish(d, "skip-no-baseline",
          renderSkip({ decision: "skip-no-baseline", files, totalLines, thresholdLines: cfg.thresholdLines }), EXIT.ok);
      }
      strykerArgs = [...cfg.strykerCmd, "--incremental", "--incrementalFile", cfg.incrementalFile,
        "--reporters", "clear-text,progress,json,html", ...cfg.extraArgs];
    } else {
      strykerArgs = [...cfg.strykerCmd, "--mutate", files.join(","),
        "--reporters", "clear-text,progress,json,html", ...cfg.extraArgs];
    }
    const run = d.exec(strykerArgs, { inherit: true });
    if (!d.exists(cfg.reportPath)) {
      return finish(d, "infra", renderInfra(
        `stryker exited ${run.code} without writing ${cfg.reportPath}. Read the run log above; this may be a crash, not a test-strength verdict.`,
      ), EXIT.infra);
    }
    const result = interpretReport(JSON.parse(d.readFile(cfg.reportPath)), cfg.breakScore);
    const summaryMd = renderResult({ files, result, breakScore: cfg.breakScore });
    return finish(d, result.verdict, summaryMd, result.verdict === "pass" ? EXIT.ok : EXIT.gateFail);
  } catch (err) {
    return finish(d, "infra", renderInfra(err.message), EXIT.infra);
  }
}

export function realDeps() {
  return {
    env: process.env,
    exec(argv, opts = {}) {
      const r = spawnSync(argv[0], argv.slice(1), {
        encoding: "utf8",
        stdio: opts.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      if (r.error) throw r.error;
      return { code: r.status ?? 1, stdout: r.stdout ?? "" };
    },
    readFile: (p) => readFileSync(p, "utf8"),
    exists: existsSync,
    writeSummary(md) {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    },
    writeOutputs(outputs) {
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, formatGithubOutputs(outputs));
    },
    log: (msg) => console.error(msg),
  };
}

const isCliEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isCliEntry) process.exit(main());
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/mutation-gate.test.ts`
Expected: 45 pass, 0 fail.

- [ ] **Step 5: Self-run on the repo (pass-empty smoke test)**

From the repo root on `mutation-pr-gate` (which touches only docs):

```bash
nvm use default   # Node >= 20 on PATH
MUTATION_GATE_BASE=main node scripts/mutation-gate.mjs; echo "exit=$?"
```

Expected: the pass-empty summary printed to stderr and `exit=0`. Also confirm the guard: `bun -e 'await import("./scripts/mutation-gate.mjs"); console.log("import-only ok")'` prints `import-only ok` and exits 0 (no gate run on import).

- [ ] **Step 6: Full-suite gate and commit**

```bash
bun test; echo "exit=$?"    # expect exit=0
git add scripts/mutation-gate.mjs scripts/mutation-gate.test.ts
git commit -m "feat: mutation-gate main orchestration, real deps, CLI entry"
```

---

### Task 8: Incremental mode

**Files:**
- Modify: `scripts/mutation-gate.test.ts` (append; the `main` from Task 7 already implements the branch, so these tests pin it)

**Interfaces:**
- Consumes: `main`, `EXIT`, `makeReport`, `fakeDeps` (Task 7 test block), `CONF`.
- Produces: pinned behavior for `MUTATION_GATE_MODE=incremental`; no new exports.

- [ ] **Step 1: Write the tests** (append)

```ts
test("incremental: missing baseline loud-skips without spawning stryker", () => {
  const { deps, calls, outputs } = fakeDeps({
    files: { "stryker.conf.json": CONF, "src/engine/dispatch.ts": "a\n" },
    execs: [MB_OK, diffOf("M\0src/engine/dispatch.ts\0")],
    env: { MUTATION_GATE_BASE: "origin/main", MUTATION_GATE_MODE: "incremental" },
  });
  expect(main(deps)).toBe(EXIT.ok);
  expect(outputs[0].decision).toBe("skip-no-baseline");
  expect(calls.length).toBe(2);
});

test("incremental: with a baseline, argv has --incremental and no --mutate", () => {
  const { deps, calls, outputs } = fakeDeps({
    files: {
      "stryker.conf.json": CONF,
      "src/engine/dispatch.ts": "a\n",
      "reports/stryker-incremental.json": "{}",
      "reports/mutation/mutation.json": JSON.stringify(
        makeReport({ "src/engine/dispatch.ts": [{ mutator: "X", status: "Killed" }] }),
      ),
    },
    execs: [MB_OK, diffOf("M\0src/engine/dispatch.ts\0"), { code: 0, stdout: "" }],
    env: { MUTATION_GATE_BASE: "origin/main", MUTATION_GATE_MODE: "incremental" },
  });
  expect(main(deps)).toBe(EXIT.ok);
  expect(outputs[0].decision).toBe("pass");
  const stryker = calls[2];
  expect(stryker).toContain("--incremental");
  expect(stryker[stryker.indexOf("--incrementalFile") + 1]).toBe("reports/stryker-incremental.json");
  expect(stryker).not.toContain("--mutate");
});

test("incremental: REQUIRE_BASELINE=false runs without a baseline", () => {
  const { deps, outputs } = fakeDeps({
    files: {
      "stryker.conf.json": CONF,
      "src/engine/dispatch.ts": "a\n",
      "reports/mutation/mutation.json": JSON.stringify(
        makeReport({ "src/engine/dispatch.ts": [{ mutator: "X", status: "Killed" }] }),
      ),
    },
    execs: [MB_OK, diffOf("M\0src/engine/dispatch.ts\0"), { code: 0, stdout: "" }],
    env: {
      MUTATION_GATE_BASE: "origin/main",
      MUTATION_GATE_MODE: "incremental",
      MUTATION_GATE_REQUIRE_BASELINE: "false",
    },
  });
  expect(main(deps)).toBe(EXIT.ok);
  expect(outputs[0].decision).toBe("pass");
});

test("an unknown mode is an infra failure", () => {
  const { deps, outputs } = fakeDeps({ env: { MUTATION_GATE_MODE: "yolo" } });
  expect(main(deps)).toBe(EXIT.infra);
  expect(outputs[0].summary).toContain('unknown MUTATION_GATE_MODE "yolo"');
});
```

- [ ] **Step 2: Run tests to verify they pass** (the implementation landed in Task 7; these pin it)

Run: `bun test scripts/mutation-gate.test.ts`
Expected: 49 pass, 0 fail. If any of the four fail, fix `main()` in `scripts/mutation-gate.mjs`, not the tests.

- [ ] **Step 3: Full-suite gate and commit**

```bash
bun test; echo "exit=$?"    # expect exit=0
git add scripts/mutation-gate.test.ts
git commit -m "test: pin mutation-gate incremental mode"
```

---

### Task 9: The workflow and the labels

**Files:**
- Create: `.github/workflows/mutation.yml`

**Interfaces:**
- Consumes: the script's env knobs, `decision`/`summary` outputs, exit codes (Tasks 4, 6, 7).
- Produces: the `mutation` check; `mutate-force`/`mutate-skip` labels. Task 10 exercises them.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/mutation.yml`:

```yaml
# Portable mutation PR gate (StrykerJS). To adopt in another repo:
#   1. copy scripts/mutation-gate.mjs and this file;
#   2. replace the toolchain setup below (setup-bun + bun install) with your own
#      (e.g. drop setup-bun, use actions/setup-node + `npm ci`);
#   3. tune the MUTATION_GATE_* env knobs (full table in the script header);
#   4. add the `mutation` check to branch protection; create the
#      mutate-force / mutate-skip labels.
# Modes: changed (default: mutates the PR's changed files) or incremental
# (MUTATION_GATE_MODE: incremental; needs a baseline, see the commented-out
# job at the bottom, plus an actions/cache restore step in this job).
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
  pull-requests: write # sticky comment
jobs:
  mutation:
    runs-on: ubuntu-latest
    timeout-minutes: 15 # backstop against a mispredicted run
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha }} # the PR as authored, not the synthetic merge ref
          fetch-depth: 0 # all branches: merge-base needs the real base branch
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14" # same pin rationale as gates (bunfig coverage semantics)
      - uses: actions/setup-node@v5
        with:
          node-version: "24" # Stryker CLI host (D-010); >=20 required, 20 is EOL
      - run: bun install --frozen-lockfile
      - name: gate
        id: gate
        env:
          MUTATION_GATE_BASE: origin/${{ github.event.pull_request.base.ref }} # the branch, never the payload SHA
          MUTATION_GATE_FORCE: ${{ contains(github.event.pull_request.labels.*.name, 'mutate-force') && '1' || '' }}
          MUTATION_GATE_SKIP: ${{ contains(github.event.pull_request.labels.*.name, 'mutate-skip') && '1' || '' }}
          # MUTATION_GATE_EXTRA_ARGS: "--concurrency 4"  # set from the Task 10 measurement
        run: node scripts/mutation-gate.mjs
      - name: sticky comment
        if: always() && steps.gate.outputs.decision != ''
        continue-on-error: true # fork PRs get a read-only token; the verdict is the gate step's alone
        env:
          GH_TOKEN: ${{ github.token }}
          DECISION: ${{ steps.gate.outputs.decision }}
          SUMMARY: ${{ steps.gate.outputs.summary }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          BODY_FILE="$(mktemp)"
          printf '<!-- mutation-gate -->\n\n%s\n' "$SUMMARY" > "$BODY_FILE"
          EXISTING="$(gh api "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" --paginate \
            --jq '[.[] | select(.body | startswith("<!-- mutation-gate -->"))][0].id // empty')"
          case "$DECISION" in
            pass|pass-empty) [ -z "$EXISTING" ] && exit 0 ;; # quiet pass: only update an existing comment
          esac
          if [ -n "$EXISTING" ]; then
            gh api -X PATCH "repos/${GITHUB_REPOSITORY}/issues/comments/${EXISTING}" -F body=@"$BODY_FILE"
          else
            gh api -X POST "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments" -F body=@"$BODY_FILE"
          fi
      - name: report artifact
        if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: mutation-report
          path: reports/mutation/
          retention-days: 14
          if-no-files-found: ignore
#  baseline: # incremental-mode adopters: produce/refresh the baseline on pushes to main
#    # (also add `push: { branches: [main] }` to `on:` and an `if: github.event_name == 'push'` guard)
#    runs-on: ubuntu-latest
#    steps:
#      - uses: actions/checkout@v7
#      - <your toolchain setup + dependency install>
#      - uses: actions/cache@v4
#        with:
#          path: reports/stryker-incremental.json
#          key: stryker-incremental-${{ github.sha }}
#          restore-keys: stryker-incremental-
#      - run: node_modules/.bin/stryker run --incremental --incrementalFile reports/stryker-incremental.json
```

- [ ] **Step 2: Sanity-check the YAML parses**

```bash
bun -e 'const { parse } = await import("yaml"); parse(await Bun.file(".github/workflows/mutation.yml").text()); console.log("yaml ok")'
```

Expected: `yaml ok`.

- [ ] **Step 3: Create the labels**

```bash
gh label create mutate-force --color B60205 --description "mutation gate: run and block even over the size threshold"
gh label create mutate-skip --color C5DEF5 --description "mutation gate: wave off the gate for this PR"
gh label list | grep mutate
```

Expected: both labels listed.

- [ ] **Step 4: Commit and push (the rehearsal branches off this)**

```bash
git add .github/workflows/mutation.yml
git commit -m "ci: mutation PR gate workflow with label overrides and sticky comment"
git push -u origin mutation-pr-gate
```

---

### Task 10: E2E rehearsal and the concurrency measurement

This task exercises the real check on a scratch PR. Nothing from this branch is merged; it exists to prove red/green/skip/labels/artifact/comment and to measure mutants-per-minute. `pull_request` workflows run from the head branch, so the scratch PR carries the new workflow. Verify every outcome by check conclusion or exit code, never log prose. The `gates` check may go red on the scratch PR while the probe is untested; that is expected and irrelevant here.

**Files:**
- Scratch branch `mutation-gate-rehearsal` (off `mutation-pr-gate`): temporary edits to `src/engine/instances.ts`, `src/engine/instances.test.ts`, `src/engine/index.ts`, `.github/workflows/mutation.yml`. All discarded when the PR closes.
- Create: `/tmp/claude-1000/-home-nn-Projects-offbook/c85f6d34-1e52-4951-b55d-61ccfd1f864d/scratchpad/mutation-gate-measurements.md` (the numbers Task 11 needs).

**Interfaces:**
- Consumes: the pushed workflow (Task 9).
- Produces: measured mutants-per-minute at concurrency 1 and 4; the decision which `MUTATION_GATE_EXTRA_ARGS` ships; recorded in the scratchpad file for Task 11.

- [ ] **Step 1: Open the rehearsal PR with a planted survivor**

```bash
git checkout -b mutation-gate-rehearsal
cat >> src/engine/instances.ts <<'EOF'

export function rehearsalProbe(n: number): string {
	return n > 10 ? "big" : "small";
}
EOF
git add src/engine/instances.ts
git commit -m "rehearsal: plant an untested probe (never merge)"
git push -u origin mutation-gate-rehearsal
gh pr create --base main --head mutation-gate-rehearsal --draft \
  --title "rehearsal: mutation gate (never merge)" \
  --body "Scratch PR exercising the mutation gate end to end. Close without merging."
```

- [ ] **Step 2: Verify the red run names the probe's mutants**

```bash
gh run list --workflow=mutation --branch mutation-gate-rehearsal --limit 1   # note the run id once it appears
gh run watch <run-id> --exit-status; echo "exit=$?"
```

Expected: `exit=1` (the check fails). Then confirm the verdict content and the artifact:

```bash
gh run view <run-id> --json conclusion --jq .conclusion            # expect: failure
gh api "repos/{owner}/{repo}/actions/runs/<run-id>/artifacts" --jq '.artifacts[].name'   # expect: mutation-report
gh pr view <pr-number> --json comments --jq '.comments[].body' | grep -c 'mutation-gate' # expect: 1
```

The job summary (run page) must list `src/engine/instances.ts:<line>` mutants (ConditionalExpression / EqualityOperator / StringLiteral) with the kill-or-annotate instruction.

- [ ] **Step 3: Exercise the label overrides while red**

```bash
gh pr edit <pr-number> --add-label mutate-skip
# wait for the labeled-event run:
gh run list --workflow=mutation --branch mutation-gate-rehearsal --limit 1
gh run watch <new-run-id> --exit-status; echo "exit=$?"     # expect exit=0 (loud skip is green)
gh run view <new-run-id> --json conclusion --jq .conclusion  # expect: success
gh pr view <pr-number> --json comments --jq '[.comments[] | select(.body | startswith("<!-- mutation-gate -->"))] | length'  # expect: 1 (upserted, not duplicated)
gh pr edit <pr-number> --remove-label mutate-skip           # triggers the red run again
```

- [ ] **Step 4: Exercise skip-size cheaply, then restore**

On the rehearsal branch, add `MUTATION_GATE_THRESHOLD_LINES: "1"` under the gate step's `env:` in `.github/workflows/mutation.yml`, commit (`rehearsal: force skip-size`), push. Expected: the new run is green with decision `skip-size` in the job summary. Then `git revert HEAD && git push` to restore.

- [ ] **Step 5: Kill the probe, verify green**

```bash
cat >> src/engine/instances.test.ts <<'EOF'

// rehearsal probe kill (never merged)
import { rehearsalProbe } from "./instances.ts";

test("rehearsalProbe boundary and literals", () => {
	expect(rehearsalProbe(11)).toBe("big");
	expect(rehearsalProbe(10)).toBe("small");
});
EOF
bun test src/engine/instances.test.ts        # judge by fail count: expect 0 fail
git add src/engine/instances.test.ts
git commit -m "rehearsal: kill the probe"
git push
```

Note: `instances.test.ts` already imports `test`/`expect` from `bun:test`, so the appended block only imports `rehearsalProbe`; an `import` declaration is legal at any top-level position in an ESM file, so the append works as-is (this is a scratch branch, tidiness is optional). Expected: next mutation run green, conclusion `success`, sticky comment updated to the pass state, still exactly one comment.

- [ ] **Step 6: Measure concurrency 1 vs 4 on a big file**

Temporarily (still on the rehearsal branch): flip the artifact step to `if: always()` and append a no-op line (`// rehearsal touch`) to `src/engine/index.ts` so the biggest engine file (363 lines) enters the mutate set. Commit, push, let the run finish (expect green; this is the concurrency-1 measurement). Then set `MUTATION_GATE_EXTRA_ARGS: "--concurrency 4"` in the workflow env, commit, push, let it finish (the concurrency-4 measurement).

For each of the two runs record into `mutation-gate-measurements.md` in the scratchpad:

```bash
SCRATCH=/tmp/claude-1000/-home-nn-Projects-offbook/c85f6d34-1e52-4951-b55d-61ccfd1f864d/scratchpad
gh run view <run-id> --json jobs \
  --jq '.jobs[0].steps[] | select(.name == "gate") | {startedAt, completedAt}'
gh run download <run-id> --name mutation-report --dir "$SCRATCH/run-<n>"
bun -e 'const r = JSON.parse(await Bun.file("<scratch>/run-<n>/mutation.json").text());
  let t = 0, k = {}; for (const f of Object.values(r.files)) for (const m of f.mutants) { t++; k[m.status]=(k[m.status]??0)+1 }
  console.log(JSON.stringify({ total: t, byStatus: k }))'
```

Record: gate-step wall time, total mutants, per-status counts, computed mutants/minute for each run. **The two runs' per-status counts must be identical**; if concurrency 4 diverges (perTest coverage mis-correlation) or crashes, record that and the decision is concurrency 1. Otherwise the faster setting wins. Derive the threshold: `sustainable = rate_winner (mutants/min) x 12 (min) / 0.5 (mutants/line)`, rounded to the nearest 100; if it is within a factor of 2 of 800, keep 800.

- [ ] **Step 7: Close out the rehearsal**

```bash
gh pr close <pr-number> --delete-branch
git checkout mutation-pr-gate
```

Then apply the measurement's outcome on `mutation-pr-gate`:
- If concurrency 4 won: uncomment/set `MUTATION_GATE_EXTRA_ARGS: "--concurrency 4"` in `.github/workflows/mutation.yml`.
- If the derived threshold differs from 800 by more than 2x: change `thresholdLines` in `DEFAULTS` in `scripts/mutation-gate.mjs`, the `800` expectations in `scripts/mutation-gate.test.ts` (readConfig defaults test), and the Threshold rationale numbers in the spec.

```bash
bun test; echo "exit=$?"    # expect exit=0
git add -A
git commit -m "ci: apply the measured mutation-gate concurrency/threshold"   # only if anything changed
git push
```

---

### Task 11: D-027, AGENTS.md, spec status

**Files:**
- Modify: `DECISIONS.md` (append D-027 at the end)
- Modify: `AGENTS.md` (two working-notes lines)
- Modify: `docs/superpowers/specs/2026-08-04-mutation-pr-gate-design.md` (Status line + measured numbers)

**Interfaces:**
- Consumes: the measurements file from Task 10.

- [ ] **Step 1: Append D-027 to `DECISIONS.md`**

Append after the last entry (D-026), filling the four `<...>` slots from `/tmp/claude-1000/-home-nn-Projects-offbook/c85f6d34-1e52-4951-b55d-61ccfd1f864d/scratchpad/mutation-gate-measurements.md`:

```markdown
### D-027: A changed-file mutation gate on PRs; full campaigns stay manual
**Date**: 2026-08-04
**What**: A second required check, `mutation` (`.github/workflows/mutation.yml` + dependency-free `scripts/mutation-gate.mjs`, the two-file portable unit): on every PR targeting main, mutate exactly the changed files that match `stryker.conf.json`'s `mutate` globs, plus sibling sources of changed or deleted test files (existence checked at HEAD), and fail below score 100. Score is Stryker's own metric: detected = Killed + Timeout, undetected = Survived + NoCoverage; Ignored and error statuses stay out of the verdict; zero valid mutants scores 100; the verdict is computed from the JSON report, never Stryker's exit code (thresholds.break defaults to null, so the exit code carries nothing). Above MUTATION_GATE_THRESHOLD_LINES (<final threshold> summed whole-file lines) the gate loud-skips: green check, step summary, sticky PR comment nudging a local run; labels `mutate-force`/`mutate-skip` override in both directions, force wins. Diff base: the PR head SHA is checked out and merge-based against `origin/<base branch>`, never the payload base SHA or the synthetic merge ref (stale-payload diffs otherwise fail open via loud-skip). Report artifact uploads on failure only. An incremental mode ships for adopting projects (baseline required by default, loud-skip without it). Measured on ubuntu-latest (Task 10 rehearsal, 2026-08-04): <N> mutants over src/engine/index.ts at concurrency 1 in <T1> (<rate1>/min) vs concurrency 4 in <T4> (<rate4>/min), per-status counts <identical | diverged>; shipping <the winning setting>.
**Why**: Amends D-010 ("run manually, never a gate") and D-017 ("mutation testing is excluded from CI in any form"): both stances priced a full-campaign gate, and a changed-file gate prices per-PR work instead, catching test-strength regressions at merge time where they are cheapest. Whole-file (not changed-line) mutation keeps the D-011 ratchet reading: every file a PR touches ends the PR mutation-clean. Loud-skip keeps the obligation visible on large PRs without holding the check hostage; the label escape hatches keep "mandatory" from eroding at the first heuristic misfire.
**Mitigations / notes**: The gate does not police annotation quality: `Ignored` is excluded, so a `// Stryker disable` comment silences a survivor, and the unobservability argument stays human review (D-011). A Stryker or runner bump can change the mutant set; run a full campaign (`bun run mutate`) after any such bump before engine PRs resume, or the drift lands on the next innocent PR. Test-helper and config changes do not trigger the gate (accepted residual; incremental mode is the answer for projects that care). Widening the `mutate` globs beyond `src/engine/` stays module-by-module, each behind its own kill-or-annotate campaign.
**From**: docs/superpowers/specs/2026-08-04-mutation-pr-gate-design.md (brainstorm dialog + adversarial agent review, 2026-08-04)
**Folds into**: scripts/mutation-gate.mjs, scripts/mutation-gate.test.ts, .github/workflows/mutation.yml, AGENTS.md (working notes), main ruleset (`mutation` required check)
```

- [ ] **Step 2: Update the two AGENTS.md working-notes lines**

In `AGENTS.md`, replace the sentence `Mutation testing is manual and never a gate.` (inside the `bun run mutate` bullet) with:

```
Mutation testing is manual full campaigns plus a changed-file PR gate (`.github/workflows/mutation.yml` + `scripts/mutation-gate.mjs`, D-027): small PRs are gated on zero undetected mutants in touched engine files; large PRs loud-skip with a sticky comment (labels `mutate-force`/`mutate-skip` override); after any Stryker/runner bump, run a full campaign before engine PRs resume.
```

And in the CI bullet, replace `Mutation testing stays out of CI (D-017).` with:

```
The `mutation` required check runs the changed-file gate on PRs (D-027); full campaigns stay out of CI.
```

- [ ] **Step 3: Update the spec's Status line and measured numbers**

In `docs/superpowers/specs/2026-08-04-mutation-pr-gate-design.md`: change the `**Status**:` line to `implemented 2026-08-04 (see D-027)` and replace the Threshold rationale's "provisional until that measurement" sentence with the measured rates and the shipped setting (same numbers as D-027).

- [ ] **Step 4: Run the full gate set and commit**

```bash
bun scripts/check-docs.ts; echo "exit=$?"   # expect exit=0 (D-027 keeps ids contiguous)
bun run lint; echo "exit=$?"                # expect exit=0
bun run typecheck; echo "exit=$?"           # expect exit=0
bun test; echo "exit=$?"                    # expect exit=0
git add DECISIONS.md AGENTS.md docs/superpowers/specs/2026-08-04-mutation-pr-gate-design.md
git commit -m "docs: D-027 mutation PR gate; amend D-010/D-017 working notes"
git push
```

---

### Task 12: Ruleset, PR, final verification

**Files:** none (GitHub state + the PR).

- [ ] **Step 1: Add `mutation` to the main ruleset's required checks**

```bash
SCRATCH=/tmp/claude-1000/-home-nn-Projects-offbook/c85f6d34-1e52-4951-b55d-61ccfd1f864d/scratchpad
RID=$(gh api repos/{owner}/{repo}/rulesets --jq '.[0].id')
gh api "repos/{owner}/{repo}/rulesets/$RID" \
  --jq '{name, target, enforcement, bypass_actors, conditions, rules}' > "$SCRATCH/ruleset.json"
jq '(.rules |= map(if .type == "required_status_checks"
      then (.parameters.required_status_checks += [{"context": "mutation"}]) else . end))' \
  "$SCRATCH/ruleset.json" > "$SCRATCH/ruleset-new.json"
gh api -X PUT "repos/{owner}/{repo}/rulesets/$RID" --input "$SCRATCH/ruleset-new.json"
gh api "repos/{owner}/{repo}/rulesets/$RID" --jq \
  '.rules[] | select(.type == "required_status_checks").parameters.required_status_checks[].context'
```

Expected final output: `gates` and `mutation`. (If more than one ruleset exists, pick the one targeting `~DEFAULT_BRANCH` when reading `RID`.)

- [ ] **Step 2: Open the real PR**

```bash
gh pr create --base main --head mutation-pr-gate \
  --title "feat: changed-file mutation gate as a second required PR check (D-027)" \
  --body "Implements docs/superpowers/specs/2026-08-04-mutation-pr-gate-design.md: scripts/mutation-gate.mjs + .github/workflows/mutation.yml (the portable two-file unit), changed-file mode gating on zero undetected mutants, loud-skip over the size threshold with mutate-force/mutate-skip label overrides, incremental mode for adopters, report artifact on failure. Rehearsed end to end on a scratch PR (red on a planted survivor, green after the kill, both labels, skip-size, sticky comment upsert, artifact); concurrency and threshold set from the measured rate (D-027)."
```

- [ ] **Step 3: Verify both checks on the real PR**

This PR touches `scripts/`, `.github/`, and docs, no engine files, so the expected `mutation` outcome is a green `pass-empty` with no sticky comment.

```bash
gh pr checks --watch; echo "exit=$?"   # expect exit=0, both gates and mutation green
gh run view <mutation-run-id> --json conclusion --jq .conclusion   # expect: success
```

Confirm in the run's job summary that the decision is `pass-empty`. Merge is the user's call; stop here and report.

---

## Verification checklist (mirrors the spec's Verification section)

- [ ] Full `bun test` exit 0 with all mutation-gate unit tests in (rename fixture, deleted-test sibling, both-deleted, full status enum, zero-valid, heredoc outputs).
- [ ] Rehearsal PR: red run named the planted mutants; green after the kill; `mutate-skip` flipped red to green without a push; `mutate-force` ran an over-threshold change; skip-size exercised via `THRESHOLD_LINES=1`; exactly one sticky comment throughout; `mutation-report` artifact on the red run.
- [ ] Concurrency 1 vs 4 measured, per-status counts compared, winner + threshold recorded in D-027 and the spec.
- [ ] `check-docs`, `lint`, `typecheck`, full `bun test` all exit 0 after the doc edits.
- [ ] Ruleset lists `gates` and `mutation`; the real PR shows both green with `mutation` = `pass-empty`.
