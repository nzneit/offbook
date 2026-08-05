import { test, expect } from "bun:test";
import { parseNameStatusZ, countLines, globToRegExp, matchesMutateGlobs, UnsupportedGlobError } from "./mutation-gate.mjs";

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
