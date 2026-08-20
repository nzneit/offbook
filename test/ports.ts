// Per-worker test-port namespacing — sentinel-claimed bands.
// Design: .superpowers/sdd/port-namespacing-design.md — decision D-033.
//
// WHY: two concurrent `bun test` processes over the same port-heavy file
// collide on EADDRINUSE (the CI mutation gate runs Stryker at --concurrency 4,
// and a crashed run is scored as a KILLED mutant — so the gate goes
// nondeterministic in both directions). Arbitration lives in the KERNEL's port
// table, not in any worker-id scheme: at preload time this module binds a
// sentinel socket to claim a band, trying band 0, then 1, ... The bind is
// atomic and exclusive, and the OS releases it on any death including SIGKILL.
// That is independent of worker ids, env propagation, runner upgrades and
// crash/respawn, and it fixes plain local concurrent `bun test` too.
//
// HOW TO READ A BAND-MAPPED PORT: band 0 is the IDENTITY map — `port(19010)`
// is 19010 — so a normal single-process local run keeps today's literals and
// grep/debugging habits still work. Bands >= 1 relocate each distinct base into
// a compact BAND_WIDTH-wide window starting at COMPACT_BASE, via a lazy dense
// index (first request in this process wins). Index assignment need not agree
// across processes for the ordinary bases: nothing compares ports across
// processes, and children receive their ports from their parent's own
// computation. The ONE exception is DETACHED_BASES below, whose indices are
// pre-seeded precisely so that they DO agree — see the comment there.
//
// ESCAPE HATCH: `OFFBOOK_TEST_BAND=<n>` forces band n and skips the claim scan
// (portability rule 5). Bands arbitrate our own processes; they cannot stop a
// third party holding a band-0 base port — Expo's dev server defaults to
// 19000/19001 and this suite allocates both — and band 0 is the identity map,
// so a developer WILL hit that one day. Forcing a band is the one-line fix.
//
// This file is the DEFINITION of the scheme, so its in-window numbers are the
// constants below, not port use-sites.
// [ports-allowlist] scheme definition — exempt from the port-hygiene sweep.
import { createServer, type Server } from "node:net";

/** Band k claims 127.0.0.1:(SENTINEL_BASE + k). Below ALLOC_FLOOR on purpose. */
export const SENTINEL_BASE = 11700;
/** Lowest legal base literal (src/broker/index.test.ts's tcp family starts here). */
export const ALLOC_FLOOR = 11800;
/** Highest legal base literal. */
export const ALLOC_CEIL = 19999;
/** Band 1's window starts here; band 0 is the identity map and uses no window. */
export const COMPACT_BASE = 20480;
/** Distinct bases one band can host. Must stay >= the suite's distinct-base count. */
export const BAND_WIDTH = 512;
/**
 * Highest band index; bands are 0..MAX_BAND (25 of them).
 * The top band's last port is COMPACT_BASE + (MAX_BAND - 1) * BAND_WIDTH +
 * (BAND_WIDTH - 1) = 32767, which must stay BELOW the Linux ephemeral
 * source-port floor (32768, /proc/sys/net/ipv4/ip_local_port_range) or a
 * kernel-assigned ephemeral port could steal a band port and reintroduce
 * exactly the flake this removes. macOS's ephemeral range starts higher
 * (49152), so the Linux number is the binding constraint on both.
 */
export const MAX_BAND = 24;

/** The env var that forces a band, named here so every message can quote it. */
export const BAND_ENV = "OFFBOOK_TEST_BAND";

