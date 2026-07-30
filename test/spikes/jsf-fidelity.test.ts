import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { SPIKE_FIXTURES, measureFixture } from "#scripts/spike-jsf-fidelity.ts";

// [stest->R-027]
// R-027 tripwire: pins the measured per-fixture recheck-failure counts so a
// JSF/schema regression is loud, not silent. Update EXPECTED only with a
// re-measurement + a D-### note (the D-008 verdict rests on these).
// Pins { draws, failures } per fixture (not failures alone) so a fixture that
// silently parsed to zero channels cannot vacuously pass as 0/0.
const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
const EXPECTED: Record<string, { draws: number; failures: number }> = {
	"composition.yaml": { draws: 20, failures: 0 },
	"external-ref.yaml": { draws: 10, failures: 0 },
	// re-measured 2026-07-30 when multi-format.yaml joined the fixture set
	// (D-018): 2 channels x 10 seeds, zero recheck failures, so the D-008
	// verdict is unchanged on the newest-supported-major fixture too.
	"multi-format.yaml": { draws: 20, failures: 0 },
	"qos-overrides.yaml": { draws: 20, failures: 0 },
	"qos-retain.yaml": { draws: 10, failures: 0 },
	"thermostat.yaml": { draws: 20, failures: 0 },
	"v2-pubsub.yaml": { draws: 20, failures: 0 },
};

test("SPIKE_FIXTURES covers exactly the fixtures/asyncapi/*.yaml directory listing", () => {
	const onDisk = readdirSync(`${import.meta.dir}/../../fixtures/asyncapi`)
		.filter((f) => f.endsWith(".yaml"))
		.sort();
	expect([...SPIKE_FIXTURES].sort()).toEqual(onDisk);
});

test("JSF recheck-failure rates match the D-008 measurement", async () => {
	const measured: Record<string, { draws: number; failures: number }> = {};
	for (const fixture of SPIKE_FIXTURES) {
		const r = await measureFixture(fixture, SEEDS);
		measured[fixture] = { draws: r.draws, failures: r.failures };
	}
	expect(measured).toEqual(EXPECTED);
});
