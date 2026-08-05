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
