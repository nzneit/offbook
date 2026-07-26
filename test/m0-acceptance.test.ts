import { afterEach, expect, test } from "bun:test";
import { connectAsync } from "mqtt";
import { loadConfig } from "#src/config/index.ts";
import { createServer } from "#src/control-plane/index.ts";
import { createFaker } from "#src/engine/faker.ts";
import type { Violation } from "#src/model/index.ts";
import { buildRegistry } from "#src/registry/index.ts";

// [itest->R-008]

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
	return { server, config, registry };
}

test("M0 gate (i): mqtt.js connects over ws and receives retained state seeded through the stack", async () => {
	const { server, config, registry } = await bootFullStack(1);

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
	// full schema-validity of the retained payload — every required field, correct
	// types, enum membership, no extras — not just the presence of one field
	const m = registry.match("state/thermostat-1");
	expect(m).toBeTruthy();
	expect(m?.channel.validate(JSON.parse(retained))).toEqual([]);
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

// [itest->R-015]
test("M0: a real mqtt.js client's off-contract publishes flow through onInbound → validateClientPublish and surface as client violations", async () => {
	const { server, config } = await bootFullStack(4);

	const client = await connectAsync(`ws://localhost:${config.brokerWsPort}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		clientId: "real-browser-1",
	});
	client.on("error", () => {});
	cleanups.push(() => client.endAsync());

	// observe-and-surface (R-015): a subscriber must still receive the
	// off-contract publishes below — validation never blocks delivery
	const observer = await connectAsync(`ws://localhost:${config.brokerWsPort}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		clientId: "observer-1",
	});
	observer.on("error", () => {});
	cleanups.push(() => observer.endAsync());
	const observed: string[] = [];
	observer.on("message", (_topic, payload) => {
		observed.push(payload.toString());
	});
	await observer.subscribeAsync("command/thermostat-1/set", { qos: 1 });

	// exercise every branch of validateClientPublish over the real transport
	// (not the HTTP /publish re-impl): schema, direction, unknown-topic, decode
	await client.publishAsync(
		"command/thermostat-1/set",
		JSON.stringify({ mode: "broil", target: 20 }),
		{ qos: 1 },
	); // schema: invalid payload on a fromClient topic
	await client.publishAsync(
		"state/thermostat-1",
		JSON.stringify({ deviceId: "x", status: "idle", target: 20, units: "C" }),
		{ qos: 1 },
	); // direction: a client publishing a toClient topic — the direction check returns before the schema check, so direction is the only violation regardless of payload
	await client.publishAsync("no/such/topic", JSON.stringify({ a: 1 }), {
		qos: 1,
	}); // unknown-topic
	await client.publishAsync("command/thermostat-1/set", "not-json{", {
		qos: 1,
	}); // decode: non-JSON bytes

	// inbound handling runs as the broker processes each PUBLISH, which can lag
	// the PUBACK publishAsync awaits — poll /validation until all four surface
	const want: Violation["kind"][] = [
		"schema",
		"direction",
		"unknown-topic",
		"decode",
	];
	let violations: Violation[] = [];
	for (let i = 0; i < 80; i++) {
		violations = (
			(await (await server.app.request("/v1/validation")).json()) as {
				violations: Violation[];
			}
		).violations;
		if (want.every((k) => violations.some((v) => v.kind === k))) break;
		await Bun.sleep(25);
	}

	const kinds = [...new Set(violations.map((v) => v.kind))].sort();
	for (const kind of want) {
		expect(kinds).toContain(kind);
		expect(violations.find((v) => v.kind === kind)?.origin).toBe("client");
	}
	// prove these came through the real inbound path, not the HTTP /publish
	// re-impl (which stamps config.injectedClientId, never a real client id)
	const schemaV = violations.find((v) => v.kind === "schema");
	expect(schemaV?.clientId).toBe("real-browser-1");
	expect(schemaV?.clientId).not.toBe(config.injectedClientId);
	// structured Ajv errors[] ride the violation over the real transport, not
	// just a stringified message — "broil" isn't in the mode enum
	expect(schemaV?.errors?.[0]?.instancePath).toBe("/mode");
	expect(schemaV?.errors?.[0]?.keyword).toBe("enum");

	// both the schema-invalid JSON and the undecodable bytes were delivered
	// raw to the subscriber while their violations surfaced above
	for (let i = 0; i < 80 && observed.length < 2; i++) await Bun.sleep(25);
	expect(observed).toContain(JSON.stringify({ mode: "broil", target: 20 }));
	expect(observed).toContain("not-json{");
});
