import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "../config/index.ts";
import type { Channel } from "../model/index.ts";
import { createFaker, l1Floor } from "./faker.ts";

const stateSchema = {
	type: "object",
	required: ["deviceId", "status", "target", "units"],
	additionalProperties: false,
	properties: {
		deviceId: { type: "string" },
		status: {
			type: "string",
			enum: ["accepted", "heating", "cooling", "idle", "offline"],
		},
		target: { type: "number" },
		units: { type: "string", enum: ["C", "F"] },
	},
};

function channel(schema: object): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
	return {
		topic: "state/{deviceId}",
		direction: "toClient",
		service: "demo",
		schema,
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos: 1,
		retain: true,
	};
}

test("faker is deterministic for a given seed + channel", async () => {
	const f1 = createFaker(loadConfig({ seed: 7 }));
	const f2 = createFaker(loadConfig({ seed: 7 }));
	const ch = channel(stateSchema);
	const [p1, p2] = await Promise.all([f1(ch), f2(ch)]);
	expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
});

test("faker output varies with the seed (config.seed is causal, not ignored)", async () => {
	// Same-seed equality above is satisfied by a faker that ignores the seed and
	// returns a constant. This pins the seed as the cause: across a batch of
	// distinct seeds the high-entropy fields (deviceId, target) must diverge.
	const ch = channel(stateSchema);
	const outs: string[] = [];
	for (const seed of [1, 2, 3, 7, 42, 999]) {
		outs.push(JSON.stringify(await createFaker(loadConfig({ seed }))(ch)));
	}
	expect(new Set(outs).size).toBeGreaterThan(1);
});

test("l1Floor returns a schema-valid payload for a real channel", async () => {
	const f = createFaker(loadConfig());
	const ch = channel(stateSchema);
	const out = await l1Floor(ch, f);
	expect("payload" in out).toBe(true);
	if ("payload" in out) expect(ch.validate(out.payload)).toEqual([]);
});

test("l1Floor drops and surfaces an L1 mock violation when the recheck fails", async () => {
	const f = createFaker(loadConfig());
	// impossible schema: faker cannot satisfy both const and enum, so the recheck fails
	const impossible = channel({
		type: "object",
		required: ["x"],
		properties: { x: { type: "string", const: "A", enum: ["B"] } },
		additionalProperties: false,
	});
	const out = await l1Floor(impossible, f);
	expect("violation" in out).toBe(true);
	if ("violation" in out) {
		expect(out.violation.origin).toBe("mock");
		expect(out.violation.kind).toBe("schema");
		expect(out.violation.emitSource?.layer).toBe("L1");
	}
});

test("l1Floor catches a rejecting faker and surfaces an L1 mock violation", async () => {
	const ch = channel(stateSchema);
	const out = await l1Floor(ch, async () => {
		throw new Error("boom");
	});
	expect("violation" in out).toBe(true);
	if ("violation" in out) {
		expect(out.violation.origin).toBe("mock");
		expect(out.violation.kind).toBe("schema");
		expect(out.violation.emitSource?.layer).toBe("L1");
	}
});
