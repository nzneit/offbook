# Offbook Documentation-System Reorg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Offbook's temporary INDEX.md + per-doc frontmatter scaffold with a durable documentation system: a requirements registry (`R-###`), a decision ledger (`D-###`), a standing intake convention, and a validating checker, per the design in `offbook-doc-system.md` (committed dc6655d).

**Architecture:** Move the four canonical specs into `docs/specs/` and the historical process docs into `docs/archive/`, leaving only `AGENTS.md` and the two ledgers at root. The specs stay the source of truth (conflict rule intact); the registry is an index into them, not a competing source. A rewritten zero-dependency Bun script (`scripts/check-docs.ts`) validates the invariants (unique/contiguous IDs, resolvable `COVERS` anchors, lifecycle consistency, well-formed intake) and is the CI/pre-commit gate.

**Tech Stack:** Bun, TypeScript, `bun test`, `git mv`/`sed` for mechanical moves. The checker hand-parses markdown with `node:fs` only (zero dependencies), matching the existing `scripts/docs-index.ts`.

## Global Constraints

Every task's requirements implicitly include these:

- **Runtime / language / tests:** Bun, TypeScript (strict), `bun test`. The checker is **zero-dependency** (`node:fs` + hand-parsing only), matching `scripts/docs-index.ts`.
- **Two permanent ID namespaces only:** `R-###` (requirements) and `D-###` (decisions), 3-digit zero-padded (`R-001`), **never reused**. Withdrawn entries are retired in place (`STATUS: retired`), never deleted; the checker enforces this by requiring IDs to be contiguous from `001`.
- **Conflict rule:** `docs/specs/contracts.md` is canonical for any interface/API detail. `REQUIREMENTS.md` is an **index into the specs**, never a competing source of truth; its one-line body is a summary and `COVERS` anchors to the normative text.
- **Frozen contract:** `contracts.md` interface/API **content is not edited**. Only its file location and companion-link path text change (path text is not an interface detail).
- **Archive is intact:** historical decision-logs are moved unchanged; their internal cross-references are **not** rewritten (they are historical records).
- **Commits:** **no** co-author / AI-attribution trailer. Commit **only on the user's explicit say-so** — the commit steps are written out, but pause for the user at each review checkpoint.
- **Style:** avoid em-dashes in new recurring formats and prose (use commas, colons, parentheses); the em-dash is kept only in doc titles matching the existing `Offbook — …` family.
- **`COVERS` format:** `<repo-relative-path>#<anchor>`, where `<anchor>` resolves to an explicit `<!-- anchor: NAME -->` marker (preferred) or a heading slug in the target file.

## File Structure

**Created:**
- `REQUIREMENTS.md` (root) — the registry; `R-###` entries indexing the specs.
- `DECISIONS.md` (root) — the append-only decision ledger; `D-###` entries.
- `docs/intake/_TEMPLATE.md` — the standing intake item template.
- `scripts/check-docs.ts` — the validator (replaces `docs-index.ts`).
- `scripts/check-docs.test.ts` — its `bun test` suite.

**Moved (via `git mv`):**
- `offbook-{contracts,design,build-plan,l2-scenarios}.md` → `docs/specs/{contracts,design,build-plan,l2-scenarios}.md` (prefix dropped).
- `offbook-doc-system.md` → `docs/specs/doc-system.md`.
- `offbook-{contracts-decisions,build-gaps,build-gaps-2,build-gaps-3,build-gaps-4,prework,handoff}.md` and the six `offbook-ergonomics-*.md` → `docs/archive/decision-logs/` (prefix dropped).

**Modified:**
- The four specs: companion-link path text rewritten to the new locations.
- `docs/specs/build-plan.md`: `<!-- anchor: NAME -->` markers added at seeded sections (not frozen; safe to edit).
- `AGENTS.md`: doc-map, work-tracking, and status sections rewritten (`CLAUDE.md` symlink inherits it).

**Deleted:**
- `INDEX.md` (by the existing teardown).
- `scripts/docs-index.ts` (replaced by `check-docs.ts`).

---

### Task 1: Retire the frontmatter + INDEX scaffold

**Files:**
- Run: `scripts/docs-index.ts` (existing, used one last time for its teardown)
- Delete: `INDEX.md` (by teardown)
- Modify: every `*.md` with frontmatter (teardown strips it)

**Interfaces:**
- Consumes: the existing `docs-index.ts --teardown` path (strips every `---\n…\n---` block, deletes `INDEX.md`).
- Produces: a frontmatter-free tree, ready to move. `docs-index.ts` itself is removed in Task 5.

- [ ] **Step 1: Preview the teardown (changes nothing)**

