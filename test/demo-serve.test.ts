// R-033 — `offbook demo --serve` + bootDemo (docs/specs/demo-app.md §4):
// bundled spec + bundled chain scenarios over the standard machinery.
// [itest->R-033]
import { expect, test } from "bun:test";
import { bootDemo } from "#src/cli/boot.ts";
import { loadConfig } from "#src/config/index.ts";
import type { StateEntry } from "#src/model/index.ts";

test("bootDemo composes the bundled spec + chain scenarios; a heat command chains to heating", async () => {
	// in-process ports: ws 19110 / tcp 12991 / ctrl 19891
	const config = loadConfig({
		brokerWsPort: 19110,
		brokerTcpPort: 12991,
		controlPlanePort: 19891,
		mode: "passive", // reactive scenarios still fire; no autonomous ticks
		wallClock: false, // virtual clock — the 100-900ms delays are instant
	});
	const composed = await bootDemo({ config });
	await composed.start();
	try {
		const scenarios = (await (
			await composed.app.request("/v1/scenarios")
		).json()) as { scenarios: { name: string }[] };
		expect(scenarios.scenarios.map((s) => s.name).sort()).toEqual([
			"set-cool",
			"set-heat",
			"set-off",
		]);
		// seedInstances gave the demo device retained initial state at boot
		const state0 = (await (await composed.app.request("/v1/state")).json()) as {
			state: StateEntry[];
		};
		expect(state0.state.some((e) => e.topic === "state/thermostat-1")).toBe(
			true,
		);

		await composed.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				topic: "command/thermostat-1/set",
				payload: { mode: "heat", target: 23 },
			}),
		});
		await composed.app.request("/v1/pending?wait");
		const state = (await (await composed.app.request("/v1/state")).json()) as {
			state: StateEntry[];
		};
		const final = state.state.find((e) => e.topic === "state/thermostat-1");
		expect((final?.payload as { status: string }).status).toBe("heating");
		expect((final?.payload as { target: number }).target).toBe(23);
	} finally {
		await composed.stop();
	}
}, 30_000);
