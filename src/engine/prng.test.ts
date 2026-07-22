import { expect, test } from "bun:test";
import { hashToInt, mulberry32 } from "./prng.ts";

test("hashToInt is stable, uint32, and input-sensitive", () => {
	expect(hashToInt("abc")).toBe(hashToInt("abc"));
	const h = hashToInt("42|state/{deviceId}|");
	expect(Number.isInteger(h)).toBe(true);
	expect(h).toBeGreaterThanOrEqual(0);
	expect(h).toBeLessThanOrEqual(0xffffffff);
	expect(hashToInt("a")).not.toBe(hashToInt("b"));
});

test("mulberry32 streams are deterministic per seed and diverge across seeds", () => {
	const a1 = mulberry32(7);
	const a2 = mulberry32(7);
	const b = mulberry32(8);
	const s1 = [a1(), a1(), a1()];
	const s2 = [a2(), a2(), a2()];
	const s3 = [b(), b(), b()];
	expect(s1).toEqual(s2);
	expect(s1).not.toEqual(s3);
	for (const v of s1) {
		expect(v).toBeGreaterThanOrEqual(0);
		expect(v).toBeLessThan(1);
	}
});
