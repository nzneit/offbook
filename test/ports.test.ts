// Unit tests for the sentinel-claimed port-band scheme (test/ports.ts, D-033).
//
// The real claim is an import side effect that binds a socket, and it already
// ran — this suite lives inside the process it claimed for. So the band search
// is tested through `claimBand`'s injected dependencies, not by rebinding
// sentinels (which would fight this process's own claim), and the mapping is
// tested through the pure `mapPort(band, base, assigned)` seam and the
// `bandPorts(band)` factory the process-level API is itself an instance of.
//
// Every base below is derived from ALLOC_FLOOR/ALLOC_CEIL rather than spelled
// out, so this file contributes no in-window port literals of its own.
import { describe, expect, test } from "bun:test";
import type { Server } from "node:net";
import {
	ALLOC_CEIL,
	ALLOC_FLOOR,
	BAND,
	BAND_ENV,
	BAND_WIDTH,
	bandPorts,
	type ClaimDeps,
	COMPACT_BASE,
	claimBand,
	DETACHED_BASES,
	detachedPortsFor,
	forcedBand,
	heldDetachedPorts,
	MAX_BAND,
	mapPort,
	newAssigned,
	port,
	portStr,
	SENTINEL_BASE,
	SENTINEL_PORT,
	tryClaim,
} from "./ports.ts";

const A = ALLOC_FLOOR + 3;
const B = ALLOC_FLOOR + 4;
const C = ALLOC_CEIL - 1;

const fresh = () => new Map<number, number>();
/** A stand-in for the claimed listener: `claimBand` only ever closes it. */
const stubServer = () => {
	let closed = false;
	return {
		close: () => {
			closed = true;
		},
		get closed() {
			return closed;
		},
	} as unknown as Server & { closed: boolean };
};

/** Default deps: nothing held, nothing forced, announcements collected. */
function deps(over: Partial<ClaimDeps> = {}): ClaimDeps & { said: string[] } {
	const said: string[] = [];
	return {
		tryBind: () => stubServer(),
		heldPorts: () => [],
		announce: (l) => said.push(l),
		forced: undefined,
		said,
		...over,
	};
}

describe("band 0 is the identity map", () => {
	test("returns the base unchanged across the whole window", () => {
		const assigned = fresh();
		for (const base of [ALLOC_FLOOR, A, B, C, ALLOC_CEIL])
			expect(mapPort(0, base, assigned)).toBe(base);
	});

	test("consumes no index space, so band 0 can never exhaust", () => {
		const assigned = fresh();
		for (let i = 0; i <= BAND_WIDTH; i++)
			expect(mapPort(0, ALLOC_FLOOR + i, assigned)).toBe(ALLOC_FLOOR + i);
		expect(assigned.size).toBe(0);
	});
});

describe("bands >= 1 use a lazy dense index", () => {
	test("indices are handed out in first-request order, first request wins", () => {
		const assigned = fresh();
		expect(mapPort(1, C, assigned)).toBe(COMPACT_BASE);
		expect(mapPort(1, A, assigned)).toBe(COMPACT_BASE + 1);
		expect(mapPort(1, B, assigned)).toBe(COMPACT_BASE + 2);
		// Re-asking for an already-indexed base returns the same port whatever
		// the order: the suite's multi-role clusters (one port as runfile field,
		// bind, identity and probe argument) depend on that stability.
		expect(mapPort(1, C, assigned)).toBe(COMPACT_BASE);
		expect(mapPort(1, A, assigned)).toBe(COMPACT_BASE + 1);
		expect(assigned.size).toBe(3);
	});

	test("every band fills its own window and only its own window", () => {
		for (let band = 1; band <= MAX_BAND; band++) {
			const assigned = fresh();
			const first = mapPort(band, ALLOC_FLOOR, assigned);
			expect(first).toBe(COMPACT_BASE + (band - 1) * BAND_WIDTH);
			let last = first;
			for (let i = 0; i < BAND_WIDTH; i++)
				last = mapPort(band, ALLOC_FLOOR + i, assigned);
			expect(last).toBe(COMPACT_BASE + band * BAND_WIDTH - 1);
		}
		// Fact 2 of the design: everything must stay below the ephemeral floor.
		expect(COMPACT_BASE + MAX_BAND * BAND_WIDTH - 1).toBeLessThan(32768);
	});

	test("two distinct bases never map to the same port within a band", () => {
		const assigned = fresh();
		const seen = new Map<number, number>();
		const stride = Math.floor((ALLOC_CEIL - ALLOC_FLOOR) / BAND_WIDTH);
		expect(stride).toBeGreaterThanOrEqual(1); // else the bases below collide
		for (let i = 0; i < BAND_WIDTH; i++) {
			const base = ALLOC_FLOOR + i * stride;
			const mapped = mapPort(3, base, assigned);
			expect(seen.has(mapped)).toBe(false);
			seen.set(mapped, base);
		}
		expect(seen.size).toBe(BAND_WIDTH);
	});
});