Run: `bun scripts/docs-index.ts --teardown --dry-run`
Expected: a list of every doc it "would strip", ending with "would delete INDEX.md" and no warnings (each file's body resumes at its H1). If any file is flagged "body does not start with a heading", stop and inspect before proceeding.

- [ ] **Step 2: Apply the teardown**

Run: `bun scripts/docs-index.ts --teardown`
Expected: "stripped frontmatter from N docs." and "deleted INDEX.md".

- [ ] **Step 3: Verify no frontmatter and no INDEX remain**

Run: `test ! -f INDEX.md && echo "INDEX gone"; grep -lE '^type: (spec|decision-log|handoff|tracker|meta|fixtures)$' *.md fixtures/**/*.md 2>/dev/null || echo "no frontmatter left"`
Expected: `INDEX gone` then `no frontmatter left`.

- [ ] **Step 4: Commit** (on user say-so)

```bash
git add -A
git commit -m "Retire frontmatter + INDEX scaffold (pre-reorg teardown)"
```

---

### Task 2: Create the tree and move every doc

**Files:**
- Create dirs: `docs/specs/`, `docs/intake/`, `docs/archive/decision-logs/`
- Move: the four specs + `doc-system.md` → `docs/specs/`; the 13 historical docs → `docs/archive/decision-logs/`

**Interfaces:**
- Consumes: the frontmatter-free files from Task 1.
- Produces: the target tree. Cross-references are still stale (old `offbook-*.md` names in prose); Task 3 fixes them.

- [ ] **Step 1: Create the directories**

```bash
mkdir -p docs/specs docs/intake docs/archive/decision-logs
```

- [ ] **Step 2: Move the specs (drop the `offbook-` prefix)**

```bash
git mv offbook-contracts.md      docs/specs/contracts.md
git mv offbook-design.md         docs/specs/design.md
git mv offbook-build-plan.md     docs/specs/build-plan.md
git mv offbook-l2-scenarios.md   docs/specs/l2-scenarios.md
git mv offbook-doc-system.md     docs/specs/doc-system.md
```

- [ ] **Step 3: Move the historical strata (drop the prefix)**

```bash
git mv offbook-contracts-decisions.md          docs/archive/decision-logs/contracts-decisions.md
git mv offbook-build-gaps.md                   docs/archive/decision-logs/build-gaps.md
git mv offbook-build-gaps-2.md                 docs/archive/decision-logs/build-gaps-2.md
git mv offbook-build-gaps-3.md                 docs/archive/decision-logs/build-gaps-3.md
git mv offbook-build-gaps-4.md                 docs/archive/decision-logs/build-gaps-4.md
git mv offbook-prework.md                      docs/archive/decision-logs/prework.md
git mv offbook-handoff.md                      docs/archive/decision-logs/handoff.md
git mv offbook-ergonomics-ci-quiescence.md     docs/archive/decision-logs/ergonomics-ci-quiescence.md
git mv offbook-ergonomics-cli-rendering.md     docs/archive/decision-logs/ergonomics-cli-rendering.md
git mv offbook-ergonomics-init-scaffold.md     docs/archive/decision-logs/ergonomics-init-scaffold.md
git mv offbook-ergonomics-l3-hot-reload.md     docs/archive/decision-logs/ergonomics-l3-hot-reload.md
git mv offbook-ergonomics-quick-wins.md        docs/archive/decision-logs/ergonomics-quick-wins.md
git mv offbook-ergonomics-server-observability.md docs/archive/decision-logs/ergonomics-server-observability.md
```

- [ ] **Step 3: Verify the root is clean and the tree is right**

Run: `ls *.md; echo "---"; ls docs/specs; echo "---"; ls docs/archive/decision-logs | wc -l`
Expected: root shows only `AGENTS.md` and `offbook-doc-system-plan.md` (this plan); `docs/specs` shows the 5 files; the archive count is `13`. (`CLAUDE.md` is a symlink and will not show under `*.md` in fish if the target moved — confirm it still resolves in Task 9.)

- [ ] **Step 4: Commit** (on user say-so)

```bash
git add -A
git commit -m "Move specs to docs/specs, archive historical strata"
```

---

### Task 3: Rewrite spec cross-references to the new paths

**Files:**
- Modify: `docs/specs/{contracts,design,build-plan,l2-scenarios}.md`

**Interfaces:**
- Consumes: the moved specs (Task 2). `contracts.md` edits are **path-only** and do not touch interface content (freeze respected).
- Produces: specs whose companion links resolve. `doc-system.md` is intentionally NOT rewritten (its migration narrative names the old files on purpose).

- [ ] **Step 1: Rewrite the four specs' references**

Apply this mapping to each of the four specs (longest tokens first so no token is a prefix of another):

```bash
for f in docs/specs/contracts.md docs/specs/design.md docs/specs/build-plan.md docs/specs/l2-scenarios.md; do
  sed -i \
    -e 's|offbook-contracts-decisions\.md|../archive/decision-logs/contracts-decisions.md|g' \
    -e 's|offbook-ergonomics-cli-rendering\.md|../archive/decision-logs/ergonomics-cli-rendering.md|g' \
    -e 's|offbook-prework\.md|../archive/decision-logs/prework.md|g' \
    -e 's|offbook-handoff\.md|../archive/decision-logs/handoff.md|g' \
    -e 's|offbook-contracts\.md|contracts.md|g' \
    -e 's|offbook-design\.md|design.md|g' \
    -e 's|offbook-build-plan\.md|build-plan.md|g' \
    -e 's|offbook-l2-scenarios\.md|l2-scenarios.md|g' \
    "$f"
done
```

- [ ] **Step 2: Verify no stale `offbook-*.md` reference survives in the specs**

Run: `grep -rnE 'offbook-[a-z0-9-]+\.md' docs/specs/contracts.md docs/specs/design.md docs/specs/build-plan.md docs/specs/l2-scenarios.md || echo "clean"`
Expected: `clean`.

- [ ] **Step 3: Spot-check the frozen contract changed only link text**

Run: `git diff docs/specs/contracts.md`
Expected: every changed line is a companion-link or section-reference path (for example `offbook-design.md` becoming `design.md`); no interface, type, endpoint, or schema text is altered.

- [ ] **Step 4: Commit** (on user say-so)

```bash
git add -A
git commit -m "Rewrite spec cross-references to docs/specs + docs/archive paths"
```

---

### Task 4: Scaffold the ledgers and the intake template

**Files:**
- Create: `REQUIREMENTS.md`, `DECISIONS.md`, `docs/intake/_TEMPLATE.md`

**Interfaces:**
- Produces: `REQUIREMENTS.md` (header + empty registry, seeded in Task 8), `DECISIONS.md` (header + `D-001`), and the intake template. These are the structures the checker (Tasks 5 to 7) validates.

- [ ] **Step 1: Create `REQUIREMENTS.md`**

```markdown
# Offbook — Requirements Registry

*Knows every line. Needs no cast.*

The enumerable list of v1 requirements. Each entry is an atomic statement, a stable never-reused `R-###` UID, a lifecycle `STATUS`, and a `COVERS` anchor into the spec that holds the normative text. This registry is an **index into the specs, not a source of truth**: on any interface detail, `docs/specs/contracts.md` wins (the conflict rule).

**STATUS values:** `specified` (in a spec, not built) · `built` (has an implementation trace) · `tested` (has a covering test) · `deferred` (v2) · `retired` (withdrawn, kept in place so its ID is never reused). `built` and `tested` are **derived** by `scripts/check-docs.ts` from trace fields, not asserted by hand.

**Entry format:**

```
#### <short human title>
**UID**: R-001
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-0
<one-sentence requirement statement>
```

## Registry

<!-- entries seeded in the build phase; see docs/specs/doc-system.md §7 -->
```

- [ ] **Step 2: Create `DECISIONS.md` with the first real entry**

```markdown
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
```

- [ ] **Step 3: Create `docs/intake/_TEMPLATE.md`**

```markdown
# YYYY-MM-DD: <topic> (intake)
**Status**: open
**Owner**: <who owes the decision>

## a — <question>
<context, options, recommendation>
→ Resolution: <decision> → allocates D-### / R-###

## b — <question>
<context, options, recommendation>
→ Resolution: <decision> → allocates D-### / R-###
```

- [ ] **Step 4: Commit** (on user say-so)

```bash
git add REQUIREMENTS.md DECISIONS.md docs/intake/_TEMPLATE.md
git commit -m "Scaffold REQUIREMENTS.md, DECISIONS.md (D-001), intake template"
```

---

### Task 5: Checker — parsing and ID invariants

**Files:**
- Create: `scripts/check-docs.ts`
- Create: `scripts/check-docs.test.ts`
- Delete: `scripts/docs-index.ts`

**Interfaces:**
- Produces:
  - `parseEntries(text: string, level: 3 | 4): Entry[]` where `Entry = { title: string; meta: Record<string, string>; body: string; line: number }`
  - `checkIds(entries: Entry[], prefix: string, getId: (e: Entry) => string): string[]` (returns human-readable error strings; empty = ok)
  - an interim `main()` that validates `REQUIREMENTS.md` + `DECISIONS.md` ids and exits nonzero on any problem.

- [ ] **Step 1: Write the failing tests**

Create `scripts/check-docs.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseEntries, checkIds } from "./check-docs.ts";

