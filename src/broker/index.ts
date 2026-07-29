import { Duplex } from "node:stream";
import Aedes from "aedes";
import { createServer } from "aedes-server-factory";
import type { ServerWebSocket } from "bun";
import type {
	Config,
	InboundEvent,
	NormalizedMessage,
} from "#src/model/index.ts";

export interface BrokerModule {
	start(): Promise<void>;
	stop(): Promise<void>;
	onInbound(handler: (event: InboundEvent) => void): void;
	onSubscribe(
		handler: (sub: { topic: string; clientId: string }) => void,
	): void;
	onFingerprint(handler: (e: FingerprintEvent) => void): void;
	emit(message: NormalizedMessage): Promise<void>;
	getState(): Promise<ReadonlyMap<string, NormalizedMessage>>;
}

// R-033 — the connect fingerprint: ws upgrade facts (when present) correlated
// with the CONNECT packet's own facts. Password is presence-only, never the
// value itself — the redaction bar (fixtures/asyncapi's fixture-quality bar
// applies here too: this is a security-relevant fact, not just a shape).
export interface FingerprintEvent {
	kind: "connect";
	clientId: string;
	protocolLevel: number | undefined;
	username: string | undefined;
	passwordPresent: boolean;
	keepalive: number | undefined;
	clean: boolean | undefined;
	ws: WsFacts | undefined;
}

// `aedes`'s .d.ts doesn't type the `persistence` property (it's typed `any`
// in AedesOptions but not surfaced on the class), even though it's a real
// runtime property (aedes.js: `this.persistence = opts.persistence || memory()`).
// Narrow just the bit of surface we use.
interface RetainedPacket {
	topic: string;
	payload: Buffer;
	qos: 0 | 1 | 2;
	retain: boolean;
}
interface AedesWithPersistence extends Aedes {
	persistence: {
		createRetainedStream(pattern: string): NodeJS.ReadableStream;
	};
}

// --- ws listener -----------------------------------------------------------
//
// `aedes-server-factory`'s `{ ws: true }` listener (and mqtt.js's default,
// non-browser ws transport) both wrap the connection into a Node Duplex via
// the "ws" package's `createWebSocketStream`. Under Bun this doesn't work,
// for two independent reasons found by hands-on testing:
//
//  1. Bun ships a built-in stand-in for the bare "ws" specifier (both
//     `require("ws")` and `import ... from "ws"` resolve to it, unconditionally,
//     even with a real "ws" installed) whose `createWebSocketStream` is an
//     unimplemented stub that throws `"Not supported yet in Bun"`.
//  2. Even routing around that (resolving the real "ws" package via a
//     sub-path, which isn't virtualized, and driving it through a plain
//     `node:http` server) doesn't fix it: a real "ws" `WebSocketServer`
//     attached to a Bun `node:http` server fires its `connection` event, but
//     the 101 handshake response bytes never actually reach the client socket
//     (verified with a raw TCP client: connection accepted server-side, zero
//     response bytes seen client-side, hang). That's a Bun `node:http`
//     upgrade-handling gap, not a library-call mismatch.
//
// `Bun.serve()`'s own first-class WebSocket support (a totally different code
// path, not layered on `node:http` upgrade emulation) doesn't have either
// problem (verified the same way). So the ws listener is hand-built on top of
// it: each opened connection gets a small Duplex bridge that aedes can
// `.handle()` exactly like a raw TCP socket, translating `_write`/incoming
// `message`s to/from `ServerWebSocket.sendBinary`/`Duplex.push`.
interface WsListener {
	listen(port: number, cb: () => void): void;
	close(cb: () => void): void;
}

// The upgrade facts captured off the raw HTTP request at handshake time — the
// R-033 connect-fingerprint's ws-layer half (CONNECT-packet facts are the
// other half, captured downstream of aedes' own "client" event). Keyed into
// `factsOut` by the bridge Duplex so the CONNECT-handling code (Task 2) can
// correlate a packet back to the connection it arrived on.
export interface WsFacts {
	path: string;
	subprotocolsOffered: string[];
	subprotocolSelected: string | undefined;
	origin: string | undefined;
	userAgent: string | undefined;
}

