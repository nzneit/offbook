// R-037 — the AsyncAPI version contract plus a parser-free shallow read of the
// `asyncapi` field. Tier 0 (model): pure functions over raw text, so both
// `registry/` (the preflight gate) and `ingestion/` (lockfile provenance, G12)
// can use them without a cross-import between tier-1 peers.
import { parse as parseYaml } from "yaml";

// The versions offbook PROMISES and TESTS. Deliberately an explicit list rather
// than `Object.keys(specs.schemas)`: the parser derives its accepted set from
// whatever @asyncapi/specs resolves at install time, so a schema being present
// does NOT mean the parser's ruleset handles that version. Parser 3.4.0 and
// 3.5.0 accept a 3.1.0 document past their version gate and then die inside
// Spectral with "Error running Nimma". See D-018.
export const SUPPORTED_SPEC_VERSIONS = [
	"2.0.0",
	"2.1.0",
	"2.2.0",
	"2.3.0",
	"2.4.0",
	"2.5.0",
	"2.6.0",
	"3.0.0",
	"3.1.0",
] as const;

// Best-effort, mirroring ingestion's readDeclaredVersion (G12): no
// @asyncapi/parser, no schema interpretation. A spec that will not yaml-parse,
// or that has no `asyncapi` field, just yields undefined.
export function readSpecVersion(specText: string): string | undefined {
	try {
		const doc = parseYaml(specText) as { asyncapi?: unknown } | null;
		const v = doc?.asyncapi;
		// undefined ONLY for a genuinely absent field. A present-but-null value
		// (bare `asyncapi:`) reads as the string "null" and is therefore a
		// positive read: it falls into the preflight's branded refusal instead
		// of past it into the parser's raw TypeError. String() stays broad
		// (never narrowed to string/number) because the parser's internal
		// TypeError also fires on `''`, `true`, and `{}` — every one of those
		// must land here as a positive read too (D-019).
		return v === undefined ? undefined : String(v);
	} catch {
		return undefined;
	}
}

export function isSupportedSpecVersion(v: string | undefined): boolean {
	return (
		v !== undefined &&
		(SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(v)
	);
}