describe("range validation", () => {
	const OUT_OF_WINDOW: Array<[string, number]> = [
		["below the floor", ALLOC_FLOOR - 1],
		["above the ceiling", ALLOC_CEIL + 1],
		["a sentinel port", SENTINEL_BASE],
		["a compact-window port", COMPACT_BASE],
		["a real service default", 9001],
		["a fixture placeholder", 1],
		["negative", -1],
		["fractional", ALLOC_FLOOR + 0.5],
		["not a number", Number.NaN],
	];

	test.each(OUT_OF_WINDOW)("rejects %s, naming the value", (_label, base) => {
		for (const band of [0, 1, MAX_BAND])
			expect(() => mapPort(band, base, fresh())).toThrow(
				`port(${base}): a test port base must be an integer in [${ALLOC_FLOOR}, ${ALLOC_CEIL}]`,
			);
	});

	test("accepts both endpoints of the window", () => {
		expect(mapPort(1, ALLOC_FLOOR, fresh())).toBe(COMPACT_BASE);
		expect(mapPort(1, ALLOC_CEIL, fresh())).toBe(COMPACT_BASE);
		expect(mapPort(0, ALLOC_FLOOR, fresh())).toBe(ALLOC_FLOOR);
		expect(mapPort(0, ALLOC_CEIL, fresh())).toBe(ALLOC_CEIL);
	});

	test("rejects a band outside 0..MAX_BAND", () => {
		for (const band of [-1, MAX_BAND + 1, 1.5])
			expect(() => mapPort(band, A, fresh())).toThrow(
				`band ${band} is not an integer in [0, ${MAX_BAND}]`,
			);
	});
});

