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
  const anyHead = /^#{1,6}\s+/;
  const out: Entry[] = [];
  let cur: Entry | null = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const h = line.match(head);
    if (h) {
      if (cur) out.push(cur);
      cur = { title: h[1].trim(), meta: {}, body: "", line: i + 1 };
      return;
    }
    if (anyHead.test(line)) {
      // a heading at any other level ends the current entry, so its meta/body
      // cannot leak into the previous same-level entry
      if (cur) out.push(cur);
      cur = null;
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
    nums.push(Number(id.slice(prefix.length + 1)));
  }
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  for (let i = 0; i < uniq.length; i++)
    if (uniq[i] !== i + 1) {
      errs.push(`${prefix} ids not contiguous from 001 (missing ${prefix}-${String(i + 1).padStart(3, "0")}) — retire in place, never delete`);
      break;
    }
  return errs;
}

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

function read(rel: string): string | null {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

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
  const intakeItems = intakeFiles.filter((f) => f.name !== "_TEMPLATE.md").length;
  console.log(`check-docs: ok — ${reqs.length} requirements, ${decs.length} decisions, ${intakeItems} intake file(s).`);
}

if (import.meta.main) main();
