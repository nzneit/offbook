// R-016 — the closed {{…}} substitution vocabulary (l2 §5): {{param}},
// {{payload.<path>}}, {{uuid}}, {{seq}}, {{now}}. L2 templating shapes DATA
// only — the moment a response needs a conditional, computation, loop, or
// memory across messages, that is the L3 boundary, by design.

export const TEMPLATE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export type TemplateRef =
	| { kind: "param"; name: string }
	| { kind: "payload"; path: string }
	| { kind: "uuid" }
	| { kind: "seq" }
	| { kind: "now" };

const IDENT_RE = /^[A-Za-z_][\w-]*$/;

// The vocabulary is CLOSED: anything else returns undefined and is rejected
// at load (l2 §7), never silently passed through.
export function parseRef(expr: string): TemplateRef | undefined {
	if (expr === "uuid") return { kind: "uuid" };
	if (expr === "seq") return { kind: "seq" };
	if (expr === "now") return { kind: "now" };
	if (expr.startsWith("payload.")) {
		const path = expr.slice("payload.".length);
		return path.length > 0 ? { kind: "payload", path } : undefined;
	}
	// bare "payload" is not a param — the helper namespace is reserved
	if (expr === "payload") return undefined;
	return IDENT_RE.test(expr) ? { kind: "param", name: expr } : undefined;
}

export interface TemplateOccurrence {
	raw: string; // the literal "{{…}}" text, for diagnostics
	ref?: TemplateRef; // absent ⇒ outside the closed vocabulary
}

export interface TemplateScan {
	occurrences: TemplateOccurrence[]; // every {{…}}, in encounter order
	singleBrace: string[]; // strings carrying single-brace residue (EQ7)
}

function scanString(s: string, acc: TemplateScan): void {
	for (const m of s.matchAll(TEMPLATE_RE))
		acc.occurrences.push({ raw: m[0], ref: parseRef(m[1] ?? "") });
	// anything brace-like left after removing well-formed {{…}} is a
	// single-brace segment — a capture written where a substitution was meant
	if (/[{}]/.test(s.replace(TEMPLATE_RE, ""))) acc.singleBrace.push(s);
}

// Deep-walks a value (string leaves only — keys stay literal, l2 §5) and
// collects every template occurrence + EQ7 single-brace residue.
export function scanValue(value: unknown, into?: TemplateScan): TemplateScan {
	const acc = into ?? { occurrences: [], singleBrace: [] };
	if (typeof value === "string") scanString(value, acc);
	else if (Array.isArray(value)) for (const v of value) scanValue(v, acc);
	else if (value !== null && typeof value === "object")
		for (const v of Object.values(value)) scanValue(v, acc);
	return acc;
}

// Sentinel: a whole-string template that resolved to undefined omits its
// field entirely, so the L1 autofill can backfill it if the schema requires
// it (l2 §5) — never an "undefined" string on the wire.
export const OMIT: unique symbol = Symbol("offbook.l2.omit");

export type Resolver = (ref: TemplateRef, raw: string) => unknown;

function substituteString(s: string, resolve: Resolver): unknown {
	const matches = [...s.matchAll(TEMPLATE_RE)];
	if (matches.length === 0) return s;
	const first = matches[0];
	// a string that IS exactly one template substitutes the raw resolved
	// value, type preserved — a numeric {{payload.target}} lands as a number
	if (matches.length === 1 && first && first[0] === s) {
		const ref = parseRef(first[1] ?? "");
		if (!ref) return s; // outside the vocabulary — load already rejected it
		const v = resolve(ref, s);
		return v === undefined ? OMIT : v;
	}
	// embedded templates interpolate as strings
	return s.replace(TEMPLATE_RE, (raw, expr) => {
		const ref = parseRef(String(expr));
		if (!ref) return raw;
		const v = resolve(ref, raw);
		if (v === undefined) return "";
		return typeof v === "object" ? JSON.stringify(v) : String(v);
	});
}

// Recursive substitution over a payload skeleton. Object keys are never
// templated; OMIT-resolved entries are dropped (fields from objects, elements
// from arrays).
export function substitute(value: unknown, resolve: Resolver): unknown {
	if (typeof value === "string") return substituteString(value, resolve);
	if (Array.isArray(value))
		return value.map((v) => substitute(v, resolve)).filter((v) => v !== OMIT);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const sv = substitute(v, resolve);
			if (sv !== OMIT) out[k] = sv;
		}
		return out;
	}
	return value;
}

// l2 §5: seeded deterministic UUID — v4-SHAPED (version/variant bits set) but
// drawn from the seeded PRNG, never crypto-random.
export function seededUuid(rand: () => number): string {
	const bytes = Array.from({ length: 16 }, () => Math.floor(rand() * 256));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
