// Enforcement for the per-worker test-port bands (test/ports.ts, D-033).
// Design: .superpowers/sdd/port-namespacing-design.md
//
// Not tied to an R-### — like test/lint-gate.test.ts (D-023) and
// test/stryker-tsconfig-noop.test.ts (D-027), this pins a decision whose
// symptom of being broken is silence.
//
// The band scheme's guarantee is TOTALITY, and totality is the only part of
// it a person can undo by accident. One port literal left outside port() is
// a port that does not move with the band: in an ordinary local run (band 0,
// the identity map) it still works, so nothing complains — it fails only in
// a second concurrent process, i.e. only in the mutation gate's Stryker
// workers, as a nondeterministic EADDRINUSE that scores a mutant KILLED. The
// scan below is what makes "every test port goes through port()" a fact
// rather than a convention.
//
// SCAN BOUNDARY — read this before adding a port anywhere new. The sweep
// covers `test/**/*.ts` plus `src/**/*.test.ts`, and nothing else. A helper
// under `scripts/` or `demo-app/` that binds a port in [ALLOC_FLOOR,
// ALLOC_CEIL] is OUTSIDE the scan and would collide silently under
// concurrency: either keep such a helper's ports out of the window entirely,
// or widen `scannedFiles()` when one lands. (Verified clean outside the
// boundary at the time of writing: no in-window bind exists there.)
//
// Six things are asserted:
//   1. TOTALITY   — no in-window numeric literal, and no in-window number
//                   rendered into a string, outside a port()/portStr() call;
//                   and no arithmetic on a port() RESULT, which would land on
//                   an unrelated port inside the band.
//   2. ACCOUNTING — the bases the suite really allocates (scanned literals
//                   PLUS the documented computed families) fit one band's
//                   index space, and no computed family is undeclared.
//   3. BAND MATH  — the geometry the scheme's safety rests on (top band under
//                   the ephemeral floor, sentinels below the window, windows
//                   disjoint, band 0 = identity, index space wide enough).
//   4. PORTABILITY— the sentinel binds an explicit 127.0.0.1 and never asks
//                   for SO_REUSEPORT (the one silent BSD/macOS failure).
//   5. ORPHANS    — every port handed to a process the suite SPAWNS is listed
//                   in DETACHED_BASES, so the claim-time probe can see it.
//   6. LOAD ORDER — test/preload.ts claims the band before anything else can
//                   load and bind.
//
// This file carries the sweep-exemption marker itself: the computed-family
// accounting below spells out family base literals (19000, 18000, …) as data,
// and those are the documented bases, not port use-sites.
// [ports-allowlist] computed-family accounting — exempt from the sweep.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
	ALLOC_CEIL,
	ALLOC_FLOOR,
	BAND_WIDTH,
	COMPACT_BASE,
	DETACHED_BASES,
	MAX_BAND,
	mapPort,
	SENTINEL_BASE,
} from "./ports.ts";

/**
 * Anchor every path at the repo root, never at `process.cwd()`. Several suite
 * tests `process.chdir` into scratch directories; a chdir that escapes its
 * `finally` would turn this gate into an ENOENT crash, and the mutation gate
 * scores a crashed run as a KILLED mutant — the exact failure mode the bands
 * exist to remove.
 */
const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Linux's default ephemeral source-port floor (/proc/sys/net/ipv4/
 * ip_local_port_range here is 32768-60999; macOS starts higher still, at
 * 49152). Read as a checked-in constant, never from /proc: the geometry is
 * static and must hold on every platform, not just the one running the test.
 * A band port at or above this could be handed out as some unrelated
 * process's source port and reintroduce exactly the flake the bands remove.
 */
const EPHEMERAL_FLOOR = 32768;

/**
 * The marker that exempts a file from the sweep. Assembled from two halves so
 * the constant itself is not a second occurrence — the same no-self-match care
 * test/import-style.test.ts takes with its import regex.
 */
const ALLOWLIST_MARKER = ["[ports", "allowlist]"].join("-");

