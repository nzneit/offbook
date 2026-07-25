// R-032 — the engine-owned instance-materialization LEDGER (contracts §2, F1).
// Records which concrete instances of parametrized toClient channels exist;
// NEVER a mirror of current retained state (that is Aedes', read via getState /
// native delivery, R3). The engine drives it: materialize on concrete
// subscribe/emit, snapshot+restore around reset, seedInstances at startup.
import type { InstanceRegistry, InstanceSnapshot } from "../model/index.ts";
import { canonicalize } from "./faker.ts";

type Instance = InstanceSnapshot["instances"][number];

export function createInstanceRegistry(): InstanceRegistry {
	// keyed by (channelAddress, canonicalized params) — the same F7 identity the
	// faker seeds by, so "same instance" can't diverge between ledger and draw
	const instances = new Map<string, Instance>();

	function add(channelAddress: string, params: Record<string, string>): void {
		const key = `${channelAddress}|${canonicalize(params)}`;
		if (instances.has(key)) return; // idempotent
		instances.set(key, { channelAddress, params: { ...params } });
	}

	return {
		materialize: add,

		snapshot() {
			return {
				instances: [...instances.values()].map((i) => ({
					channelAddress: i.channelAddress,
					params: { ...i.params },
				})),
			};
		},

		restore(s) {
			instances.clear();
			for (const i of s.instances) add(i.channelAddress, i.params);
		},
	};
}
