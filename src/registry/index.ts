import { Parser } from "@asyncapi/parser";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { exec, matches } from "mqtt-pattern";
import type {
	Channel,
	Config,
	Diagnostic,
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

// AsyncAPI 3.x lets a payload be a Multi Format Schema Object (`{schemaFormat,
// schema}`), permitted even for the default JSON-Schema format. `BaseModel.json()`
// returns that wrapper verbatim (the parser's own Schema model unwraps
// `_json.schema` internally for its typed accessors), so spreading it yields a
// schema with NO validation keywords: a validator that accepts everything (D-018).
// Deliberately does NOT branch on the schemaFormat STRING: the implementation
// emits `application/vnd.aai.asyncapi;version=X` while the spec text mandates a
// `+json` suffix, so a literal comparison would silently stop matching.
function extractPayloadSchema(payloadJson: unknown): object {
	if (payloadJson === null || typeof payloadJson !== "object") return {};
	const p = payloadJson as Record<string, unknown>;
	if (
		"schemaFormat" in p &&
		typeof p.schema === "object" &&
		p.schema !== null
	) {
		return p.schema as object;
	}
	return p;
}

// The dialect BOTH spec majors declare for the Schema Object ("a superset of
// JSON Schema Draft 07") and the one @asyncapi/parser actually emits. Stamping
// 2020-12 over it was the root cause of the tuple-compile crash and of
// `additionalItems` being silently ignored (D-018). Stamped explicitly so
// `channel.schema`, which GET /topics hands out, is self-describing.
const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

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
	const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));

	const channels: Channel[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const op of document.operations().all()) {
		const ch = op.channels().all()[0];
		const address = ch.address() ?? "";
		// MQTT defines qos/retain on the OPERATION binding only: the Channel
		// Binding Object "MUST NOT contain any properties. Its name is reserved
		// for future use." at every binding version. A channel-level mqtt binding
		// nonetheless parses clean, so say it is ignored rather than defaulting
		// in silence (D-018).
		const channelMqtt = ch
			.bindings()
			.get("mqtt")
			?.value<Record<string, unknown>>();
		if (channelMqtt && Object.keys(channelMqtt).length > 0) {
			const keys = Object.keys(channelMqtt).join(", ");
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `binding-on-channel: '${address}' declares an mqtt CHANNEL binding (${keys}); MQTT defines qos/retain on the operation only, so these are ignored`,
				source: address,
			});
		}
		const msg = op.messages().all()[0];
		const schema = {
			$schema: DRAFT_07,
			...extractPayloadSchema(msg?.payload()?.json()),
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
		diagnostics: () => diagnostics,
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
		diagnostics: () => registries.flatMap((r) => [...r.diagnostics()]),
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
