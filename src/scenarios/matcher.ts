// R-016 — the L2 `when.topic` matcher and pattern-overlap analysis (l2 §3–§4).
// This is the one PERMITTED matcher besides SpecRegistry.match (contracts §2):
// it fuses {param} capture, MQTT +/# filter semantics, and payloadMatch in a
// single walk — an operation the registry's matcher deliberately refuses. It
// never resolves a concrete topic to a Channel (that stays registry.match's
// monopoly).

const PARAM_RE = /^\{([^{}]+)\}$/;

// Level-by-level walk (l2 §4): literals must equal, {param} binds, + matches
// any one level, # swallows the rest — including ZERO trailing levels
// (MQTT 3.1.1: a/# also matches a). Terminality of # is enforced at load.
export function matchTopic(
	pattern: string,
	topic: string,
): Record<string, string> | undefined {
	const ps = pattern.split("/");
	const ts = topic.split("/");
	const params: Record<string, string> = {};
	for (let i = 0; i < ps.length; i++) {
		const p = ps[i];
		if (p === "#" && i === ps.length - 1) return params;
		const t = ts[i];
		if (t === undefined) return undefined;
		const name = p?.match(PARAM_RE)?.[1];
		if (name !== undefined) {
			params[name] = t;
			continue;
		}
		if (p === "+") continue;
		if (p !== t) return undefined;
	}
	return ts.length === ps.length ? params : undefined;
}

export type PatternRelation =
	| { intersects: false }
	| { intersects: true; covers: boolean; witness: string };

// Pattern-vs-pattern relation, for the l2 §3 overlap warning and the l2 §7
// when-topic→channel binding. `covers` = every topic matching `b` also
// matches `a`; `witness` = one topic (concrete where possible) in the
// intersection, for a human-readable diagnostic.
export function comparePatterns(a: string, b: string): PatternRelation {
	const as = a.split("/");
	const bs = b.split("/");
	const witness: string[] = [];
	let covers = true;
	for (let i = 0; ; i++) {
		const av = as[i];
		const bv = bs[i];
		if (av === undefined && bv === undefined)
			return { intersects: true, covers, witness: witness.join("/") };
		if (av === "#") {
			// a swallows the rest (zero or more); b's remainder supplies the
			// witness suffix
			witness.push(...bs.slice(i));
			return { intersects: true, covers, witness: witness.join("/") };
		}
		if (bv === "#") {
			// b swallows the rest: a's remaining levels are the witness, and b
			// also matches topics (other lengths) that a cannot — not covered
			witness.push(...as.slice(i));
			return { intersects: true, covers: false, witness: witness.join("/") };
		}
		if (av === undefined || bv === undefined) return { intersects: false };
		const aVar = av === "+" || PARAM_RE.test(av);
		const bVar = bv === "+" || PARAM_RE.test(bv);
		if (!aVar && !bVar) {
			if (av !== bv) return { intersects: false };
			witness.push(av);
			continue;
		}
		if (!aVar) {
			// a literal vs b variable: they meet at a's literal, but b admits
			// segments a rejects — a no longer covers b
			covers = false;
			witness.push(av);
			continue;
		}
		// a variable: b's level text is the best witness — a literal stays
		// concrete, and a {param} name reads better than '+'
		witness.push(bv);
	}
}

// Dotted-path read (l2 §4): walks objects (and arrays by numeric segment);
// any miss resolves to undefined, never a throw.
export function resolvePath(value: unknown, path: string): unknown {
	let cur: unknown = value;
	for (const key of path.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
			return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	const ak = Object.keys(a);
	const bk = Object.keys(b);
	if (ak.length !== bk.length) return false;
	return ak.every((k) =>
		deepEqual(
			(a as Record<string, unknown>)[k],
			(b as Record<string, unknown>)[k],
		),
	);
}

// l2 §4 subset equality: every listed dotted path deep-equals the inbound
// field; extra inbound fields are ignored; NO operators (that's the L3
// signal).
export function payloadMatches(
	match: Record<string, unknown> | undefined,
	payload: unknown,
): boolean {
	if (!match) return true;
	return Object.entries(match).every(([path, expected]) =>
		deepEqual(resolvePath(payload, path), expected),
	);
}
