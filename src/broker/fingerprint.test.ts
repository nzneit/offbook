// R-033 — connect fingerprint + ws-fidelity listener behavior (docs/specs/demo-app.md §3).
// [itest->R-033]
import { afterAll, beforeAll, expect, test } from "bun:test";
import { MqttClient, connectAsync as mqttConnectAsync } from "mqtt";
import tcpStreamBuilder from "mqtt/lib/connect/tcp";
import { loadConfig } from "#src/config/index.ts";
import type { InboundEvent } from "#src/model/index.ts";
import type { BrokerModule, FingerprintEvent } from "./index.ts";
import { createBroker, fingerprintLine } from "./index.ts";

// ports unique to this file: ws 19100 / tcp 12990
const WS = 19100;
const TCP = 12990;

// mqtt.js's `connect()` memoizes its protocol->streamBuilder table in a
// module-level variable, computed once, on the FIRST connect()/connectAsync()
// call anywhere in the process — gated on THAT call's `forceNativeWebSocket`
// option, not each call's own. `bun test` runs the whole suite in one
// process, and this file's own ws tests (which must pass
// `forceNativeWebSocket: true` — Bun's "ws" stand-in makes the non-native
// path throw, see index.ts) run first, so by the time this file's tcp test
// runs, the table was already built without a `mqtt`/tcp builder at all —
// verified by hand: a later plain `mqtt://` connect() silently coerces
// `opts.protocol` to `"ws"` and fails a WS handshake against a raw TCP port.
// Sidestep the poisoned shared table for the tcp case only: drive the same
// `MqttClient` class with the real tcp stream builder directly (this is
// exactly what `connect()` does internally, minus the cache lookup).
type ConnectOptions = NonNullable<Parameters<typeof mqttConnectAsync>[1]>;
function tcpConnectAsync(
	url: string,
	opts: ConnectOptions,
): Promise<MqttClient> {
	const { hostname, port } = new URL(url);
	const fullOpts: ConnectOptions = { ...opts, hostname, port: Number(port) };
	return new Promise((resolve, reject) => {
		const client = new MqttClient(
			(c) => tcpStreamBuilder(c, fullOpts),
			fullOpts,
		);
		client.once("connect", () => resolve(client));
		client.once("error", (err) => reject(err));
	});
}
function connectAsync(url: string, opts: ConnectOptions): Promise<MqttClient> {
	return url.startsWith("mqtt://")
		? tcpConnectAsync(url, opts)
		: mqttConnectAsync(url, opts);
}

let broker: BrokerModule;
const events: FingerprintEvent[] = [];

beforeAll(async () => {
	broker = createBroker(
		loadConfig({
			brokerWsPort: WS,
			brokerTcpPort: TCP,
			controlPlanePort: 19898,
		}),
	);
	broker.onFingerprint((e) => events.push(e));
	await broker.start();
});
afterAll(async () => {
	await broker.stop();
});

test("the 101 echoes the first offered subprotocol — a real browser requires this", async () => {
	const ws = new WebSocket(`ws://localhost:${WS}`, ["mqtt", "mqttv3.1"]);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`));
	});
	expect(ws.protocol).toBe("mqtt");
	ws.close();
});

test("a ws CONNECT emits a correlated connect fingerprint — password as presence only", async () => {
	const client = await connectAsync(`ws://localhost:${WS}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		protocolVersion: 4,
		clientId: "fp-ws-1",
		username: "alice",
		password: "s3cret-value",
		keepalive: 30,
		clean: true,
	});
	const connect = events.find(
		(e) => e.kind === "connect" && e.clientId === "fp-ws-1",
	);
	expect(connect).toMatchObject({
		protocolLevel: 4,
		username: "alice",
		passwordPresent: true,
		keepalive: 30,
		clean: true,
	});
	// correlation: the upgrade facts rode along
	expect(connect?.ws?.path).toBe("/");
	expect(connect?.ws?.subprotocolsOffered).toContain("mqtt");
	expect(connect?.ws?.subprotocolSelected).toBe("mqtt");
	// the redaction bar: the secret appears NOWHERE in any event
	expect(JSON.stringify(events)).not.toContain("s3cret-value");
	await client.endAsync();
});

test("a tcp CONNECT emits a fingerprint with no ws block", async () => {
	const client = await connectAsync(`mqtt://localhost:${TCP}`, {
		reconnectPeriod: 0,
		clientId: "fp-tcp-1",
	});
	const connect = events.find(
		(e) => e.kind === "connect" && e.clientId === "fp-tcp-1",
	);
	expect(connect).toBeDefined();
	expect(connect?.ws).toBeUndefined();
	expect(connect?.passwordPresent).toBe(false);
	await client.endAsync();
});

