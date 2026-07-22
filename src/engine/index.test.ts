import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "../config/index.ts";
import type {
	Channel,
	NormalizedMessage,
	SpecRegistry,
	Violation,
} from "../model/index.ts";
import { createDispatchRegistry } from "./dispatch.ts";
import { createEngine } from "./index.ts";

const stateSchema = {
	type: "object",
	required: ["status"],
	additionalProperties: false,
	properties: { status: { type: "string", enum: ["ok", "warn"] } },
};

function makeChannel(
	topic: string,
	schema: object,
	qos: 0 | 1 | 2,
	retain: boolean,
): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
	return {
		topic,
		direction: "toClient",
		service: "t",
		schema,
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos,
		retain,
	};
}

// one toClient state channel with {param}; match captures the id
function makeRegistry(): SpecRegistry {
	const state = makeChannel("state/{deviceId}", stateSchema, 2, true);
	return {
		match(topic: string) {
			const m = topic.match(/^state\/([^/]+)$/);
			if (m?.[1]) return { channel: state, params: { deviceId: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [state],
	};
}

function harness(seed = 1) {
	const config = loadConfig({ seed });
	const emitted: NormalizedMessage[] = [];
	const violations: Omit<Violation, "seq" | "observedAt">[] = [];
	let seq = 0;
	const engine = createEngine({
		config,
		broker: {
			emit: async (m) => {
				emitted.push(m);
			},
		},
		registry: makeRegistry,
		record: (v) => {
			violations.push(v);
			return { ...v, seq: ++seq, observedAt: "t" } as Violation;
		},
		dispatch: createDispatchRegistry(),
	});
	return { config, engine, emitted, violations };
}

test("R-013: an authored {topic, payload} reaches broker.emit with channel-resolved qos/retain — never undefined", async () => {
	const { engine, emitted } = harness();
	engine.publish(
		{ topic: "state/d1", payload: { status: "ok" } },
		{ layer: "L3" },
	);
	await engine.idle();
	expect(emitted).toEqual([
		{
			topic: "state/d1",
			payload: { status: "ok" },
			qos: 2,
			retain: true,
			delayMs: undefined,
		},
	]);
});

test("R-013/G10: an off-spec L2-sourced emit drops (F5) and surfaces a mock violation stamped with scenarioName/stepIndex", async () => {
	const { engine, emitted, violations } = harness();
	engine.publish(
		{ topic: "state/d1", payload: { status: "BOGUS" } },
		{ layer: "L2", scenarioName: "warm-up", stepIndex: 2 },
	);
	await engine.idle();
	expect(emitted).toEqual([]); // dropped, never emitted (F5; no re-draw per D-008)
	expect(violations.length).toBe(1);
	const v = violations[0];
	expect(v?.origin).toBe("mock");
	expect(v?.kind).toBe("schema");
	expect(v?.emitSource).toEqual({
		layer: "L2",
		scenarioName: "warm-up",
		stepIndex: 2,
	});
	expect(v?.errors?.[0]?.keyword).toBe("enum");
});

test("R-013: an L2 ranged delay flows keyed through the choke-point and advances logical now() finitely", async () => {
	const { config, engine, emitted } = harness(7);
	const before = engine.now();
	engine.publish(
		{ topic: "state/d1", payload: { status: "ok" }, delay: "150-300ms" },
		{ layer: "L2", scenarioName: "warm-up", stepIndex: 0 },
		{ scenarioName: "warm-up", stepIndex: 0 },
	);
	await engine.idle();
	expect(emitted.length).toBe(1);
	const advanced = engine.now() - before;
	expect(Number.isFinite(advanced)).toBe(true);
	expect(advanced).toBeGreaterThanOrEqual(150);
	expect(advanced).toBeLessThanOrEqual(300);
	expect(before).toBe(config.fixedEpoch);
});

test("unmatched mock topic: surfaced as unknown-topic (stamped) AND still emitted at defaults — observe-and-surface", async () => {
	const { engine, emitted, violations } = harness();
	engine.publish(
		{ topic: "no/such/topic", payload: { a: 1 } },
		{ layer: "L3" },
	);
	await engine.idle();
	expect(emitted).toEqual([
		{
			topic: "no/such/topic",
			payload: { a: 1 },
			qos: 1,
			retain: false,
			delayMs: undefined,
		},
	]);
	expect(violations[0]?.kind).toBe("unknown-topic");
	expect(violations[0]?.origin).toBe("mock");
	expect(violations[0]?.emitSource).toEqual({ layer: "L3" });
});

test("reactive path: inbound dispatches the matched L3 handler; ctx.publish is stamped L3; ctx.random is per-invocation deterministic", async () => {
	const draws: number[][] = [];
	for (let run = 0; run < 2; run++) {
		const config = loadConfig({ seed: 7 });
		const emitted: NormalizedMessage[] = [];
		const d = createDispatchRegistry();
		const engine = createEngine({
			config,
			broker: {
				emit: async (m) => {
					emitted.push(m);
				},
			},
			registry: makeRegistry,
			record: (v) => ({ ...v, seq: 1, observedAt: "t" }) as Violation,
			dispatch: d,
		});
		const seen: number[] = [];
		d.register(
			"state/{deviceId}",
			() => ({
				onInbound(_event, ctx) {
					seen.push(ctx.random(), ctx.random());
					ctx.publish({ topic: "state/replayed", payload: { status: "ok" } });
				},
			}),
			"h.ts",
		);
		d.instantiate();
		engine.onInbound({
			message: { topic: "state/d1", payload: { status: "warn" } },
			meta: { clientId: "c1", seq: 1, receivedAt: 0 },
		});
		await engine.idle();
		expect(emitted.length).toBe(1);
		expect(emitted[0]?.topic).toBe("state/replayed");
		expect(emitted[0]?.qos).toBe(2); // ctx.publish rode the choke-point (channel-resolved)
		draws.push(seen);
	}
	expect(draws[0]).toEqual(draws[1]); // per-invocation stream reproducible across runs (F7)
});

test("proactive path: subscribe with no L3 handler falls to the L1 floor and emits a valid retained payload", async () => {
	const { engine, emitted, violations } = harness();
	engine.onSubscribe("state/d7");
	await engine.idle();
	expect(violations).toEqual([]);
	expect(emitted.length).toBe(1);
	expect(emitted[0]?.topic).toBe("state/d7");
	expect(emitted[0]?.retain).toBe(true);
	expect(["ok", "warn"]).toContain(
		(emitted[0]?.payload as { status: string }).status,
	);
});

test("passive mode fires no ticks (F10)", async () => {
	const config = loadConfig({ seed: 1, mode: "passive" });
	const emitted: NormalizedMessage[] = [];
	const d = createDispatchRegistry();
	const engine = createEngine({
		config,
		broker: {
			emit: async (m) => {
				emitted.push(m);
			},
		},
		registry: makeRegistry,
		record: (v) => ({ ...v, seq: 1, observedAt: "t" }) as Violation,
		dispatch: d,
	});
	let ticked = 0;
	d.register(
		"state/{deviceId}",
		() => ({
			tick() {
				ticked++;
			},
		}),
		"h.ts",
	);
	d.instantiate();
	engine.tick();
	await engine.idle();
	expect(ticked).toBe(0);
});
