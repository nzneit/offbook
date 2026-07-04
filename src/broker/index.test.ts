import { afterEach, expect, test } from "bun:test";
import { connectAsync } from "mqtt";
import { loadConfig } from "../config/index.ts";
import { createBroker } from "./index.ts";

const brokers: Array<{ stop(): Promise<void> }> = [];
function track<T extends { stop(): Promise<void> }>(b: T): T {
	brokers.push(b);
	return b;
}
afterEach(async () => {
	while (brokers.length) await brokers.pop()?.stop();
});

// use per-test ports to avoid collisions across the suite
function ports(n: number) {
	return loadConfig({
		brokerWsPort: 19000 + n,
		brokerTcpPort: 11800 + n,
		controlPlanePort: 19800 + n,
	});
}

test("emit(retain) is readable via getState, and clear-retain evicts the key", async () => {
	const b = track(createBroker(ports(1)));
	await b.start();
	await b.emit({ topic: "state/x", payload: { v: 1 }, retain: true });
	let state = await b.getState();
	expect(state.get("state/x")?.payload).toEqual({ v: 1 });
	await b.emit({ topic: "state/x", payload: undefined, retain: true });
	state = await b.getState();
	expect(state.has("state/x")).toBe(false);
});

test("M0 gate (i): a browser-style mqtt.js client connects over ws, receives a retained message, and a QoS-1 publish round-trips", async () => {
	const cfg = ports(2);
	const b = track(createBroker(cfg));
	await b.start();

	// forceNativeWebSocket routes mqtt.js through its browser code path (the
	// global WebSocket + a hand-rolled stream proxy) instead of the Node path
	// (the "ws" package's createWebSocketStream, which Bun's built-in "ws"
	// stand-in doesn't implement). This is also the more faithful choice: the
	// client under test is a browser application (see AGENTS.md vocabulary),
	// so exercising mqtt.js's actual browser transport is the closer emulation.
	const url = `ws://localhost:${cfg.brokerWsPort}`;
	const sub = await connectAsync(url, { forceNativeWebSocket: true });
	const pub = await connectAsync(url, { forceNativeWebSocket: true });
	try {
		// retained receipt: publish retained BEFORE the subscriber subscribes
		await pub.publishAsync(
			"state/thermostat-1",
			JSON.stringify({ status: "idle" }),
			{ retain: true, qos: 1 },
		);
		const retained = await new Promise<string>((resolve) => {
			sub.on("message", (_t, payload) => resolve(payload.toString()));
			sub.subscribe("state/thermostat-1", { qos: 1 });
		});
		expect(JSON.parse(retained)).toEqual({ status: "idle" });

		// QoS-1 round-trip on a fresh topic
		const rt = new Promise<string>((resolve) =>
			sub.on(
				"message",
				(t, payload) => t === "rt/1" && resolve(payload.toString()),
			),
		);
		await sub.subscribeAsync("rt/1", { qos: 1 });
		await pub.publishAsync("rt/1", "ping", { qos: 1 });
		expect(await rt).toBe("ping");
	} finally {
		await sub.endAsync();
		await pub.endAsync();
	}
});
