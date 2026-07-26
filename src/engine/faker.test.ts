import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "../config/index.ts";
import type { Channel, SchemaError } from "../model/index.ts";
import { canonicalize, createFaker, l1Floor } from "./faker.ts";

// [utest->R-011]

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

function rawChannel(
	topic: string,
	schema: object,
	validate: Channel["validate"] = () => [],
): Channel {
	return {
		topic,
		direction: "toClient",
		service: "t",
		schema,
		validate,
		qos: 1,
		retain: false,
	};
}

const schemaError = (instancePath: string, keyword: string): SchemaError => ({
	instancePath,
	keyword,
	schemaPath: "#",
	params: {},
});

test("canonicalize is the exact F7 identity string: '' for absent/empty, sorted k=v&k=v otherwise", () => {
	expect(canonicalize(undefined)).toBe("");
	expect(canonicalize({})).toBe("");
	expect(canonicalize({ b: "2", a: "1" })).toBe("a=1&b=2");
});

test("the faker seed key is (config.seed, channel address, canonical params): each axis shifts the draw", async () => {
	const intSchema = { type: "integer", minimum: 0, maximum: 1_000_000 };
	const faker = createFaker(loadConfig({ seed: 7 }));
	const base = await faker(rawChannel("a/{id}", intSchema), { id: "1" });
	expect(await faker(rawChannel("a/{id}", intSchema), { id: "1" })).toEqual(
		base,
	);
	expect(await faker(rawChannel("b/{id}", intSchema), { id: "1" })).not.toEqual(
		base,
	);
	expect(await faker(rawChannel("a/{id}", intSchema), { id: "2" })).not.toEqual(
		base,
	);
	expect(
		await createFaker(loadConfig({ seed: 8 }))(
			rawChannel("a/{id}", intSchema),
			{ id: "1" },
		),
	).not.toEqual(base);
});

test("l1Floor formats the recheck detail from the first error: root '' falls back to '/', nested path verbatim", async () => {
	const root = await l1Floor(
		rawChannel("t/{x}", { type: "object" }, () => [schemaError("", "not")]),
		async () => ({}),
	);
	expect("violation" in root).toBe(true);
	if ("violation" in root) {
		expect(root.violation.detail).toBe("/: not");
		expect(root.violation.topic).toBe("t/{x}");
		expect(root.violation.channel).toBe("t/{x}");
		expect(root.violation.errors).toEqual([schemaError("", "not")]);
		expect(root.violation.payload).toEqual({});
		expect(root.violation.severity).toBe("error");
	}
	const nested = await l1Floor(
		rawChannel("t/{x}", { type: "object" }, () => [
			schemaError("/x", "maximum"),
		]),
		async () => ({}),
	);
	if ("violation" in nested)
		expect(nested.violation.detail).toBe("/x: maximum");
});

test("a rejecting faker surfaces 'faker rejected: <original message>'", async () => {
	const out = await l1Floor(
		rawChannel("t/{x}", { type: "object" }),
		async () => {
			throw new Error("nope");
		},
	);
	expect("violation" in out).toBe(true);
	if ("violation" in out)
		expect(out.violation.detail).toBe("faker rejected: nope");
});

test("alwaysFakeOptionals: every optional property is present in the draw", async () => {
	const props: Record<string, object> = {};
	for (const k of ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"])
		props[k] = { type: "integer" };
	const faker = createFaker(loadConfig({ seed: 7 }));
	const out = await faker(
		rawChannel("o/{id}", {
			type: "object",
			properties: props,
			required: [],
			additionalProperties: false,
		}),
	);
	expect(Object.keys(out as object).sort()).toEqual([
		"p1",
		"p2",
		"p3",
		"p4",
		"p5",
		"p6",
		"p7",
		"p8",
	]);
});

test("failOnInvalidTypes stays off: an unknown schema type must not reject the draw", async () => {
	const faker = createFaker(loadConfig({ seed: 7 }));
	const outcome = await faker(rawChannel("f/{id}", { type: "file" })).then(
		() => "resolved",
		(e) => `threw: ${e}`,
	);
	expect(outcome).toBe("resolved");
});
