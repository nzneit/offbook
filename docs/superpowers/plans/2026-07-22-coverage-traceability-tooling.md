# Coverage Gate + Tag-Verified Traceability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on a Bun-native coverage gate, make R-### → test traces machine-verified via arrow-tag comments, and stand up experimental mutation testing on `src/engine/`.

**Architecture:** All gating stays local (no CI exists): `bunfig.toml` makes `bun test` itself the coverage gate, and `scripts/check-docs.ts` gains two new pure-function passes (forward: every `tested` requirement's `TEST` files carry its tag; reverse: no dangling/malformed/retired-target tags anywhere). Mutation testing is a manual `bun run mutate`, never a gate.

**Tech Stack:** Bun 1.3.14 test runner (built-in coverage + lcov), TypeScript, `@stryker-mutator/core` + `@hughescr/stryker-bun-runner` (dev-deps only).

**Spec:** `docs/superpowers/specs/2026-07-22-coverage-traceability-tooling-design.md`

## Global Constraints

- Bun >= 1.3.7 required (installed: 1.3.14). Coverage lcov correctness needs >= 1.3.0; the Stryker runner needs >= 1.3.7.
- `scripts/check-docs.ts` stays zero-dependency: `node:fs` + `node:path` only, hand-parsing, pure functions returning `string[]` errors, fs only in `main()`-side helpers.
- Tag grammar, verbatim and case-sensitive, no interior spaces: `[utest->R-###]`, `[itest->R-###]`, `[stest->R-###]` where `###` is exactly three digits.
- **Fixture-splitting rule:** the reverse sweep scans `scripts/*.test.ts`, so no string literal in `scripts/check-docs.test.ts` may contain a contiguous `test->` arrow-tag literal. Build every fixture tag by string concatenation (helper provided in Task 2).
- New dependencies are dev-deps only; runtime `dependencies` in `package.json` must not change.
- Transport isolation untouched: nothing outside `src/broker/` imports aedes/MQTT packages (this plan touches no `src/` module code at all, only test-file comments).
- Formatting: run `bun run lint` (biome) before every commit; fix with `bunx biome check --write .` if it complains.
- Commit style: `<area>: <subject>` matching repo history. No AI-attribution or Co-Authored-By trailers.
- `bun scripts/check-docs.ts` and `bun test` must both pass at every commit boundary. Task 4 lands the retrofit and the checker wiring in one commit for exactly this reason.

---

### Task 1: Bun-native coverage gate (`bunfig.toml`)

**Files:**
- Create: `bunfig.toml`
- Modify: `.gitignore` (currently 3 lines: `node_modules/`, `.offbook/`, `*.log`)

**Interfaces:**
- Consumes: nothing.
- Produces: `coverage/lcov.info` on every `bun test` run; a non-zero exit when coverage drops below the floors. Task 5's Stryker runs `bun test` under the hood and inherits this config harmlessly (mutation runs don't check thresholds; if the Stryker runner README says otherwise, Task 5 handles it).

- [ ] **Step 1: Baseline**

Run: `bun test 2>&1 | tail -5`
Expected: all tests pass, exit 0. Record the pass count. If anything fails, STOP: fix the suite first; this plan assumes green.

- [ ] **Step 2: Measure current coverage**

Run: `bun test --coverage 2>&1 | tail -40`
Expected: a coverage table ending in an `All files` row with `% Funcs` and `% Lines` columns. Record three numbers:
- `ALL_LINES` = All-files % Lines
- `ALL_FUNCS` = All-files % Funcs
- `MIN_FILE_LINES` / `MIN_FILE_FUNCS` = the lowest per-file values in the table

- [ ] **Step 3: Create `bunfig.toml`**

Floors: start from the all-files numbers minus 2 percentage points, rounded down to a whole percent, expressed as a fraction (e.g. `ALL_LINES` 91.3% → `lines = 0.89`). Write the actual measured-derived numbers, not the example.

