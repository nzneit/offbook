// [utest->R-032]
import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "#src/config/index.ts";
import type {
	Channel,
	Direction,
	NormalizedMessage,
	SpecRegistry,
	Violation,
} from "#src/model/index.ts";
import { createDispatchRegistry } from "./dispatch.ts";
import { createEngine } from "./index.ts";
import { createInstanceRegistry } from "./instances.ts";

test("R-032: materialize is idempotent — same instance recorded once, param key order irrelevant", () => {
	const reg = createInstanceRegistry();
	reg.materialize("state/{deviceId}/{room}", { deviceId: "t1", room: "den" });
	reg.materialize("state/{deviceId}/{room}", { room: "den", deviceId: "t1" });
	expect(reg.snapshot().instances).toEqual([
		{
			channelAddress: "state/{deviceId}/{room}",
			params: { deviceId: "t1", room: "den" },
		},
	]);
});

test("R-032: distinct params on one channel are distinct instances, kept in materialization order", () => {
	const reg = createInstanceRegistry();
	reg.materialize("state/{id}", { id: "b" });
	reg.materialize("state/{id}", { id: "a" });
	reg.materialize("other/{id}", { id: "b" });
	expect(reg.snapshot().instances).toEqual([
		{ channelAddress: "state/{id}", params: { id: "b" } },
		{ channelAddress: "state/{id}", params: { id: "a" } },
		{ channelAddress: "other/{id}", params: { id: "b" } },
	]);
});

test("R-032: restore replaces the ledger with EXACTLY the snapshot set", () => {
	const reg = createInstanceRegistry();
	reg.materialize("state/{id}", { id: "seeded" });
	const snap = reg.snapshot();
	reg.materialize("state/{id}", { id: "later" });
	reg.restore(snap);
	expect(reg.snapshot().instances).toEqual([
		{ channelAddress: "state/{id}", params: { id: "seeded" } },
	]);
	// restore is not a merge: an empty snapshot empties the ledger
	reg.restore({ instances: [] });
	expect(reg.snapshot().instances).toEqual([]);
});

test("R-032: snapshot/restore are defensive copies — caller mutation never corrupts the ledger", () => {
	const reg = createInstanceRegistry();
	reg.materialize("state/{id}", { id: "a" });
	const snap = reg.snapshot();
	const snapped = snap.instances[0];
	if (snapped) snapped.params.id = "mutated";
	expect(reg.snapshot().instances[0]?.params.id).toBe("a");

	const inputInstance = { channelAddress: "state/{id}", params: { id: "x" } };
	reg.restore({ instances: [inputInstance] });
	inputInstance.params.id = "mutated";
	expect(reg.snapshot().instances[0]?.params.id).toBe("x");
});

// ---- engine wiring: the five materialization-policy rules (contracts §2, G3/F1) ----

const schema = {
	type: "object",
	required: ["temp"],
	additionalProperties: false,
	properties: { temp: { type: "number" }, mode: { type: "string" } },
};

function makeChannel(
	topic: string,
	direction: Direction,
	retain: boolean,
): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
	return {
		topic,
		direction,
		service: "t",
		schema,
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos: 1,
		retain,
	};
}

