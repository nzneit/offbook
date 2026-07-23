import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "../config/index.ts";
import type { Channel } from "../model/index.ts";
import { parseDelay, resolveEmit } from "./resolve-emit.ts";

// [utest->R-013]

function channel(overrides: Partial<Channel> = {}): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile({});
	return {
		topic: "state/{deviceId}",
		direction: "toClient",
		service: "demo",
		schema: {},
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos: 2,
		retain: true,
		...overrides,
	};
}

const key = { scenarioName: "warm-up", stepIndex: 0 };

test("F13: an authored {topic, payload} fills qos/retain from the channel — never undefined", () => {
	const out = resolveEmit(
		{ topic: "state/d1", payload: { a: 1 } },
		channel(),
		loadConfig(),
		key,
	);
	expect(out).toEqual({
		topic: "state/d1",
		payload: { a: 1 },
		qos: 2,
		retain: true,
		delayMs: 0,
	});
});

test("F13: an explicit qos/retain wins over the channel binding", () => {
	const out = resolveEmit(
		{ topic: "state/d1", payload: {}, qos: 0, retain: false },
		channel(),
		loadConfig(),
	);
	expect(out.qos).toBe(0);
	expect(out.retain).toBe(false);
});

test("F13: a channel with no binding falls back to qos 1 / retain false", () => {
	const out = resolveEmit(
		{ topic: "state/d1", payload: {} },
		channel({ qos: undefined, retain: undefined }),
		loadConfig(),
	);
	expect(out.qos).toBe(1);
	expect(out.retain).toBe(false);
});

test("delay: fixed forms parse exactly; s converts to ms", () => {
	const config = loadConfig();
	expect(parseDelay("150ms", config, key)).toBe(150);
	expect(parseDelay("2s", config, key)).toBe(2000);
});

test("delay: ranged draw is finite, in [min,max], keyed by (scenarioName, stepIndex), and seed-causal (F7)", () => {
	const config = loadConfig({ seed: 7 });
	const d1 = parseDelay("150-300ms", config, key);
	expect(Number.isFinite(d1)).toBe(true);
	expect(d1).toBeGreaterThanOrEqual(150);
	expect(d1).toBeLessThanOrEqual(300);
	// same key + seed ⇒ same draw
	expect(parseDelay("150-300ms", config, key)).toBe(d1);
	// key and seed are both causal: across other steps/seeds the draw varies
	const variants = [
		parseDelay("150-300ms", config, { scenarioName: "warm-up", stepIndex: 1 }),
		parseDelay("150-300ms", config, { scenarioName: "other", stepIndex: 0 }),
		parseDelay("150-300ms", loadConfig({ seed: 8 }), key),
	];
	expect(new Set([d1, ...variants]).size).toBeGreaterThan(1);
});

test("delay flows through resolveEmit into delayMs", () => {
	const config = loadConfig({ seed: 7 });
	const out = resolveEmit(
		{ topic: "state/d1", payload: {}, delay: "150-300ms" },
		channel(),
		config,
		key,
	);
	expect(out.delayMs).toBe(parseDelay("150-300ms", config, key));
});

test("a delay string without a delayKey, and malformed grammar, both throw", () => {
	const config = loadConfig();
	expect(() =>
		resolveEmit({ topic: "t", payload: {}, delay: "10ms" }, channel(), config),
	).toThrow();
	expect(() => parseDelay("fast", config, key)).toThrow();
	expect(() => parseDelay("300-150ms", config, key)).toThrow(); // inverted range
});

test("both delay and delayMs set throws — no silent precedence at the choke-point", () => {
	expect(() =>
		resolveEmit(
			{ topic: "t", payload: {}, delay: "10ms", delayMs: 5 },
			channel(),
			loadConfig(),
			key,
		),
	).toThrow();
});

test("channel-side qos 0 / retain false are honored (nullish, not falsy, coalescing)", () => {
	const out = resolveEmit(
		{ topic: "state/d1", payload: {} },
		channel({ qos: 0, retain: false }),
		loadConfig(),
	);
	expect(out.qos).toBe(0);
	expect(out.retain).toBe(false);
});

test("mixed-unit range strings reject (unit suffix is single and shared)", () => {
	expect(() => parseDelay("1s-2s", loadConfig(), key)).toThrow();
});
