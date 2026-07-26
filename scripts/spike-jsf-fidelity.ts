// R-027 (F8): measure json-schema-faker fidelity — per-fixture Ajv-recheck
// failure rates for seeded draws over every bundled channel.schema.
// Verdict rule (D-008): nonzero on a §5-bar fixture ⇒ F5 keyed-fallback needed.
import { loadConfig } from "#src/config/index.ts";
import { createFaker } from "#src/engine/faker.ts";
import { buildRegistry } from "#src/registry/index.ts";

export const SPIKE_FIXTURES = [
	"composition.yaml",
	"external-ref.yaml",
	"qos-overrides.yaml",
	"qos-retain.yaml",
	"thermostat.yaml",
	"v2-pubsub.yaml",
];

export interface FixtureReport {
	fixture: string;
	draws: number;
	failures: number;
	byChannel: Record<string, { draws: number; failures: number }>;
}

const FIXTURE_DIR = `${import.meta.dir}/../fixtures/asyncapi`;

export async function measureFixture(
	fixture: string,
	seeds: number[],
): Promise<FixtureReport> {
	const path = `${FIXTURE_DIR}/${fixture}`;
	const specText = await Bun.file(path).text();
	const reg = await buildRegistry({
		specText,
		service: "spike",
		config: loadConfig(),
		source: path,
	});
	const report: FixtureReport = {
		fixture,
		draws: 0,
		failures: 0,
		byChannel: {},
	};
	for (const ch of reg.channels()) {
		const per = { draws: 0, failures: 0 };
		report.byChannel[ch.topic] = per;
		for (const seed of seeds) {
			const faker = createFaker(loadConfig({ seed }));
			per.draws++;
			report.draws++;
			try {
				const payload = await faker(ch);
				if (ch.validate(payload).length > 0) {
					per.failures++;
					report.failures++;
				}
			} catch {
				// a rejecting faker counts as a failed draw (F5 treats both the same)
				per.failures++;
				report.failures++;
			}
		}
	}
	return report;
}

if (import.meta.main) {
	const seeds = Array.from({ length: 25 }, (_, i) => i + 1);
	for (const fixture of SPIKE_FIXTURES) {
		const r = await measureFixture(fixture, seeds);
		const rate = r.draws ? ((100 * r.failures) / r.draws).toFixed(1) : "n/a";
		console.log(`${fixture}: ${r.failures}/${r.draws} failed (${rate}%)`);
		for (const [topic, per] of Object.entries(r.byChannel)) {
			if (per.failures > 0)
				console.log(`  ${topic}: ${per.failures}/${per.draws}`);
		}
	}
}
