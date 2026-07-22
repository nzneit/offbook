import { expect, test } from "bun:test";
import {
	measureFixture,
	SPIKE_FIXTURES,
} from "../../scripts/spike-jsf-fidelity.ts";

// R-027 tripwire: pins the measured per-fixture recheck-failure counts so a
// JSF/schema regression is loud, not silent. Update EXPECTED_FAILURES only
// with a re-measurement + a D-### note (the D-008 verdict rests on these).
const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
const EXPECTED_FAILURES: Record<string, number> = {
	"composition.yaml": 0,
	"external-ref.yaml": 0,
	"qos-overrides.yaml": 0,
	"qos-retain.yaml": 0,
	"thermostat.yaml": 0,
	"v2-pubsub.yaml": 0,
};

test("JSF recheck-failure rates match the D-008 measurement", async () => {
	const measured: Record<string, number> = {};
	for (const fixture of SPIKE_FIXTURES) {
		measured[fixture] = (await measureFixture(fixture, SEEDS)).failures;
	}
	expect(measured).toEqual(EXPECTED_FAILURES);
});
