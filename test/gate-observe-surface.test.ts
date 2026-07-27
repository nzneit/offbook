// R-031 — the observe-and-surface v1 gate, cross-cutting over R-015's
// module bar: NO validation path ever blocks delivery. A real mqtt.js ws
// subscriber on '#' receives every off-contract publish — schema (real
// client), direction (real client on a toClient topic), unknown-topic
// (HTTP-injected, G9), and decode (raw non-JSON bytes) — while each lands
// in the violation log with its kind. The broker stays payload-agnostic.
// [itest->R-031]
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectAsync } from "mqtt";
import { type Composed, compose } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import type { Violation } from "#src/model/index.ts";
import { buildRegistry } from "#src/registry/index.ts";

// 196xx/129xx ports: distinct from every other suite
const WS = 19060;
const config = loadConfig({
	brokerWsPort: WS,
	brokerTcpPort: 12960,
	controlPlanePort: 19860,
});

let server: Composed;
let client: Awaited<ReturnType<typeof connectAsync>>;
const received: { topic: string; payload: string }[] = [];

beforeAll(async () => {
	const registry = await buildRegistry({
		specText: await Bun.file("src/demo/thermostat.yaml").text(),
		service: "demo",
		config,
	});
	server = await compose({ config, registry });
	await server.start();
	// browser-style mqtt.js over Bun's native ws (mirrors the m0 harness)
	client = await connectAsync(`ws://localhost:${WS}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
	});
	client.on("error", () => {});
	client.on("message", (topic, payload) =>
		received.push({ topic, payload: payload.toString() }),
	);
	await client.subscribeAsync("#", { qos: 1 });
});

afterAll(async () => {
	await client.endAsync();
	await server.stop();
});

const post = (path: string, body: unknown) =>
	server.app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

async function until(pred: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred() && Date.now() < deadline)
		await new Promise((r) => setTimeout(r, 25));
}

test("all four violation kinds are DELIVERED to a real subscriber and surfaced in the log", async () => {
	// 1. schema: a real client publish, valid JSON but off-contract
	await client.publishAsync(
		"command/thermostat-1/set",
		JSON.stringify({ mode: "broil", target: 22 }),
		{ qos: 1 },
	);
	// 2. direction: a real client publishes a toClient topic
	await client.publishAsync(
		"state/thermostat-1",
		JSON.stringify({ deviceId: "thermostat-1", status: "idle" }),
		{ qos: 1 },
	);
	// 3. unknown-topic: HTTP-injected — re-enters the same inbound path (G9)
	await post("/v1/publish", {
		topic: "zzz/unknown",
		payload: { any: "thing" },
	});
	// 4. decode: raw non-JSON bytes from a real client
	await client.publishAsync("command/thermostat-1/set", "not-json{", {
		qos: 1,
	});

	await server.app.request("/v1/pending?wait");
	await until(
		() =>
			received.some((m) => m.payload === "not-json{") &&
			received.some((m) => m.topic === "zzz/unknown"),
	);

	// delivery was never blocked: every publish reached the subscriber raw
	expect(
		received.some(
			(m) =>
				m.topic === "command/thermostat-1/set" && m.payload.includes("broil"),
		),
	).toBe(true);
	expect(received.some((m) => m.topic === "state/thermostat-1")).toBe(true);
	expect(received.some((m) => m.topic === "zzz/unknown")).toBe(true);
	expect(received.some((m) => m.payload === "not-json{")).toBe(true); // byte-intact

	// ...while every one of them was surfaced with its kind
	const { violations } = (await (
		await server.app.request("/v1/validation?origin=client")
	).json()) as { violations: Violation[] };
	const kinds = new Set(violations.map((v) => v.kind));
	expect(kinds.has("schema")).toBe(true);
	expect(kinds.has("direction")).toBe(true);
	expect(kinds.has("unknown-topic")).toBe(true);
	expect(kinds.has("decode")).toBe(true);
}, 15_000);
