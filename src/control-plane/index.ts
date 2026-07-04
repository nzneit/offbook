import { Hono } from "hono";
import type { BrokerModule } from "../broker/index.ts";
import { createBroker } from "../broker/index.ts";
import { l1Floor } from "../engine/faker.ts";
import type {
	Config,
	Faker,
	SpecRegistry,
	TopicInfo,
	Violation,
} from "../model/index.ts";
import {
	type ValidationLog,
	createValidationLog,
} from "../validation/index.ts";

// D-003: Faker is async — await each faker(c) sequentially (a for-of loop,
// NOT Promise.all) so buildTopicInfo itself must be async too.
export async function buildTopicInfo(
	registry: SpecRegistry,
	faker: Faker,
): Promise<TopicInfo[]> {
	const infos: TopicInfo[] = [];
	for (const c of registry.channels()) {
		// F5: run the discovery example through the L1 floor. A schema-invalid
		// draw or a rejecting faker degrades to an omitted example for that one
		// channel rather than throwing and 500-ing the whole /topics response.
		const floor = await l1Floor(c, faker);
		infos.push({
			topic: c.topic,
			direction: c.direction,
			service: c.service,
			title: c.title,
			description: c.description,
			schema: c.schema,
			example: "payload" in floor ? floor.payload : undefined,
			qos: c.qos,
			retain: c.retain,
		});
	}
	return infos;
}

function envelope(code: string, message: string) {
	return { error: { code, message } };
}

export function createServer(
	config: Config,
	deps: { registry: SpecRegistry; faker: Faker },
) {
	const { registry, faker } = deps;
	const broker = createBroker(config);
	const log = createValidationLog(config);

	// inbound client publishes (from real MQTT clients) → validate + surface, never block
	broker.onInbound((event) =>
		validateClientPublish(
			event.message.topic,
			event.message.payload,
			event.meta.clientId,
			event.meta.decodeError,
		),
	);

	function validateClientPublish(
		topic: string,
		payload: unknown,
		clientId: string,
		decodeError?: string,
	) {
		if (decodeError) {
			log.record({
				origin: "client",
				kind: "decode",
				severity: "error",
				topic,
				detail: `decode: ${decodeError}`,
				payload,
				clientId,
			});
			return;
		}
		const m = registry.match(topic);
		if (!m) {
			log.record({
				origin: "client",
				kind: "unknown-topic",
				severity: "error",
				topic,
				detail: "unknown-topic",
				payload,
				clientId,
			});
			return;
		}
		if (m.channel.direction !== "fromClient") {
			log.record({
				origin: "client",
				kind: "direction",
				severity: "error",
				topic,
				channel: m.channel.topic,
				detail: "direction: client published a toClient topic",
				payload,
				clientId,
			});
			return;
		}
		const errors = m.channel.validate(payload);
		if (errors.length)
			log.record({
				origin: "client",
				kind: "schema",
				severity: "error",
				topic,
				channel: m.channel.topic,
				detail: `${errors[0].instancePath || "/"}: ${errors[0].keyword}`,
				payload,
				clientId,
				errors,
			});
	}

	const app = new Hono();

	app.get("/v1/topics", async (c) =>
		c.json({ topics: await buildTopicInfo(registry, faker) }),
	);

	app.get("/v1/validation", (c) => {
		const sinceSeq = c.req.query("sinceSeq");
		const violations = log.query({
			sinceSeq: sinceSeq === undefined ? undefined : Number(sinceSeq),
			origin: c.req.query("origin") as "client" | "mock" | undefined,
			kind: c.req.query("kind") as Violation["kind"] | undefined,
		});
		return c.json({ violations, summary: log.summary() });
	});

	app.post("/v1/publish", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			topic?: string;
			payload?: unknown;
			example?: boolean;
			qos?: 0 | 1 | 2;
			retain?: boolean;
		};
		if (!body.topic)
			return c.json(envelope("bad-request", "topic is required"), 400);
		if (body.payload !== undefined && body.example)
			return c.json(
				envelope("example-and-payload", "provide payload XOR example"),
				400,
			);

		const sinceSeq = log.baseline();
		const m = registry.match(body.topic);
		let payload: unknown;
		if (body.example) {
			if (!m)
				return c.json(
					envelope(
						"example-on-unknown-topic",
						"cannot generate an example for an unknown topic",
					),
					400,
				);
			// F5: generate through the L1 floor. If the draw fails its Ajv recheck
			// (or the faker rejects), drop-and-surface — record the L1 mock
			// violation and do NOT emit the invalid payload. `injected: false`
			// truthfully reports that nothing reached the broker.
			const floor = await l1Floor(m.channel, faker);
			if ("violation" in floor) {
				log.record(floor.violation);
				return c.json(
					{
						topic: body.topic,
						direction: m.channel.direction,
						matched: true,
						injected: false,
						sinceSeq,
					},
					202,
				);
			}
			payload = floor.payload;
		} else {
			payload = body.payload;
		}
		const qos = body.qos ?? m?.channel.qos ?? 1;
		const retain = body.retain ?? m?.channel.retain ?? false;
		await broker.emit({ topic: body.topic, payload, qos, retain });

		// an HTTP publish re-enters with origin per G9: fromClient/unknown → client; a toClient publish is the mock serving state → mock
		if (!m) {
			log.record({
				origin: "client",
				kind: "unknown-topic",
				severity: "error",
				topic: body.topic,
				detail: "unknown-topic",
				payload,
				clientId: config.injectedClientId,
			});
		} else {
			const errors = m.channel.validate(payload);
			if (errors.length) {
				const origin = m.channel.direction === "toClient" ? "mock" : "client";
				log.record({
					origin,
					kind: "schema",
					severity: "error",
					topic: body.topic,
					channel: m.channel.topic,
					detail: `${errors[0].instancePath || "/"}: ${errors[0].keyword}`,
					payload,
					clientId: origin === "client" ? config.injectedClientId : undefined,
					errors,
				});
			}
		}

		return c.json(
			{
				topic: body.topic,
				direction: m ? m.channel.direction : null,
				matched: !!m,
				injected: true,
				sinceSeq,
			},
			202,
		);
	});

	let httpServer: { stop(): void } | undefined;
	return {
		app,
		broker,
		log,
		async start() {
			await broker.start();
			httpServer = Bun.serve({
				port: config.controlPlanePort,
				fetch: app.fetch,
			});
		},
		async stop() {
			httpServer?.stop();
			await broker.stop();
		},
	};
}

export type Server = ReturnType<typeof createServer>;
export type { BrokerModule, ValidationLog };