/**
 * Every base the suite hands to a process it SPAWNS: the `--ws-port` /
 * `--tcp-port` / `--ctrl-port` trios of `offbook up` and `demo --serve`, plus
 * the demo-app server's `--port`. Completeness is enforced BOTH WAYS by
 * test/port-hygiene.test.ts: a flag site naming a base missing from this list
 * fails, and so does a base here that no flag site names.
 *
 * DELIBERATELY NOT HERE: `test/instance-discovery.test.ts`'s two `spawnServe`
 * fatal-boot fixtures. They pass their ports in a boot FILE, not on the command
 * line, and they are fixtures for boot-contract errors that serve.ts rejects
 * before compose binds anything — the tests assert exactly that. Their ports
 * exist only so a mutant that lets the boot proceed cannot fall back to
 * loadConfig's real published defaults (9080/9001/1883) and poison `offbook
 * doctor`'s probe. Listing them would make the claim-time probe skip a band
 * over ports nothing ever binds.
 *
 * WHY THE LIST EXISTS: the sentinel is a PROCESS claim, not a PORT claim.
 * `offbook up` spawns a DETACHED server; when a mutant run is SIGKILLed
 * (Stryker timeout) the OS frees the sentinel immediately but the orphan keeps
 * holding its band's ws/tcp/ctrl ports. A later process claiming that band
 * would walk straight into the original EADDRINUSE — still scored as a KILLED
 * mutant, still drifting the gate toward false green. So a band is claimed only
 * when its sentinel binds AND none of these ports is held (`claimBand` below).
 * Probe-and-skip, never a reaper: at concurrency > 1 a presence-keyed reaper
 * SIGKILLs sibling workers' LIVE runs and scores their mutants KILLED, which is
 * strictly worse than the flake it replaces.
 *
 * WHY THE ORDER IS PART OF THE MECHANISM: the probe has to compute the same
 * ports the orphan's parent computed, and the ordinary lazy index depends on
 * this process's own call order. So this list pre-seeds every band's index map
 * (index i = position in this list), which makes these bases — and only these —
 * map identically in every process that claims the same band. Appending is
 * always safe; reordering is fine too (every process reads this same file), but
 * keep it sorted so a reviewer can diff it against the flag sites.
 */
export const DETACHED_BASES: readonly number[] = Object.freeze([
	12489, 12490, 12491, 12492, 12493, 12494, 12495, 12496, 12901, 12910, 12921,
	12922, 12930, 12931, 12940, 12945, 12951, 12992, 12994, 12996, 12997, 19001,
	19010, 19021, 19022, 19030, 19031, 19040, 19045, 19051, 19111, 19120, 19140,
	19141, 19430, 19431, 19432, 19433, 19434, 19435, 19438, 19439, 19440, 19441,
	19442, 19443, 19444, 19445, 19457, 19463, 19464, 19801, 19810, 19822, 19830,
	19840, 19845, 19850, 19892, 19894, 19896, 19897, 19994,
]);

/**
 * A fresh per-band index map, pre-seeded with DETACHED_BASES so those bases map
 * identically in every process — the precondition the cross-process orphan
 * probe rests on. Band 0 ignores the map entirely (identity), so the pre-seed
 * costs nothing there.
 */
export function newAssigned(): Map<number, number> {
	return new Map(DETACHED_BASES.map((base, index) => [base, index]));
}

/**
 * Map one base literal into `band`'s window.
 *
 * Pure except for `assigned`, which carries the band's lazy dense index
 * (base -> index, first request wins). Exported so the mapping can be tested
 * without faking a second sentinel claim.
 */
export function mapPort(
	band: number,
	base: number,
	assigned: Map<number, number>,
): number {
	if (!Number.isInteger(band) || band < 0 || band > MAX_BAND)
		throw new Error(
			`[test/ports] mapPort: band ${band} is not an integer in [0, ${MAX_BAND}].`,
		);
	if (!Number.isInteger(base) || base < ALLOC_FLOOR || base > ALLOC_CEIL)
		throw new Error(
			`[test/ports] port(${base}): a test port base must be an integer in ` +
				`[${ALLOC_FLOOR}, ${ALLOC_CEIL}]. Values outside that window are not ` +
				`band-mapped — the real defaults (9001/1883/9080), out-of-range fixture ` +
				`sentinels and non-port numbers stay plain literals. A base outside the ` +
				`window would land inside another band's territory.`,
		);
	if (band === 0) return base;
	let index = assigned.get(base);
	if (index === undefined) {
		index = assigned.size;
		if (index >= BAND_WIDTH)
			throw new Error(
				`[test/ports] band ${band} is out of index space: ${BAND_WIDTH} distinct ` +
					`bases are already mapped and ${base} would be number ${index + 1}. ` +
					`Raise BAND_WIDTH and re-check MAX_BAND — the top band must stay below 32768.`,
			);
		assigned.set(base, index);
	}
	return COMPACT_BASE + (band - 1) * BAND_WIDTH + index;
}

/**
 * The `port`/`portStr` pair for one band, over one index map. The process-level
 * API below is exactly `bandPorts(BAND)`, so a test can drive the same code at
 * any band — including the exhaustion path, which band 0 (the only band a local
 * single-process run ever claims) can never reach.
 */
export function bandPorts(band: number): {
	port: (base: number) => number;
	portStr: (base: number) => string;
	assigned: Map<number, number>;
} {
	const assigned = newAssigned();
	const p = (base: number): number => mapPort(band, base, assigned);
	return { port: p, portStr: (base) => String(p(base)), assigned };
}

