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
