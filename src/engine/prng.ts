// Seeded PRNG primitives (F7). One hash implementation serves the faker's JSF
// seed key, ranged-delay keys (R-013), and per-invocation ctx.random() streams
// (R-012) — never a long-lived module-global cursor.

// stable string -> uint32 (FNV-1a)
export function hashToInt(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// Mulberry32 — the project-pinned PRNG (AGENTS.md); floats in [0, 1)
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