test("parseEntries reads UID meta and the statement body", () => {
  const t = `#### Seeded determinism\n**UID**: R-001\n**STATUS**: specified\nThe scheduler is deterministic.`;
  const [e] = parseEntries(t, 4);
  expect(e.meta.UID).toBe("R-001");
  expect(e.meta.STATUS).toBe("specified");
  expect(e.body).toBe("The scheduler is deterministic.");
});

test("parseEntries isolates heading levels (#### not caught by level 3)", () => {
  const t = `### D-001: a decision\n#### R-thing\n**UID**: R-001`;
  expect(parseEntries(t, 3).map((e) => e.title)).toEqual(["D-001: a decision"]);
});

test("checkIds flags a duplicate", () => {
  const entries = [
    { title: "", meta: { UID: "R-001" }, body: "", line: 1 },
    { title: "", meta: { UID: "R-001" }, body: "", line: 5 },
  ];
  expect(checkIds(entries, "R", (e) => e.meta.UID).some((m) => m.includes("duplicate R-001"))).toBe(true);
});

test("checkIds flags a gap (a deleted id)", () => {
  const entries = [
    { title: "", meta: { UID: "R-001" }, body: "", line: 1 },
    { title: "", meta: { UID: "R-003" }, body: "", line: 5 },
  ];
  expect(checkIds(entries, "R", (e) => e.meta.UID).some((m) => m.includes("contiguous"))).toBe(true);
});