/**
 * The ports a detached server spawned by a process in `band` would be holding.
 * Pure: a fresh pre-seeded map, so the answer does not depend on what this
 * process has asked for so far.
 */
export function detachedPortsFor(band: number): number[] {
	const assigned = newAssigned();
	return DETACHED_BASES.map((base) => mapPort(band, base, assigned));
}

/**
 * Bind-probe `band`'s detached-server ports; returns the ones some other
 * process is holding. Pure bind checks — no `ss`, no `lsof`, no `/proc`, so it
 * is portable (portability rule 3). A listening socket has no TIME_WAIT, so the
 * probe's own binds are released the instant they are closed.
 */
export function heldDetachedPorts(
	band: number,
	tryBind: (port: number) => Server | null,
): number[] {
	const held: number[] = [];
	for (const p of detachedPortsFor(band)) {
		const probe = tryBind(p);
		if (probe === null) held.push(p);
		else probe.close();
	}
	return held;
}

/**
 * Try to claim one sentinel port. Returns the held listener, or null if some
 * other process already owns it. Exported for the unit tests.
 *
 * The `"127.0.0.1"` host argument is REQUIRED, not stylistic (portability rule
 * 2, pinned by test/port-hygiene.test.ts). Listeners set SO_REUSEADDR by
 * default, and BSD/macOS then permits two live binds on the same port when the
 * bound ADDRESSES differ, where Linux refuses: a sentinel on 0.0.0.0:11700 in
 * one process and 127.0.0.1:11700 in another could BOTH be granted, putting two
 * processes in one band with the guarantee silently gone — and only on the
 * platform nobody here runs. One code path binding a hardcoded 127.0.0.1 makes
 * every conflict an exact-address match on every OS. For the same reason
 * nothing here may ever set SO_REUSEPORT (`Bun.serve`'s `reusePort`), which is
 * precisely the "let another process share this port" switch.
 *
 * Bun 1.3.14, measured: `server.listen(port, "127.0.0.1")` settles the bind
 * SYNCHRONOUSLY for a literal IP — `srv.listening` is already true by the time
 * listen() returns, or the bind has already failed and it is false; the
 * EADDRINUSE is only *reported* asynchronously, as an 'error' event, hence the
 * handler installed before listen(). A synchronous outcome is mandatory: the
 * claim has to finish before any test module loads and binds.
 *
 * `Bun.listen` throws EADDRINUSE synchronously too, but `unref()` on ITS
 * listener releases the socket outright (also measured: the port disappears
 * from `ss` and another process binds it), so it cannot hold a band for a
 * process lifetime. node:net's unref() keeps the bind and only stops the handle
 * from holding the event loop open, which is exactly what is wanted here.
 */
export function tryClaim(sentinelPort: number): Server | null {
	const srv = createServer();
	// EADDRINUSE lands on a later tick; unhandled, it would be fatal.
	srv.on("error", () => {
		// The synchronous `srv.listening` check below is the real signal.
	});
	srv.listen(sentinelPort, "127.0.0.1");
	if (srv.listening) {
		srv.unref();
		return srv;
	}
	try {
		srv.close(() => {
			// Closing a server that never started reports ERR_SERVER_NOT_RUNNING
			// here rather than as an 'error' event. Nothing to do about it.
		});
	} catch {
		// Same case, on any Bun version that prefers to throw it.
	}
	return null;
}

/**
 * Read the OFFBOOK_TEST_BAND escape hatch. `undefined` means "scan the bands".
 * Throws on anything that is not a band index, because silently ignoring a
 * typo'd override would put the developer back in the mystery it exists to end.
 */
export function forcedBand(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	if (!/^\d+$/.test(raw.trim()))
		throw new Error(
			`[test/ports] ${BAND_ENV}=${raw} is not a band index. ` +
				`Set it to a whole number in [0, ${MAX_BAND}], or unset it to let the ` +
				`sentinel scan pick a free band.`,
		);
	const band = Number(raw.trim());
	if (band > MAX_BAND)
		throw new Error(
			`[test/ports] ${BAND_ENV}=${raw} is out of range: bands are 0..${MAX_BAND} ` +
				`(band ${band} would map ports at or above ${COMPACT_BASE + band * BAND_WIDTH}, ` +
				`inside the ephemeral source-port range).`,
		);
	return band;
}

