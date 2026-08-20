import { afterEach, expect, test } from "bun:test";
import { connect, connectAsync } from "mqtt";
import { loadConfig } from "#src/config/index.ts";
import type { InboundEvent } from "#src/model/index.ts";
import { port } from "#test/ports.ts";
import { createBroker } from "./index.ts";

// [utest->R-003]

const brokers: Array<{ stop(): Promise<void> }> = [];
function track<T extends { stop(): Promise<void> }>(b: T): T {
	brokers.push(b);
	return b;
}
afterEach(async () => {
	while (brokers.length) await brokers.pop()?.stop();
});

// Per-test ports, so the file's own brokers never collide with each other or
// with the rest of the suite. Port BASES for this file (repo convention:
// unique per file): ws 19000+n / tcp 11800+n / ctrl 19800+n, n = 1..8; the
// ctrl base is config-only, since createBroker binds ws and tcp only. Those
// are allocation bases, not necessarily the ports bound at runtime: every
// computed base goes through port() from test/ports.ts, which maps it into
// this process's claimed band. Band 0 (a normal local run) is the identity
// map, so the numbers here are what you will see; a concurrent run claims a
// higher band and the same bases land elsewhere. port() is applied per
// computed value (port(19000 + n)), never to the base alone — in a mapped
// band, distinct values must stay distinct.
function ports(n: number) {
	return loadConfig({
		brokerWsPort: port(19000 + n),
		brokerTcpPort: port(11800 + n),
		controlPlanePort: port(19800 + n),
	});
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(
	pred: () => boolean,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline) return;
		await delay(10);
	}
}

// Collect the retained topics a wildcard subscriber replays on subscribe (Aedes' native retained
// delivery). Settle briefly past the expected count so a wrongly-delivered topic would be caught.
async function collectRetained(
	url: string,
	filter: string,
	expected: number,
): Promise<Set<string>> {
	const c = await connectAsync(url, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
	});
	c.on("error", () => {});
	const topics = new Set<string>();
	try {
		c.on("message", (t) => topics.add(t));
		await c.subscribeAsync(filter, { qos: 1 });
		await waitUntil(() => topics.size >= expected, 1000);
		await delay(50);
	} finally {
		await c.endAsync();
	}
	return topics;
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

test("getState skips a retained non-JSON payload (no StateEntry for an undecodable retained publish)", async () => {
	const cfg = ports(3);
	const b = track(createBroker(cfg));
	await b.start();

	const url = `ws://localhost:${cfg.brokerWsPort}`;
	const pub = await connectAsync(url, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
	});
	pub.on("error", () => {});
	try {
		await pub.publishAsync("state/bad-1", "not json {{", {
			retain: true,
			qos: 1,
		});
		const state = await b.getState();
		expect(state.has("state/bad-1")).toBe(false);
	} finally {
		await pub.endAsync();
	}
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
	const sub = await connectAsync(url, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
	});
	const pub = await connectAsync(url, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
	});
	sub.on("error", () => {});
	pub.on("error", () => {});
	try {
		// retained receipt: publish retained BEFORE the subscriber subscribes
		await pub.publishAsync(
			"state/thermostat-1",
			JSON.stringify({ status: "idle" }),
			{ retain: true, qos: 1 },
		);
		const retained = new Promise<string>((resolve) =>
			sub.once("message", (_t, payload) => resolve(payload.toString())),
		);
		await sub.subscribeAsync("state/thermostat-1", { qos: 1 });
		expect(JSON.parse(await retained)).toEqual({ status: "idle" });

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

test("emit and getState before start() reject with one legible error (D-031: aedes 1.x persistence lives in listen())", async () => {
	const b = track(createBroker(ports(7)));
	await expect(b.emit({ topic: "t", payload: { x: 1 } })).rejects.toThrow(
		"broker not started",
	);
	await expect(b.getState()).rejects.toThrow("broker not started");
});

test("start() is single-lifecycle: re-entry rejects without destroying state, and start-after-stop rejects (D-031)", async () => {
	const b = track(createBroker(ports(8)));
	await b.start();
	await b.emit({ topic: "pin/retained", payload: { v: 1 }, retain: true });
	// B-1: a second start() must reject legibly BEFORE touching aedes.listen()
	// — on raw aedes 1.x a second listen() rebuilds persistence (wiping the
	// retained store) and orphans the heartbeat interval before the bind fails
	await expect(b.start()).rejects.toThrow("broker already started");
	// the retained store survived the rejected re-entry
	const state = await b.getState();
	expect(state.has("pin/retained")).toBe(true);
	await b.stop();
	// B-2: start-after-stop must reject too (1.x listen() would otherwise
	// resolve into a zombie: mqemitter closed, ports accepting, nothing delivered)
	await expect(b.start()).rejects.toThrow("broker already started");
});

// --- R-009: fuller tier-1 broker acceptance ---

// [utest->R-009]
test("R-009: a non-JSON publish surfaces via onInbound (decodeError) and is still delivered raw", async () => {
	const cfg = ports(4);
	const b = track(createBroker(cfg));
	await b.start();
	// surfacing is out-of-band from delivery (the aedes 'publish' event can fire either side of
	// subscriber delivery), so await the inbound event rather than snapshotting after receipt.
	const inbound = new Promise<InboundEvent>((resolve) => {
		b.onInbound((e) => {
			if (e.message.topic === "raw/1") resolve(e);
		});
	});

	const url = `ws://localhost:${cfg.brokerWsPort}`;
	const sub = await connectAsync(url, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
	});
	const pub = await connectAsync(url, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
	});
	sub.on("error", () => {});
	pub.on("error", () => {});
	try {
		const got = new Promise<Buffer>((resolve) =>
			sub.once("message", (_t, payload) => resolve(payload as Buffer)),
		);
		await sub.subscribeAsync("raw/1", { qos: 1 });
		await pub.publishAsync("raw/1", "not json {{", { qos: 1 });
		// delivered raw: the undecodable bytes reach the subscriber unchanged (payload-agnostic broker)
		expect((await got).toString()).toBe("not json {{");
		// surfaced, not crashed: an inbound event with payload undefined + a decodeError
		const ev = await inbound;
		expect(ev.message.payload).toBeUndefined();
		expect(ev.meta.decodeError).toBeDefined();
	} finally {
		await sub.endAsync();
		await pub.endAsync();
	}
});

