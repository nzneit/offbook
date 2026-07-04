import { afterEach, expect, test } from "bun:test";
import { connectAsync } from "mqtt";
import { loadConfig } from "../src/config/index.ts";
import { createServer } from "../src/control-plane/index.ts";
import { createFaker } from "../src/engine/faker.ts";
import type { Violation } from "../src/model/index.ts";
import { buildRegistry } from "../src/registry/index.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

// 177xx/178xx/179xx: a port range distinct from every other test file's
// (broker/index.test.ts uses 19000s/11800s/19800s; control-plane/index.test.ts
// uses 18000s/12800s/18800s), so this file can't collide with either.
function ports(n: number) {
	return loadConfig({
		brokerWsPort: 17700 + n,
		brokerTcpPort: 17800 + n,
		controlPlanePort: 17900 + n,
	});
}

async function bootFullStack(n: number) {
	const config = ports(n);
	const specText = await Bun.file("src/demo/thermostat.yaml").text();
	const registry = await buildRegistry({ specText, service: "demo", config });
	const server = createServer(config, { registry, faker: createFaker(config) });
	await server.start();
	cleanups.push(() => server.stop());
	return { server, config };
}

test("M0 gate (i): mqtt.js connects over ws and receives retained state seeded through the stack", async () => {
	const { server, config } = await bootFullStack(1);

	// seed a toClient retained state through the full stack (HTTP -> broker.emit)
	await server.app.request("/v1/publish", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ topic: "state/thermostat-1", example: true }),
	});

	// browser-style mqtt.js client over Bun.serve's native ws (not node-ws) —
	// must mirror src/broker/index.test.ts's harness connect exactly.
	const client = await connectAsync(`ws://localhost:${config.brokerWsPort}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
	});
	client.on("error", () => {});
	cleanups.push(() => client.endAsync());

	const retained = await new Promise<string>((resolve) => {
		client.once("message", (_topic, payload) => resolve(payload.toString()));
		client.subscribe("state/thermostat-1", { qos: 1 });
	});
	expect(JSON.parse(retained)).toHaveProperty("status");
});

test("M0 gate (ii): every demo topic/shape/direction is discoverable via GET /v1/topics", async () => {
	const { server } = await bootFullStack(2);

	const body = (await (await server.app.request("/v1/topics")).json()) as {
		topics: Array<{ topic: string; direction: string; schema: object }>;
	};
	const topics = body.topics;

	expect(topics.map((t) => t.topic).sort()).toEqual([
		"command/{deviceId}/set",
		"state/{deviceId}",
	]);
	for (const t of topics) {
		expect(["toClient", "fromClient"]).toContain(t.direction);
		expect(t.schema).toBeTruthy();
	}
});

test("M0 output: an off-contract client publish is delivered and surfaced (validation-as-value)", async () => {
	const { server } = await bootFullStack(3);

	const pub = (await (
		await server.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				topic: "command/thermostat-1/set",
				payload: { mode: "broil", target: 20 },
			}),
		})
	).json()) as { sinceSeq: number };

	const after = (await (
		await server.app.request(`/v1/validation?sinceSeq=${pub.sinceSeq}`)
	).json()) as { violations: Violation[] };

	expect(
		after.violations.some((v) => v.kind === "schema" && v.origin === "client"),
	).toBe(true);
});
