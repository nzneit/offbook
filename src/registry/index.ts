import { Parser } from "@asyncapi/parser";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020";
import { exec, matches } from "mqtt-pattern";
import type {
	Channel,
	Config,
	SchemaError,
	ServiceConfig,
	SpecRegistry,
} from "#src/model/index.ts";
import {
	SUPPORTED_SPEC_VERSIONS,
	isSupportedSpecVersion,
	readSpecVersion,
} from "#src/model/spec-version.ts";

const parser = new Parser();

// mqtt-pattern captures with +name, not {name}; rewrite each single-segment {p} to +p.
function toPattern(address: string): string {
	return address.replace(/\{([^/}]+)\}/g, "+$1");
}

function directionOf(action: string): "toClient" | "fromClient" {
	// v3: send→toClient, receive→fromClient. v2: subscribe→toClient, publish→fromClient
	// (publish = the client publishes and the service receives ⇒ fromClient).
	return action === "send" || action === "subscribe"
		? "toClient"
		: "fromClient";
}

export async function buildRegistry(opts: {
	specText: string;
	service: string;
	config: Config;
	// qos/retain tiers 2-3 (topicOverrides / qosDefault / retainDefault); absent ⇒ spec binding + global only
	serviceConfig?: ServiceConfig;
	// base path/URI so the parser can resolve external $refs (e.g. shared/common.yaml); omit for self-contained specs
	source?: string;
}): Promise<SpecRegistry> {
	// R-037 preflight: check the declared version BEFORE handing the document to
	// the parser. The parser's own gate is derived from @asyncapi/specs at
	// install time, so an unsupported-but-present version can pass it and then
	// fail deep in the Spectral ruleset with an opaque "Error running Nimma".
	// Offbook's supported set is a promise it tests, so it is checked here (D-018).
	const specVersion = readSpecVersion(opts.specText);
	if (!isSupportedSpecVersion(specVersion)) {
		throw new Error(
			`unsupported AsyncAPI version ${
				specVersion === undefined
					? "(no `asyncapi` field found)"
					: `"${specVersion}"`
			} in service '${opts.service}': offbook supports ${SUPPORTED_SPEC_VERSIONS[0]} through ${
				SUPPORTED_SPEC_VERSIONS[SUPPORTED_SPEC_VERSIONS.length - 1]
			}. Convert the spec first: \`asyncapi convert <file> --target-version 3.1.0\``,
		);
	}
	const parsed = opts.source
		? await parser.parse(opts.specText, { source: opts.source })
		: await parser.parse(opts.specText);
	const { document } = parsed;
	if (!document) {
		const errs = parsed.diagnostics
			.filter((d) => d.severity === 0)
			.map((d) => d.message);
		throw new Error(`failed to parse spec: ${errs.join("; ")}`);
	}
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
		// §2 precedence, resolved per-field: spec MQTT binding → topicOverrides (tier 2,
		// string-equality on the {param} address, F14) → per-service default (tier 3) → global.
		// `??` (not `||`) so a legitimate qos 0 / retain false is not treated as "unset".
		const override = opts.serviceConfig?.topicOverrides?.[address];
		const qos =
			mqtt?.qos ?? override?.qos ?? opts.serviceConfig?.qosDefault ?? 1;
		const retain =
			mqtt?.retain ??
			override?.retain ??
			opts.serviceConfig?.retainDefault ??
			false;
		channels.push({
			topic: address,
			direction: directionOf(op.action()),
			service: opts.service,
			schema,
			validate: (payload: unknown): SchemaError[] =>
				validateFn(payload) ? [] : ((validateFn.errors ?? []) as SchemaError[]),
			qos,
			retain,
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

// One registry over every service's channels (the `up` boot path): same match
// rule as buildRegistry — most-specific first (fewer params), then declaration
// order, which across services is services.yaml key order.
export function mergeRegistries(registries: SpecRegistry[]): SpecRegistry {
	const channels = registries.flatMap((r) => [...r.channels()]);
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