// The tcp listener is bare node:net (D-024, replacing `aedes-server-factory`);
// the CONNECT test above only proves the handshake, so this one proves data
// flows through it in both directions.
test("the tcp listener round-trips data: a tcp publish reaches onInbound, an emit reaches a tcp subscriber", async () => {
	const inbound: InboundEvent[] = [];
	broker.onInbound((e) => inbound.push(e));
	const client = await connectAsync(`mqtt://localhost:${TCP}`, {
		reconnectPeriod: 0,
		clientId: "fp-tcp-rt",
	});
	const got = new Promise<string>((resolve) =>
		client.on("message", (topic, payload) =>
			resolve(`${topic} ${payload.toString()}`),
		),
	);
	await client.subscribeAsync("state/tcp-rt", { qos: 1 });
	await client.publishAsync("command/tcp-rt", JSON.stringify({ n: 7 }), {
		qos: 1,
	});
	await broker.emit({ topic: "state/tcp-rt", payload: { ok: true }, qos: 1 });
	expect(await got).toBe('state/tcp-rt {"ok":true}');
	const seen = inbound.find((e) => e.message.topic === "command/tcp-rt");
	expect(seen?.message.payload).toEqual({ n: 7 });
	expect(seen?.message.qos).toBe(1);
	await client.endAsync();
});

test("subscribe observations dedupe per clientId·topic·qos; publish per clientId·qos·retain", async () => {
	const client = await connectAsync(`ws://localhost:${WS}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		clientId: "fp-obs-1",
	});
	await client.subscribeAsync("state/#", { qos: 1 });
	await client.subscribeAsync("state/#", { qos: 1 }); // repeat — no new event
	await client.subscribeAsync("state/#", { qos: 2 }); // new qos — new event
	await client.publishAsync("command/t/set", "{}", { qos: 1 });
	await client.publishAsync("command/t/set", "{}", { qos: 1 }); // repeat class
	await client.publishAsync("command/t/set", "{}", { qos: 1, retain: true }); // new class

	const subs = events.filter(
		(e) => e.kind === "subscribe" && e.clientId === "fp-obs-1",
	);
	expect(subs.map((s) => ({ topic: s.topic, qos: s.qos }))).toEqual([
		{ topic: "state/#", qos: 1 },
		{ topic: "state/#", qos: 2 },
	]);
	const pubs = events.filter(
		(e) => e.kind === "publish" && e.clientId === "fp-obs-1",
	);
	expect(pubs.map((p) => ({ qos: p.qos, retain: p.retain }))).toEqual([
		{ qos: 1, retain: false },
		{ qos: 1, retain: true },
	]);
	await client.endAsync();
});

test("dedup keys cannot collide across distinct clientId/topic triples", async () => {
	const a = await connectAsync(`ws://localhost:${WS}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		clientId: "dev",
	});
	await a.subscribeAsync("cmd 1", { qos: 2 });
	const b = await connectAsync(`ws://localhost:${WS}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		clientId: "dev cmd",
	});
	await b.subscribeAsync("1", { qos: 2 });
	const subs = events.filter(
		(e) =>
			e.kind === "subscribe" &&
			(e.clientId === "dev" || e.clientId === "dev cmd"),
	);
	expect(subs.map((s) => ({ clientId: s.clientId, topic: s.topic }))).toEqual([
		{ clientId: "dev", topic: "cmd 1" },
		{ clientId: "dev cmd", topic: "1" },
	]);
	await a.endAsync();
	await b.endAsync();
});

test("fingerprintLine renders one greppable single-line-JSON entry per event", () => {
	expect(
		fingerprintLine({
			kind: "connect",
			clientId: "a",
			protocolLevel: 4,
			passwordPresent: false,
			ws: {
				path: "/",
				subprotocolsOffered: ["mqtt"],
				subprotocolSelected: "mqtt",
				origin: undefined,
				userAgent: undefined,
			},
		}),
	).toBe(
		'ws-connect {"clientId":"a","protocolLevel":4,"passwordPresent":false,"ws":{"path":"/","subprotocolsOffered":["mqtt"],"subprotocolSelected":"mqtt"}}',
	);
	expect(
		fingerprintLine({ kind: "connect", clientId: "b", passwordPresent: false }),
	).toStartWith("tcp-connect {");
	expect(
		fingerprintLine({
			kind: "subscribe",
			clientId: "a",
			topic: "state/#",
			qos: 1,
		}),
	).toBe('mqtt-subscribe {"clientId":"a","topic":"state/#","qos":1}');
	expect(
		fingerprintLine({ kind: "publish", clientId: "a", qos: 2, retain: false }),
	).toBe('mqtt-publish {"clientId":"a","qos":2,"retain":false}');
});
