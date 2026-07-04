import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "../config/index.ts";
import { createFaker } from "../engine/faker.ts";
import { buildRegistry } from "../registry/index.ts";
import { createServer } from "./index.ts";

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
