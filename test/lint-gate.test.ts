import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Guards the biome config against the one way it is known to die quietly (D-023).
// Not tied to an R-### — like test/import-style.test.ts (D-013), this pins a
// decision, not a requirement.
//
// `biome migrate` rewrites `"recommended": true` (v1) as `"preset": "none"`
// (v2), which does not port the rule set — it deletes it. The failure is silent
// in the worst way: `bun run lint` still exits 0, CI stays green, and the repo
// lints nothing. Measured on the 1.9.4 -> 2.5.6 bump: a file containing `any`,
// `==` and an unused `var` drew zero diagnostics under the migrated config and
// three once `preset` was corrected. So the config is asserted here rather than
// trusted, because the symptom of it being wrong is that nothing complains.
const config = JSON.parse(readFileSync("biome.json", "utf8")) as {
	linter: { enabled: boolean; rules: { preset: string } };
	overrides: Array<{
		includes: string[];
		linter: { rules: { style: { noRestrictedImports: unknown } } };
	}>;
};

test("the linter is enabled and the recommended rule set is actually on", () => {
	expect(config.linter.enabled).toBe(true);
	// "none" is what `biome migrate` writes, and it disables everything.
	expect(config.linter.rules.preset).toBe("recommended");
});

// The R-030 transport-isolation lint rule, asserted structurally so a config
// edit cannot drop it without a test failing. The regex gate in
// test/transport-isolation.test.ts is the independent second layer: that one
// catches an actual offending import, this one catches the rule going missing.
test("the transport-isolation rule is configured for src/ and exempted for src/broker/", () => {
	const src = config.overrides.find((o) => o.includes.includes("**/src/**"));
	const broker = config.overrides.find((o) =>
		o.includes.includes("**/src/broker/**"),
	);
	expect(src).toBeDefined();
	expect(broker).toBeDefined();

	const rule = src?.linter.rules.style.noRestrictedImports as {
		level: string;
		options: { paths: Record<string, string> };
	};
	expect(rule.level).toBe("error");
	expect(Object.keys(rule.options.paths).sort()).toEqual([
		"aedes",
		"aedes-server-factory",
	]);

	// broker/ is the one place allowed to import a transport package
	expect(broker?.linter.rules.style.noRestrictedImports).toBe("off");
});
