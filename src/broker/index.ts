import { Duplex } from "node:stream";
import Aedes from "aedes";
import { createServer } from "aedes-server-factory";
import type { ServerWebSocket } from "bun";
import type {
	Config,
	InboundEvent,
	NormalizedMessage,
} from "../model/index.ts";

export interface BrokerModule {
	start(): Promise<void>;
	stop(): Promise<void>;
	onInbound(handler: (event: InboundEvent) => void): void;
	onSubscribe(
		handler: (sub: { topic: string; clientId: string }) => void,
	): void;
	emit(message: NormalizedMessage): Promise<void>;
	getState(): Promise<ReadonlyMap<string, NormalizedMessage>>;
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

function createWsListener(aedes: Aedes): WsListener {
	const duplexes = new WeakMap<ServerWebSocket<undefined>, Duplex>();
	let server: ReturnType<typeof Bun.serve<undefined>> | undefined;

	return {
		listen(port, cb) {
			server = Bun.serve<undefined>({
				port,
				fetch(req, srv) {
					if (srv.upgrade(req)) return undefined;
					return new Response("Upgrade required", { status: 426 });
				},
				websocket: {
					open(ws) {
						const duplex = new Duplex({
							read() {
								/* pushed externally from the `message` handler below */
							},
							write(chunk: Buffer, _encoding, callback) {
								ws.sendBinary(chunk);
								callback();
							},
							final(callback) {
								try {
									ws.close();
								} catch {
									// already closed
								}
								callback();
							},
						});
						duplexes.set(ws, duplex);
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
			server.stop(true).then(() => cb());
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
	const aedes = new Aedes() as AedesWithPersistence;
	const wsServer = createWsListener(aedes);
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
					if (p.payload && p.payload.length > 0) {
						map.set(p.topic, {
							topic: p.topic,
							payload: decode(p.payload).payload,
							qos: p.qos,
							retain: true,
						});
					}
				});
				stream.on("end", () => resolve(map));
			}),
	};
}