function createWsListener(
	aedes: Aedes,
	factsOut: WeakMap<object, WsFacts>,
): WsListener {
	const duplexes = new WeakMap<ServerWebSocket<WsFacts>, Duplex>();
	let server: ReturnType<typeof Bun.serve<WsFacts>> | undefined;

	return {
		listen(port, cb) {
			server = Bun.serve<WsFacts>({
				port,
				fetch(req, srv) {
					const offeredHeader = req.headers.get("sec-websocket-protocol");
					const offered = offeredHeader
						? offeredHeader
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean)
						: [];
					// A real browser DROPS the connection if its requested subprotocol
					// isn't echoed on the 101 (mqtt.js always requests "mqtt") — verified
					// by hand that Bun's own `srv.upgrade()` already echoes the first
					// offered subprotocol unassisted, so there's no header to set here;
					// this just records which one that was.
					const data: WsFacts = {
						path: new URL(req.url).pathname,
						subprotocolsOffered: offered,
						subprotocolSelected: offered[0],
						origin: req.headers.get("origin") ?? undefined,
						userAgent: req.headers.get("user-agent") ?? undefined,
					};
					if (srv.upgrade(req, { data })) return undefined;
					return new Response("Upgrade required", { status: 426 });
				},
				websocket: {
					open(ws) {
						let wsClosed = false;
						const closeWs = () => {
							if (wsClosed) return;
							wsClosed = true;
							// Deferred a tick: calling `ws.close()` synchronously/reentrantly
							// from inside a duplex "close"/"error" event — which can itself
							// fire synchronously from within Bun's own `message` callback,
							// e.g. while aedes processes a DISCONNECT or a malformed packet
							// — was observed by hand to leave the connection in a state
							// where Bun's `server.stop()` never resolves. Deferring one
							// tick avoids it.
							setImmediate(() => {
								try {
									ws.close();
								} catch {
									// already closed
								}
							});
						};
						const duplex = new Duplex({
							read() {
								/* pushed externally from the `message` handler below */
							},
							write(chunk: Buffer, _encoding, callback) {
								ws.sendBinary(chunk);
								callback();
							},
							final(callback) {
								closeWs();
								callback();
							},
						});
						// A malformed packet makes aedes `destroy(err)` the stream, which
						// emits "error" (not just "close"/"final") — without a listener,
						// that's an uncaught error that can crash the whole process.
						duplex.on("error", () => closeWs());
						// `destroy()` (e.g. a clientId-takeover/abort) skips `_final` and
						// goes straight to "close", so the ws must be torn down there too;
						// `closeWs` is idempotent so this is safe alongside the `_final`
						// path above.
						duplex.on("close", () => closeWs());
						duplexes.set(ws, duplex);
						// keyed by the bridge Duplex, not the ServerWebSocket, so Task 2's
						// CONNECT-handling code (which only sees the aedes `client`/stream
						// side) can look these facts back up.
						factsOut.set(duplex, ws.data);
						aedes.handle(duplex);
					},
					message(ws, message) {
						duplexes
							.get(ws)
							?.push(
								typeof message === "string" ? Buffer.from(message) : message,
							);
					},
					close(ws) {
						duplexes.get(ws)?.push(null);
						duplexes.delete(ws);
					},
				},
			});
			cb();
		},
		close(cb) {
			if (!server) return cb();
			// `server.stop()`'s promise can hang forever once this listener's
			// bridge has force-closed a `ServerWebSocket` from the server side
			// (the `closeWs` path above, needed for FIX2's error/close teardown)
			// — confirmed against a minimal `Bun.serve` repro with no aedes/mqtt
			// involved at all, so this is a Bun runtime quirk, not something
			// fixable from inside the bridge. Race it against a short grace
			// period so one poisoned connection can't wedge the whole shutdown;
			// `server.stop(true)` has already force-closed every connection it
			// can see well before this timeout would ever fire.
			let settled = false;
			const settle = () => {
				if (settled) return;
				settled = true;
				cb();
			};
			server.stop(true).then(settle);
			setTimeout(settle, 500);
		},
	};
}

function decode(buf: Buffer): { payload: unknown; decodeError?: string } {
	const text = buf.toString("utf8");
	if (text === "") return { payload: undefined };
	try {
		return { payload: JSON.parse(text) };
	} catch (e) {
		return { payload: undefined, decodeError: (e as Error).message };
	}
}

