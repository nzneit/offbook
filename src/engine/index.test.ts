import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "#src/config/index.ts";
import type {
	Channel,
	NormalizedMessage,
	SpecRegistry,
	Violation,
} from "#src/model/index.ts";
import type { DispatchRegistry } from "./dispatch.ts";
import { createDispatchRegistry } from "./dispatch.ts";
import { createEngine } from "./index.ts";
import { hashToInt, mulberry32 } from "./prng.ts";

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
		diagnostics: () => [],
		match(topic: string) {
			const m = topic.match(/^state\/([^/]+)$/);
			if (m?.[1]) return { channel: state, params: { deviceId: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [state],
	};
}

// makeRegistry()'s state/{deviceId} channel, but declared reactive-only (R-040)
function flaggedRegistry(): SpecRegistry {
	const state = {
		...makeChannel("state/{deviceId}", stateSchema, 2, true),
		initialState: false,
	};
	return {
		diagnostics: () => [],
		match(topic: string) {
			const m = topic.match(/^state\/([^/]+)$/);
			if (m?.[1]) return { channel: state, params: { deviceId: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [state],
	};
}

function buildEngine(
	overrides: Parameters<typeof loadConfig>[0] = {},
	registry: SpecRegistry = makeRegistry(),
	seedInstances?: Record<string, Record<string, string>[]>,
) {
	const config = loadConfig(overrides);
	const emitted: NormalizedMessage[] = [];
	const violations: Omit<Violation, "seq" | "observedAt">[] = [];
	const dispatch = createDispatchRegistry();
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
		seedInstances,
	});
	return { config, engine, emitted, violations, dispatch };
}

async function pollUntil(cond: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!cond() && Date.now() - start < timeoutMs) await Bun.sleep(5);
}

// [utest->R-013]
test("R-013: an authored {topic, payload} reaches broker.emit with channel-resolved qos/retain — never undefined", async () => {
	const { engine, emitted } = buildEngine();
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

// [utest->R-013]
test("R-013/G10: an off-spec L2-sourced emit drops (F5) and surfaces a mock violation stamped with scenarioName/stepIndex", async () => {
	const { engine, emitted, violations } = buildEngine();
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
	expect(v?.detail).toBe("/status: enum"); // nested instancePath verbatim, Ajv keyword
	expect(v?.topic).toBe("state/d1");
	expect(v?.channel).toBe("state/{deviceId}");
});

// [utest->R-013]
test("R-013: an L2 ranged delay flows keyed through the choke-point and advances logical now() finitely", async () => {
	const { config, engine, emitted } = buildEngine({ seed: 7 });
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
	const { engine, emitted, violations } = buildEngine();
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
	expect(violations[0]?.severity).toBe("error");
	expect(violations[0]?.emitSource).toEqual({ layer: "L3" });
	expect(violations[0]?.detail).toContain("unknown-topic");
	expect(violations[0]?.topic).toBe("no/such/topic");
	expect(violations[0]?.payload).toEqual({ a: 1 });
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
	const { engine, emitted, violations } = buildEngine();
	engine.onSubscribe("state/d7");
	await engine.idle();
	expect(violations).toEqual([]);
	expect(emitted.length).toBe(1);
	expect(emitted[0]?.topic).toBe("state/d7");
	expect(emitted[0]?.retain).toBe(true);
	const status = (emitted[0]?.payload as { status: string } | undefined)
		?.status;
	// String() so an absent payload fails readably as "undefined" rather than
	// failing to typecheck against toContain's string parameter
	expect(["ok", "warn"]).toContain(String(status));
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

test("an off-spec L1-sourced emit drops and surfaces with emitSource.layer === 'L1' (G10 via the one emit path)", async () => {
	const { engine, emitted, violations } = buildEngine();
	engine.publish(
		{ topic: "state/d1", payload: { status: "BOGUS" } },
		{ layer: "L1" },
	);
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(violations.length).toBe(1);
	expect(violations[0]?.emitSource).toEqual({ layer: "L1" });
});

test("ctx.random streams are keyed per invocation: draws advance within one, distinct events get distinct streams (F7(ii))", async () => {
	const config = loadConfig({ seed: 7 });
	const d = createDispatchRegistry();
	const engine = createEngine({
		config,
		broker: { emit: async () => {} },
		registry: makeRegistry,
		record: (v) => ({ ...v, seq: 1, observedAt: "t" }) as Violation,
		dispatch: d,
	});
	const byEvent: Record<number, number[]> = {};
	d.register(
		"state/{deviceId}",
		() => ({
			onInbound(event, ctx) {
				byEvent[event.meta.seq] = [ctx.random(), ctx.random()];
			},
		}),
		"h.ts",
	);
	d.instantiate();
	for (const seq of [1, 2]) {
		engine.onInbound({
			message: { topic: "state/d1", payload: { status: "warn" } },
			meta: { clientId: "c1", seq, receivedAt: 0 },
		});
	}
	await engine.idle();
	const a = byEvent[1];
	const b = byEvent[2];
	expect(a?.[0]).not.toBe(a?.[1]); // the stream advances within one invocation
	expect(a).not.toEqual(b); // a different invocationKey (meta.seq) yields a different stream
});

function tickCounter(d: DispatchRegistry): () => number {
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
	return () => ticked;
}

test("startTicks in passive mode is a no-op even with wallClock on (F10)", async () => {
	const { engine, dispatch } = buildEngine({
		mode: "passive",
		wallClock: true,
		tickIntervalMs: 10,
	});
	const ticks = tickCounter(dispatch);
	engine.startTicks();
	await Bun.sleep(40);
	engine.stopTicks();
	expect(ticks()).toBe(0);
});

test("startTicks without wallClock is a no-op (virtual ticks are driven via tick())", async () => {
	const { engine, dispatch } = buildEngine({
		wallClock: false,
		tickIntervalMs: 10,
	});
	const ticks = tickCounter(dispatch);
	engine.startTicks();
	await Bun.sleep(40);
	engine.stopTicks();
	expect(ticks()).toBe(0);
});

test("startTicks in autonomous wall mode fires handler ticks on real cadence; stopTicks halts them", async () => {
	const { config, engine, dispatch } = buildEngine({
		wallClock: true,
		tickIntervalMs: 10,
	});
	const ticks = tickCounter(dispatch);
	engine.startTicks();
	await pollUntil(() => ticks() >= 2);
	engine.stopTicks();
	const seen = ticks();
	expect(seen).toBeGreaterThanOrEqual(2);
	await Bun.sleep(40);
	expect(ticks()).toBeLessThanOrEqual(seen + 1); // one already-queued fire tolerated; the interval is gone
	await engine.idle();
	expect(engine.now()).toBeGreaterThanOrEqual(
		config.fixedEpoch + 2 * config.tickIntervalMs,
	);
});

test("tick() dispatches every handler in precedence order; the tick index advances the keyed streams", async () => {
	const { config, engine, dispatch } = buildEngine({ seed: 7 });
	const calls: [string, number][] = [];
	dispatch.register("state/{deviceId}", () => ({}), "0-none.ts"); // no tick method
	dispatch.register(
		"state/{deviceId}",
		() => ({
			tick(ctx) {
				calls.push(["b-mod", ctx.random()]);
			},
		}),
		"b-mod.ts",
	);
	dispatch.register(
		"state/{deviceId}",
		() => ({
			tick(ctx) {
				calls.push(["a-mod", ctx.random()]);
			},
		}),
		"a-mod.ts",
	);
	dispatch.instantiate();
	engine.tick();
	engine.tick();
	await engine.idle();
	expect(calls.map((c) => c[0])).toEqual(["a-mod", "b-mod", "a-mod", "b-mod"]);
	// exact keyed draws: tick|<idx>|<modulePath>|<order>; a-mod registered third (order 2), b-mod second (order 1)
	const draw = (idx: number, path: string, order: number) =>
		mulberry32(hashToInt(`${config.seed}|ctx|tick|${idx}|${path}|${order}`))();
	expect(calls[0]?.[1]).toBe(draw(0, "a-mod.ts", 2));
	expect(calls[1]?.[1]).toBe(draw(0, "b-mod.ts", 1));
	expect(calls[2]?.[1]).toBe(draw(1, "a-mod.ts", 2));
	expect(calls[3]?.[1]).toBe(draw(1, "b-mod.ts", 1));
});

function permissiveRegistry(): SpecRegistry {
	const ch = makeChannel("thing/{id}", { type: "object" }, 1, false);
	return {
		diagnostics: () => [],
		match(topic: string) {
			const m = topic.match(/^thing\/([^/]+)$/);
			if (m?.[1]) return { channel: ch, params: { id: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [ch],
	};
}

function brokenRegistry(): SpecRegistry {
	const ch = makeChannel("broken/{id}", { not: {} }, 1, true);
	return {
		diagnostics: () => [],
		match(topic: string) {
			const m = topic.match(/^broken\/([^/]+)$/);
			if (m?.[1]) return { channel: ch, params: { id: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [ch],
	};
}

test("subscribe with a registered initialState handler wins over the L1 floor and draws its keyed stream", async () => {
	const { config, engine, emitted, dispatch } = buildEngine(
		{},
		permissiveRegistry(),
	);
	let draw = -1;
	dispatch.register(
		"thing/{id}",
		() => ({
			initialState(topic, ctx) {
				draw = ctx.random();
				ctx.publish({ topic, payload: { marker: "authored" } });
			},
		}),
		"h.ts",
	);
	dispatch.instantiate();
	engine.onSubscribe("thing/t1");
	await engine.idle();
	expect(emitted.length).toBe(1);
	expect(emitted[0]?.payload).toEqual({ marker: "authored" }); // authored, not an L1 fake
	expect(draw).toBe(
		mulberry32(hashToInt(`${config.seed}|ctx|subscribe|thing/t1|h.ts|0`))(),
	);
});

test("the L1 floor on an unsatisfiable schema stays empty and surfaces the recheck violation (F5)", async () => {
	const { engine, emitted, violations } = buildEngine({}, brokenRegistry());
	engine.onSubscribe("broken/b1");
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(violations.length).toBe(1);
	expect(violations[0]?.detail).toBe("/: not"); // root instancePath "" falls back to "/"
	expect(violations[0]?.topic).toBe("broken/{id}"); // the floor stamps the channel address; publish()'s recheck would stamp the concrete topic
	expect(violations[0]?.kind).toBe("schema");
	expect(violations[0]?.emitSource).toEqual({ layer: "L1" });
	expect(engine.instances.snapshot()).toEqual({
		instances: [{ channelAddress: "broken/{id}", params: { id: "b1" } }],
	});
});

test("loadHandlers delegates to the dispatch registry and then instantiates", async () => {
	const calls: string[] = [];
	const stub: DispatchRegistry = {
		register() {},
		loadHandlers: async (dir) => {
			calls.push(`load:${dir}`);
			return ["/x/10-a.ts"];
		},
		instantiate: () => {
			calls.push("instantiate");
		},
		select: () => undefined,
		all: () => [],
	};
	const config = loadConfig({});
	const engine = createEngine({
		config,
		broker: { emit: async () => {} },
		registry: makeRegistry,
		record: (v) => ({ ...v, seq: 1, observedAt: "t" }) as Violation,
		dispatch: stub,
	});
	expect(await engine.loadHandlers("/handlers")).toEqual(["/x/10-a.ts"]);
	expect(calls).toEqual(["load:/handlers", "instantiate"]);
});

test("engine.faker exposes the seeded faker: same channel+params reproduce, output is schema-valid", async () => {
	const { engine } = buildEngine();
	const m = makeRegistry().match("state/d1");
	if (!m)
		throw new Error("unreachable: fixture registry always matches state/d1");
	const a = await engine.faker(m.channel, m.params);
	const b = await engine.faker(m.channel, m.params);
	expect(b).toEqual(a);
	expect(m.channel.validate(a)).toEqual([]);
});

test("tick() in autonomous mode advances the clock and ticks handlers; in passive mode neither happens", async () => {
	const active = buildEngine({ seed: 1 });
	const activeTicks = tickCounter(active.dispatch);
	active.engine.tick();
	await active.engine.idle();
	expect(activeTicks()).toBe(1);
	expect(active.engine.now()).toBe(
		active.config.fixedEpoch + active.config.tickIntervalMs,
	);

	const passive = buildEngine({ seed: 1, mode: "passive" });
	const passiveTicks = tickCounter(passive.dispatch);
	passive.engine.tick();
	await passive.engine.idle();
	expect(passiveTicks()).toBe(0);
	expect(passive.engine.now()).toBe(passive.config.fixedEpoch);
});

test("inbound with no registration, or a handler without onInbound, is a silent no-op, never a crash", async () => {
	const errors: unknown[][] = [];
	const orig = console.error;
	console.error = (...a: unknown[]) => {
		errors.push(a);
	};
	try {
		const bare = buildEngine(); // no registrations at all
		bare.engine.onInbound({
			message: { topic: "state/d1", payload: { status: "ok" } },
			meta: { clientId: "c", seq: 1, receivedAt: 0 },
		});
		await bare.engine.idle();

		const tickOnly = buildEngine(); // matched registration, but no onInbound method
		tickOnly.dispatch.register(
			"state/{deviceId}",
			() => ({ tick() {} }),
			"h.ts",
		);
		tickOnly.dispatch.instantiate();
		tickOnly.engine.onInbound({
			message: { topic: "state/d1", payload: { status: "ok" } },
			meta: { clientId: "c", seq: 1, receivedAt: 0 },
		});
		await tickOnly.engine.idle();

		expect(bare.emitted).toEqual([]);
		expect(tickOnly.emitted).toEqual([]);
	} finally {
		console.error = orig;
	}
	expect(errors).toEqual([]); // neither path threw inside the scheduler task
});

test("a '+' inside a topic level is not a wildcard: the subscribe materializes (level-exact detection)", async () => {
	const { engine, emitted } = buildEngine();
	engine.onSubscribe("state/x+y");
	await engine.idle();
	expect(emitted.length).toBe(1);
	expect(engine.instances.snapshot()).toEqual({
		instances: [
			{ channelAddress: "state/{deviceId}", params: { deviceId: "x+y" } },
		],
	});
});

function literalRegistry(): SpecRegistry {
	const ch = makeChannel("plain/topic", { type: "object" }, 1, false);
	return {
		diagnostics: () => [],
		match: (topic: string) =>
			topic === "plain/topic" ? { channel: ch, params: {} } : undefined,
		matchesFilter: () => false,
		channels: () => [ch],
	};
}

test("a wrong-typed mock payload surfaces the root-path fallback in the detail", async () => {
	const { engine, violations } = buildEngine();
	engine.publish({ topic: "state/d1", payload: 42 }, { layer: "L3" });
	await engine.idle();
	expect(violations[0]?.detail).toBe("/: type");
	expect(violations[0]?.channel).toBe("state/{deviceId}");
	expect(violations[0]?.topic).toBe("state/d1");
	expect(violations[0]?.severity).toBe("error");
});

test("a delayed unknown-topic emit still schedules at its delay (the ?? 0 fallback is nullish, not falsy)", async () => {
	const { config, engine, emitted } = buildEngine();
	engine.publish(
		{ topic: "no/such/topic", payload: { a: 1 }, delayMs: 120 },
		{ layer: "L3" },
	);
	await engine.idle();
	expect(emitted.length).toBe(1);
	expect(engine.now()).toBe(config.fixedEpoch + 120);
});

test("an L2 ranged delay advances now() by the exact keyed draw (config.seed reaches the choke-point intact)", async () => {
	const { config, engine, emitted } = buildEngine({ seed: 7 });
	const key = { scenarioName: "warm-up", stepIndex: 3 };
	engine.publish(
		{ topic: "state/d1", payload: { status: "ok" }, delay: "150-300ms" },
		{ layer: "L2", ...key },
		key,
	);
	await engine.idle();
	const draw = mulberry32(hashToInt(`${config.seed}|delay|warm-up|3`))();
	expect(emitted.length).toBe(1);
	expect(engine.now()).toBe(config.fixedEpoch + 150 + Math.floor(draw * 151));
});

test("ctx.publish stamps L3 and ctx.now() reads the logical clock", async () => {
	const { config, engine, violations, dispatch } = buildEngine();
	let sawNow = -1;
	dispatch.register(
		"state/{deviceId}",
		() => ({
			onInbound(_e, ctx) {
				sawNow = ctx.now();
				ctx.publish({ topic: "state/d1", payload: { status: "BOGUS" } }); // off-spec on purpose
			},
		}),
		"h.ts",
	);
	dispatch.instantiate();
	engine.onInbound({
		message: { topic: "state/d1", payload: { status: "ok" } },
		meta: { clientId: "c", seq: 1, receivedAt: 0 },
	});
	await engine.idle();
	expect(sawNow).toBe(config.fixedEpoch);
	expect(violations[0]?.emitSource).toEqual({ layer: "L3" });
	expect(violations[0]?.detail).toBe("/status: enum");
});

test("materialization rule (ii) is exact: a parametrized mock emit records its instance, nothing else", async () => {
	const { engine } = buildEngine();
	engine.publish(
		{ topic: "state/d4", payload: { status: "ok" } },
		{ layer: "L3" },
	);
	await engine.idle();
	expect(engine.instances.snapshot()).toEqual({
		instances: [
			{ channelAddress: "state/{deviceId}", params: { deviceId: "d4" } },
		],
	});
});

test("a non-parametrized mock emit never invents a ledger instance", async () => {
	const { engine, emitted } = buildEngine({}, literalRegistry());
	engine.publish({ topic: "plain/topic", payload: {} }, { layer: "L3" });
	await engine.idle();
	expect(emitted.length).toBe(1);
	expect(engine.instances.snapshot()).toEqual({ instances: [] });
});

test("a concrete parametrized subscribe records exactly its instance in the ledger", async () => {
	const { engine } = buildEngine();
	engine.onSubscribe("state/d5");
	await engine.idle();
	expect(engine.instances.snapshot()).toEqual({
		instances: [
			{ channelAddress: "state/{deviceId}", params: { deviceId: "d5" } },
		],
	});
});

test("start() with no seeds: a {param} address is never eagerly republished as a literal topic", async () => {
	const { engine, emitted } = buildEngine();
	engine.start();
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(engine.instances.snapshot()).toEqual({ instances: [] });
});

test("start(): a resolvable parametrized seed entry lands in the ledger and republishes its initial state", async () => {
	const { engine, emitted } = buildEngine({}, makeRegistry(), {
		"state/{deviceId}": [{ deviceId: "d9" }],
	});
	engine.start();
	await engine.idle();
	expect(engine.instances.snapshot()).toEqual({
		instances: [
			{ channelAddress: "state/{deviceId}", params: { deviceId: "d9" } },
		],
	});
	expect(emitted.length).toBe(1);
	expect(emitted[0]?.topic).toBe("state/d9");
});

test("start(): a resolvable non-parametrized seed entry does not invent a ledger instance", async () => {
	const { engine, emitted } = buildEngine({}, literalRegistry(), {
		"plain/topic": [{}],
	});
	engine.start();
	await engine.idle();
	expect(engine.instances.snapshot()).toEqual({ instances: [] });
	expect(emitted.length).toBe(1); // the eager loop's own initial state, exactly once
});

test("start(): a junk seed entry surfaces loudly with address and params in the detail, and is skipped", async () => {
	const { engine, emitted, violations } = buildEngine({}, makeRegistry(), {
		"junk/{x}": [{ x: "1" }],
	});
	engine.start();
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(engine.instances.snapshot()).toEqual({ instances: [] });
	expect(violations.length).toBe(1);
	const v = violations[0];
	expect(v?.kind).toBe("unknown-topic");
	expect(v?.topic).toBe("junk/1");
	expect(v?.severity).toBe("error");
	expect(v?.emitSource).toEqual({ layer: "L1" });
	expect(v?.detail).toContain("seedInstances: 'junk/{x}'");
	expect(v?.detail).toContain('{"x":"1"}');
	expect(v?.detail).toContain(
		"does not resolve to a toClient channel instance",
	);
});

function fromClientRegistry(): SpecRegistry {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile({
		type: "object",
	});
	const ch: Channel = {
		topic: "cmd/{id}",
		direction: "fromClient",
		service: "t",
		schema: { type: "object" },
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos: 1,
		retain: false,
	};
	return {
		diagnostics: () => [],
		match(topic: string) {
			const m = topic.match(/^cmd\/([^/]+)$/);
			if (m?.[1]) return { channel: ch, params: { id: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [ch],
	};
}

test("a mock emit on a fromClient channel never materializes an instance (rule (ii) is toClient-only)", async () => {
	const { engine, emitted } = buildEngine({}, fromClientRegistry());
	engine.publish({ topic: "cmd/c1", payload: {} }, { layer: "L3" });
	await engine.idle();
	expect(emitted.length).toBe(1); // still delivered; direction gates the ledger, not delivery
	expect(engine.instances.snapshot()).toEqual({ instances: [] });
});

test("start(): a seed entry resolving to a fromClient channel surfaces loudly and stays out of the ledger", async () => {
	const { engine, emitted, violations } = buildEngine(
		{},
		fromClientRegistry(),
		{
			"cmd/{id}": [{ id: "c9" }],
		},
	);
	engine.start();
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(engine.instances.snapshot()).toEqual({ instances: [] });
	expect(violations.length).toBe(1);
	expect(violations[0]?.kind).toBe("unknown-topic");
	expect(violations[0]?.detail).toContain(
		"does not resolve to a toClient channel instance",
	);
});

// [utest->R-040]
test("subscribe on an initialState:false channel records the instance and emits nothing", async () => {
	const { engine, emitted, violations } = buildEngine({}, flaggedRegistry());
	engine.onSubscribe("state/d7");
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(violations).toEqual([]);
	expect(engine.instances.snapshot()).toEqual({
		instances: [
			{ channelAddress: "state/{deviceId}", params: { deviceId: "d7" } },
		],
	});
});

// [utest->R-040]
test("start(): an initialState:false literal channel is skipped by the eager sweep", async () => {
	const flagged = {
		...makeChannel("plain/topic", stateSchema, 1, true),
		initialState: false,
	};
	const reg: SpecRegistry = {
		diagnostics: () => [],
		match: (topic) =>
			topic === "plain/topic" ? { channel: flagged, params: {} } : undefined,
		matchesFilter: () => false,
		channels: () => [flagged],
	};
	const { engine, emitted } = buildEngine({}, reg);
	engine.start();
	await engine.idle();
	expect(emitted).toEqual([]);
});

// [utest->R-040]
test("start() + reset(): seeded instances on an initialState:false channel land in the ledger but never republish", async () => {
	const { engine, emitted } = buildEngine({}, flaggedRegistry(), {
		"state/{deviceId}": [{ deviceId: "d9" }],
	});
	engine.start();
	await engine.idle();
	expect(engine.instances.snapshot()).toEqual({
		instances: [
			{ channelAddress: "state/{deviceId}", params: { deviceId: "d9" } },
		],
	});
	expect(emitted).toEqual([]);
	engine.reset(undefined);
	await engine.idle();
	expect(emitted).toEqual([]);
});

// [utest->R-040]
test("an L3 initialState handler still runs on an initialState:false channel (handler wins)", async () => {
	const flagged = {
		...makeChannel("thing/{id}", { type: "object" }, 1, false),
		initialState: false,
	};
	const reg: SpecRegistry = {
		diagnostics: () => [],
		match(topic: string) {
			const m = topic.match(/^thing\/([^/]+)$/);
			if (m?.[1]) return { channel: flagged, params: { id: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [flagged],
	};
	const { engine, emitted, dispatch } = buildEngine({}, reg);
	dispatch.register(
		"thing/{id}",
		() => ({
			initialState(topic, ctx) {
				ctx.publish({ topic, payload: { marker: "authored" } });
			},
		}),
		"h.ts",
	);
	dispatch.instantiate();
	engine.onSubscribe("thing/t1");
	await engine.idle();
	expect(emitted.length).toBe(1);
	expect(emitted[0]?.payload).toEqual({ marker: "authored" });
});
