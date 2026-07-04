import { Parser } from "@asyncapi/parser";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020";
import { exec, matches } from "mqtt-pattern";
import type {
	Channel,
	Config,
	SchemaError,
	SpecRegistry,
} from "../model/index.ts";

const parser = new Parser();

// mqtt-pattern captures with +name, not {name}; rewrite each single-segment {p} to +p.
function toPattern(address: string): string {
	return address.replace(/\{([^/}]+)\}/g, "+$1");
}

function directionOf(action: string): "toClient" | "fromClient" {
	// v3: send→toClient, receive→fromClient.
	return action === "send" ? "toClient" : "fromClient";
}

export async function buildRegistry(opts: {
	specText: string;
	service: string;
	config: Config;
}): Promise<SpecRegistry> {
	const { document } = await parser.parse(opts.specText);
	if (!document) throw new Error("failed to parse spec");
	const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));

	const channels: Channel[] = [];
	for (const op of document.operations().all()) {
		const ch = op.channels().all()[0];
		const address = ch.address() ?? "";
		const msg = op.messages().all()[0];
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			...((msg?.payload()?.json() ?? {}) as object),
		};
		const validateFn = ajv.compile(schema);
		const mqtt = op.bindings().get("mqtt")?.value<{
			qos?: 0 | 1 | 2;
			retain?: boolean;
		}>();
		channels.push({
			topic: address,
			direction: directionOf(op.action()),
			service: opts.service,
			schema,
			validate: (payload: unknown): SchemaError[] =>
				validateFn(payload) ? [] : ((validateFn.errors ?? []) as SchemaError[]),
			qos: mqtt?.qos ?? 1,
			retain: mqtt?.retain ?? false,
			title: msg?.title() ?? undefined,
			description: ch.description() ?? msg?.description() ?? undefined,
		});
	}

	// most-specific first (fewer params = more literal segments), then declaration order
	const ordered = channels
		.map((c, i) => ({ c, i }))
		.sort((a, b) => {
			const pa = (a.c.topic.match(/\{/g) ?? []).length;
			const pb = (b.c.topic.match(/\{/g) ?? []).length;
			return pa - pb || a.i - b.i;
		});

	return {
		channels: () => channels,
		matchesFilter: (filter, topic) => matches(filter, topic),
		match: (topic) => {
			for (const { c } of ordered) {
				const params = exec(toPattern(c.topic), topic);
				if (params)
					return { channel: c, params: params as Record<string, string> };
			}
			return undefined;
		},
	};
}