// [utest->R-009]
test("R-009: wildcard subscribe replays retained state from Aedes' store — matches getState(), excludes evicted, respects +/#", async () => {
	const cfg = ports(5);
	const b = track(createBroker(cfg));
	await b.start();

	// retained state via the broker's own emit path (mock emissions, client === null)
	await b.emit({ topic: "state/a", payload: { v: 1 }, retain: true });
	await b.emit({ topic: "state/b", payload: { v: 2 }, retain: true });
	await b.emit({ topic: "state/deep/x", payload: { v: 3 }, retain: true });
	await b.emit({ topic: "state/b", payload: undefined, retain: true }); // evict b

	const stored = new Set((await b.getState()).keys());
	expect(stored).toEqual(new Set(["state/a", "state/deep/x"]));

	const url = `ws://localhost:${cfg.brokerWsPort}`;
	// state/# replays every retained topic — the SAME set getState() returns (one source of truth, R3)
	expect(await collectRetained(url, "state/#", 2)).toEqual(stored);
	// state/+ is single-segment: state/a only — NOT nested state/deep/x, and evicted state/b stays gone
	expect(await collectRetained(url, "state/+", 1)).toEqual(
		new Set(["state/a"]),
	);
});

// [utest->R-009]
test("R-009 (known limitation — D-006): Aedes' in-memory persistence does not redeliver an unacked QoS-1 message on session resume", async () => {
	const cfg = ports(6);
	const b = track(createBroker(cfg));
	await b.start();
	// ws (like the rest of the suite; DUP/redelivery is transport-agnostic and session resume keys
	// on clientId, not the connection). force-end so no drain wait can wedge teardown.
	const url = `ws://localhost:${cfg.brokerWsPort}`;
	const clientId = "dup-sub";
	const wsOpts = {
		forceNativeWebSocket: true,
		clean: false,
		manualAcks: true,
		reconnectPeriod: 0,
	} as const;

	// PUBACK-suppressing harness (build-plan tier-1): a persistent session with manualAcks receives
	// the QoS-1 message but never PUBACKs, so per MQTT it should stay in-flight and be redelivered
	// with DUP=1 on resume. It is not — see the tripwire below.
	const c1 = await connectAsync(url, { clientId, ...wsOpts });
	c1.on("error", () => {});
	const pub = await connectAsync(url, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
	});
	pub.on("error", () => {});
	try {
		const first = new Promise<{ dup: boolean }>((resolve) =>
			c1.once("message", (_t, _p, packet) => resolve(packet)),
		);
		await c1.subscribeAsync("dup/1", { qos: 1 });
		await pub.publishAsync("dup/1", "hello", { qos: 1 });
		expect((await first).dup).toBe(false); // initial delivery is not a redelivery
		await c1.endAsync(true); // leave it unacked; the session persists (clean: false)

		// Resume the same session. `connect` (not `connectAsync`) so the message handler is attached
		// before CONNACK — no race that could hide a redelivery.
		const c2 = connect(url, { clientId, ...wsOpts });
		c2.on("error", () => {});
		let redelivered: { dup: boolean } | undefined;
		c2.on("message", (_t, _p, packet) => {
			redelivered = packet;
		});
		const ack = await new Promise<{ sessionPresent: boolean }>(
			(resolve, reject) => {
				c2.once("connect", (a) => resolve(a));
				c2.once("error", reject);
			},
		);
		try {
			expect(ack.sessionPresent).toBe(true); // the persistent session IS resumed …
			await delay(400);
			// … but Aedes' default in-memory persistence does NOT redeliver the in-flight QoS-1
			// message, so no DUP arrives. TRIPWIRE (D-006): this pins the known limitation. When the
			// broker gains a redelivering persistence, `redelivered` becomes defined and this flips
			// red — rewire it then to `expect(redelivered?.dup).toBe(true)`.
			expect(redelivered).toBeUndefined();
		} finally {
			await c2.endAsync(true);
		}
	} finally {
		await pub.endAsync(true);
	}
});
