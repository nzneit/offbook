// R-016 — the L2 runtime composed with the real engine: reactive dispatch
// through the engine's L2 seam (L3 shadows L2), seeded cumulative delays +
// {{…}} templating + L1 autofill, trigger, counters across firings/reset,
// hot-reload (autonomous) vs frozen (passive), strict vs lenient load, and
// the L2 emitSource on a runtime off-spec emit.
// [utest->R-016]
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "#src/config/index.ts";
import { createDispatchRegistry } from "#src/engine/dispatch.ts";
import { createEngine } from "#src/engine/index.ts";
import type {
	Channel,
	Config,
	InboundEvent,
	NormalizedMessage,
	SpecRegistry,
	Violation,
} from "#src/model/index.ts";
import { type ScenarioRuntime, createScenarioRuntime } from "./index.ts";
import { matchTopic } from "./matcher.ts";

const stateSchema = {
	type: "object",
	additionalProperties: false,
	required: ["deviceId", "status", "units"],
	properties: {
		deviceId: { type: "string" },
		status: { type: "string" },
		units: { type: "string" },
		target: { type: "number" },
		updatedAt: { type: "number" },
		corrId: { type: "string" },
		n: { type: "number" },
	},
};

const commandSchema = {
	type: "object",
	additionalProperties: false,
	required: ["mode", "target"],
	properties: { mode: { type: "string" }, target: { type: "number" } },
};

function makeChannel(
	topic: string,
	direction: Channel["direction"],
	schema: object,
): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
	return {
		topic,
		direction,
		service: "t",
		schema,
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
	};
}

const channels = [
	makeChannel("command/{deviceId}/set", "fromClient", commandSchema),
	makeChannel("state/{deviceId}", "toClient", stateSchema),
];

const registry: SpecRegistry = {
	diagnostics: () => [],
	match(topic) {
		for (const channel of channels) {
			const params = matchTopic(channel.topic, topic);
			if (params) return { channel, params };
		}
		return undefined;
	},
	matchesFilter: () => false,
	channels: () => channels,
};

const THERMOSTAT = `
- name: set-temperature-heat
  when:
    topic: command/{deviceId}/set
    payloadMatch: { mode: heat }
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          target: "{{payload.target}}"
          status: accepted
          updatedAt: "{{now}}"
        delay: 150-300ms
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: heating }
        delay: 1-2s
- name: set-generic-ack
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: accepted }
- name: device-offline
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: offline }
`;

const COUNTERIZED = `
- name: counterized
  then:
    - emit:
        topic: state/fixed
        payload: { deviceId: fixed, status: ok, corrId: "{{uuid}}", n: "{{seq}}" }
`;

async function setup(
	files: Record<string, string>,
	overrides: Partial<Config> = {},
	opts: { load?: boolean } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "offbook-l2rt-"));
	for (const [name, text] of Object.entries(files))
		writeFileSync(join(dir, name), text);
	const config = loadConfig(overrides);
	const emitted: NormalizedMessage[] = [];
	const violations: Omit<Violation, "seq" | "observedAt">[] = [];
	const logs: string[] = [];
	const dispatch = createDispatchRegistry();
	// the engine's thunk closes over `runtime` before its declaration — the
	// same wiring order the composition root uses (dispatch happens long after
	// both exist)
	const engine = createEngine({
		config,
		broker: {
			emit: async (m) => {
				emitted.push(m);
			},
		},
		registry: () => registry,
		record: (v) => {
			violations.push(v);
			return { ...v, seq: violations.length, observedAt: "t" } as Violation;
		},
		dispatch,
		scenarios: () => runtime,
	});
	const runtime: ScenarioRuntime = createScenarioRuntime({
		config,
		dir,
		registry: () => registry,
		engine,
		log: (l) => logs.push(l),
	});
	if (opts.load !== false) await runtime.load();
	return { dir, config, engine, runtime, emitted, violations, dispatch, logs };
}

