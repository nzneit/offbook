// [utest->R-037]
import { expect, test } from "bun:test";
import {
	isSupportedSpecVersion,
	readSpecVersion,
	SUPPORTED_SPEC_VERSIONS,
} from "./spec-version.ts";

test("reads the asyncapi version from spec text without a parser", () => {
	expect(
		readSpecVersion("asyncapi: 3.0.0\ninfo: { title: T, version: 1.0.0 }"),
	).toBe("3.0.0");
	expect(
		readSpecVersion("asyncapi: '2.6.0'\ninfo: { title: T, version: 1.0.0 }"),
	).toBe("2.6.0");
});

test("a YAML-numeric version is normalized to a string", () => {
	// `asyncapi: 2.6` is a YAML float, not a string; String() keeps the read honest
	expect(readSpecVersion("asyncapi: 2.6")).toBe("2.6");
});

test("absent or unparseable spec text yields undefined, never a throw", () => {
	expect(readSpecVersion("info: { title: T }")).toBeUndefined();
	expect(readSpecVersion("this: [is: not: valid: yaml")).toBeUndefined();
	expect(readSpecVersion("")).toBeUndefined();
});

// [utest->R-037]
test('a present-but-null asyncapi field reads as the string "null", not undefined', () => {
	// `asyncapi:` with no value is a genuinely PRESENT field (YAML null), distinct
	// from the field being absent. Collapsing it to undefined let the preflight
	// fall through to the parser, which TypeErrors on it (D-019); reading it as
	// "null" instead routes it into the preflight's own branded refusal.
	expect(readSpecVersion("asyncapi:\ninfo: { title: T, version: 1.0.0 }")).toBe(
		"null",
	);
});

test("the supported set is exactly the tested promise (2.0.0-2.6.0, 3.0.0, 3.1.0)", () => {
	expect([...SUPPORTED_SPEC_VERSIONS]).toEqual([
		"2.0.0",
		"2.1.0",
		"2.2.0",
		"2.3.0",
		"2.4.0",
		"2.5.0",
		"2.6.0",
		"3.0.0",
		"3.1.0",
	]);
});

test("1.x, the 2.0.0 release candidates, and absent versions are unsupported", () => {
	expect(isSupportedSpecVersion("3.1.0")).toBe(true);
	expect(isSupportedSpecVersion("2.0.0")).toBe(true);
	expect(isSupportedSpecVersion("1.2.0")).toBe(false);
	expect(isSupportedSpecVersion("2.0.0-rc1")).toBe(false);
	expect(isSupportedSpecVersion("4.0.0")).toBe(false);
	expect(isSupportedSpecVersion(undefined)).toBe(false);
});