/**
 * The only files allowed to carry that marker, each with the reason. Pinned
 * by name so the marker cannot be sprinkled onto a use-site file to silence
 * a real violation: adding a file here is a reviewable act.
 */
const ALLOWLISTED_FILES = new Map<string, string>([
	[
		"test/ports.ts",
		"defines the scheme; its in-window numbers are ALLOC_FLOOR/ALLOC_CEIL and the DETACHED_BASES list, not port use-sites",
	],
	[
		"test/port-hygiene.test.ts",
		"declares the computed-family accounting; its in-window numbers are the documented family bases, not port use-sites",
	],
]);

/**
 * Call frames whose TRAILING numeric argument is a millisecond timeout, never
 * a port. bun:test's optional last argument is a per-test timeout and that
 * range overlaps the port window (the suite spells most timeouts 10_000/
 * 20_000/60_000, and four of them 15_000, which IS in the window).
 *
 * The exemption is deliberately narrow: the literal must be in the trailing
 * ARGUMENT position of one of these calls — the next thing after it is the
 * call's own `)`. "Anywhere inside a test body" would swallow the most natural
 * way a future author adds a port (`test("x", () => { const WS = 19010; … })`,
 * or a `{ controlPlanePort: 19470 }` object built inside a test), and band 0 is
 * the identity map, so such a port works locally forever and collides only in a
 * second concurrent process.
 */
const TIMEOUT_FRAMES = new Set([
	"test",
	"test.each",
	"it",
	"it.each",
	"setTimeout",
	"setInterval",
]);

type Literal = {
	value: number;
	index: number;
	frame: string;
	/** Index of the `(` that opened `frame`, so the call can be looked up. */
	frameOpen: number;
	/** First non-whitespace character after the literal. */
	next: string;
};
type StringNumber = { value: number; index: number };
type PortCall = {
	name: string;
	/** Index of the call's `(`. */
	open: number;
	/** The argument source, whitespace-normalized. */
	arg: string;
	/** The base, when the argument is exactly one integer literal. */
	literal: number | null;
	/** First non-whitespace character after the call's `)`. */
	next: string;
	index: number;
};

/**
 * Decode one numeric literal's TEXT into its value. Separators and radix
 * prefixes are invisible to a naive digit scan, and both are plausible here:
 * the repo's own house style writes long numbers with separators (`4_193_996`
 * appears in the suite, and four `15_000` timeouts), so `19_010` — a port that
 * does not move with the band — would otherwise never be recorded at all.
 * `0x4a3a` is 19002 by the same argument.
 */
function decodeNumber(raw: string): number | null {
	const body = raw.replaceAll("_", "");
	if (/^0[xX][0-9a-fA-F]+$/.test(body))
		return Number.parseInt(body.slice(2), 16);
	if (/^0[oO][0-7]+$/.test(body)) return Number.parseInt(body.slice(2), 8);
	if (/^0[bB][01]+$/.test(body)) return Number.parseInt(body.slice(2), 2);
	if (/^[0-9]+$/.test(body)) return Number(body);
	return null;
}

/**
 * The scan. TypeScript is tokenized far enough to tell code from prose:
 * comments are dropped (a stale header comment naming old ports is
 * documentation, not a bind), string bodies are collected separately from
 * code, `${...}` inside a template literal is scanned AS code (that is where
 * a legitimate rendered port lives: `ws://localhost:${port(19010)}`), and
 * regex literals are skipped so their digits and quote characters cannot
 * desync the tokenizer.
 *
 * For every numeric literal it records the innermost enclosing call frame —
 * the identifier immediately before the `(` it sits inside — which is what
 * "the number is an argument of port()" means precisely. Every `port(...)` /
 * `portStr(...)` call is recorded too, with its argument text, so a call whose
 * argument is computed (`port(19000 + n)`) can be told apart from one whose
 * argument is a base literal.
 */