const inbound = (topic: string, payload: unknown): InboundEvent => ({
	message: { topic, payload },
	meta: { clientId: "c1", seq: 0, receivedAt: 0 },
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error("timeout waiting");
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("reactive dispatch (the l2 §0 running example)", () => {
	test("matches, binds params, templates, autofills, and paces seeded delays", async () => {
		const s = await setup({ "50-thermostat.yaml": THERMOSTAT });
		s.engine.onInbound(inbound("command/t1/set", { mode: "heat", target: 21 }));
		await s.engine.idle();

		expect(s.violations).toEqual([]);
		expect(s.emitted).toHaveLength(2);
		const [first, second] = s.emitted;
		expect(first?.topic).toBe("state/t1");
		const p1 = first?.payload as Record<string, unknown>;
		expect(p1.deviceId).toBe("t1"); // {{deviceId}} bound from the capture
		expect(p1.target).toBe(21); // {{payload.target}} — type preserved
		expect(p1.status).toBe("accepted");
		expect(typeof p1.units).toBe("string"); // required field autofilled by L1

		// {{now}} = fire-time + the step's cumulative seeded delay (l2 §5/§6)
		const d1 = (p1.updatedAt as number) - s.config.fixedEpoch;
		expect(d1).toBeGreaterThanOrEqual(150);
		expect(d1).toBeLessThanOrEqual(300);

		// step 2 is relative/cumulative: +1–2s after the PREVIOUS emit
		const p2 = second?.payload as Record<string, unknown>;
		expect(p2.status).toBe("heating");
		const total = s.engine.now() - s.config.fixedEpoch;
		expect(total - d1).toBeGreaterThanOrEqual(1000);
		expect(total - d1).toBeLessThanOrEqual(2000);

		// F13 through the runner: no qos/retain authored, channel has none —
		// spec defaults land, never undefined
		expect(first?.qos).toBe(1);
		expect(first?.retain).toBe(false);
	});

	test("payloadMatch discriminates; within L2 the first match wins", async () => {
		const s = await setup({ "50-thermostat.yaml": THERMOSTAT });
		s.engine.onInbound(inbound("command/t1/set", { mode: "cool", target: 18 }));
		await s.engine.idle();
		// only the topic-only fallback fired, once
		expect(s.emitted).toHaveLength(1);
		expect((s.emitted[0]?.payload as Record<string, unknown>).status).toBe(
			"accepted",
		);

		s.emitted.length = 0;
		s.engine.onInbound(inbound("command/t1/set", { mode: "heat", target: 21 }));
		await s.engine.idle();
		// the payload-discriminated scenario won; the fallback did NOT also fire
		expect(s.emitted).toHaveLength(2);
	});

	test("an inbound matching no scenario (or no channel) fires nothing", async () => {
		const s = await setup({ "50-thermostat.yaml": THERMOSTAT });
		s.engine.onInbound(inbound("ghost/topic", { x: 1 }));
		await s.engine.idle();
		expect(s.emitted).toHaveLength(0);
	});

	test("same seed ⇒ byte-identical emission stream (determinism)", async () => {
		const run = async () => {
			const s = await setup({ "50-thermostat.yaml": THERMOSTAT }, { seed: 7 });
			s.engine.onInbound(
				inbound("command/t1/set", { mode: "heat", target: 21 }),
			);
			s.runtime.trigger("device-offline", { params: { deviceId: "t2" } });
			await s.engine.idle();
			return JSON.stringify(s.emitted);
		};
		expect(await run()).toBe(await run());
	});
});

describe("L3 → L2 precedence (the engine seam)", () => {
	test("an L3 handler with onInbound shadows the matching scenario", async () => {
		const s = await setup({ "50-thermostat.yaml": THERMOSTAT });
		s.dispatch.register(
			"command/{deviceId}/set",
			() => ({
				onInbound: (_e, ctx) =>
					ctx.publish({
						topic: "state/l3",
						payload: { deviceId: "l3", status: "l3", units: "u" },
					}),
			}),
			"handlers/00-thermo.ts",
		);
		s.dispatch.instantiate();
		s.engine.onInbound(inbound("command/t1/set", { mode: "heat", target: 21 }));
		await s.engine.idle();
		expect(s.emitted).toHaveLength(1);
		expect(s.emitted[0]?.topic).toBe("state/l3");
	});

	test("a registered L3 handler owns the topic even without onInbound", async () => {
		const s = await setup({ "50-thermostat.yaml": THERMOSTAT });
		s.dispatch.register(
			"command/{deviceId}/set",
			() => ({}),
			"handlers/00-thermo.ts",
		);
		s.dispatch.instantiate();
		s.engine.onInbound(inbound("command/t1/set", { mode: "heat", target: 21 }));
		await s.engine.idle();
		expect(s.emitted).toHaveLength(0); // whole topic handed to L3 (l2 §0)
	});
});

describe("trigger (POST /trigger seam)", () => {
	test("fires a when-less scenario with explicit params", async () => {
		const s = await setup({ "50-thermostat.yaml": THERMOSTAT });
		const r = s.runtime.trigger("device-offline", {
			params: { deviceId: "t9" },
		});
		expect(r).toEqual({ name: "device-offline", stepCount: 1 });
		await s.engine.idle();
		expect(s.emitted[0]?.topic).toBe("state/t9");
		expect((s.emitted[0]?.payload as Record<string, unknown>).status).toBe(
			"offline",
		);
	});

	test("an unknown name is undefined and fires nothing", async () => {
		const s = await setup({ "50-thermostat.yaml": THERMOSTAT });
		expect(s.runtime.trigger("ghost")).toBeUndefined();
		await s.engine.idle();
		expect(s.emitted).toHaveLength(0);
	});

	test("an omitted param is seed-faked deterministically", async () => {
		const run = async () => {
			const s = await setup({ "50-thermostat.yaml": THERMOSTAT }, { seed: 3 });
			s.runtime.trigger("device-offline");
			await s.engine.idle();
			return s.emitted[0]?.topic ?? "";
		};
		const a = await run();
		expect(a).toMatch(/^state\/deviceId-[0-9a-f]{8}$/);
		expect(await run()).toBe(a);
	});

	test("a hand-fired reactive scenario seed-fakes the inbound payload", async () => {
		const run = async () => {
			const s = await setup({ "50-thermostat.yaml": THERMOSTAT }, { seed: 5 });
			s.runtime.trigger("set-temperature-heat", {
				params: { deviceId: "t1" },
			});
			await s.engine.idle();
			return s.emitted;
		};
		const emitted = await run();
		expect(emitted).toHaveLength(2);
		const p1 = emitted[0]?.payload as Record<string, unknown>;
		// {{payload.target}} came from a seed-faked command payload
		expect(typeof p1.target).toBe("number");
		expect(JSON.stringify(emitted)).toBe(JSON.stringify(await run()));
	});
});

describe("{{seq}}/{{uuid}} counters (contracts §3 F7 category ii)", () => {
	test("continue across firings; cleared and re-seeded by reset", async () => {
		const s = await setup({ "10-counter.yaml": COUNTERIZED });
		s.runtime.trigger("counterized");
		s.runtime.trigger("counterized");
		await s.engine.idle();
		const [a, b] = s.emitted.map(
			(m) => m.payload as { corrId: string; n: number },
		);
		expect(a?.n).toBe(1);
		expect(b?.n).toBe(2); // monotonic per scenario, across firings
		expect(a?.corrId).not.toBe(b?.corrId); // counter-advanced, not keyed-per-step
		expect(a?.corrId).toMatch(/^[0-9a-f-]{36}$/);

		s.engine.reset();
		s.runtime.reset();
		await s.engine.idle();
		s.emitted.length = 0; // drop the reset republish noise
		s.runtime.trigger("counterized");
		await s.engine.idle();
		const c = s.emitted[0]?.payload as { corrId: string; n: number };
		expect(c.n).toBe(1); // counters back to t0
		expect(c.corrId).toBe(a?.corrId ?? ""); // same seed ⇒ same first uuid
	});
});

describe("hot-reload & passive freeze (l2 §8, G24)", () => {
	test("reload swaps definitions atomically but keeps counters", async () => {
		const s = await setup({ "50-counter.yaml": COUNTERIZED });
		s.runtime.trigger("counterized");
		await s.engine.idle();
		expect((s.emitted[0]?.payload as { n: number }).n).toBe(1);

		writeFileSync(
			join(s.dir, "05-added.yaml"),
			"- name: added\n  then:\n    - emit:\n        topic: state/added\n        payload: { deviceId: added, status: ok }\n",
		);
		await s.runtime.reload();
		// sorted-path order: the 05- drop-in slots ahead of 50- (l2 §3)
		expect(s.runtime.scenarios().map((i) => i.name)).toEqual([
			"added",
			"counterized",
		]);
		expect(s.logs.find((l) => l.includes("scenarios reloaded"))).toBeDefined();

		s.emitted.length = 0;
		s.runtime.trigger("counterized");
		await s.engine.idle();
		// swap touched definitions only — the per-scenario counter continued
		expect((s.emitted[0]?.payload as { n: number }).n).toBe(2);
	});

	test("watch() hot-reloads on file change in autonomous mode", async () => {
		const s = await setup({ "50-counter.yaml": COUNTERIZED });
		expect(s.runtime.watch()).toBe(true);
		try {
			writeFileSync(
				join(s.dir, "60-late.yaml"),
				"- name: late\n  then:\n    - emit:\n        topic: state/late\n        payload: { deviceId: late, status: ok }\n",
			);
			await until(() => s.runtime.scenarios().some((i) => i.name === "late"));
		} finally {
			s.runtime.stopWatch();
		}
	});

	test("passive freezes the scenario set: no watcher", async () => {
		const s = await setup(
			{ "50-counter.yaml": COUNTERIZED },
			{
				mode: "passive",
			},
		);
		expect(s.runtime.watch()).toBe(false);
	});
});

describe("strict vs lenient load (l2 §7)", () => {
	const MIXED = `
- name: broken
- name: works
  then:
    - emit:
        topic: state/w1
        payload: { deviceId: w1, status: ok }
`;

	test("lenient (dev default): skipped-loud, the rest still serves", async () => {
		const s = await setup({ "50-mixed.yaml": MIXED });
		const errs = s.runtime.diagnostics().filter((d) => d.severity === "error");
		expect(errs).toHaveLength(1);
		expect(errs[0]?.kind).toBe("scenario-load");
		expect(s.runtime.scenarios().map((i) => i.name)).toEqual(["works"]);
		s.runtime.trigger("works");
		await s.engine.idle();
		expect(s.emitted).toHaveLength(1);
	});

	test("strict: any scenario error is fatal at startup", async () => {
		const s = await setup(
			{ "50-mixed.yaml": MIXED },
			{ strict: true },
			{
				load: false,
			},
		);
		await expect(s.runtime.load()).rejects.toThrow(/strict/);
	});
});

describe("emit-time recheck provenance (G10)", () => {
	test("an inbound value pushing a templated field off-spec drops with an L2 emitSource", async () => {
		const s = await setup({ "50-thermostat.yaml": THERMOSTAT });
		// off-contract inbound (target should be a number) — delivery is not
		// blocked, and the scenario still fires: observe-and-surface
		s.engine.onInbound(
			inbound("command/t1/set", { mode: "heat", target: "oops" }),
		);
		await s.engine.idle();
		// step 0 (templated target) dropped; step 1 (heating) still emitted
		expect(s.emitted).toHaveLength(1);
		expect((s.emitted[0]?.payload as Record<string, unknown>).status).toBe(
			"heating",
		);
		expect(s.violations).toHaveLength(1);
		const v = s.violations[0];
		expect(v?.origin).toBe("mock");
		expect(v?.kind).toBe("schema");
		expect(v?.emitSource).toEqual({
			layer: "L2",
			scenarioName: "set-temperature-heat",
			stepIndex: 0,
		});
	});
});