test("checkIds passes a clean contiguous set", () => {
  const entries = [
    { title: "", meta: { UID: "R-001" }, body: "", line: 1 },
    { title: "", meta: { UID: "R-002" }, body: "", line: 5 },
  ];
  expect(checkIds(entries, "R", (e) => e.meta.UID)).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test scripts/check-docs.test.ts`
Expected: FAIL — cannot resolve `./check-docs.ts` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/check-docs.ts`:

```ts
#!/usr/bin/env bun
// check-docs.ts — validate the Offbook documentation-system invariants.
// Zero dependencies: node:fs + hand-parsing, matching the retired docs-index.ts.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

export type Entry = { title: string; meta: Record<string, string>; body: string; line: number };

// Split a doc into heading blocks at exactly `level` hashes. The trailing \s in
// the pattern means a level-3 regex never matches a #### heading and vice-versa.
export function parseEntries(text: string, level: 3 | 4): Entry[] {
  const head = new RegExp(`^#{${level}}\\s+(.+)$`);
  const out: Entry[] = [];
  let cur: Entry | null = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const h = line.match(head);
    if (h) {
      if (cur) out.push(cur);
      cur = { title: h[1].trim(), meta: {}, body: "", line: i + 1 };
      return;
    }
    if (!cur) return;
    const m = line.match(/^\*\*([A-Za-z]+)\*\*:\s*(.*)$/);
    if (m) cur.meta[m[1].toUpperCase()] = m[2].trim();
    else if (line.trim()) cur.body += (cur.body ? "\n" : "") + line;
  });
  if (cur) out.push(cur);
  return out;
}

// Unique + well-formed + contiguous-from-001. Contiguity enforces "retire in
// place, never delete", which is how IDs are guaranteed never reused.
export function checkIds(entries: Entry[], prefix: string, getId: (e: Entry) => string): string[] {
  const errs: string[] = [];
  const re = new RegExp(`^${prefix}-\\d{3}$`);
  const seen = new Set<string>();
  const nums: number[] = [];
  for (const e of entries) {
    const id = getId(e);
    if (!re.test(id)) { errs.push(`bad ${prefix} id: "${id}" (line ${e.line})`); continue; }
    if (seen.has(id)) errs.push(`duplicate ${id}`);
    seen.add(id);
    nums.push(Number(id.slice(2)));
  }
  nums.sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++)
    if (nums[i] !== i + 1) {
      errs.push(`${prefix} ids not contiguous from 001 (missing ${prefix}-${String(i + 1).padStart(3, "0")}) — retire in place, never delete`);
      break;
    }
  return errs;
}

