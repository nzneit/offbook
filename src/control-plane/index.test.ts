import { afterEach, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "#src/config/index.ts";
import { createFaker } from "#src/engine/faker.ts";
import type { Channel, SpecRegistry } from "#src/model/index.ts";
import { buildRegistry } from "#src/registry/index.ts";
import { buildTopicInfo, createServer } from "./index.ts";

const servers: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
	while (servers.length) await servers.pop()?.stop();
});

async function boot(n: number) {
	const config = loadConfig({
		brokerWsPort: 18000 + n,
		brokerTcpPort: 12800 + n,
		controlPlanePort: 18800 + n,
	});
	const specText = await Bun.file("src/demo/thermostat.yaml").text();
	const registry = await buildRegistry({ specText, service: "demo", config });
	const faker = createFaker(config);
	const s = createServer(config, { registry, faker });
	servers.push(s);
	await s.start();
	return {
		s,
		config,
		req: (path: string, init?: RequestInit) => s.app.request(path, init),
	};
}

// --- hand-built registry fixtures (the demo spec is all-valid, so the L1-floor
// failure path can only be exercised against a schema the faker can't satisfy) --
const goodSchema = {
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
// faker cannot satisfy const:"A" AND enum:["B"] at once → the Ajv recheck fails
const impossibleSchema = {
	type: "object",
	required: ["x"],
	additionalProperties: false,
	properties: { x: { type: "string", const: "A", enum: ["B"] } },
};

function makeChannel(topic: string, schema: object): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
	return {
		topic,
		direction: "toClient",
		service: "demo",
		schema,
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos: 1,
		retain: false,
	};
}

function fakeRegistry(channels: Channel[]): SpecRegistry {
	return {
		channels: () => channels,
		match: (topic) => {
			const c = channels.find((ch) => ch.topic === topic);
			return c ? { channel: c, params: {} } : undefined;
		},
		matchesFilter: () => false,
	};
}

async function bootWith(n: number, registry: SpecRegistry) {
	const config = loadConfig({
		brokerWsPort: 18000 + n,
		brokerTcpPort: 12800 + n,
		controlPlanePort: 18800 + n,
	});
	const s = createServer(config, { registry, faker: createFaker(config) });
	servers.push(s);
	await s.start();
	return {
		config,
		req: (path: string, init?: RequestInit) => s.app.request(path, init),
	};
}

test("buildTopicInfo omits the example when the L1 floor can't produce a schema-valid draw (F5) and never fails discovery", async () => {
	const infos = await buildTopicInfo(
		fakeRegistry([
			makeChannel("good/topic", goodSchema),
			makeChannel("bad/topic", impossibleSchema),
		]),
		createFaker(loadConfig()),
	);
	expect(infos.find((i) => i.topic === "good/topic")?.example).toBeDefined();
	expect(infos.find((i) => i.topic === "bad/topic")?.example).toBeUndefined();
});

test("POST /v1/publish {example} drops-and-surfaces an L1 mock violation instead of emitting an invalid payload (F5)", async () => {
	const { req } = await bootWith(
		6,
		fakeRegistry([makeChannel("bad/topic", impossibleSchema)]),
	);
	const res = await req("/v1/publish", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ topic: "bad/topic", example: true }),
	});
	expect(res.status).toBe(202);
	const body = await res.json();
	// F5 drop: nothing reached the broker, and the mock violation is surfaced
	expect(body.injected).toBe(false);
	expect(body.matched).toBe(true);
	const after = await (
		await req(`/v1/validation?sinceSeq=${body.sinceSeq}`)
	).json();
	const v = after.violations.find(
		(x: { origin: string; kind: string }) =>
			x.origin === "mock" && x.kind === "schema",
	);
	expect(v).toBeDefined();
	expect(v.emitSource?.layer).toBe("L1");
});

test("POST /v1/publish of an off-contract fromClient payload is delivered AND surfaces a schema/client violation", async () => {
	const { req } = await boot(1);
	const before = await (await req("/v1/validation")).json();
	const res = await req("/v1/publish", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			topic: "command/thermostat-1/set",
			payload: { mode: "broil", target: 20 },
		}),
	});
	expect(res.status).toBe(202);
	const body = await res.json();
	expect(body).toMatchObject({
		direction: "fromClient",
		matched: true,
		injected: true,
	});
	const after = await (
		await req(`/v1/validation?sinceSeq=${body.sinceSeq}`)
	).json();
	const v = after.violations.find((x: { kind: string }) => x.kind === "schema");
	expect(v).toMatchObject({
		origin: "client",
		kind: "schema",
		channel: "command/{deviceId}/set",
	});
	expect(after.summary.byOrigin.client).toBeGreaterThanOrEqual(1);
	expect(before.summary).toBeDefined();
});

test("GET /v1/topics returns TopicInfo[] with examples byte-equal to POST /publish {example:true}", async () => {
	const { req } = await boot(2);
	const topics = (await (await req("/v1/topics")).json()).topics as Array<{
		topic: string;
		direction: string;
		example: unknown;
	}>;
	const state = topics.find((t) => t.topic === "state/{deviceId}");
	expect(state).toBeDefined();
	expect(state?.direction).toBe("toClient");
	const pub = await (
		await req("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ topic: "state/thermostat-1", example: true }),
		})
	).json();
	expect(pub.matched).toBe(true);
	// both example generators are the injected faker at channel level → byte-equal
	const viaTopics = JSON.stringify(state?.example);
	const state2 = (
		(await (await req("/v1/topics")).json()).topics as Array<{
			topic: string;
			example: unknown;
		}>
	).find((t) => t.topic === "state/{deviceId}");
	expect(state2).toBeDefined();
	expect(JSON.stringify(state2?.example)).toBe(viaTopics);
});

test("GET /v1/topics example is non-empty and carries the schema's required fields (D-003: a missed await would serialize a pending promise to {})", async () => {
	const { req } = await boot(5);
	const topics = (await (await req("/v1/topics")).json()).topics as Array<{
		topic: string;
		example: Record<string, unknown>;
	}>;
	const state = topics.find((t) => t.topic === "state/{deviceId}");
	expect(state).toBeDefined();
	expect(state?.example).toBeDefined();
	expect(Object.keys(state?.example ?? {}).length).toBeGreaterThan(0);
	for (const key of ["deviceId", "status", "target", "units"]) {
		expect(state?.example).toHaveProperty(key);
	}
});

test("POST /v1/publish rejects payload+example together and example on an unknown topic", async () => {
	const { req } = await boot(3);
	const both = await req("/v1/publish", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ topic: "state/x", payload: {}, example: true }),
	});
	expect(both.status).toBe(400);
	expect((await both.json()).error.code).toBe("example-and-payload");
	const unk = await req("/v1/publish", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ topic: "no/such/topic", example: true }),
	});
	expect(unk.status).toBe(400);
	expect((await unk.json()).error.code).toBe("example-on-unknown-topic");
});

test("POST /v1/publish to an unknown topic still injects (202) and raises an unknown-topic violation", async () => {
	const { req } = await boot(4);
	const res = await req("/v1/publish", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ topic: "no/such/topic", payload: { a: 1 } }),
	});
	expect(res.status).toBe(202);
	const body = await res.json();
	expect(body).toMatchObject({
		direction: null,
		matched: false,
		injected: true,
	});
	const after = await (
		await req(`/v1/validation?sinceSeq=${body.sinceSeq}`)
	).json();
	expect(
		after.violations.some((v: { kind: string }) => v.kind === "unknown-topic"),
	).toBe(true);
});
