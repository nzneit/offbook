// R-016 — L2 when.topic matcher: {param} capture + MQTT +/# semantics fused
// with payloadMatch subset equality (l2 §4), and the pattern-overlap analysis
// behind the l2 §3 shadow/overlap diagnostics.
// [utest->R-016]
import { describe, expect, test } from "bun:test";
import {
	comparePatterns,
	deepEqual,
	matchTopic,
	payloadMatches,
	resolvePath,
} from "./matcher.ts";

describe("matchTopic", () => {
	test("literal pattern matches only itself", () => {
		expect(matchTopic("state/lobby", "state/lobby")).toEqual({});
		expect(matchTopic("state/lobby", "state/attic")).toBeUndefined();
		expect(matchTopic("state/lobby", "state/lobby/x")).toBeUndefined();
		expect(matchTopic("state/lobby", "state")).toBeUndefined();
	});

	test("{param} captures exactly one level", () => {
		expect(matchTopic("command/{deviceId}/set", "command/t1/set")).toEqual({
			deviceId: "t1",
		});
		expect(
			matchTopic("command/{deviceId}/set", "command/t1/extra/set"),
		).toBeUndefined();
		expect(matchTopic("{a}/{b}", "x/y")).toEqual({ a: "x", b: "y" });
	});

	test("+ matches one level without capturing", () => {
		expect(matchTopic("state/+", "state/t1")).toEqual({});
		expect(matchTopic("state/+", "state/t1/x")).toBeUndefined();
		expect(matchTopic("state/+", "state")).toBeUndefined();
	});

	test("# matches zero or more trailing levels (MQTT 3.1.1)", () => {
		expect(matchTopic("state/#", "state")).toEqual({});
		expect(matchTopic("state/#", "state/t1")).toEqual({});
		expect(matchTopic("state/#", "state/t1/deep/er")).toEqual({});
		expect(matchTopic("state/#", "other/t1")).toBeUndefined();
	});

	test("captures before a # still bind", () => {
		expect(matchTopic("cmd/{id}/#", "cmd/t1/set/deep")).toEqual({ id: "t1" });
	});

	test("a non-terminal # never matches a normal topic (defensive)", () => {
		expect(matchTopic("a/#/b", "a/x/b")).toBeUndefined();
	});
});

describe("comparePatterns", () => {
	test("disjoint literals do not intersect", () => {
		expect(comparePatterns("a/b", "a/c")).toEqual({ intersects: false });
		expect(comparePatterns("a/b", "a/b/c")).toEqual({ intersects: false });
	});

	test("equal patterns intersect and cover", () => {
		expect(comparePatterns("command/{d}/set", "command/{d}/set")).toEqual({
			intersects: true,
			covers: true,
			witness: "command/{d}/set",
		});
	});

	test("a {param} covers a literal; the literal is the witness", () => {
		expect(comparePatterns("command/{deviceId}/set", "command/t1/set")).toEqual(
			{ intersects: true, covers: true, witness: "command/t1/set" },
		);
	});

	test("a literal intersects but does not cover a {param}", () => {
		expect(comparePatterns("command/t1/set", "command/{deviceId}/set")).toEqual(
			{ intersects: true, covers: false, witness: "command/t1/set" },
		);
	});

	test("# covers everything below, including zero levels", () => {
		expect(comparePatterns("cmd/#", "cmd/{d}/set")).toEqual({
			intersects: true,
			covers: true,
			witness: "cmd/{d}/set",
		});
		expect(comparePatterns("cmd/#", "cmd")).toEqual({
			intersects: true,
			covers: true,
			witness: "cmd",
		});
	});

	test("a finite pattern intersects a # but cannot cover it", () => {
		expect(comparePatterns("cmd/{d}/set", "cmd/#")).toEqual({
			intersects: true,
			covers: false,
			witness: "cmd/{d}/set",
		});
		expect(comparePatterns("cmd", "cmd/#")).toEqual({
			intersects: true,
			covers: false,
			witness: "cmd",
		});
	});

	test("+ and {param} are interchangeable single-level variables", () => {
		expect(comparePatterns("s/+", "s/{id}")).toEqual({
			intersects: true,
			covers: true,
			witness: "s/{id}",
		});
	});
});

describe("resolvePath / deepEqual / payloadMatches", () => {
	test("resolvePath walks dotted paths and misses to undefined", () => {
		expect(resolvePath({ a: { b: 2 } }, "a.b")).toBe(2);
		expect(resolvePath({ a: { b: 2 } }, "a.c")).toBeUndefined();
		expect(resolvePath({ a: [10, 20] }, "a.1")).toBe(20);
		expect(resolvePath(null, "a")).toBeUndefined();
		expect(resolvePath("scalar", "a")).toBeUndefined();
	});

	test("deepEqual is structural over objects, arrays, scalars", () => {
		expect(deepEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(
			true,
		);
		expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(deepEqual([1, 2], [2, 1])).toBe(false);
		expect(deepEqual(null, undefined)).toBe(false);
		expect(deepEqual(2, "2")).toBe(false);
	});

	test("payloadMatches is subset equality; extra inbound fields ignored", () => {
		const inbound = { mode: "heat", target: 21, status: { code: 2 } };
		expect(payloadMatches({ mode: "heat" }, inbound)).toBe(true);
		expect(payloadMatches({ mode: "cool" }, inbound)).toBe(false);
		expect(payloadMatches({ "status.code": 2 }, inbound)).toBe(true);
		expect(payloadMatches({ "status.code": 3 }, inbound)).toBe(false);
		expect(payloadMatches(undefined, inbound)).toBe(true);
		expect(payloadMatches({ mode: "heat" }, undefined)).toBe(false);
	});
});
