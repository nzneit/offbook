#!/usr/bin/env bun
// docs-index.ts — generate INDEX.md from each doc's frontmatter.
//
// TEMPORARY, intentionally idiosyncratic work-tracking scaffold. Wind down at MVP:
//   bun scripts/docs-index.ts --teardown   # strip every frontmatter block + delete INDEX.md
//   rm -r scripts                           # then delete this script + the AGENTS.md pointer line
//
// Zero dependencies (frontmatter is hand-parsed). Usage:
//   bun scripts/docs-index.ts            regenerate INDEX.md
//   bun scripts/docs-index.ts --check    exit 1 if INDEX.md is stale (optional pre-commit hook)
//   bun scripts/docs-index.ts --teardown remove the scaffold
//   bun scripts/docs-index.ts --teardown --dry-run   preview teardown — show what it would do, change nothing

import { readFileSync, writeFileSync, unlinkSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const INDEX = join(ROOT, "INDEX.md");
const SCAN = ["*.md", "fixtures/**/*.md"]; // project docs only — never .git/.claude/node_modules

type Meta = {
  type?: string;
  status?: string;
  summary?: string;
  supersedes?: string;
  foldsInto?: string[];
  related?: string[];
};
type Doc = Meta & { rel: string; title: string; open: number };

function docPaths(): string[] {
  const set = new Set<string>();
  for (const pat of SCAN)
    for (const rel of new Bun.Glob(pat).scanSync({ cwd: ROOT })) set.add(rel);
  return [...set]
    .filter((rel) => rel !== "INDEX.md" && !lstatSync(join(ROOT, rel)).isSymbolicLink())
    .sort();
}

// Hand-parse a leading `---\n…\n---` block. `key: value`, plus `key: [a, b]` lists.
function parseFrontmatter(text: string): { meta: Meta; body: string } {
  // Match `---\n<block>\n---` plus the closing line's trailing blank line(s), so the
  // body resumes exactly at the first real content (clean teardown round-trip).
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n+|$)/);
  if (!fm) return { meta: {}, body: text };
  const body = text.slice(fm[0].length);
  const meta: Record<string, unknown> = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([a-z][a-z-]*):\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // folds-into → foldsInto
    const raw = m[2].trim();
    meta[key] =
      raw.startsWith("[") && raw.endsWith("]")
        ? raw.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean)
        : raw;
  }
  return { meta: meta as Meta, body };
}

