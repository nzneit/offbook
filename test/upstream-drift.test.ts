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
import { readFileSync, readdirSync, statSync } from "node:fs";
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

test("SUPPORTED_SPEC_VERSIONS matches the versions @asyncapi/specs exposes", () => {
	// Exact equality, no filtering: the 2.0.0-rc1/rc2 schemas exist on disk but
	// are excluded from the export map, so `schemas` is exactly the release set.
	//
	// Red here means a parser bump changed the available versions. The fix is to
	// verify the new version against the real parser and then add it to the
	// constant — NOT to derive the constant from this. Parser 3.4.0 shipped the
	// 3.1.0 schema and still died inside its own ruleset (D-018), which this
	// check cannot see.
	expect([...SUPPORTED_SPEC_VERSIONS] as string[]).toEqual(
		Object.keys((specs as { schemas: Record<string, unknown> }).schemas),
	);
});

test("the mqtt operation binding constants match the official schema", () => {
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
	// import edge, not mentions of the name in prose comments.
	const offenders = walk("src")
		.filter((p) => p.endsWith(".ts"))
		.filter((p) =>
			/from\s+["']@asyncapi\/specs(\/[^"']*)?["']/.test(
				readFileSync(p, "utf8"),
			),
		);
	expect(offenders).toEqual([]);
});