describe("index exhaustion", () => {
	test("throws once a band has mapped BAND_WIDTH distinct bases", () => {
		const assigned = fresh();
		for (let i = 0; i < BAND_WIDTH; i++) mapPort(1, ALLOC_FLOOR + i, assigned);
		expect(assigned.size).toBe(BAND_WIDTH);
		expect(() => mapPort(1, ALLOC_FLOOR + BAND_WIDTH, assigned)).toThrow(
			`band 1 is out of index space: ${BAND_WIDTH} distinct bases are already mapped`,
		);
	});

	test("an exhausted band still serves the bases it already indexed", () => {
		const assigned = fresh();
		for (let i = 0; i < BAND_WIDTH; i++) mapPort(2, ALLOC_FLOOR + i, assigned);
		expect(mapPort(2, ALLOC_FLOOR, assigned)).toBe(COMPACT_BASE + BAND_WIDTH);
		expect(assigned.size).toBe(BAND_WIDTH);
	});

	test("the refused mapping leaves the index untouched", () => {
		const assigned = fresh();
		for (let i = 0; i < BAND_WIDTH; i++) mapPort(1, ALLOC_FLOOR + i, assigned);
		expect(() => mapPort(1, ALLOC_CEIL, assigned)).toThrow();
		expect(assigned.has(ALLOC_CEIL)).toBe(false);
		expect(assigned.size).toBe(BAND_WIDTH);
	});

	// The guard above is invisible to an ordinary local run: `port()` there is
	// bandPorts(0), and band 0 returns before the index logic. So drive the very
	// composition the suite uses — bandPorts(band).port — at a band that does
	// index, and prove it refuses rather than silently wrapping into the next
	// band's window.
	test("bandPorts(1).port throws when its own index space fills", () => {
		const banded = bandPorts(1);
		const preSeeded = banded.assigned.size;
		expect(preSeeded).toBe(DETACHED_BASES.length);
		// fill the rest of the index space with bases the pre-seed does not
		// already hold, so every call really does consume an index
		const detached = new Set(DETACHED_BASES);
		let last = 0;
		for (let base = ALLOC_FLOOR; banded.assigned.size < BAND_WIDTH; base++) {
			if (detached.has(base)) continue;
			last = banded.port(base);
		}
		// the last index in this band's window, and still inside it
		expect(last).toBe(COMPACT_BASE + BAND_WIDTH - 1);
		expect(banded.assigned.size).toBe(BAND_WIDTH);
		// ALLOC_CEIL is neither pre-seeded nor reached by the loop above
		expect(banded.assigned.has(ALLOC_CEIL)).toBe(false);
		expect(() => banded.port(ALLOC_CEIL)).toThrow(
			`band 1 is out of index space: ${BAND_WIDTH} distinct bases are already mapped`,
		);
		expect(() => banded.portStr(ALLOC_CEIL)).toThrow("out of index space");
		// …while an already-indexed base still resolves
		expect(banded.port(ALLOC_FLOOR)).toBe(
			COMPACT_BASE + (banded.assigned.get(ALLOC_FLOOR) as number),
		);
	});
});

describe("the detached-server pre-seed", () => {
	test("pre-seeds exactly DETACHED_BASES, in list order", () => {
		const assigned = newAssigned();
		expect(assigned.size).toBe(DETACHED_BASES.length);
		DETACHED_BASES.forEach((base, i) => {
			expect(assigned.get(base)).toBe(i);
		});
	});

	test("DETACHED_BASES are in-window, distinct and sorted", () => {
		expect(new Set(DETACHED_BASES).size).toBe(DETACHED_BASES.length);
		expect([...DETACHED_BASES].sort((x, y) => x - y)).toEqual([
			...DETACHED_BASES,
		]);
		for (const base of DETACHED_BASES) {
			expect(base).toBeGreaterThanOrEqual(ALLOC_FLOOR);
			expect(base).toBeLessThanOrEqual(ALLOC_CEIL);
		}
	});

	// The whole point of the pre-seed: an orphan's ports must be computable by a
	// process that never ran the orphan's test file. Two independent processes
	// are simulated by two independent index maps whose OTHER requests differ.
	test("two processes in one band agree on the detached ports whatever else they asked for", () => {
		const p1 = bandPorts(7);
		const p2 = bandPorts(7);
		p1.port(ALLOC_FLOOR); // p1 allocates first…
		p2.port(ALLOC_CEIL); // …p2 allocates something else first
		for (const base of DETACHED_BASES)
			expect(p1.port(base)).toBe(p2.port(base));
		expect(detachedPortsFor(7)).toEqual(DETACHED_BASES.map((b) => p1.port(b)));
	});

	test("band 0's detached ports are the bases themselves", () => {
		expect(detachedPortsFor(0)).toEqual([...DETACHED_BASES]);
	});

	test("a band's detached ports all land inside that band's window", () => {
		for (const band of [1, 2, MAX_BAND]) {
			const first = COMPACT_BASE + (band - 1) * BAND_WIDTH;
			for (const p of detachedPortsFor(band)) {
				expect(p).toBeGreaterThanOrEqual(first);
				expect(p).toBeLessThan(first + BAND_WIDTH);
			}
		}
	});

	test("heldDetachedPorts reports only the ports the binder refuses, and releases the rest", () => {
		const wanted = detachedPortsFor(5);
		const busy = new Set([wanted[2], wanted[9]]);
		const opened: Server[] = [];
		const held = heldDetachedPorts(5, (p) => {
			if (busy.has(p)) return null;
			const s = stubServer();
			opened.push(s);
			return s;
		});
		expect(held).toEqual([wanted[2] as number, wanted[9] as number]);
		// every probe that DID bind was closed again — a probe that leaked its
		// listener would hold the very ports the suite is about to use
		expect(opened.length).toBe(wanted.length - busy.size);
		expect(
			opened.every((s) => (s as Server & { closed: boolean }).closed),
		).toBe(true);
	});
});

