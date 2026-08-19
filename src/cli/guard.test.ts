// [utest->R-045] — the guarded-mutation rule (design "one rule, five
// sites"): re-read the precondition immediately before acting, abort on
// mismatch. The five call sites each get their own pin where they live;
// this file pins the rule itself.
import { expect, test } from "bun:test";
import { guarded } from "./guard.ts";

test("guarded: acts when the re-read matches, reports true", async () => {
	let acted = false;
	const result = await guarded({
		read: () => 42,
		expect: (v) => v === 42,
		act: () => {
			acted = true;
		},
	});
	expect(result).toBe(true);
	expect(acted).toBe(true);
});

test("guarded: aborts when the precondition changed, reports false", async () => {
	let state = "expected";
	state = "changed-between-scan-and-act";
	let acted = false;
	const result = await guarded({
		read: () => state,
		expect: (v) => v === "expected",
		act: () => {
			acted = true;
		},
	});
	expect(result).toBe(false);
	expect(acted).toBe(false);
});

test("guarded: the re-read happens at act time, not capture time (async)", async () => {
	let record: string | undefined = "present";
	const seen: (string | undefined)[] = [];
	const site = {
		read: async () => {
			await new Promise((r) => setTimeout(r, 10));
			return record;
		},
		expect: (v: string | undefined) => {
			seen.push(v);
			return v !== undefined;
		},
		act: () => {},
	};
	expect(await guarded(site)).toBe(true);
	record = undefined; // vanishes between invocations
	expect(await guarded(site)).toBe(false);
	expect(seen).toEqual(["present", undefined]); // fresh read both times
});
