// R-034/R-036 — every cookbook recipe is a loadable scenario file
// (adoption.md §4): extracted from the tagged fences and loaded against the
// bundled demo spec's registry with zero diagnostics — no vacuous recipes.
// [itest->R-034]
// [itest->R-036]
import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "#src/config/index.ts";
import { createFaker } from "#src/engine/faker.ts";
import { buildRegistry } from "#src/registry/index.ts";
import { buildTable } from "#src/scenarios/loader.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const GUIDE = join(REPO_ROOT, "docs/guides/scenario-cookbook.md");
const DEMO_SPEC = join(REPO_ROOT, "src/demo/thermostat.yaml");

test("every `yaml scenario` fence in the cookbook loads clean against the demo spec", async () => {
	const text = await Bun.file(GUIDE).text();
	const fences = [...text.matchAll(/```yaml scenario\n([\s\S]*?)```/g)].map(
		(m) => m[1],
	);
	expect(fences.length).toBeGreaterThanOrEqual(4); // ack, chain, on-demand, deterministic-values

	const config = loadConfig({});
	const registry = await buildRegistry({
		specText: await Bun.file(DEMO_SPEC).text(),
		service: "demo",
		config,
	});
	const faker = createFaker(config);
	for (const [i, yaml] of fences.entries()) {
		const { diagnostics } = await buildTable(
			[{ source: `recipe-${i}.yaml`, text: yaml }],
			{
				registry,
				faker,
				config,
			},
		);
		expect(diagnostics).toEqual([]);
	}
});