describe("the band claim", () => {
	test("takes the lowest band whose sentinel binds", () => {
		const tried: number[] = [];
		const d = deps({
			tryBind: (p) => {
				tried.push(p);
				return p === SENTINEL_BASE + 3 ? stubServer() : null;
			},
		});
		expect(claimBand(d).band).toBe(3);
		expect(tried).toEqual([
			SENTINEL_BASE,
			SENTINEL_BASE + 1,
			SENTINEL_BASE + 2,
			SENTINEL_BASE + 3,
		]);
	});

	test("takes band 0 when it is free, and stops there", () => {
		const tried: number[] = [];
		const d = deps({
			tryBind: (p) => {
				tried.push(p);
				return stubServer();
			},
		});
		expect(claimBand(d).band).toBe(0);
		expect(tried).toEqual([SENTINEL_BASE]);
		expect(d.said).toEqual([]);
	});

	// Finding 6: the sentinel is a PROCESS claim. A detached server that
	// outlived its parent still holds the band's ports, and the OS freed the
	// sentinel the moment the parent died — so a free sentinel is not enough.
	test("skips a band whose sentinel is free but whose detached ports are still held", () => {
		const sentinels: Array<Server & { closed: boolean }> = [];
		const d = deps({
			tryBind: () => {
				const s = stubServer();
				sentinels.push(s);
				return s;
			},
			heldPorts: (band) =>
				band === 0 ? [detachedPortsFor(0)[0] as number] : [],
		});
		const claim = claimBand(d);
		expect(claim.band).toBe(1);
		// band 0's sentinel was handed back rather than squatted
		expect(sentinels[0]?.closed).toBe(true);
		expect(sentinels[1]?.closed).toBe(false);
		expect(d.said.length).toBe(1);
		expect(d.said[0]).toContain("band 0 skipped");
		expect(d.said[0]).toContain("detached-server port(s) still held");
		expect(d.said[0]).toContain(String(detachedPortsFor(0)[0]));
	});

	test("skipping is not killing: the holder is never signalled, only stepped over", () => {
		// A reaper would have to know a pid; claimBand is handed nothing but a
		// bind probe and an announcer, so friendly fire is structurally
		// impossible rather than merely avoided.
		const d = deps({ heldPorts: (band) => (band < 4 ? [COMPACT_BASE] : []) });
		expect(claimBand(d).band).toBe(4);
		expect(d.said.length).toBe(4);
	});

	test("fails loudly, naming the exhausted range and the escape hatch, when every band is taken", () => {
		let attempts = 0;
		const d = deps({
			tryBind: () => {
				attempts++;
				return null;
			},
		});
		expect(() => claimBand(d)).toThrow(
			`all ${MAX_BAND + 1} bands (sentinels ${SENTINEL_BASE}-${SENTINEL_BASE + MAX_BAND} on 127.0.0.1)`,
		);
		expect(() => claimBand(deps({ tryBind: () => null }))).toThrow(BAND_ENV);
		expect(attempts).toBe(MAX_BAND + 1);
	});

	test("the failure hint is portable: a Linux command AND a BSD one", () => {
		let message = "";
		try {
			claimBand(deps({ tryBind: () => null }));
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).toContain("ss -ltn");
		expect(message).toContain("lsof -nP -iTCP:");
		expect(message).toContain("macOS/BSD");
	});

	test("tryClaim refuses a port this process already holds", () => {
		// The sentinel for our own band is, by construction, unavailable.
		expect(tryClaim(SENTINEL_PORT)).toBeNull();
	});

	test("tryClaim returns a listener for a free port", () => {
		// Port 0 = an OS-assigned ephemeral port: proves the synchronous
		// success detection without touching anyone's band.
		const held = tryClaim(0);
		if (!held) throw new Error("tryClaim(0) failed to bind an ephemeral port");
		try {
			expect(held.listening).toBe(true);
			// Held ports really are held: a second claim of the same port fails.
			const { port: ephemeral } = held.address() as { port: number };
			expect(tryClaim(ephemeral)).toBeNull();
		} finally {
			held.close();
		}
	});
});

