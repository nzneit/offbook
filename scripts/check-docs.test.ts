import { test, expect } from "bun:test";
import { parseEntries, checkIds, parseCovers, resolveAnchor, checkCovers, slugify } from "./check-docs.ts";

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

test("parseEntries does not leak a foreign-level heading's meta into the previous entry", () => {
  const t = `#### First\n**UID**: R-001\nstatement one.\n### A grouping header\n**UID**: R-999\n#### Second\n**UID**: R-002\nstatement two.`;
  const entries = parseEntries(t, 4);
  expect(entries.map((e) => e.meta.UID)).toEqual(["R-001", "R-002"]);
});

test("checkIds does not emit a false gap when a duplicate is present", () => {
  const entries = [
    { title: "", meta: { UID: "R-001" }, body: "", line: 1 },
    { title: "", meta: { UID: "R-001" }, body: "", line: 3 },
    { title: "", meta: { UID: "R-002" }, body: "", line: 5 },
  ];
  const errs = checkIds(entries, "R", (e) => e.meta.UID);
  expect(errs.some((m) => m.includes("duplicate R-001"))).toBe(true);
  expect(errs.some((m) => m.includes("contiguous"))).toBe(false);
});

test("checkIds flags a malformed id", () => {
  const entries = [{ title: "", meta: { UID: "R-1" }, body: "", line: 1 }];
  expect(checkIds(entries, "R", (e) => e.meta.UID).some((m) => m.includes("bad R id"))).toBe(true);
});

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

test("checkCovers passes when path and anchor resolve", () => {
  const reqs = [{ title: "", meta: { UID: "R-001", COVERS: "docs/specs/build-plan.md#tier-0" }, body: "", line: 1 }];
  expect(checkCovers(reqs, () => "<!-- anchor: tier-0 -->")).toEqual([]);
});

test("resolveAnchor returns false for non-matching input", () => {
  expect(resolveAnchor("no marker, no heading here", "ghost")).toBe(false);
});

test("slugify lowercases and hyphenates", () => {
  expect(slugify("Tier 0 Foundation")).toBe("tier-0-foundation");
});

test("parseCovers with no anchor returns path only", () => {
  expect(parseCovers("docs/specs/design.md")).toEqual({ path: "docs/specs/design.md" });
});

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

test("checkLifecycle flags a missing STATUS", () => {
  expect(checkLifecycle([{ title: "", meta: { UID: "R-001" }, body: "", line: 1 }]).some((m) => m.includes("missing STATUS"))).toBe(true);
});

test("checkLifecycle requires TEST for tested", () => {
  expect(checkLifecycle([{ title: "", meta: { UID: "R-001", STATUS: "tested" }, body: "", line: 1 }]).some((m) => m.includes("TEST"))).toBe(true);
});

test("checkIntake passes an open item", () => {
  expect(checkIntake([{ name: "2026-07-10-topic.md", content: "# topic\n**Status**: open\n" }])).toEqual([]);
});

import { scanArrowTags } from "./check-docs.ts";

// Fixture tags are built by concatenation so the repo-wide tag sweep (which
// scans scripts/*.test.ts) never sees this file's fixtures as real tags.
const mktag = (type: string, uid: string) => `[${type}` + `->${uid}]`;

import { checkTestTraces, checkTagSweep } from "./check-docs.ts";

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