// Mirrors the real registry's mqtt-pattern matcher: a literal '+' or '#' segment
// in the TOPIC binds as a param value (exec treats the topic as literal), so the
// engine's wildcard guard — not the matcher — must keep filters out.
function makeWiringRegistry(): SpecRegistry {
	const status = makeChannel("status/all", "toClient", true);
	const state = makeChannel("state/{deviceId}", "toClient", true);
	const command = makeChannel("command/{deviceId}/set", "fromClient", false);
	const all = [status, state, command];
	return {
		diagnostics: () => [],
		match(topic: string) {
			if (topic === "status/all")
				return { channel: status, params: {} as Record<string, string> };
			let m = topic.match(/^state\/([^/]+)$/);
			if (m?.[1]) return { channel: state, params: { deviceId: m[1] } };
			m = topic.match(/^command\/([^/]+)\/set$/);
			if (m?.[1]) return { channel: command, params: { deviceId: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => all,
	};
}

function wire(
	seed = 1,
	seedInstances?: Record<string, Record<string, string>[]>,
) {
	const config = loadConfig({ seed });
	const emitted: NormalizedMessage[] = [];
	const violations: Omit<Violation, "seq" | "observedAt">[] = [];
	let seq = 0;
	const dispatch = createDispatchRegistry();
	const engine = createEngine({
		config,
		broker: {
			emit: async (m) => {
				emitted.push(m);
			},
		},
		registry: makeWiringRegistry,
		record: (v) => {
			violations.push(v);
			return { ...v, seq: ++seq, observedAt: "t" } as Violation;
		},
		dispatch,
		seedInstances,
	});
	return { engine, emitted, violations, dispatch };
}

const ledger = (engine: ReturnType<typeof wire>["engine"]) =>
	engine.instances.snapshot().instances;

// [utest->R-032]
test("R-032/G3: start() publishes retained initial state eagerly for non-parametrized toClient channels only", async () => {
	const { engine, emitted, violations } = wire();
	engine.start();
	await engine.idle();
	expect(violations).toEqual([]);
	// status/all eagerly; state/{deviceId} has no instances; command/* is fromClient
	expect(emitted.map((m) => m.topic)).toEqual(["status/all"]);
	expect(emitted[0]?.retain).toBe(true);
	expect(ledger(engine)).toEqual([]); // eager channels are spec-derived, never ledger entries
});

// [utest->R-032]
test("R-032/CR1: seedInstances pre-materializes the demo set — distinct instances get distinct payloads", async () => {
	const { engine, emitted, violations } = wire(1, {
		"state/{deviceId}": [{ deviceId: "t1" }, { deviceId: "t2" }],
	});
	engine.start();
	await engine.idle();
	expect(violations).toEqual([]);
	expect(emitted.map((m) => m.topic)).toEqual([
		"status/all",
		"state/t1",
		"state/t2",
	]);
	const [, t1, t2] = emitted;
	expect(t1?.retain).toBe(true);
	expect(JSON.stringify(t1?.payload)).not.toBe(JSON.stringify(t2?.payload));
	expect(ledger(engine)).toEqual([
		{ channelAddress: "state/{deviceId}", params: { deviceId: "t1" } },
		{ channelAddress: "state/{deviceId}", params: { deviceId: "t2" } },
	]);
});

// [utest->R-032]
test("R-032: a seedInstances entry that resolves to no toClient channel surfaces loudly, never silently", async () => {
	const { engine, emitted, violations } = wire(1, {
		"nope/{x}": [{ x: "1" }],
	});
	engine.start();
	await engine.idle();
	expect(emitted.map((m) => m.topic)).toEqual(["status/all"]); // nothing emitted for it
	expect(ledger(engine)).toEqual([]); // and nothing recorded
	expect(violations.length).toBe(1);
	expect(violations[0]?.origin).toBe("mock");
	expect(violations[0]?.kind).toBe("unknown-topic");
	expect(violations[0]?.detail).toContain("seedInstances");
});

// [utest->R-032]
test("R-032: a concrete subscribe on a parametrized toClient channel materializes the instance", async () => {
	const { engine, emitted } = wire();
	engine.onSubscribe("state/d7");
	await engine.idle();
	expect(ledger(engine)).toEqual([
		{ channelAddress: "state/{deviceId}", params: { deviceId: "d7" } },
	]);
	expect(emitted.map((m) => m.topic)).toEqual(["state/d7"]);
});

// [utest->R-032]
test("R-032/F6: a wildcard subscribe never invents params — no publish, no materialization", async () => {
	const { engine, emitted } = wire();
	engine.onSubscribe("state/+");
	engine.onSubscribe("state/#");
	engine.onSubscribe("#");
	await engine.idle();
	expect(emitted).toEqual([]); // replay is Aedes' native retained delivery, not the engine's
	expect(ledger(engine)).toEqual([]);
});

// [utest->R-032]
test("R-032: a subscribe on a fromClient channel publishes no initial state", async () => {
	const { engine, emitted } = wire();
	engine.onSubscribe("command/d1/set");
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(ledger(engine)).toEqual([]);
});

// [utest->R-032]
test("R-032: a fromClient command materializes via the reactive emit — the emit path records the instance", async () => {
	const { engine, emitted, dispatch } = wire();
	dispatch.register(
		"command/{deviceId}/set",
		() => ({
			onInbound(event, ctx) {
				const id = event.message.topic.split("/")[1];
				ctx.publish({ topic: `state/${id}`, payload: { temp: 21 } });
			},
		}),
		"h.ts",
	);
	dispatch.instantiate();
	engine.onInbound({
		message: { topic: "command/t9/set", payload: { temp: 21 } },
		meta: { clientId: "c", seq: 1, receivedAt: 0 },
	});
	await engine.idle();
	expect(emitted.map((m) => m.topic)).toEqual(["state/t9"]);
	// the toClient state instance is recorded; the fromClient command is NOT
	expect(ledger(engine)).toEqual([
		{ channelAddress: "state/{deviceId}", params: { deviceId: "t9" } },
	]);
});

// [utest->R-032]
test("R-032: reset republishes initial state through the ledger — eager floor + exactly the recorded set, re-seeded", async () => {
	const { engine, emitted, violations } = wire(1, {
		"state/{deviceId}": [{ deviceId: "t1" }],
	});
	engine.start();
	engine.onSubscribe("state/d7"); // lazily materialized on top of the seed set
	await engine.idle();
	const before = new Map(
		emitted.map((m) => [m.topic, JSON.stringify(m.payload)]),
	);

	emitted.length = 0;
	engine.reset();
	await engine.idle();
	// eager channels first, then the ledger in materialization order
	expect(emitted.map((m) => m.topic)).toEqual([
		"status/all",
		"state/t1",
		"state/d7",
	]);
	for (const m of emitted) {
		expect(m.retain).toBe(true);
		// same seed ⇒ the republished floor replays the identical keyed draw
		expect(before.get(m.topic)).toBe(JSON.stringify(m.payload));
	}
	expect(violations).toEqual([]);
	// the ledger survives reset: exactly the recorded set, not emptied
	expect(ledger(engine)).toEqual([
		{ channelAddress: "state/{deviceId}", params: { deviceId: "t1" } },
		{ channelAddress: "state/{deviceId}", params: { deviceId: "d7" } },
	]);

	emitted.length = 0;
	engine.reset(99);
	await engine.idle();
	expect(emitted.map((m) => m.topic)).toEqual([
		"status/all",
		"state/t1",
		"state/d7",
	]);
	// re-seeded: the same set re-materializes with diverged payloads
	const rekeyed = emitted.map((m) => JSON.stringify(m.payload)).join("|");
	const original = [...before.values()].join("|");
	expect(rekeyed).not.toBe(original);
});

// rehearsal probe kill (never merged)
import { rehearsalProbe } from "./instances.ts";

test("rehearsalProbe boundary and literals", () => {
	expect(rehearsalProbe(11)).toBe("big");
	expect(rehearsalProbe(10)).toBe("small");
});
