#!/usr/bin/env bun
// check-docs.ts — validate the Offbook documentation-system invariants.
// Zero dependencies: node:fs + hand-parsing, matching the retired docs-index.ts.
import { readFileSync, existsSync } from "node:fs";
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