```toml
[test]
coverage = true
coverageSkipTestFiles = true
coverageReporter = ["text", "lcov"]
coverageDir = "coverage"
# Coverage gate — ratchet policy: raise the floors as coverage grows; never
# lower them to admit a regression.
# Bun quirks (verified 2026-07): plural keys only ("lines"/"functions" —
# singular keys are silently ignored and gate nothing); a failing gate prints
# NO message, exit code 1 is the only signal; a "statements" key exists but no
# statement metric is computed; branch coverage does not exist (bun#7100) —
# test strength beyond lines/functions is mutation testing's job (bun run mutate).
# Requires Bun >= 1.3.0 (older lcov understates coverage).
# Threshold semantics on Bun 1.3.14, measured 2026-07-22: <FILL: per-file OR repo-overall — determined in Step 4>
coverageThreshold = { lines = 0.NN, functions = 0.NN }
```

- [ ] **Step 4: Verify the gate trips, and pin down threshold semantics**

Run: `bun test > /dev/null 2>&1; echo "exit=$?"`

- If `exit=0`: the all-files-minus-2 floors pass, which means the threshold is **repo-overall** (or every file individually clears it — check: if `MIN_FILE_LINES` is below your floor and it still passed, it is definitively repo-overall). Now prove the gate can fail: temporarily set `lines = 0.99`, rerun, expect `exit=1` with no test failures listed (the silent-gate footgun, seen live). Restore the real floor.
- If `exit=1` with zero failing tests: the threshold is **per-file**. Lower the floors to 2 points below `MIN_FILE_LINES`/`MIN_FILE_FUNCS`, rerun, expect `exit=0`. Then do the same temporary-0.99 trip check.

Either way, replace the `<FILL: ...>` comment line with the observed semantics (this is the resolution of the open question flagged in the spec; the words `per-file` or `repo-overall` plus the floor rationale).

- [ ] **Step 5: Verify the lcov artifact**

Run: `bun test > /dev/null 2>&1; head -5 coverage/lcov.info`
Expected: `SF:` and `DA:` records (bare line records are correct: Bun emits no FN/FNDA or BRDA records).

- [ ] **Step 6: Gitignore the coverage dir**

Append `coverage/` to `.gitignore`.

- [ ] **Step 7: Lint**

Run: `bun run lint`
Expected: clean (biome does not check .toml, but the `.gitignore` edit and any stray files ride along).

- [ ] **Step 8: Commit**

```bash
git add bunfig.toml .gitignore
git commit -m "tooling: bun-native coverage gate (always-on lcov + ratcheted thresholds)"
```

---

### Task 2: Arrow-tag scanner (`scanArrowTags`)

**Files:**
- Modify: `scripts/check-docs.ts` (add types + one exported function; do not touch existing functions or `main()`)
- Test: `scripts/check-docs.test.ts` (append)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Tasks 3 and 4 rely on these exact names/shapes):

```ts
export type ArrowTag = { type: "utest" | "itest" | "stest"; uid: string; line: number };
export type TagScan = { tags: ArrowTag[]; malformed: { raw: string; line: number }[] };
export function scanArrowTags(text: string): TagScan;
```

- [ ] **Step 1: Write the failing tests**

Append to `scripts/check-docs.test.ts`. The `mktag` helper implements the fixture-splitting rule from Global Constraints: the file's own text must never contain a contiguous arrow tag, or the Task 4 sweep would read these fixtures as real tags (and the malformed ones would fail the gate).

```ts
import { scanArrowTags } from "./check-docs.ts";

// Fixture tags are built by concatenation so the repo-wide tag sweep (which
// scans scripts/*.test.ts) never sees this file's fixtures as real tags.
const mktag = (type: string, uid: string) => `[${type}` + `->${uid}]`;

test("scanArrowTags finds a strict tag in a line comment", () => {
  const { tags, malformed } = scanArrowTags(`// ${mktag("utest", "R-014")}\ntest("x", () => {});`);
  expect(tags).toEqual([{ type: "utest", uid: "R-014", line: 1 }]);
  expect(malformed).toEqual([]);
});

test("scanArrowTags accepts itest and stest and reports 1-based lines", () => {
  const text = `line one\n// ${mktag("itest", "R-008")}\n/* ${mktag("stest", "R-027")} */`;
  const { tags } = scanArrowTags(text);
  expect(tags).toEqual([
    { type: "itest", uid: "R-008", line: 2 },
    { type: "stest", uid: "R-027", line: 3 },
  ]);
});