function scanCode(text: string): {
	literals: Literal[];
	strings: StringNumber[];
	portCalls: PortCall[];
} {
	const literals: Literal[] = [];
	const strings: StringNumber[] = [];
	const portCalls: PortCall[] = [];
	const frames: Array<{ name: string; open: number }> = [];
	// The last significant code character, used to tell a regex literal from
	// a division: `/` after a value divides, `/` after an operator or an
	// opening bracket starts a regex.
	let prevSignificant = "";
	let i = 0;
	const n = text.length;

	/** First non-whitespace character at or after `from` (empty at EOF). */
	const peek = (from: number): string => {
		let k = from;
		while (k < n && /\s/.test(text[k] as string)) k++;
		return text[k] ?? "";
	};

	const readString = (quote: string): void => {
		const start = i + 1;
		i = start;
		while (i < n && text[i] !== quote) {
			if (text[i] === "\\") i++;
			i++;
		}
		strings.push(...numbersIn(text.slice(start, i), start));
		i++;
	};

	while (i < n) {
		const c = text[i];
		if (c === "/" && text[i + 1] === "/") {
			while (i < n && text[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		if (c === "/" && /^[(,=:[!&|?{};+\-*%~^<>]$/.test(prevSignificant)) {
			// regex literal: skip it, honouring escapes and character classes
			i++;
			let inClass = false;
			while (i < n) {
				if (text[i] === "\\") {
					i += 2;
					continue;
				}
				if (text[i] === "/" && !inClass) break;
				if (text[i] === "[") inClass = true;
				else if (text[i] === "]") inClass = false;
				i++;
			}
			i++;
			prevSignificant = "/";
			continue;
		}
		if (c === '"' || c === "'") {
			readString(c);
			prevSignificant = '"';
			continue;
		}
		if (c === "`") {
			i++;
			let chunk = i;
			while (i < n) {
				if (text[i] === "\\") {
					i += 2;
					continue;
				}
				if (text[i] === "`") break;
				if (text[i] === "$" && text[i + 1] === "{") {
					strings.push(...numbersIn(text.slice(chunk, i), chunk));
					// find the matching `}`, then scan the expression as code
					let depth = 1;
					const start = i + 2;
					let j = start;
					while (j < n && depth > 0) {
						const cj = text[j];
						if (cj === "{") depth++;
						else if (cj === "}") depth--;
						else if (cj === "`" || cj === '"' || cj === "'") {
							const q = cj;
							j++;
							while (j < n && text[j] !== q) {
								if (text[j] === "\\") j++;
								j++;
							}
						}
						j++;
					}
					const inner = scanCode(text.slice(start, j - 1));
					for (const lit of inner.literals)
						literals.push({
							...lit,
							index: start + lit.index,
							frameOpen: start + lit.frameOpen,
						});
					for (const s of inner.strings)
						strings.push({ ...s, index: start + s.index });
					for (const call of inner.portCalls)
						portCalls.push({
							...call,
							index: start + call.index,
							open: start + call.open,
						});
					i = j;
					chunk = i;
					continue;
				}
				i++;
			}
			strings.push(...numbersIn(text.slice(chunk, i), chunk));
			i++;
			prevSignificant = "`";
			continue;
		}
		if (c === "(") {
			let k = i - 1;
			while (k >= 0 && /\s/.test(text[k] as string)) k--;
			const end = k + 1;
			while (k >= 0 && /[\w$.]/.test(text[k] as string)) k--;
			frames.push({ name: text.slice(k + 1, end), open: i });
			prevSignificant = "(";
			i++;
			continue;
		}
		if (c === ")") {
			const frame = frames.pop();
			if (frame && (frame.name === "port" || frame.name === "portStr")) {
				const arg = text
					.slice(frame.open + 1, i)
					.trim()
					.replace(/\s+/g, " ");
				const pure = /^[0-9][0-9_]*$/.test(arg) ? decodeNumber(arg) : null;
				portCalls.push({
					name: frame.name,
					open: frame.open,
					arg,
					literal: pure,
					next: peek(i + 1),
					index: frame.open,
				});
			}
			prevSignificant = ")";
			i++;
			continue;
		}
		if (/[0-9]/.test(c as string) && !/[\w$.]/.test(text[i - 1] ?? "")) {
			let j = i;
			if (
				text[i] === "0" &&
				/[xXoObB]/.test(text[i + 1] ?? "") &&
				/[0-9a-fA-F]/.test(text[i + 2] ?? "")
			)
				j = i + 2;
			while (j < n && /[0-9a-fA-F_]/.test(text[j] as string)) j++;
			const raw = text.slice(i, j);
			// a decimal point, exponent or identifier char right after means
			// this is not a plain integer literal
			const value = /[\w$.]/.test(text[j] ?? "") ? null : decodeNumber(raw);
			if (value !== null) {
				const frame = frames[frames.length - 1];
				literals.push({
					value,
					index: i,
					frame: frame?.name ?? "",
					frameOpen: frame?.open ?? -1,
					next: peek(j),
				});
			}
			prevSignificant = "0";
			i = j;
			continue;
		}
		if (!/\s/.test(c as string)) prevSignificant = c as string;
		i++;
	}
	return { literals, strings, portCalls };
}

/**
 * In-window numbers written into prose that ends up in a string: a rendered
 * port in an expected message, a URL, a JSON fixture. Delimited by non-word
 * characters so a digit run inside a hex token or a longer number is not one.
 */
function numbersIn(body: string, offset: number): StringNumber[] {
	const out: StringNumber[] = [];
	for (const m of body.matchAll(/(?<![0-9A-Za-z])[0-9]{4,6}(?![0-9A-Za-z])/g)) {
		const value = Number(m[0]);
		if (inWindow(value)) out.push({ value, index: offset + (m.index ?? 0) });
	}
	return out;
}

const inWindow = (v: number) => v >= ALLOC_FLOOR && v <= ALLOC_CEIL;

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

/** Everything the band scheme covers: the test tree plus src's test files. */
function scannedFiles(): string[] {
	return [
		...walk(join(REPO_ROOT, "test")).filter((p) => p.endsWith(".ts")),
		...walk(join(REPO_ROOT, "src")).filter((p) => p.endsWith(".test.ts")),
	]
		.map((p) => relative(REPO_ROOT, p))
		.sort();
}

const read = (file: string) => readFileSync(join(REPO_ROOT, file), "utf8");

/**
 * Blank out every comment span, preserving newlines and every other index, so
 * a regex can be run over CODE without prose matching it. String bodies are
 * left intact (the flag scan below needs `"--ws-port"` to survive) but are
 * skipped over, so a `//` inside a URL never starts a comment. Regex literals
 * are skipped for the same reason `scanCode` skips them.
 */
function blankComments(text: string): string {
	const out = text.split("");
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < out.length; k++)
			if (out[k] !== "\n") out[k] = " ";
	};
	let prevSignificant = "";
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i] as string;
		if (c === "/" && text[i + 1] === "/") {
			const start = i;
			while (i < n && text[i] !== "\n") i++;
			blank(start, i);
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			const start = i;
			i += 2;
			while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i += 2;
			blank(start, Math.min(i, n));
			continue;
		}
		if (c === "/" && /^[(,=:[!&|?{};+\-*%~^<>]$/.test(prevSignificant)) {
			i++;
			let inClass = false;
			while (i < n) {
				if (text[i] === "\\") {
					i += 2;
					continue;
				}
				if (text[i] === "/" && !inClass) break;
				if (text[i] === "[") inClass = true;
				else if (text[i] === "]") inClass = false;
				i++;
			}
			i++;
			prevSignificant = "/";
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			i++;
			while (i < n && text[i] !== c) {
				if (text[i] === "\\") i++;
				i++;
			}
			i++;
			prevSignificant = '"';
			continue;
		}
		if (!/\s/.test(c)) prevSignificant = c;
		i++;
	}
	return out.join("");
}

const lineOf = (text: string, index: number) =>
	text.slice(0, index).split("\n").length;

const range = (from: number, to: number): number[] =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Bases the suite builds by ARITHMETIC inside the call — `port(19000 + n)` —
 * which a literal scan cannot see. They are real index-space consumers, so the
 * band-width assertion is only honest if it counts them.
 *
 * Every entry is checked in BOTH directions below: a computed `port()` call
 * site that is not declared here fails, and a declaration that matches no call
 * site fails. So this list cannot rot quietly the way a hand-maintained count
 * would.
 */
type ComputedFamily = {
	/** Repo-relative file the call site lives in. */
	file: string;
	/** The argument source, exactly as written (whitespace-normalized). */
	expr: string;
	/** Every base the site really requests at runtime. */
	bases: number[];
	why: string;
};

/** `boot(n)`'s n arguments in src/control-plane/index.test.ts. */
const CONTROL_PLANE_N = [...range(1, 21), 30, 31, 91, 92];

const COMPUTED_FAMILIES: ComputedFamily[] = [
	...[19000, 11800, 19800].map((base) => ({
		file: "src/broker/index.test.ts",
		expr: `${base} + n`,
		bases: range(1, 8).map((n) => base + n),
		why: "ports(n) — one broker per test, n = 1..8",
	})),
	...[18000, 12800, 18800].map((base) => ({
		file: "src/control-plane/index.test.ts",
		expr: `${base} + n`,
		bases: CONTROL_PLANE_N.map((n) => base + n),
		why: "bootPorts(n) — the suite's widest per-file window",
	})),
	...[16000, 12600, 16800].map((base) => ({
		file: "test/ci-settlement.test.ts",
		expr: `${base} + n`,
		bases: range(1, 2).map((n) => base + n),
		why: "boot(n) — two composed servers",
	})),
	...[19070, 12970, 19870].map((base) => ({
		file: "test/gate-validation.test.ts",
		expr: `${base} + n`,
		bases: range(1, 5).map((n) => base + n),
		why: "bootFixture(n) — n = 1..5, the +0 row is never used",
	})),
	...[17700, 17800, 17900].map((base) => ({
		file: "test/m0-acceptance.test.ts",
		expr: `${base} + n`,
		bases: range(1, 4).map((n) => base + n),
		why: "ports(n) — the full-stack boots, n = 1..4",
	})),
	{
		file: "test/ports.test.ts",
		expr: "A",
		bases: [ALLOC_FLOOR + 3],
		why: "the process-level API test's first probe base",
	},
	{
		file: "test/ports.test.ts",
		expr: "B",
		bases: [ALLOC_FLOOR + 4],
		why: "the process-level API test's second probe base",
	},
	{
		file: "test/ports.test.ts",
		expr: "ALLOC_CEIL + 1",
		bases: [],
		why: "an out-of-window base: the call always throws, so it indexes nothing",
	},
	{
		file: "test/ports.test.ts",
		expr: "ALLOC_FLOOR - 1",
		bases: [],
		why: "as above, below the floor",
	},
	{
		file: "test/ports.test.ts",
		expr: "base",
		bases: [],
		why: "iterates DETACHED_BASES, every one of which is already counted",
	},
];

type Scan = {
	/** Bases from literal `port(N)` / `portStr(N)` call sites. */
	bases: Set<number>;
	violations: string[];
	/** Computed `port()` call sites, as `file:expr`. */
	computedSites: Set<string>;
};

let cached: Scan | undefined;

/** Every in-window base the suite hands to port()/portStr(), scanned once. */
function scanBases(): Scan {
	cached ??= scanBasesUncached();
	return cached;
}

function scanBasesUncached(): Scan {
	const bases = new Set<number>();
	const violations: string[] = [];
	const computedSites = new Set<string>();
	for (const file of scannedFiles()) {
		const text = read(file);
		if (ALLOWLISTED_FILES.has(file) && text.includes(ALLOWLIST_MARKER))
			continue;
		const { literals, strings, portCalls } = scanCode(text);
		const callByOpen = new Map(portCalls.map((c) => [c.open, c]));
		for (const call of portCalls) {
			if (call.literal === null) computedSites.add(`${file}:${call.arg}`);
			// Arithmetic on a port() RESULT walks off this base's slot and onto
			// whichever unrelated base happens to hold the next index — invisible
			// in band 0 (the identity map), a silent cross-wire in every other.
			if (call.next === "+" || call.next === "-" || call.next === "*")
				violations.push(
					`${file}:${lineOf(text, call.index)}: arithmetic on the RESULT of ` +
						`${call.name}(${call.arg}) — do the arithmetic INSIDE the call ` +
						`(${call.name}(${call.arg} + 1)), or the offset lands on an ` +
						`unrelated base's slot in every band but 0`,
				);
		}
		for (const lit of literals) {
			if (!inWindow(lit.value)) continue;
			if (lit.frame === "port" || lit.frame === "portStr") {
				// `port(19000 + n)`: the literal is a family base, not a base —
				// COMPUTED_FAMILIES accounts for what the family really requests.
				if (callByOpen.get(lit.frameOpen)?.literal !== null)
					bases.add(lit.value);
				continue;
			}
			if (TIMEOUT_FRAMES.has(lit.frame) && lit.next === ")") continue;
			violations.push(
				`${file}:${lineOf(text, lit.index)}: bare literal ${lit.value} ` +
					`(inside ${lit.frame ? `${lit.frame}(...)` : "no call"}) — wrap it as port(${lit.value})`,
			);
		}
		for (const s of strings) {
			violations.push(
				`${file}:${lineOf(text, s.index)}: the number ${s.value} is written into a string ` +
					`— render it as \${port(${s.value})} so the text follows the band`,
			);
		}
	}
	return { bases, violations, computedSites };
}

/** Every base the suite really allocates: scanned literals + computed families. */
function allBases(): Set<number> {
	const all = new Set(scanBases().bases);
	for (const f of COMPUTED_FAMILIES) for (const b of f.bases) all.add(b);
	return all;
}

test("TOTALITY: every in-window port number in the suite goes through port()/portStr()", () => {
	const { bases, violations } = scanBases();
	// The failure message is the whole point of this test, so it carries the
	// reason as well as the sites: a raw literal survives band 0 (a local run)
	// and only collides once a second process claims a band.
	expect(
		violations.length === 0
			? []
			: [
					`${violations.length} port number(s) outside port()/portStr() in [${ALLOC_FLOOR}, ${ALLOC_CEIL}].`,
					"Each is a port that does NOT move with this process's band, so it passes",
					"locally (band 0 is the identity map) and collides only under concurrency.",
					...violations,
				],
	).toEqual([]);
	// A scan that matched nothing would pass vacuously; the suite really does
	// allocate hundreds of bases.
	expect(bases.size).toBeGreaterThan(100);
});

test("the sweep exemption is confined to the files that document it", () => {
	const marked = scannedFiles().filter((f) =>
		read(f).includes(ALLOWLIST_MARKER),
	);
	expect(marked.sort()).toEqual([...ALLOWLISTED_FILES.keys()].sort());
});

test("ACCOUNTING: every computed port() call site is declared, and every declaration is real", () => {
	const { computedSites } = scanBases();
	const declared = new Set(COMPUTED_FAMILIES.map((f) => `${f.file}:${f.expr}`));
	// Undeclared: a family whose bases nobody counted — the band-width
	// assertion below would then be checking a number it made up.
	expect([...computedSites].filter((s) => !declared.has(s)).sort()).toEqual([]);
	// Dangling: a declaration whose call site is gone, which inflates the count
	// and hides a real shrink in headroom.
	expect([...declared].filter((s) => !computedSites.has(s)).sort()).toEqual([]);
});

test("ACCOUNTING: one band's index space holds every base the suite allocates", () => {
	const { bases } = scanBases();
	const all = allBases();
	// The literal scan alone understates the load badly — five files build
	// their bases arithmetically inside the call — so the assertion counts the
	// declared families too. Running out is loud (mapPort throws and names the
	// ceiling), never silent, but only for bands >= 1: band 0 is the identity
	// map and never indexes, so a local run would never notice.
	expect(all.size).toBeGreaterThan(bases.size);
	expect(BAND_WIDTH).toBeGreaterThanOrEqual(all.size);
	// Residual, stated rather than hidden: the CALL SITES are enforced in both
	// directions above, but each family's n-range is read from the source by a
	// human, so adding a `ports(9)` to an existing family would not move this
	// count. The margin is the answer to that — the geometry must never be
	// tuned to hug a hand-maintained number.
	expect(BAND_WIDTH - all.size).toBeGreaterThanOrEqual(64);
});

test("BAND MATH: the geometry keeps every band port safe and every window disjoint", () => {
	// The top band's highest port must stay below the ephemeral floor.
	const highestPort = COMPACT_BASE + MAX_BAND * BAND_WIDTH - 1;
	expect(highestPort).toBeLessThan(EPHEMERAL_FLOOR);
	// Sentinels sit below the base window, so a sentinel can never be a base
	// and claiming a band can never squat a port a test wants.
	expect(SENTINEL_BASE + MAX_BAND).toBeLessThan(ALLOC_FLOOR);
	// Band 0's ports are the bases themselves, so the compact windows must
	// start above the window or band 0 and band 1 would overlap.
	expect(COMPACT_BASE).toBeGreaterThan(ALLOC_CEIL);
	expect(ALLOC_FLOOR).toBeLessThan(ALLOC_CEIL);
	// Every band is one BAND_WIDTH-wide window, in order, with no gaps that
	// would let two bands share a port.
	for (let band = 1; band <= MAX_BAND; band++) {
		const first = mapPort(band, ALLOC_FLOOR, new Map());
		expect(first).toBe(COMPACT_BASE + (band - 1) * BAND_WIDTH);
		expect(first + BAND_WIDTH - 1).toBeLessThanOrEqual(highestPort);
	}
});

test("BAND MATH: band 0 is the identity map for every base the suite allocates", () => {
	const assigned = new Map<number, number>();
	const moved = [...allBases()].filter((b) => mapPort(0, b, assigned) !== b);
	// Band 0 keeping today's literals is a hard requirement, not a nicety: it
	// is what lets a local run, a stack trace and a grep still agree with the
	// numbers written in the source.
	expect(moved).toEqual([]);
});

test("PORTABILITY: the sentinel binds an explicit 127.0.0.1 and never asks for SO_REUSEPORT", () => {
	// Comments blanked: the prose above tryClaim explains WHY 0.0.0.0 and
	// reusePort are forbidden, and that explanation must not trip its own pin.
	const source = blankComments(read("test/ports.ts"));
	const listens = [...source.matchAll(/\.listen\(/g)].length;
	const hostBound = [
		...source.matchAll(
			/\.listen\(\s*[A-Za-z_$][\w$]*\s*,\s*"127\.0\.0\.1"\s*\)/g,
		),
	].length;
	const problems: string[] = [];
	if (listens === 0)
		problems.push(
			"test/ports.ts no longer calls .listen() at all — has the sentinel moved to another API? Move this pin with it.",
		);
	if (hostBound !== listens)
		problems.push(
			`${listens - hostBound} of ${listens} .listen(...) call(s) in test/ports.ts do not pass an explicit "127.0.0.1".`,
		);
	if (/reusePort/.test(source))
		problems.push(
			"test/ports.ts mentions reusePort. SO_REUSEPORT is precisely the 'let another process share this port' switch; the sentinel must never set it.",
		);
	if (/0\.0\.0\.0/.test(source))
		problems.push(
			"test/ports.ts mentions 0.0.0.0 — the sentinel must bind the loopback address exactly.",
		);
	expect(
		problems.length === 0
			? []
			: [
					"The sentinel's host argument is load-bearing on BSD/macOS, and deleting it",
					"keeps every test green on Linux. Listeners set SO_REUSEADDR by default, and",
					"BSD then permits two live binds on the same port when the bound ADDRESSES",
					"differ: a sentinel on 0.0.0.0:11700 in one process and 127.0.0.1:11700 in",
					"another would BOTH be granted — two processes in one band, the guarantee",
					"gone, and only on the platform nobody here runs.",
					...problems,
				],
	).toEqual([]);
});

/**
 * Every base handed to a process the suite SPAWNS, resolved from the CLI flag
 * sites. One level of file-scope constant is followed (`const CTRL =
 * port(19801)` … `"--ctrl-port", String(CTRL)`); anything else fails, so the
 * check is fail-closed rather than quietly incomplete.
 */
function spawnedFlagBases(): {
	bases: Map<number, string>;
	unresolved: string[];
} {
	const bases = new Map<number, string>();
	const unresolved: string[] = [];
	const FLAG =
		/"(--ws-port|--tcp-port|--ctrl-port|--port)"\s*,\s*((?:portStr|port)\(\s*\d+\s*\)|String\(\s*[A-Za-z_$][\w$]*\s*\)|[A-Za-z_$][\w$]*)/g;
	const CONST =
		/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:portStr|port)\(\s*(\d+)\s*\)/g;
	for (const file of scannedFiles()) {
		// comments blanked: a doc comment quoting a flag site is prose, not a spawn
		const text = blankComments(read(file));
		const consts = new Map(
			[...text.matchAll(CONST)].map((m) => [m[1] as string, Number(m[2])]),
		);
		for (const m of text.matchAll(FLAG)) {
			const arg = (m[2] as string).trim();
			const direct = /^(?:portStr|port)\(\s*(\d+)\s*\)$/.exec(arg);
			const named = /^(?:String\(\s*)?([A-Za-z_$][\w$]*)\s*\)?$/.exec(arg);
			const base = direct
				? Number(direct[1])
				: named
					? consts.get(named[1] as string)
					: undefined;
			const where = `${file}:${lineOf(text, m.index ?? 0)}`;
			if (base === undefined) unresolved.push(`${where}: ${m[1]} ${arg}`);
			else bases.set(base, where);
		}
	}
	return { bases, unresolved };
}

test("ORPHANS: every port handed to a spawned server is in DETACHED_BASES", () => {
	const { bases, unresolved } = spawnedFlagBases();
	expect(unresolved).toEqual([]);
	// Non-vacuous: the suite really does spawn detached servers.
	expect(bases.size).toBeGreaterThan(20);
	const listed = new Set(DETACHED_BASES);
	const missing = [...bases]
		.filter(([base]) => !listed.has(base))
		.map(
			([base, where]) =>
				`${where}: base ${base} is handed to a spawned server but is not in DETACHED_BASES`,
		);
	expect(
		missing.length === 0
			? []
			: [
					"A detached server outlives the run that spawned it when that run is",
					"SIGKILLed (Stryker timeout): the OS frees the sentinel, the orphan keeps",
					"the ports. The claim-time probe in test/ports.ts only sees the ports",
					"listed in DETACHED_BASES, so an unlisted one brings the EADDRINUSE flake",
					"straight back — as a mutant scored KILLED.",
					...missing,
				],
	).toEqual([]);
	// The list must not grow stale in the other direction either.
	expect([...DETACHED_BASES].filter((b) => !bases.has(b))).toEqual([]);
});

test("LOAD ORDER: test/preload.ts claims the band as its first statement", () => {
	const source = read("test/preload.ts");
	// Comments only; a preload that imports anything before ./ports.ts lets
	// that module bind a port before the band is known.
	const code = source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.trim();
	const firstStatement = code.split("\n")[0]?.trim();
	expect(firstStatement).toBe('import "./ports.ts";');
});
