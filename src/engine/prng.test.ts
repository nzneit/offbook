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

test("hashToInt matches the FNV-1a reference bit-for-bit over a corpus (pinned algorithm, F7)", () => {
	const reference = (s: string): number => {
		let h = 2166136261;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return h >>> 0;
	};
	const corpus = [
		"",
		"a",
		"abc",
		"42|state/{deviceId}|",
		"7|ctx|tick|0|h.ts|0",
		"7|delay|warm-up|3",
		"😀🚀",
		"\u0000\uffff",
	];
	for (let i = 0; i < 500; i++) corpus.push(`k${i}|${i * 31}`);
	for (const s of corpus) expect(hashToInt(s)).toBe(reference(s));
});

test("mulberry32 matches the reference stream for many seeds (pinned algorithm, F7)", () => {
	const reference = (seed: number): (() => number) => {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	};
	for (const seed of [0, 1, 2, 0xffffffff, 123456789, hashToInt("offbook")]) {
		const ours = mulberry32(seed);
		const ref = reference(seed);
		for (let i = 0; i < 20; i++) expect(ours()).toBe(ref());
	}
});