test("scanArrowTags flags malformed tags instead of ignoring them", () => {
  // two-digit uid, unknown type prefix, uppercase type — all arrow-shaped, all rejected
  const text = `// ${mktag("utest", "R-14")}\n// ${mktag("test", "R-014")}\n// ${mktag("Utest", "R-014")}`;
  const { tags, malformed } = scanArrowTags(text);
  expect(tags).toEqual([]);
  expect(malformed.map((m) => m.line)).toEqual([1, 2, 3]);
});

test("scanArrowTags ignores tag-shaped text outside comments", () => {
  const { tags, malformed } = scanArrowTags(`const s = "${mktag("utest", "R-001")}";`);
  expect(tags).toEqual([]);
  expect(malformed).toEqual([]);
});

test("scanArrowTags reads a block-comment continuation line", () => {
  const { tags } = scanArrowTags(`/*\n * ${mktag("utest", "R-002")}\n */`);
  expect(tags).toEqual([{ type: "utest", uid: "R-002", line: 2 }]);
});

test("scanArrowTags finds multiple tags on one line", () => {
  const { tags } = scanArrowTags(`// ${mktag("utest", "R-001")} ${mktag("utest", "R-002")}`);
  expect(tags.map((t) => t.uid)).toEqual(["R-001", "R-002"]);
});
```

Note: the ignores-outside-comments fixture works because `const s = "` contains no `//` or `/*` before the tag. Do not "improve" it into a line that has a comment marker anywhere before the string.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/check-docs.test.ts 2>&1 | tail -5`
Expected: FAIL — `scanArrowTags` is not exported (`SyntaxError`/`export not found`).

- [ ] **Step 3: Implement `scanArrowTags`**

Add to `scripts/check-docs.ts`, after `checkIntake` and before `function read(...)`:

```ts
export type ArrowTag = { type: "utest" | "itest" | "stest"; uid: string; line: number };
export type TagScan = { tags: ArrowTag[]; malformed: { raw: string; line: number }[] };

// A tag only counts inside a comment: `//` or `/*` earlier on the line, or a
// block-comment continuation line (leading `*`). Line-based on purpose — the
// checker stays a hand-parser, not a TS lexer.
function inComment(line: string, idx: number): boolean {
  const before = line.slice(0, idx);
  return before.includes("//") || before.includes("/*") || /^\s*\*/.test(line);
}