export type ClaimDeps = {
	/** Bind one sentinel port; null when another process holds it. */
	tryBind: (sentinelPort: number) => Server | null;
	/** Which of `band`'s detached-server ports some other process still holds. */
	heldPorts: (band: number) => number[];
	/** Where a skip announcement goes (stderr in production). */
	announce: (line: string) => void;
	/** A validated OFFBOOK_TEST_BAND, or undefined to scan. */
	forced: number | undefined;
};

/**
 * Walk the bands lowest-first and keep the first one whose sentinel binds AND
 * whose detached-server ports are all free. Every dependency is injected so the
 * loop, the skip path and the exhaustion path are testable without a second
 * process; production wiring is at the bottom of this file.
 *
 * Under a forced band the scan does not happen at all: the sentinel is still
 * bound when it is free (so a second forced process at the same band is at
 * least visible in `ss`), but a busy sentinel or a held port does not move us —
 * the developer asked for this band on purpose.
 */
export function claimBand(deps: ClaimDeps): {
	band: number;
	sentinel: Server | null;
} {
	if (deps.forced !== undefined)
		return {
			band: deps.forced,
			sentinel: deps.tryBind(SENTINEL_BASE + deps.forced),
		};
	for (let band = 0; band <= MAX_BAND; band++) {
		const sentinel = deps.tryBind(SENTINEL_BASE + band);
		if (!sentinel) continue;
		const held = deps.heldPorts(band);
		if (held.length === 0) return { band, sentinel };
		// A detached server outlived the process that claimed this band (its
		// sentinel died with it, its ports did not). Give the band back and
		// move on — killing the holder would be a reaper, and at concurrency > 1
		// a reaper murders sibling workers' live runs.
		sentinel.close();
		deps.announce(
			`[test/ports] band ${band} skipped: ${held.length} detached-server port(s) ` +
				`still held (${held.slice(0, 4).join(", ")}${held.length > 4 ? ", …" : ""}) — ` +
				`a server outlived the run that spawned it`,
		);
	}
	throw new Error(
		`[test/ports] could not claim a test-port band: all ${MAX_BAND + 1} bands ` +
			`(sentinels ${SENTINEL_BASE}-${SENTINEL_BASE + MAX_BAND} on 127.0.0.1) are ` +
			`either claimed or still holding a detached server's ports.\n` +
			`Each concurrent test process holds exactly one, so either more than ` +
			`${MAX_BAND + 1} test processes are running at once (lower the runner's ` +
			`concurrency) or a crashed run leaked a listener. Inspect with:\n` +
			`  ss -ltn 'sport >= :${SENTINEL_BASE} and sport <= :${SENTINEL_BASE + MAX_BAND}'   # Linux\n` +
			`  lsof -nP -iTCP:${SENTINEL_BASE}-${SENTINEL_BASE + MAX_BAND} -sTCP:LISTEN         # macOS/BSD\n` +
			`To bypass the scan entirely (a third-party process squatting a base ` +
			`port, say — Expo defaults to 19000/19001, which this suite allocates), ` +
			`force one: ${BAND_ENV}=<0..${MAX_BAND}> bun test`,
	);
}

const FORCED = forcedBand(process.env[BAND_ENV]);
const claim = claimBand({
	tryBind: tryClaim,
	heldPorts: (band) => heldDetachedPorts(band, tryClaim),
	announce: (line) => {
		process.stderr.write(`${line}\n`);
	},
	forced: FORCED,
});

/** This process's band. 0 is the identity map. */
export const BAND = claim.band;
/** The sentinel port this process holds for its whole lifetime. */
export const SENTINEL_PORT = SENTINEL_BASE + BAND;
/**
 * The claim itself. Held (and unref'd, so it never keeps a process alive) until
 * the process dies; the OS frees it then, SIGKILL included. Exported so the
 * live reference is unmistakable rather than looking like a stray binding.
 * `null` only under a forced band whose sentinel was already taken.
 */
export const bandSentinel: Server | null = claim.sentinel;

const api = bandPorts(BAND);

/** Map a test port base literal into this process's band. */
export const port = api.port;

/** `port()` as a string, for CLI flag arguments. */
export const portStr = api.portStr;

if (FORCED !== undefined)
	process.stderr.write(
		`[test/ports] band ${FORCED} forced by ${BAND_ENV}; claim scan skipped` +
			`${bandSentinel === null ? " (its sentinel is already held — another process may share this band)" : ""}\n`,
	);
// The CI canary line. A runner upgrade that silently drops preload preservation
// puts every worker in band 0 and the collisions come straight back, so this
// has to be greppable in the Stryker log.
process.stderr.write(`[test/ports] band ${BAND}\n`);
