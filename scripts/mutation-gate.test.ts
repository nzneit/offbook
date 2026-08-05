import { test, expect } from "bun:test";
import { parseNameStatusZ, countLines, globToRegExp, matchesMutateGlobs, UnsupportedGlobError, siblingOf, selectMutateSet, DEFAULTS, readConfig, decide, interpretReport, renderSkip, renderResult, renderInfra, formatGithubOutputs, EXIT, resolveDefaultBase, readMutateGlobs, main, realDeps } from "./mutation-gate.mjs";

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
