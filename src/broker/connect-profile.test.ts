// R-006/R-007 — the closed spikes' in-repo pin (D-026). The authoritative runs
// were the real browser application against this broker's defaults; the
// published capture is fixtures/connect/real-client.json, and this file keeps
// the closure honest in both directions. The fixture must stay internally
// consistent (redacted / not-captured fields stay null; no auth; no QoS 2),
// and the broker must keep accepting the measured profile: MQTT 3.1.1
// (level 4) over ws, no auth, a non-root path (the real one is private — the
// listener must not care), retained receipt on subscribe, a persistent
// session at keepalive 30, QoS 0/1 both ways.
// [itest->R-006]
// [itest->R-007]
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectAsync } from "mqtt";
import { loadConfig } from "#src/config/index.ts";
import { DEFAULT_CONFIG, type InboundEvent } from "#src/model/index.ts";
import type { BrokerModule, FingerprintEvent } from "./index.ts";
import { createBroker } from "./index.ts";

// ports unique to this file: ws 19200 / tcp 12950
const WS = 19200;
const TCP = 12950;

// A stand-in for the real, undisclosed ws path: any non-root path proves the
// property that makes the redaction affordable — the listener upgrades every
// path and records it only as a fingerprint fact, never routes on it.
const PATH_STAND_IN = "/an/undisclosed/path";

interface ConnectProfile {
	capturedAt: string;
	source: string;
	wsUrl: string | null;
	path: string | null;
	subprotocol: string | null;
	protocolLevel: number;
	clientIdPattern: string | null;
	auth: { username: string | null; passwordPresent: boolean };
	keepalive: number | null;
	clean: boolean | null;
	qosUsed: number[];
	retainUsed: boolean | null;
	redacted: string[];
	notCaptured: string[];
	provenance: string;
}

let profile: ConnectProfile;
let broker: BrokerModule;
const events: FingerprintEvent[] = [];
const inbound: InboundEvent[] = [];

beforeAll(async () => {
	profile = (await Bun.file(
		`${import.meta.dir}/../../fixtures/connect/real-client.json`,
	).json()) as ConnectProfile;
	broker = createBroker(
		loadConfig({
			brokerWsPort: WS,
			brokerTcpPort: TCP,
			controlPlanePort: 19201,
		}),
	);
	broker.onFingerprint((e) => events.push(e));
	broker.onInbound((e) => inbound.push(e));
	await broker.start();
	// retained state the profile connection must receive on subscribe
	await broker.emit({
		topic: "state/profile-pin",
		payload: { ok: true },
		qos: 1,
		retain: true,
	});
});
afterAll(async () => {
	await broker.stop();
});

test("the fixture is internally consistent and carries exactly the disclosed facts", () => {
	// the redactions are enforced, not just described: every field the capture
	// marks redacted or not-captured must actually be null
	for (const key of [...profile.redacted, ...profile.notCaptured]) {
		expect((profile as unknown as Record<string, unknown>)[key]).toBeNull();
	}
	expect(profile.source).toBe("real-client");
	// the published facts (D-026): MQTT 3.1.1, no auth, QoS 0/1 only, a
	// persistent session at keepalive 30
	expect(profile.protocolLevel).toBe(4);
	expect(profile.auth).toEqual({ username: null, passwordPresent: false });
	expect([...profile.qosUsed].sort()).toEqual([0, 1]); // no QoS 2 use — R-007's open question, answered
	expect(profile.keepalive).toBe(30);
	expect(profile.clean).toBe(false);
});

test("the broker accepts the measured profile: level 4, no auth, non-root path — connect, SUBACK, retained receipt", async () => {
	expect(profile.redacted).toContain("path"); // the stand-in path below exists because of this redaction
	const client = await connectAsync(`ws://localhost:${WS}${PATH_STAND_IN}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		// = profile.protocolLevel, pinned to 4 in the fixture test above
		protocolVersion: profile.protocolLevel as 4,
		clientId: "profile-pin-1",
		// the captured session shape: keepalive 30, persistent session — the ??
		// arms are unreachable while the fixture test pins both values non-null
		keepalive: profile.keepalive ?? undefined,
		clean: profile.clean ?? undefined,
		// no username/password — the profile's auth block says none were sent
	});
	const retained = new Promise<{
		topic: string;
		body: string;
		retain: boolean;
	}>((resolve) =>
		client.on("message", (topic, payload, packet) =>
			resolve({ topic, body: payload.toString(), retain: packet.retain }),
		),
	);
	const granted = await client.subscribeAsync("state/profile-pin", { qos: 1 });
	expect(granted[0]?.qos).toBe(1);
	expect(await retained).toEqual({
		topic: "state/profile-pin",
		body: '{"ok":true}',
		retain: true,
	});
	// the server-side view matches the profile, and the path rode along as a
	// recorded fact — proving the listener accepted it without routing on it
	const connect = events.find(
		(e) => e.kind === "connect" && e.clientId === "profile-pin-1",
	);
	expect(connect).toMatchObject({
		protocolLevel: 4,
		passwordPresent: false,
		keepalive: 30, // = profile.keepalive
		clean: false, // = profile.clean
	});
	expect(connect?.username).toBeUndefined();
	expect(connect?.ws?.path).toBe(PATH_STAND_IN);
	await client.endAsync();
});

test("both measured QoS classes round-trip: subscribe grants them, publishes reach onInbound at them", async () => {
	const client = await connectAsync(`ws://localhost:${WS}${PATH_STAND_IN}`, {
		forceNativeWebSocket: true,
		reconnectPeriod: 0,
		protocolVersion: profile.protocolLevel as 4,
		clientId: "profile-pin-2",
	});
	for (const qos of profile.qosUsed as (0 | 1)[]) {
		const granted = await client.subscribeAsync(`state/profile-pin/${qos}`, {
			qos,
		});
		expect(granted[0]?.qos).toBe(qos);
		await client.publishAsync(
			`command/profile-pin/${qos}`,
			JSON.stringify({ qos }),
			{ qos },
		);
	}
	// QoS 0 has no ack to await, so poll for both inbound events
	const mine = () =>
		inbound.filter((e) => e.message.topic.startsWith("command/profile-pin/"));
	const deadline = Date.now() + 2000;
	while (mine().length < profile.qosUsed.length && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 10));
	}
	for (const qos of profile.qosUsed as (0 | 1)[]) {
		const seen = mine().find(
			(e) => e.message.topic === `command/profile-pin/${qos}`,
		);
		expect(seen?.message.payload).toEqual({ qos });
		expect(seen?.message.qos).toBe(qos);
	}
	await client.endAsync();
});

test("R-007's port-default artifact, as narrowed by D-026: the public default stays 9001", () => {
	// the real target is redacted, so it lives in a local brokerWsPort
	// override — the public default deliberately did not move
	expect(profile.redacted).toContain("wsUrl");
	expect(DEFAULT_CONFIG.brokerWsPort).toBe(9001);
});