export function createBroker(config: Config): BrokerModule {
	// consumed by the CONNECT-handling code below to correlate a packet's
	// client-facing facts back to the ws upgrade it arrived on
	const wsFacts = new WeakMap<object, WsFacts>();
	const fingerprints: Array<(e: FingerprintEvent) => void> = [];
	const emitFingerprint = (e: FingerprintEvent) => {
		for (const h of fingerprints) h(e);
	};
	// narrow view of the CONNECT packet — no mqtt-packet type import needed
	interface ConnectFacts {
		clientId: string;
		protocolVersion?: number;
		keepalive?: number;
		clean?: boolean;
		username?: string;
		password?: unknown;
	}
	const aedes = new Aedes({
		preConnect: (client, packet, done) => {
			const p = packet as unknown as ConnectFacts;
			const conn = (client as unknown as { conn: object }).conn;
			emitFingerprint({
				kind: "connect",
				clientId: p.clientId,
				protocolLevel: p.protocolVersion,
				username: typeof p.username === "string" ? p.username : undefined,
				passwordPresent: p.password !== undefined && p.password !== null,
				keepalive: p.keepalive,
				clean: p.clean,
				ws: wsFacts.get(conn), // undefined for tcp — that IS the signal
			});
			done(null, true); // accept-all auth (design §8) is unchanged
		},
	}) as AedesWithPersistence;
	const wsServer = createWsListener(aedes, wsFacts);
	const tcpServer = createServer(aedes);
	let seq = 0;
	const inbound: Array<(e: InboundEvent) => void> = [];
	const subs: Array<(s: { topic: string; clientId: string }) => void> = [];

	aedes.on("publish", (packet, client) => {
		if (!client) return; // ignore our own emits (client === null)
		const { payload, decodeError } = decode(packet.payload as Buffer);
		const event: InboundEvent = {
			message: {
				topic: packet.topic,
				payload,
				qos: packet.qos,
				retain: packet.retain,
			},
			meta: {
				clientId: client.id,
				seq: seq++,
				receivedAt: Date.now(),
				decodeError,
			},
		};
		for (const h of inbound) h(event);
	});
	aedes.on("subscribe", (subscriptions, client) => {
		for (const s of subscriptions)
			for (const h of subs) h({ topic: s.topic, clientId: client?.id ?? "" });
	});

	return {
		start: () =>
			Promise.all([
				new Promise<void>((resolve) =>
					wsServer.listen(config.brokerWsPort, () => resolve()),
				),
				new Promise<void>((resolve) =>
					tcpServer.listen(config.brokerTcpPort, () => resolve()),
				),
			]).then(() => undefined),
		stop: () =>
			Promise.all([
				new Promise<void>((resolve) => wsServer.close(() => resolve())),
				new Promise<void>((resolve) => tcpServer.close(() => resolve())),
				new Promise<void>((resolve) => aedes.close(() => resolve())),
			]).then(() => undefined),
		onInbound: (h) => {
			inbound.push(h);
		},
		onSubscribe: (h) => {
			subs.push(h);
		},
		onFingerprint: (h) => {
			fingerprints.push(h);
		},
		emit: (m) =>
			new Promise<void>((resolve, reject) => {
				const payload =
					m.payload === undefined
						? Buffer.alloc(0)
						: Buffer.from(JSON.stringify(m.payload));
				aedes.publish(
					{
						cmd: "publish",
						topic: m.topic,
						payload,
						qos: m.qos ?? 1,
						retain: m.retain ?? false,
						dup: false,
					},
					(err) => (err ? reject(err) : resolve()),
				);
			}),
		getState: () =>
			new Promise((resolve) => {
				const map = new Map<string, NormalizedMessage>();
				const stream = aedes.persistence.createRetainedStream("#");
				stream.on("data", (p: RetainedPacket) => {
					if (!p.payload || p.payload.length === 0) return;
					const { payload, decodeError } = decode(p.payload);
					if (decodeError !== undefined) return; // non-decodable retained ⇒ no StateEntry (§2/§5)
					map.set(p.topic, {
						topic: p.topic,
						payload,
						qos: p.qos,
						retain: true,
					});
				});
				stream.on("end", () => resolve(map));
			}),
	};
}