describe("the OFFBOOK_TEST_BAND escape hatch", () => {
	test("an unset or blank value means 'scan'", () => {
		expect(forcedBand(undefined)).toBeUndefined();
		expect(forcedBand("")).toBeUndefined();
		expect(forcedBand("   ")).toBeUndefined();
	});

	test("a band index is taken, whitespace and all", () => {
		expect(forcedBand("0")).toBe(0);
		expect(forcedBand(" 3 ")).toBe(3);
		expect(forcedBand(String(MAX_BAND))).toBe(MAX_BAND);
	});

	test("a typo is refused, not silently ignored", () => {
		for (const raw of ["x", "1.5", "-1", "0x3", "3 4"])
			expect(() => forcedBand(raw)).toThrow(`${BAND_ENV}=${raw}`);
		expect(() => forcedBand("nope")).toThrow("is not a band index");
	});

	test("an out-of-range band is refused, naming the range and the reason", () => {
		const over = String(MAX_BAND + 1);
		expect(() => forcedBand(over)).toThrow(`bands are 0..${MAX_BAND}`);
		expect(() => forcedBand(over)).toThrow("ephemeral source-port range");
	});

	test("forcing a band skips the scan entirely and never probes", () => {
		const tried: number[] = [];
		const d = deps({
			forced: 5,
			tryBind: (p) => {
				tried.push(p);
				return stubServer();
			},
			heldPorts: () => {
				throw new Error("the forced path must not probe");
			},
		});
		const claim = claimBand(d);
		expect(claim.band).toBe(5);
		expect(claim.sentinel).not.toBeNull();
		expect(tried).toEqual([SENTINEL_BASE + 5]);
	});

	test("a forced band is kept even when its sentinel is already held", () => {
		const claim = claimBand(deps({ forced: 2, tryBind: () => null }));
		expect(claim.band).toBe(2);
		expect(claim.sentinel).toBeNull();
	});
});

describe("the process-level API", () => {
	test("this process claimed a real band and holds its sentinel", () => {
		expect(BAND).toBeGreaterThanOrEqual(0);
		expect(BAND).toBeLessThanOrEqual(MAX_BAND);
		expect(SENTINEL_PORT).toBe(SENTINEL_BASE + BAND);
		expect(SENTINEL_PORT).toBeLessThan(ALLOC_FLOOR);
	});

	test("port() is stable per base and portStr() is its string", () => {
		const first = port(A);
		expect(port(A)).toBe(first);
		expect(portStr(A)).toBe(String(first));
		expect(port(B)).not.toBe(first);
	});

	test("port() enforces the same window as mapPort()", () => {
		expect(() => port(ALLOC_CEIL + 1)).toThrow(`port(${ALLOC_CEIL + 1})`);
		expect(() => portStr(ALLOC_FLOOR - 1)).toThrow(`port(${ALLOC_FLOOR - 1})`);
	});

	test("port() agrees with bandPorts(BAND) — it IS that composition", () => {
		const twin = bandPorts(BAND);
		for (const base of DETACHED_BASES.slice(0, 5))
			expect(port(base)).toBe(twin.port(base));
	});
});