const titleOf = (body: string) => (body.match(/^#\s+(.+)$/m)?.[1] ?? "(untitled)").trim();
const short = (t: string) => t.replace(/^Offbook\s+—\s+/, "");
const docLink = (d: Doc) => `[${short(d.title)}](${d.rel})`;
const slugLink = (slug: string) => `[${slug.replace(/^offbook-/, "")}](${slug}.md)`;

function load(): Doc[] {
  return docPaths().map((rel) => {
    const { meta, body } = parseFrontmatter(readFileSync(join(ROOT, rel), "utf8"));
    return { rel, title: titleOf(body), open: (body.match(/☐/g) ?? []).length, ...meta };
  });
}

const PREAMBLE = `# Offbook — Document Index

> **GENERATED — do not edit by hand.** Regenerate after adding/editing a doc's frontmatter:
> \`bun scripts/docs-index.ts\`. This index and the per-doc frontmatter are a **temporary,
> intentionally idiosyncratic work-tracking scaffold.** Wind it down at MVP:
> \`bun scripts/docs-index.ts --teardown\` (strips all frontmatter + deletes this file).

**Frontmatter schema** (top of each doc): \`type\` (spec · decision-log · handoff · tracker · meta · fixtures) ·
\`status\` (living · open · resolved · superseded) · \`summary\` (one line) · optional \`supersedes\` / \`folds-into\` / \`related\`.

**Disciplines.** \`offbook-contracts.md\` is the canonical authority (the conflict rule). A **handoff is transient:**
when every \`☐\` item is ticked, its decisions **fold into** the canonical doc named in \`folds-into\` and its
\`status\` flips to \`resolved\` — moving it from *Open work* to *Archive*. The live set you actually track is just the
*Open work* frontier below.`;

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function renderIndex(docs: Doc[]): string {
  const isOpen = (d: Doc) => d.status === "open";
  const isArchive = (d: Doc) => d.status === "resolved" || d.status === "superseded";
  const open = docs.filter(isOpen);
  const archive = docs.filter(isArchive);
  const reference = docs.filter((d) => !isOpen(d) && !isArchive(d));
  const totalOpen = open.reduce((n, d) => n + d.open, 0);

  return (
    [
      PREAMBLE,
      `## Open work — the live frontier (${open.length} docs, ${totalOpen} open items)\n\n` +
        table(
          ["Doc", "Open", "Folds into", "Summary"],
          open.map((d) => [
            docLink(d),
            String(d.open),
            (d.foldsInto ?? []).map(slugLink).join(", ") || "—",
            d.summary ?? "",
          ]),
        ),
      `## Reference — canonical & living\n\n` +
        table(
          ["Doc", "Type", "Summary"],
          reference.map((d) => [docLink(d), d.type ?? "", d.summary ?? ""]),
        ),
      `## Archive — resolved records\n\n` +
        table(
          ["Doc", "Type", "Status", "Lineage", "Summary"],
          archive.map((d) => [
            docLink(d),
            d.type ?? "",
            d.status ?? "",
            d.supersedes ? `supersedes ${slugLink(d.supersedes)}` : "—",
            d.summary ?? "",
          ]),
        ),
    ].join("\n\n") + "\n"
  );
}

function teardown(dry: boolean): void {
  const verb = dry ? "would strip" : "stripped";
  let count = 0;
  let warnings = 0;
  for (const rel of docPaths()) {
    const abs = join(ROOT, rel);
    const text = readFileSync(abs, "utf8");
    const { meta, body } = parseFrontmatter(text);
    if (body === text) continue; // no frontmatter block — untouched
    count++;
    const keep = body.split("\n", 1)[0];
    const ok = body.startsWith("#"); // body should resume at the H1 — guards against over-stripping
    if (!ok) warnings++;
    console.log(`  ${rel}`);
    console.log(`      strip: ${Object.keys(meta).join(", ") || "(none)"}`);
    console.log(`      keep : ${keep}${ok ? "" : "   ⚠ body does not start with a heading — inspect"}`);
    if (!dry) writeFileSync(abs, body);
  }
  const hadIndex = existsSync(INDEX);
  if (!dry && hadIndex) unlinkSync(INDEX);
  console.log("");
  console.log(`${verb} frontmatter from ${count} docs.`);
  if (hadIndex) console.log(`${dry ? "would delete" : "deleted"} INDEX.md`);
  if (warnings) console.log(`⚠ ${warnings} file(s) flagged above — review before applying.`);
  console.log(
    dry
      ? "\nDry run — nothing changed. Apply with: bun scripts/docs-index.ts --teardown"
      : "\nFinish wind-down: rm -r scripts  and delete the 'Work tracking' line in AGENTS.md.",
  );
}

const args = new Set(process.argv.slice(2));
if (args.has("--teardown")) {
  teardown(args.has("--dry-run"));
} else {
  const docs = load();
  const rendered = renderIndex(docs);
  if (args.has("--check")) {
    const cur = existsSync(INDEX) ? readFileSync(INDEX, "utf8") : "";
    if (cur !== rendered) {
      console.error("INDEX.md is stale — run: bun scripts/docs-index.ts");
      process.exit(1);
    }
    console.log("INDEX.md is up to date.");
  } else {
    writeFileSync(INDEX, rendered);
    console.log(`Wrote INDEX.md — ${docs.length} docs.`);
  }
}
