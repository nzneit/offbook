import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "../config/index.ts";
import type {
	NormalizedMessage,
	SpecRegistry,
	Violation,
} from "../model/index.ts";
import { createDispatchRegistry } from "./dispatch.ts";
import { createEngine } from "./index.ts";

const schema = {
	type: "object",
	required: ["n"],
	additionalProperties: false,
	properties: { n: { type: "number" } },
};

function makeRegistry(): SpecRegistry {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
	const ch = {
		topic: "state/{id}",
		direction: "toClient" as const,
		service: "t",
		schema,
		validate: (p: unknown) => (v(p) ? [] : (v.errors ?? [])),
		qos: 1 as const,
		retain: true,
	};
	return {
		match: (topic: string) => {
			const m = topic.match(/^state\/([^/]+)$/);
			return m?.[1] ? { channel: ch, params: { id: m[1] } } : undefined;
		},
		matchesFilter: () => false,
		channels: () => [ch],
	};
}

// A stateful handler + a scripted run: reset must clear handler state (fresh
// factory instance), re-seed ctx streams, and re-epoch the clock, so the same
// script replays byte-identically.
function build(seed: number) {
	const config = loadConfig({ seed });
	const emitted: [string, unknown, number][] = [];
	const d = createDispatchRegistry();
	const engine = createEngine({
		config,
		broker: {
			emit: async (m: NormalizedMessage) => {
				emitted.push([m.topic, m.payload, engine.now()]);
			},
		},
		registry: makeRegistry,
		record: (v) => ({ ...v, seq: 1, observedAt: "t" }) as Violation,
		dispatch: d,
	});
	let counter = 0; // factory-scoped: a re-instantiated handler starts fresh
	d.register(
		"state/{id}",
		() => {
			counter = 0;
			return {
				onInbound(_event, ctx) {
					counter++;
					ctx.publish({
						topic: "state/replay",
						payload: { n: counter + ctx.random() },
					});
				},
			};
		},
		"h.ts",
	);
	d.instantiate();
	return { engine, emitted };
}

async function script(
	engine: ReturnType<typeof build>["engine"],
): Promise<void> {
	engine.onInbound({
		message: { topic: "state/a", payload: { n: 1 } },
		meta: { clientId: "c", seq: 1, receivedAt: 0 },
	});
	engine.onInbound({
		message: { topic: "state/b", payload: { n: 2 } },
		meta: { clientId: "c", seq: 2, receivedAt: 0 },
	});
	await engine.idle();
}

// [utest->R-014]
test("R-014: reset + same seed replays the same script to a byte-identical emission stream", async () => {
	const { engine, emitted } = build(7);
	await script(engine);
	const first = JSON.stringify(emitted);
	expect(emitted.length).toBe(2);

	emitted.length = 0;
	engine.reset();
	await script(engine);
	expect(JSON.stringify(emitted)).toBe(first); // handler state (fresh factory instance) + clock restored; ctx streams are
	// pure (seed, invocationKey) functions with no cross-reset state to restore
});

// [utest->R-014]
test("R-014: reset(newSeed) re-keys the PRNGs — the same script diverges", async () => {
	const { engine, emitted } = build(7);
	await script(engine);
	const first = JSON.stringify(emitted);

	emitted.length = 0;
	engine.reset(8);
	await script(engine);
	expect(JSON.stringify(emitted)).not.toBe(first);
});

// [utest->R-014]
test("R-014: reset clears pending scheduled work and re-epochs now()", async () => {
	const { engine, emitted } = build(1);
	engine.publish(
		{ topic: "state/x", payload: { n: 1 }, delay: "500ms" },
		{ layer: "L2", scenarioName: "s", stepIndex: 0 },
		{ scenarioName: "s", stepIndex: 0 },
	);
	engine.reset();
	await engine.idle();
	expect(emitted).toEqual([]); // the in-flight step never fires post-reset
	expect(engine.pending()).toEqual({ scheduled: 0, settled: true });
	expect(engine.now()).toBe(loadConfig({ seed: 1 }).fixedEpoch);
});

// [utest->R-014]
test("R-014: reset re-instantiates factories — handler instance state does not survive", async () => {
	const { engine, emitted } = build(7);
	await script(engine); // counter reached 2
	engine.reset();
	engine.onInbound({
		message: { topic: "state/a", payload: { n: 1 } },
		meta: { clientId: "c", seq: 1, receivedAt: 0 },
	});
	await engine.idle();
	const last = emitted.at(-1);
	// a surviving instance would emit n ≈ 3.x; a fresh one emits n ≈ 1.x
	expect((last?.[1] as { n: number }).n).toBeLessThan(2);
});

// [utest->R-014]
test("R-014: reset re-keys the L1 faker — same seed replays the floor draw, a new seed diverges", async () => {
	const { engine, emitted } = build(7);
	engine.onSubscribe("state/a");
	await engine.idle();
	const first = JSON.stringify(emitted);
	expect(emitted.length).toBe(1);

	emitted.length = 0;
	engine.reset();
	engine.onSubscribe("state/a");
	await engine.idle();
	expect(JSON.stringify(emitted)).toBe(first); // same seed ⇒ identical keyed draw

	emitted.length = 0;
	engine.reset(9);
	engine.onSubscribe("state/a");
	await engine.idle();
	expect(JSON.stringify(emitted)).not.toBe(first); // re-keyed faker ⇒ divergent draw
});

test("meta.seq is engine-owned: re-stamped on arrival, zeroed by reset — replay survives broker-side seq drift", async () => {
	const config = loadConfig({ seed: 7 });
	const d = createDispatchRegistry();
	const engine = createEngine({
		config,
		broker: { emit: async () => {} },
		registry: makeRegistry,
		record: (v) => ({ ...v, seq: 1, observedAt: "t" }) as Violation,
		dispatch: d,
	});
	const seen: { seq: number; draw: number }[] = [];
	d.register(
		"state/{id}",
		() => ({
			onInbound(event, ctx) {
				seen.push({ seq: event.meta.seq, draw: ctx.random() });
			},
		}),
		"h.ts",
	);
	d.instantiate();
	// broker-minted seqs are arbitrary (a long-lived broker session)
	engine.onInbound({
		message: { topic: "state/a", payload: { n: 1 } },
		meta: { clientId: "c", seq: 41, receivedAt: 0 },
	});
	engine.onInbound({
		message: { topic: "state/a", payload: { n: 1 } },
		meta: { clientId: "c", seq: 99, receivedAt: 0 },
	});
	await engine.idle();
	expect(seen.map((s) => s.seq)).toEqual([1, 2]); // engine re-stamped in arrival order
	const firstDraw = seen[0]?.draw;

	engine.reset();
	seen.length = 0;
	engine.onInbound({
		message: { topic: "state/a", payload: { n: 1 } },
		meta: { clientId: "c", seq: 123, receivedAt: 0 },
	});
	await engine.idle();
	expect(seen[0]?.seq).toBe(1); // counter zeroed by reset
	expect(seen[0]?.draw).toBe(firstDraw); // same invocation key ⇒ same ctx stream despite drift
});
