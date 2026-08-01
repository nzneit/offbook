// R-037 / R-039 — the upstream-drift gate. offbook hand-authors two constants
// that mirror @asyncapi/specs (the supported version set and the mqtt operation
// binding's key contract) rather than deriving them at runtime, because a value
// being present upstream is not the same as offbook having tested it (D-018,
// D-019). Hand-authored constants go stale silently, so this gate makes the
// drift loud at the dependency bump, which is the moment someone can act on it.
// @asyncapi/specs is a devDependency: this file is the ONLY place it may be
// imported, which the third check enforces.
// [stest->R-037]
// [stest->R-039]
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import specs from "@asyncapi/specs";
import mqttOperationBinding from "@asyncapi/specs/bindings/mqtt/0.2.0/operation.json" with {
	type: "json",
};
import { SUPPORTED_SPEC_VERSIONS } from "#src/model/spec-version.ts";
import {
	MQTT_EXTENSION_KEY,
	MQTT_OPERATION_KEYS,
} from "#src/registry/index.ts";

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

// `import(...)` alongside `from "…"` / `require(…)`, all with the same
// whitespace tolerance, so a dynamic import (`await import("@asyncapi/specs/…")`,
// a live idiom in this codebase — see src/engine/dispatch.ts) cannot slip past
// the devDependency guard below. Indirection through a variable
// (`import(someVar)`) still evades this by design: matching that would need
// real static analysis, not a source-text regex.
const ASYNCAPI_SPECS_IMPORT =
	/from\s+["']@asyncapi\/specs(\/[^"']*)?["']|require\(\s*["']@asyncapi\/specs(\/[^"']*)?["']\s*\)|import\(\s*["']@asyncapi\/specs(\/[^"']*)?["']\s*\)/;

test("SUPPORTED_SPEC_VERSIONS matches the versions @asyncapi/specs exposes", () => {
	// This test's premise is that the ROOT @asyncapi/specs (our devDependency,
	// what this file imports) is the SAME copy @asyncapi/parser resolves at
	// runtime. They are deduped today, but nested copies are a real phenomenon
	// in this very tree (node_modules/@asyncapi/parser/node_modules/ajv-formats
	// exists). If a future parser bump ever carries its own nested
	// @asyncapi/specs, this comparison would silently run against the WRONG
	// copy at exactly the moment — a version bump — it exists to catch
	// something. Fail loud instead: if this ever exists, resolve the comparison
	// through the parser's own dependency instead of the root import above.
	expect(
		existsSync("node_modules/@asyncapi/parser/node_modules/@asyncapi/specs"),
	).toBe(false);

	// Exact equality, no filtering: the 2.0.0-rc1/rc2 AND every 1.x schema exist
	// on disk but are excluded from the export map, so `schemas` is exactly the
	// release set offbook cares about.
	//
	// Red here means a parser bump changed the available versions. The fix is to
	// verify the new version against the REAL parser, then either add it to the
	// constant or record a deliberate exclusion in this gate — NOT to derive the
	// constant from this check unconditionally: verification can fail. Parser
	// 3.4.0 shipped the 3.1.0 schema and still died inside its own ruleset
	// (D-018), which this check alone cannot see.
	expect([...SUPPORTED_SPEC_VERSIONS] as string[]).toEqual(
		Object.keys((specs as { schemas: Record<string, unknown> }).schemas),
	);
});

test("the mqtt operation binding constants match the official schema", () => {
	// Versioned schemas are immutable upstream, so comparing against a fixed
	// path (bindings/mqtt/0.2.0/operation.json below) can never itself detect
	// drift: that file will never change. Real drift arrives as a NEW binding
	// version directory, which may add legal keys; until offbook's constant is
	// updated for it, a spec declaring that version would draw a spurious
	// binding-unknown-key warning — the crying-wolf failure this diagnostic
	// exists to avoid. So pin the version SET too, not just the pinned
	// version's content.
	expect(
		[...readdirSync("node_modules/@asyncapi/specs/bindings/mqtt")].sort(),
	).toEqual(["0.1.0", "0.2.0"]);

	const schema = mqttOperationBinding as {
		properties: Record<string, unknown>;
		patternProperties: Record<string, unknown>;
	};
	expect([...MQTT_OPERATION_KEYS].sort()).toEqual(
		Object.keys(schema.properties).sort(),
	);
	// transcribed character-for-character, so the source strings compare directly
	expect(Object.keys(schema.patternProperties)).toEqual([
		MQTT_EXTENSION_KEY.source,
	]);
});

test("@asyncapi/specs stays a devDependency: nothing under src/ imports it", () => {
	// Biome's noRestrictedImports matches whole module specifiers, so it cannot
	// express "this package at any subpath", and the realistic regression is a
	// deep JSON import like the one this gate replaced (D-019). Same idiom as
	// test/transport-isolation.test.ts and ingestion's G12 guard: match the
	// `from "…"`, `require("…")`, AND `import("…")` edges, not mentions of the
	// name in prose comments.
	const offenders = walk("src")
		.filter((p) => p.endsWith(".ts"))
		.filter((p) => ASYNCAPI_SPECS_IMPORT.test(readFileSync(p, "utf8")));
	expect(offenders).toEqual([]);
});
