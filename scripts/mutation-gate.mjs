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
