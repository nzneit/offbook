import mqtt from "mqtt";

export function makeClientId(): string {
	return `demo-app-${Math.random().toString(36).slice(2, 8)}`;
}

// A raw probe BEFORE mqtt.js connects: mqtt.js hides its socket, and the
// R-006 checklist wants the upgrade + negotiated subprotocol observed
// directly (docs/specs/demo-app.md §6). Sends no CONNECT — leaves no
// fingerprint line.
export function probeWs(
	url: string,
): Promise<{ ok: boolean; subprotocolSelected?: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (r: { ok: boolean; subprotocolSelected?: string }) => {
			if (settled) return;
			settled = true;
			try {
				ws.close();
			} catch {
				/* already closed */
			}
			resolve(r);
		};
		const ws = new WebSocket(url, ["mqtt"]);
		ws.onopen = () =>
			done({ ok: true, subprotocolSelected: ws.protocol || undefined });
		ws.onerror = () => done({ ok: false });
		setTimeout(() => done({ ok: false }), 3000);
	});
}

export interface ConnectOptions {
	wsUrl: string;
	clientId: string;
}

export function connectClient({ wsUrl, clientId }: ConnectOptions) {
	return mqtt.connect(wsUrl, {
		protocolVersion: 4, // MQTT 3.1.1 — the only level offbook speaks
		clientId,
		keepalive: 60,
		clean: true,
		reconnectPeriod: 2000, // visible in the checklist's reconnect counter
	});
}