// Arrow-shaped candidates that fail the strict grammar are surfaced as
// malformed, never silently ignored — a typo must not leak a coverage claim.
export function scanArrowTags(text: string): TagScan {
  const tags: ArrowTag[] = [];
  const malformed: { raw: string; line: number }[] = [];
  const candidate = /\[[A-Za-z]*test->[^\]]*\]/g;
  const strict = /^\[(utest|itest|stest)->(R-\d{3})\]$/;
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(candidate)) {
      if (!inComment(line, m.index)) continue;
      const s = m[0].match(strict);
      if (s) tags.push({ type: s[1] as ArrowTag["type"], uid: s[2], line: i + 1 });
      else malformed.push({ raw: m[0], line: i + 1 });
    }
  });
  return { tags, malformed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/check-docs.test.ts 2>&1 | tail -5`
Expected: PASS — every existing test plus the 6 new `scanArrowTags` tests, 0 fail.

- [ ] **Step 5: Full suite + doc gate still green**

Run: `bun test > /dev/null 2>&1; echo "exit=$?"; bun scripts/check-docs.ts`
Expected: `exit=0` and `check-docs: ok — 31 requirements, 8 decisions, ...` (nothing is wired into `main()` yet).

- [ ] **Step 6: Lint and commit**

```bash
bun run lint
git add scripts/check-docs.ts scripts/check-docs.test.ts
git commit -m "check-docs: add scanArrowTags (strict [utest->R-###] grammar, malformed surfaced)"
```

---

### Task 3: Trace verification passes (`checkTestTraces`, `checkTagSweep`)

**Files:**
- Modify: `scripts/check-docs.ts` (two exported functions; still no `main()` changes)
- Test: `scripts/check-docs.test.ts` (append)

**Interfaces:**
- Consumes: `scanArrowTags`, `ArrowTag` from Task 2; existing `Entry` type and the `readFile: (rel: string) => string | null` injection pattern used by `checkCovers`.
- Produces (Task 4 wires these exact signatures into `main()`):

```ts
export function checkTestTraces(reqs: Entry[], readFile: (rel: string) => string | null): string[];
export function checkTagSweep(files: { path: string; content: string }[], reqs: Entry[]): string[];
```

- [ ] **Step 1: Write the failing tests**

Append to `scripts/check-docs.test.ts` (reuses the `mktag` helper from Task 2):

```ts
import { checkTestTraces, checkTagSweep } from "./check-docs.ts";

const tested = (uid: string, testField: string) =>
  ({ title: "", meta: { UID: uid, STATUS: "tested", TEST: testField }, body: "", line: 1 });

test("checkTestTraces passes when every TEST file carries the tag", () => {
  const files: Record<string, string> = { "src/a.test.ts": `// ${mktag("utest", "R-001")}` };
  expect(checkTestTraces([tested("R-001", "src/a.test.ts")], (p) => files[p] ?? null)).toEqual([]);
});

test("checkTestTraces errors when a TEST file exists but has no tag for the UID", () => {
  const files: Record<string, string> = { "src/a.test.ts": `// ${mktag("utest", "R-002")}` };
  const errs = checkTestTraces([tested("R-001", "src/a.test.ts")], (p) => files[p] ?? null);
  expect(errs.some((m) => m.includes("R-001") && m.includes("no arrow tag"))).toBe(true);
});

test("checkTestTraces errors when a TEST path does not exist", () => {
  const errs = checkTestTraces([tested("R-001", "src/gone.test.ts")], () => null);
  expect(errs.some((m) => m.includes("TEST path not found"))).toBe(true);
});

test("checkTestTraces checks every comma-separated TEST file, not just one", () => {
  const files: Record<string, string> = {
    "src/a.test.ts": `// ${mktag("utest", "R-001")}`,
    "src/b.test.ts": "no tag here",
  };
  const errs = checkTestTraces([tested("R-001", "src/a.test.ts, src/b.test.ts")], (p) => files[p] ?? null);
  expect(errs.some((m) => m.includes("src/b.test.ts"))).toBe(true);
  expect(errs.some((m) => m.includes("src/a.test.ts"))).toBe(false);
});

test("checkTestTraces ignores non-tested requirements", () => {
  const req = { title: "", meta: { UID: "R-001", STATUS: "specified" }, body: "", line: 1 };
  expect(checkTestTraces([req], () => null)).toEqual([]);
});

test("checkTagSweep flags a dangling tag", () => {
  const files = [{ path: "src/a.test.ts", content: `// ${mktag("utest", "R-999")}` }];
  const errs = checkTagSweep(files, [tested("R-001", "x")]);
  expect(errs.some((m) => m.includes("dangling") && m.includes("R-999") && m.includes("src/a.test.ts:1"))).toBe(true);
});

test("checkTagSweep flags a tag on a retired requirement", () => {
  const files = [{ path: "src/a.test.ts", content: `// ${mktag("utest", "R-001")}` }];
  const retired = { title: "", meta: { UID: "R-001", STATUS: "retired" }, body: "", line: 1 };
  expect(checkTagSweep(files, [retired]).some((m) => m.includes("retired"))).toBe(true);
});

test("checkTagSweep accepts a tag on a built requirement (early coverage)", () => {
  const files = [{ path: "src/a.test.ts", content: `// ${mktag("utest", "R-001")}` }];
  const built = { title: "", meta: { UID: "R-001", STATUS: "built", IMPL: "src/" }, body: "", line: 1 };
  expect(checkTagSweep(files, [built])).toEqual([]);
});

test("checkTagSweep surfaces malformed tags with file:line", () => {
  const files = [{ path: "src/a.test.ts", content: `// ${mktag("utest", "R-14")}` }];
  expect(checkTagSweep(files, []).some((m) => m.includes("malformed") && m.includes("src/a.test.ts:1"))).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/check-docs.test.ts 2>&1 | tail -5`
Expected: FAIL — `checkTestTraces`/`checkTagSweep` not exported.

- [ ] **Step 3: Implement both passes**

Add to `scripts/check-docs.ts` directly below `scanArrowTags`:

```ts
// Forward direction: a `tested` STATUS is only as good as its TEST trace, so
// every listed file must exist and carry an arrow tag for the UID — a listed
// file that never mentions the requirement is the honor system, and an error.
export function checkTestTraces(reqs: Entry[], readFile: (rel: string) => string | null): string[] {
  const errs: string[] = [];
  for (const r of reqs) {
    if (r.meta.STATUS !== "tested") continue;
    const uid = r.meta.UID ?? "?";
    const files = (r.meta.TEST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const f of files) {
      const text = readFile(f);
      if (text == null) { errs.push(`${uid}: TEST path not found: ${f}`); continue; }
      if (!scanArrowTags(text).tags.some((t) => t.uid === uid))
        errs.push(`${uid}: no arrow tag for ${uid} in TEST file ${f} (expected e.g. // [utest->${uid}])`);
    }
  }
  return errs;
}

// Reverse direction: every tag in the test tree must point at a live
// requirement. Tags on built/specified requirements are early coverage — fine.
export function checkTagSweep(files: { path: string; content: string }[], reqs: Entry[]): string[] {
  const errs: string[] = [];
  const byUid = new Map(reqs.map((r) => [r.meta.UID ?? "", r]));
  for (const f of files) {
    const { tags, malformed } = scanArrowTags(f.content);
    for (const m of malformed)
      errs.push(`${f.path}:${m.line}: malformed arrow tag ${m.raw} (expected [utest|itest|stest->R-###])`);
    for (const t of tags) {
      const req = byUid.get(t.uid);
      if (!req) errs.push(`${f.path}:${t.line}: dangling arrow tag [${t.type}->${t.uid}] — no such requirement`);
      else if (req.meta.STATUS === "retired")
        errs.push(`${f.path}:${t.line}: arrow tag [${t.type}->${t.uid}] targets a retired requirement — retire or retarget the test`);
    }
  }
  return errs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/check-docs.test.ts 2>&1 | tail -5`
Expected: PASS — every existing test plus these 9 new trace-pass tests, 0 fail.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint
git add scripts/check-docs.ts scripts/check-docs.test.ts
git commit -m "check-docs: trace-tag passes (forward TEST-file check, reverse sweep)"
```

---

### Task 4: Retrofit tags, wire the gate, document the convention

Retrofit + wiring land in ONE commit so the gate never knowingly ships red (spec §2).

**Files:**
- Modify: `scripts/check-docs.ts` (`main()` + one fs helper)
- Modify (tag comments only, no code changes): `src/model/index.test.ts`, `src/config/index.test.ts`, `src/broker/index.test.ts`, `src/registry/index.test.ts`, `src/ingestion/index.test.ts`, `src/engine/scheduler.test.ts`, `src/engine/faker.test.ts`, `src/engine/dispatch.test.ts`, `src/engine/resolve-emit.test.ts`, `src/engine/index.test.ts`, `src/engine/reset.test.ts`, `src/validation/index.test.ts`, `test/m0-acceptance.test.ts`, `test/spikes/jsf-fidelity.test.ts`
- Modify: `AGENTS.md` (one sentence; `CLAUDE.md` is a symlink to it, do not edit separately)

**Interfaces:**
- Consumes: `checkTestTraces`, `checkTagSweep` (Task 3 signatures).
- Produces: the live gate. From this commit on, `bun scripts/check-docs.ts` fails on honor-system traces.

- [ ] **Step 1: Add the tags**

Complete tag → file mapping (from the current `REQUIREMENTS.md` registry; every `tested` requirement's every `TEST` file). Placement rule: if the file has test(s) whose title contains the UID (find them with `grep -n "R-0" <file>`), put the tag comment on its own line directly above each such `test(...)`; otherwise put it once at the top of the file, directly below the imports. Types: `src/**` → `utest`; `test/m0-acceptance.test.ts` → `itest`; `test/spikes/**` → `stest`.

| File | Tag(s) to add |
|---|---|
| `src/model/index.test.ts` | `// [utest->R-001]` |
| `src/config/index.test.ts` | `// [utest->R-002]` |
| `src/broker/index.test.ts` | `// [utest->R-003]`, `// [utest->R-009]` (R-009 has titled tests, tag each) |
| `src/registry/index.test.ts` | `// [utest->R-004]`, `// [utest->R-026]` |
| `src/ingestion/index.test.ts` | `// [utest->R-005]` |
| `src/engine/scheduler.test.ts` | `// [utest->R-010]` |
| `src/engine/faker.test.ts` | `// [utest->R-011]` |
| `src/engine/dispatch.test.ts` | `// [utest->R-012]` |
| `src/engine/resolve-emit.test.ts` | `// [utest->R-013]` |
| `src/engine/index.test.ts` | `// [utest->R-013]` (R-013-titled tests exist, tag each) |
| `src/engine/reset.test.ts` | `// [utest->R-014]` |
| `src/validation/index.test.ts` | `// [utest->R-015]` |
| `test/m0-acceptance.test.ts` | `// [itest->R-008]`, `// [itest->R-015]` (an R-015 comment near line 117 marks the covering test) |
| `test/spikes/jsf-fidelity.test.ts` | `// [stest->R-027]` |

(`test/transport-isolation.test.ts` traces no requirement; it gets no tag.)

- [ ] **Step 2: Wire `main()`**

In `scripts/check-docs.ts`, add below the `read` helper:

```ts
function listTestFiles(): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  for (const dir of ["src", "test", "scripts"]) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const rel of readdirSync(abs, { recursive: true }) as string[]) {
      if (!rel.endsWith(".test.ts")) continue;
      const p = join(dir, rel);
      out.push({ path: p, content: readFileSync(join(ROOT, p), "utf8") });
    }
  }
  return out;
}
```

And in `main()`, extend the `errors` array (after `...checkLifecycle(reqs),`):

```ts
    ...checkTestTraces(reqs, read),
    ...checkTagSweep(listTestFiles(), reqs),
```

- [ ] **Step 3: Run the gate, expect green**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 31 requirements, 8 decisions, ...`. Any error here is a retrofit miss — the message names the file and UID; fix and rerun.

- [ ] **Step 4: Prove the gate bites (negative check)**

Temporarily delete the `// [utest->R-014]` line from `src/engine/reset.test.ts`, run `bun scripts/check-docs.ts`, expect exit 1 with `R-014: no arrow tag for R-014 in TEST file src/engine/reset.test.ts ...`. Restore the line, rerun, expect ok.

- [ ] **Step 5: Full suite still green**

Run: `bun test > /dev/null 2>&1; echo "exit=$?"`
Expected: `exit=0` (tags are comments; nothing behavioral changed).

- [ ] **Step 6: Document the convention in `AGENTS.md`**

In the **Doc-system gate** paragraph (line ~22), after "...lifecycle consistency (`built`/`tested` require a trace), and well-formed intake." insert:

```
A `tested` requirement's `TEST` files must carry a matching arrow-tag comment (`// [utest->R-###]`, or `itest`/`stest`); the checker verifies tags in both directions (missing and dangling).
```

- [ ] **Step 7: Lint and commit**

```bash
bun run lint
git add scripts/check-docs.ts src test AGENTS.md
git commit -m "check-docs: wire tag verification into the gate; retrofit R-### arrow tags"
```

---

### Task 5: Mutation testing harness (Stryker on `src/engine/`)

**Files:**
- Create: `stryker.conf.json`
- Modify: `package.json` (devDependencies + one script), `.gitignore`

**Interfaces:**
- Consumes: the `bun test` setup (Task 1's bunfig is inherited by the runner's child processes).
- Produces: `bun run mutate` → mutation report for `src/engine/`. Not a gate; no other task depends on it.

- [ ] **Step 1: Install dev-deps**

Run: `bun add -d @stryker-mutator/core @hughescr/stryker-bun-runner`
Expected: both land in `devDependencies`; `dependencies` unchanged.

- [ ] **Step 2: Confirm the runner's config surface**

Run: `sed -n '1,80p' node_modules/@hughescr/stryker-bun-runner/README.md`
Expected: the README states the `testRunner` name to use in Stryker config (expected: `"bun"`) and any runner-specific options. If it differs from the config below, follow the README.

- [ ] **Step 3: Create `stryker.conf.json`**

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "testRunner": "bun",
  "plugins": ["@hughescr/stryker-bun-runner"],
  "coverageAnalysis": "perTest",
  "concurrency": 1,
  "mutate": ["src/engine/**/*.ts", "!src/engine/**/*.test.ts"],
  "reporters": ["clear-text", "progress", "html"],
  "tempDirName": ".stryker-tmp"
}
```

`concurrency: 1` is a hard runner requirement (sequential execution). Scope is `src/engine/` only by design: the deterministic core, where Bun's missing branch coverage hurts most (spec §3).

- [ ] **Step 4: Add the script and gitignore entries**

In `package.json` `scripts`, after `"lint"`: `"mutate": "stryker run"`.
Append to `.gitignore`: `.stryker-tmp/` and `reports/`.

- [ ] **Step 5: Run it**

Run: `bun run mutate` (allow up to 10 minutes; it mutates every engine file and reruns covering tests per mutant)
Expected: a clear-text mutation score table per file and `reports/mutation/mutation.html`. Record the overall score in the task summary; the score is informational, there is no threshold.

**If the runner fails** (spawn errors, hangs, protocol errors — it is a young single-maintainer plugin): fall back to the command runner by replacing `stryker.conf.json` with:

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "testRunner": "command",
  "commandRunner": { "command": "bun test src/engine" },
  "coverageAnalysis": "off",
  "concurrency": 1,
  "mutate": ["src/engine/**/*.ts", "!src/engine/**/*.test.ts"],
  "reporters": ["clear-text", "progress", "html"],
  "tempDirName": ".stryker-tmp"
}
```

and note the fallback in the commit message. If `stryker` itself fails to launch because no Node binary exists on the machine, change the script to `"mutate": "bunx --bun stryker run"` and retry.

- [ ] **Step 6: Gates still green, lint, commit**

Run: `bun test > /dev/null 2>&1; echo "exit=$?"; bun scripts/check-docs.ts; bun run lint`
Expected: `exit=0`, `check-docs: ok`, lint clean.

```bash
git add stryker.conf.json package.json bun.lock .gitignore
git commit -m "tooling: stryker mutation harness for src/engine (manual bun run mutate, not a gate)"
```

---

### Task 6: Decision ledger entry (D-009)

**Files:**
- Modify: `DECISIONS.md` (append; ledger currently ends at D-008)

**Interfaces:**
- Consumes: nothing; records what Tasks 1-5 adopted.
- Produces: the `D-###` provenance required by spec §5. `check-docs.ts` validates the id's contiguity.

- [ ] **Step 1: Append the entry**

Append to the end of `DECISIONS.md`:

```markdown
### D-009: Adopt a coverage gate, arrow-tag traceability, and a mutation-testing harness
**Date**: 2026-07-22
**What**: Three dev-tooling conventions: (1) `bun test` computes coverage on every run (`bunfig.toml`), emits lcov, and fails under ratcheted line/function floors — raise-only, never lowered to admit a regression; (2) a `tested` requirement's `TEST` files must carry OFT-style arrow-tag comments (`// [utest->R-###]`, also `itest`/`stest`), verified both directions by `check-docs.ts` (missing tag in a traced file, dangling/malformed/retired-target tags in the test tree); (3) mutation testing via Stryker + the Bun runner, scoped to `src/engine/`, run manually (`bun run mutate`), never a gate.
**Why**: Bun has no branch coverage (bun#7100), so line/function floors + mutation testing stand in for test-strength measurement; the honor-system `TEST` trace fields were verifiable only by hand. Full OpenFastTrace adoption was rejected (JVM dependency, mandatory `type~name~revision` id grammar, no lifecycle model), but its tag syntax is kept verbatim-compatible so a later migration is mechanical. Provenance: two verified deep-research rounds, 2026-07-22.
**From**: docs/superpowers/specs/2026-07-22-coverage-traceability-tooling-design.md (brainstorm dialog, 2026-07-22)
**Folds into**: AGENTS.md (doc-system gate paragraph)
```

- [ ] **Step 2: Validate and commit**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 31 requirements, 9 decisions, ...`

```bash
git add DECISIONS.md
git commit -m "docs: D-009 — adopt coverage gate, arrow-tag traceability, mutation harness"
```