function read(rel: string): string | null {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function main(): void {
  const reqs = parseEntries(read("REQUIREMENTS.md") ?? "", 4).filter((e) => e.meta.UID);
  const decs = parseEntries(read("DECISIONS.md") ?? "", 3).filter((e) => /^D-\d+/.test(e.title));
  const errors = [
    ...checkIds(reqs, "R", (e) => e.meta.UID ?? ""),
    ...checkIds(decs, "D", (e) => e.title.match(/^(D-\d+)/)?.[1] ?? ""),
  ];
  if (errors.length) {
    console.error(`check-docs: ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`check-docs: ok — ${reqs.length} requirements, ${decs.length} decisions.`);
}

if (import.meta.main) main();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test scripts/check-docs.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the checker against the real ledgers**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 0 requirements, 1 decisions.` (registry seeded later; `D-001` from Task 4).

- [ ] **Step 6: Remove the retired script and commit** (on user say-so)

```bash
git rm scripts/docs-index.ts
git add scripts/check-docs.ts scripts/check-docs.test.ts
git commit -m "Add check-docs.ts (parse + ID invariants); remove docs-index.ts"
```

---

### Task 6: Checker — COVERS anchor resolution

**Files:**
- Modify: `scripts/check-docs.ts`
- Modify: `scripts/check-docs.test.ts`

**Interfaces:**
- Consumes: `Entry`, `read` from Task 5.
- Produces:
  - `slugify(heading: string): string`
  - `parseCovers(covers: string): { path: string; anchor?: string }`
  - `resolveAnchor(fileText: string, anchor: string): boolean` (explicit `<!-- anchor: NAME -->` marker, or a heading whose slug matches)
  - `checkCovers(reqs: Entry[], readFile: (rel: string) => string | null): string[]`
  - `main()` extended to run `checkCovers`.

- [ ] **Step 1: Add the failing tests**

Append to `scripts/check-docs.test.ts`:

```ts
import { parseCovers, resolveAnchor, checkCovers } from "./check-docs.ts";

test("parseCovers splits path and anchor", () => {
  expect(parseCovers("docs/specs/build-plan.md#tier-0")).toEqual({ path: "docs/specs/build-plan.md", anchor: "tier-0" });
});

test("resolveAnchor finds an explicit marker", () => {
  expect(resolveAnchor("intro\n<!-- anchor: tier-0 -->\nbody", "tier-0")).toBe(true);
});

test("resolveAnchor finds a heading slug", () => {
  expect(resolveAnchor("## Tier 0 foundation\n", "tier-0-foundation")).toBe(true);
});

test("checkCovers errors when the file is missing", () => {
  const reqs = [{ title: "", meta: { UID: "R-001", COVERS: "docs/specs/nope.md#x" }, body: "", line: 1 }];
  expect(checkCovers(reqs, () => null).some((m) => m.includes("path not found"))).toBe(true);
});

test("checkCovers errors when the anchor is missing", () => {
  const reqs = [{ title: "", meta: { UID: "R-001", COVERS: "docs/specs/build-plan.md#ghost" }, body: "", line: 1 }];
  expect(checkCovers(reqs, () => "no marker, no matching heading").some((m) => m.includes("anchor not found"))).toBe(true);
});

test("checkCovers errors when COVERS is absent", () => {
  const reqs = [{ title: "", meta: { UID: "R-001" }, body: "", line: 1 }];
  expect(checkCovers(reqs, () => "").some((m) => m.includes("missing COVERS"))).toBe(true);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `bun test scripts/check-docs.test.ts`
Expected: FAIL — `parseCovers`/`resolveAnchor`/`checkCovers` are not exported yet.

- [ ] **Step 3: Implement the anchor resolver**

Add to `scripts/check-docs.ts` (above `main`):

```ts
export function slugify(heading: string): string {
  return heading.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

export function parseCovers(covers: string): { path: string; anchor?: string } {
  const [path, anchor] = covers.split("#");
  return anchor ? { path: path.trim(), anchor: anchor.trim() } : { path: path.trim() };
}

export function resolveAnchor(fileText: string, anchor: string): boolean {
  if (fileText.includes(`<!-- anchor: ${anchor} -->`)) return true;
  const headings = fileText.match(/^#{1,6}\s+.+$/gm) ?? [];
  return headings.some((h) => slugify(h.replace(/^#{1,6}\s+/, "")) === anchor);
}

export function checkCovers(reqs: Entry[], readFile: (rel: string) => string | null): string[] {
  const errs: string[] = [];
  for (const r of reqs) {
    const uid = r.meta.UID ?? "?";
    const covers = r.meta.COVERS;
    if (!covers) { errs.push(`${uid}: missing COVERS`); continue; }
    const { path, anchor } = parseCovers(covers);
    const text = readFile(path);
    if (text == null) { errs.push(`${uid}: COVERS path not found: ${path}`); continue; }
    if (anchor && !resolveAnchor(text, anchor)) errs.push(`${uid}: COVERS anchor not found: ${path}#${anchor}`);
  }
  return errs;
}
```

Extend `main()` — replace the `errors` array with:

```ts
  const errors = [
    ...checkIds(reqs, "R", (e) => e.meta.UID ?? ""),
    ...checkIds(decs, "D", (e) => e.title.match(/^(D-\d+)/)?.[1] ?? ""),
    ...checkCovers(reqs, read),
  ];
```

- [ ] **Step 4: Run to verify all tests pass**

Run: `bun test scripts/check-docs.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit** (on user say-so)

```bash
git add scripts/check-docs.ts scripts/check-docs.test.ts
git commit -m "check-docs.ts: COVERS anchor resolution"
```

---

### Task 7: Checker — lifecycle and intake validation

**Files:**
- Modify: `scripts/check-docs.ts`
- Modify: `scripts/check-docs.test.ts`

**Interfaces:**
- Consumes: `Entry`, `read` from Task 5.
- Produces:
  - `checkLifecycle(reqs: Entry[]): string[]` (STATUS enum; `built` requires `IMPL`, `tested` requires `TEST`)
  - `checkIntake(files: { name: string; content: string }[]): string[]`
  - the final `main()` wiring all five validators plus the intake-directory scan; the default action is the validation gate (nonzero exit on any problem).

- [ ] **Step 1: Add the failing tests**

Append to `scripts/check-docs.test.ts`:

```ts
import { checkLifecycle, checkIntake } from "./check-docs.ts";

test("checkLifecycle rejects an unknown status", () => {
  expect(checkLifecycle([{ title: "", meta: { UID: "R-001", STATUS: "done" }, body: "", line: 1 }]).some((m) => m.includes("invalid STATUS"))).toBe(true);
});

test("checkLifecycle requires IMPL for built", () => {
  expect(checkLifecycle([{ title: "", meta: { UID: "R-001", STATUS: "built" }, body: "", line: 1 }]).some((m) => m.includes("IMPL"))).toBe(true);
});

test("checkLifecycle passes specified with no trace", () => {
  expect(checkLifecycle([{ title: "", meta: { UID: "R-001", STATUS: "specified" }, body: "", line: 1 }])).toEqual([]);
});

test("checkIntake flags a resolved file left in intake", () => {
  expect(checkIntake([{ name: "2026-07-10-x.md", content: "**Status**: resolved" }]).some((m) => m.includes("move to"))).toBe(true);
});

test("checkIntake flags a missing status line", () => {
  expect(checkIntake([{ name: "2026-07-10-x.md", content: "no status here" }]).some((m) => m.includes("Status"))).toBe(true);
});

test("checkIntake ignores the template", () => {
  expect(checkIntake([{ name: "_TEMPLATE.md", content: "no status" }])).toEqual([]);
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `bun test scripts/check-docs.test.ts`
Expected: FAIL — `checkLifecycle`/`checkIntake` not exported yet.

- [ ] **Step 3: Implement lifecycle + intake and finalize `main`**

Add to `scripts/check-docs.ts` (above `main`):

```ts
const STATUSES = ["specified", "built", "tested", "deferred", "retired"];

export function checkLifecycle(reqs: Entry[]): string[] {
  const errs: string[] = [];
  for (const r of reqs) {
    const uid = r.meta.UID ?? "?";
    const s = r.meta.STATUS;
    if (!s) { errs.push(`${uid}: missing STATUS`); continue; }
    if (!STATUSES.includes(s)) { errs.push(`${uid}: invalid STATUS "${s}" (allowed: ${STATUSES.join(", ")})`); continue; }
    if (s === "built" && !r.meta.IMPL) errs.push(`${uid}: STATUS built requires an IMPL trace`);
    if (s === "tested" && !r.meta.TEST) errs.push(`${uid}: STATUS tested requires a TEST trace`);
  }
  return errs;
}

export function checkIntake(files: { name: string; content: string }[]): string[] {
  const errs: string[] = [];
  for (const f of files) {
    if (f.name === "_TEMPLATE.md") continue;
    const m = f.content.match(/^\*\*Status\*\*:\s*(open|resolved)\s*$/m);
    if (!m) { errs.push(`intake/${f.name}: missing or invalid **Status**: (open|resolved)`); continue; }
    if (m[1] === "resolved") errs.push(`intake/${f.name}: resolved — move to docs/archive/intake/`);
  }
  return errs;
}
```

Replace `main()` with its final form:

```ts
function main(): void {
  const reqs = parseEntries(read("REQUIREMENTS.md") ?? "", 4).filter((e) => e.meta.UID);
  const decs = parseEntries(read("DECISIONS.md") ?? "", 3).filter((e) => /^D-\d+/.test(e.title));

  const intakeDir = join(ROOT, "docs/intake");
  const intakeFiles = existsSync(intakeDir)
    ? readdirSync(intakeDir).filter((n) => n.endsWith(".md")).map((n) => ({ name: n, content: readFileSync(join(intakeDir, n), "utf8") }))
    : [];

  const errors = [
    ...checkIds(reqs, "R", (e) => e.meta.UID ?? ""),
    ...checkIds(decs, "D", (e) => e.title.match(/^(D-\d+)/)?.[1] ?? ""),
    ...checkCovers(reqs, read),
    ...checkLifecycle(reqs),
    ...checkIntake(intakeFiles),
  ];

  if (errors.length) {
    console.error(`check-docs: ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`check-docs: ok — ${reqs.length} requirements, ${decs.length} decisions, ${intakeFiles.length} intake file(s).`);
}
```

- [ ] **Step 4: Run to verify all tests pass**

Run: `bun test scripts/check-docs.test.ts`
Expected: PASS (18 tests).

- [ ] **Step 5: Run the full checker**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 0 requirements, 1 decisions, 0 intake file(s).`

- [ ] **Step 6: Commit** (on user say-so)

```bash
git add scripts/check-docs.ts scripts/check-docs.test.ts
git commit -m "check-docs.ts: lifecycle + intake validation; finalize gate"
```

---

### Task 8: Seed the registry from the build-plan acceptance criteria

**Files:**
- Modify: `docs/specs/build-plan.md` (add `<!-- anchor: NAME -->` markers; not frozen)
- Modify: `REQUIREMENTS.md` (add the first batch of `R-###` entries)

**Interfaces:**
- Consumes: the checker (Tasks 5 to 7) to verify each entry resolves.
- Produces: the Tier-0, Tier-1, and spike requirements as `R-001`..`R-007`. Remaining tiers and contract obligations follow the documented staged process.

- [ ] **Step 1: Add anchor markers to the build-plan sections being covered**

Append the marker to the end of each target heading line in `docs/specs/build-plan.md` (the heading text is unchanged; the marker is an HTML comment):

```bash
cd docs/specs
sed -i \
  -e '/^### Tier 0 — foundation/ s/$/ <!-- anchor: tier-0 -->/' \
  -e '/^### Tier 1 — parallel/ s/$/ <!-- anchor: tier-1 -->/' \
  -e '/^## 5\. The de-risking spikes/ s/$/ <!-- anchor: spikes -->/' \
  build-plan.md
cd ../..
grep -nE '<!-- anchor: (tier-0|tier-1|spikes) -->' docs/specs/build-plan.md
```

Expected: three lines printed, one per marker.

- [ ] **Step 2: Seed the first requirements batch**

Replace the `## Registry` placeholder comment in `REQUIREMENTS.md` with these entries (statements lifted from the build-plan acceptance criteria):

```markdown
## Registry

#### model/ contract types present and exported
**UID**: R-001
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-0
Every type in contracts.md §1–6 is transcribed, `tsc`-clean, and exported from `src/model/`.

#### config/ loads services + environments to typed objects
**UID**: R-002
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-0
`config/` loads a `services.yaml` (including a `topicOverrides` entry) and `environments.yaml` into typed objects with no `ingestion/` import.

#### broker/ ws connect, retained receipt, QoS-1 round-trip
**UID**: R-003
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-1
A browser-style `mqtt.js` client connects to the Aedes ws listener over MQTT 3.1.1, subscribes, receives a retained message, and a QoS-1 publish round-trips.

#### registry/ parses fixtures, matches topics, resolves qos/retain
**UID**: R-004
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-1
`registry/` parses every `fixtures/asyncapi/*` (including external-ref, qos-retain, qos-overrides), resolves channel direction and the qos/retain precedence chain, and its `match`/`matchesFilter` behave per the §5 correctness bar.

#### ingestion/ branch-tip fetch and lockfile writer
**UID**: R-005
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#tier-1
`ingestion/` resolves a fixture spec at a branch tip, records the post-fetch SHA + content-hash + declared-version to `specs.lock`, and imports no AsyncAPI parser.

#### WS-fidelity spike is the authoritative connect gate
**UID**: R-006
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#spikes
The real browser application's `mqtt.js` connects+subscribes+receives-retained against a bare Aedes ws listener, finalizing the broker's listener config (subprotocol/path/auth).

#### capture the browser application's connect()
**UID**: R-007
**STATUS**: specified
**COVERS**: docs/specs/build-plan.md#spikes
The client's `connect()` auth fields, ws URL/path, subprotocol, protocol level, and any QoS-2 use are captured into a config fixture + broker ws port default.
```

- [ ] **Step 3: Run the checker to verify every entry resolves**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 7 requirements, 1 decisions, 0 intake file(s).` If it reports `COVERS anchor not found`, the marker in Step 1 did not land on that heading; fix the marker, not the entry.

- [ ] **Step 4: Record the staged-seeding process for the rest**

Append to `REQUIREMENTS.md`:

```markdown
<!--
Seeding is staged (doc-system.md §7). Batch 1 (R-001..R-007): Tier 0/1 + spikes.
Next batches, allocated in order from R-008:
  - Tier 2 (engine/, validation/), Tier 3 (scenarios/, control-plane/), Tier 4 (cli/) acceptance criteria — build-plan.md §3.
  - The v1 acceptance gate items — build-plan.md §4 (add an anchor per section covered).
  - Contract obligations and hard constraints — contracts.md, AGENTS.md (add explicit <!-- anchor: NAME --> markers; contract markers are additive and do not alter frozen interface content).
Allocate the next id = max existing + 1; never reuse. Run `bun scripts/check-docs.ts` after each batch.
-->
```

- [ ] **Step 5: Commit** (on user say-so)

```bash
git add REQUIREMENTS.md docs/specs/build-plan.md
git commit -m "Seed registry batch 1 (R-001..R-007: Tier 0/1 + spikes)"
```

---

### Task 9: Fold the handoff, rewrite AGENTS.md, wire the gate

**Files:**
- Modify: `AGENTS.md` (doc-map, work-tracking, status sections; `CLAUDE.md` symlink inherits)
- Read: `docs/archive/decision-logs/handoff.md` (fold its "what to build, in order" into AGENTS status)

**Interfaces:**
- Consumes: everything from Tasks 1 to 8.
- Produces: an entry point that points at the new tree and names `REQUIREMENTS.md` as the work list; the checker documented as the gate. Final verification proves the whole system green.

- [ ] **Step 1: Confirm the CLAUDE.md symlink still resolves**

Run: `readlink CLAUDE.md; head -1 CLAUDE.md`
Expected: `AGENTS.md` and the first line of AGENTS.md. (The symlink target did not move, so it should be intact.)

- [ ] **Step 2: Rewrite the AGENTS.md "Doc map" section**

Replace the current "## Doc map" list (the `offbook-*.md` bullets) and the "Conflict rule" line with:

```markdown
## Doc map (which doc is canonical for what)
- **`docs/specs/contracts.md`** — the **frozen v1 interfaces & HTTP API**. The synchronization point; build against this. *Canonical for types/endpoints/config schemas.*
- **`docs/specs/design.md`** — decisions & rationale (§1–§12). *Canonical for "why".*
- **`docs/specs/l2-scenarios.md`** — the L2 scenario authoring format.
- **`docs/specs/build-plan.md`** — tech stack, repo scaffold, tiered dependency graph, per-module acceptance, spike specs.
- **`docs/specs/doc-system.md`** — how this documentation system is organized.
- **`REQUIREMENTS.md`** — the enumerable v1 requirements registry (`R-###`); the answer to "what needs building, and is it done".
- **`DECISIONS.md`** — the decision ledger (`D-###`); forward-authoritative provenance.
- **`docs/intake/`** — open review-round items (start from `_TEMPLATE.md`); resolve into `R-###`/`D-###`, then move to `docs/archive/`.
- **`docs/archive/`** — resolved intake + the historical decision-logs (original G/F/S/P/EQ ids, intact).
- **`fixtures/asyncapi/`** — test specs + their README (incl. the **Fixture quality bar**).

**Conflict rule:** if any doc disagrees with `docs/specs/contracts.md` on an interface/API detail, the contract wins — fix the other doc. `REQUIREMENTS.md` indexes the specs; it is never a competing source of truth.
```

- [ ] **Step 3: Replace the "Work tracking (temporary scaffold)" paragraph**

Replace it with the standing-system description:

```markdown
**Doc-system gate.** The corpus is validated by `bun scripts/check-docs.ts`: unique/contiguous `R-###`/`D-###` ids, resolvable `COVERS` anchors, lifecycle consistency (`built`/`tested` require a trace), and well-formed intake. Run it before committing; it is the CI/pre-commit gate. See `docs/specs/doc-system.md` for the full design.
```

- [ ] **Step 4: Fold the handoff into the "Status & next" section**

Read `docs/archive/decision-logs/handoff.md` for its current "what to build, in order" content, and update the AGENTS.md "## Status & next" section so the ordering points at `REQUIREMENTS.md` (the registry sorted by lifecycle is the work list) with the spikes (`R-006`/`R-007`) called out as the parallel build-gates. Keep it to the same 2 to 3 sentences the section already uses.

- [ ] **Step 5: Verify no stale references remain in the entry point**

Run: `grep -nE 'offbook-[a-z0-9-]+\.md|INDEX\.md|docs-index' AGENTS.md || echo "clean"`
Expected: `clean`.

- [ ] **Step 6: Full-system verification**

Run: `bun test scripts/check-docs.test.ts && bun scripts/check-docs.ts && grep -rnE 'offbook-[a-z0-9-]+\.md' docs/specs/contracts.md docs/specs/design.md docs/specs/build-plan.md docs/specs/l2-scenarios.md AGENTS.md || echo "ALL GREEN"`
Expected: 18 tests pass, `check-docs: ok — 7 requirements, 1 decisions, 0 intake file(s).`, then `ALL GREEN` (no stale references in any living doc).

- [ ] **Step 7: Commit** (on user say-so)

```bash
git add AGENTS.md
git commit -m "Fold handoff into AGENTS.md; point entry-point at the registry + gate"
```

---

## Self-Review

**1. Spec coverage** (against `offbook-doc-system.md`):

| Spec section | Task |
|---|---|
| §4.1 two ID namespaces | Task 5 (`checkIds` format + contiguity) |
| §4.2 directory layout | Tasks 2, 4 |
| §4.3 REQUIREMENTS.md registry | Tasks 4, 8 |
| §4.4 DECISIONS.md ledger | Task 4 (D-001), forward-only note |
| §4.5 intake convention | Task 4 (template), Task 7 (`checkIntake`) |
| §4.6 AGENTS.md entry point | Task 9 |
| §4.7 the checker | Tasks 5, 6, 7 |
| §4.8 anchor mechanism (split-safe) | Task 6 (`resolveAnchor`), Task 8 (markers) |
| §5 out of scope (no monolith split, no back-fill) | honored: specs moved not split; archive intact |
| §6 migration (8 steps) | Tasks 1–9 |
| §7 seeding cost (acceptance-first, staged) | Task 8 |

No spec section is unimplemented. The single pre-existing open item (P1 spikes) is seeded as `R-006`/`R-007` (Task 8).

**2. Placeholder scan:** the only `<...>` tokens are inside the intake **template** (Task 4) and the registry **entry-format example** (Task 4), which are meant to be literal templates. All executable steps carry real code or exact commands.

**3. Type consistency:** `Entry`, `parseEntries`, `checkIds(entries, prefix, getId)`, `parseCovers`, `resolveAnchor`, `slugify`, `checkCovers(reqs, readFile)`, `checkLifecycle`, `checkIntake` keep the same signatures from introduction (Tasks 5 to 7) through `main()`. `main()` is shown in interim form (Task 5), extended (Task 6), and final (Task 7) with no signature drift.

---

## Execution Handoff

Plan complete and saved to `offbook-doc-system-plan.md` (root, sibling to the spec, matching the repo convention; it is a transient build artifact and can be archived once executed). Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — I execute the tasks in this session using executing-plans, batching with checkpoints for your review.

Which approach?
