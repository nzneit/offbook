// R-033 — connect fingerprint + ws-fidelity listener behavior (docs/specs/demo-app.md §3).
// [itest->R-033]
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BrokerModule } from "#src/broker/index.ts";
import { createBroker } from "#src/broker/index.ts";
import { loadConfig } from "#src/config/index.ts";

// ports unique to this file: ws 19100 / tcp 12990
const WS = 19100;
const TCP = 12990;

let broker: BrokerModule;

beforeAll(async () => {
	broker = createBroker(
		loadConfig({
			brokerWsPort: WS,
			brokerTcpPort: TCP,
			controlPlanePort: 19898,
		}),
	);
	// broker.onFingerprint((e) => events.push(e)); // added in Task 2
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
