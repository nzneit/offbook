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
	isSupportedSpecVersion,
	readSpecVersion,
	SUPPORTED_SPEC_VERSIONS,
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

// Keywords JSON Schema introduced after draft-07. offbook validates under
// draft-07, where these are unknown and therefore SILENTLY IGNORED, which is
// the worst failure mode for a contract checker, so their presence is surfaced
// (D-018). `$defs` and `definitions` are deliberately absent: both resolve
// correctly under draft-07, and fixtures/asyncapi/shared/common.yaml
// legitimately uses `$defs`.
const POST_DRAFT07_KEYWORDS = new Set([
	"prefixItems",
	"unevaluatedProperties",
	"unevaluatedItems",
	"dependentRequired",
	"dependentSchemas",
	"minContains",
	"maxContains",
	"$dynamicRef",
	"$dynamicAnchor",
	"$recursiveRef",
	"$recursiveAnchor",
]);

// The mqtt OPERATION binding's legal keys, transcribed from @asyncapi/specs'
// bindings/mqtt/0.2.0/operation.json. Hand-authored and drift-tested rather than
// derived at runtime, for the reason D-018 gave for SUPPORTED_SPEC_VERSIONS: a
// value being present upstream is not the same as offbook having tested it.
// Keeping it a constant is also what lets @asyncapi/specs be a devDependency
// (D-019) instead of an undeclared transitive of @asyncapi/parser, resolved only
// by flat hoisting. Validating against 0.2.0 is permissive-correct: its property
// set is a superset of 0.1.0's. Exported for test/upstream-drift.test.ts, which
// pins both halves against the installed schema.
export const MQTT_OPERATION_KEYS = new Set([
	"bindingVersion",
	"messageExpiryInterval",
	"qos",
	"retain",
]);

// The same schema permits vendor extensions via `patternProperties`. Transcribed
// character-for-character from that key, so the drift test compares source
// strings rather than approximating the intent. Reading only `properties` meant
// a spec-legal `x-vendor-thing` was reported as an unknown key (D-019).
// biome-ignore lint/complexity/noUselessEscapeInRegex: the `\.` is redundant to the regex engine but NOT to this constant's purpose — `.source` is compared byte-for-byte against the upstream schema key in test/upstream-drift.test.ts, so unescaping it breaks the character-for-character transcription D-019 relies on (biome 2's "safe" fix does exactly that; D-023)
export const MQTT_EXTENSION_KEY = /^x-[\w\d\.\x2d_]+$/;

// MQTT 5 only, per the "MQTT Versions" column of the binding spec. offbook is
// MQTT 3.1.1 only, so these can never be honored and saying so beats silence.
const MQTT5_ONLY_KEYS = new Set([
	"messageExpiryInterval",
	"payloadFormatIndicator",
	"correlationData",
	"contentType",
	"responseTopic",
	"sessionExpiryInterval",
	"maximumPacketSize",
]);

function postDraft07Keywords(
	node: unknown,
	found: Set<string> = new Set(),
): Set<string> {
	if (Array.isArray(node)) {
		for (const item of node) postDraft07Keywords(item, found);
		return found;
	}
	if (node === null || typeof node !== "object") return found;
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (POST_DRAFT07_KEYWORDS.has(key)) found.add(key);
		postDraft07Keywords(value, found);
	}
	return found;
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
	// fail deep in the Spectral ruleset with an opaque "Error running Nimma"
	// (D-018) — or, for an unquoted `asyncapi: 2.6`, with a raw TypeError stack
	// out of getSemver.
	//
	// Fires ONLY on a version this read positively resolved. An unreadable or
	// absent `asyncapi` field is not offbook's call to make: the parser's own
	// diagnostics distinguish a YAML syntax error from a non-AsyncAPI document,
	// and guessing "unsupported version" mislabelled both, along with the empty
	// file and the fetched HTML error page (D-019). The message names the tested
	// set rather than a range, because a version can sit inside 2.0.0-3.1.0 and
	// still be untested.
	const specVersion = readSpecVersion(opts.specText);
	if (specVersion !== undefined && !isSupportedSpecVersion(specVersion)) {
		throw new Error(
			`unsupported AsyncAPI version "${specVersion}" in service '${opts.service}': offbook supports ${SUPPORTED_SPEC_VERSIONS.join(
				", ",
			)}. Convert the spec first: \`asyncapi convert <file> --target-version 3.1.0\``,
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
		// An MQTT topic can legitimately carry one of several declared message
		// types (a v2 `message.oneOf` union, or a v3 operation listing several
		// messages). Reading only messages()[0] reported every other variant as a
		// violation. `anyOf` keeps Channel.schema singular, so the faker and
		// /topics are unaffected (D-018).
		const messages = op.messages().all();
		const msg = messages[0];
		const payloadSchemas = messages.map((m) =>
			extractPayloadSchema(m.payload()?.json()),
		);
		const schema =
			payloadSchemas.length > 1
				? { $schema: DRAFT_07, anyOf: payloadSchemas }
				: { $schema: DRAFT_07, ...(payloadSchemas[0] ?? {}) };
		const modernKeywords = postDraft07Keywords(schema);
		if (modernKeywords.size > 0) {
			const names = [...modernKeywords].sort().join(", ");
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `dialect-mismatch: '${address}' uses post-draft-07 keyword(s) ${names}; offbook validates under draft-07 (the dialect both AsyncAPI majors declare), so these are NOT enforced`,
				source: address,
			});
		}
		// A schema Ajv refuses must never validate GREEN: that is false
		// confidence, the failure mode this tool exists to prevent. The channel
		// still enters the catalog because discovery is a v1 floor that survives
		// weak specs, but every payload on it reports one explicit violation
		// (D-018).
		let validate: (payload: unknown) => SchemaError[];
		try {
			const validateFn = ajv.compile(schema);
			validate = (payload: unknown): SchemaError[] =>
				validateFn(payload) ? [] : ((validateFn.errors ?? []) as SchemaError[]);
		} catch (cause) {
			const reason = (cause as Error).message;
			diagnostics.push({
				kind: "spec-load",
				severity: "error",
				detail: `schema-compile-failed: '${address}' payload schema did not compile, so nothing on this channel is validated: ${reason}`,
				source: address,
			});
			const compileError: SchemaError = {
				instancePath: "",
				schemaPath: "#",
				keyword: "offbook:schema-compile-failed",
				params: {},
				message: `payload schema did not compile: ${reason}`,
			};
			validate = () => [compileError];
		}
		// Read untyped: 2.x maps `mqtt` to an EMPTY schema in its own
		// meta-schema, so nothing upstream validated these values and a declared
		// type here would be a lie (D-018).
		const mqtt = op.bindings().get("mqtt")?.value<Record<string, unknown>>();
		if (mqtt) {
			const unknownKeys = Object.keys(mqtt).filter(
				(k) => !MQTT_OPERATION_KEYS.has(k) && !MQTT_EXTENSION_KEY.test(k),
			);
			if (unknownKeys.length > 0) {
				const bad = unknownKeys.sort().join(", ");
				const legal = [...MQTT_OPERATION_KEYS].sort().join(", ");
				diagnostics.push({
					kind: "spec-load",
					severity: "warning",
					detail: `binding-unknown-key: '${address}' mqtt operation binding has unknown key(s) ${bad}; the mqtt binding defines ${legal}`,
					source: address,
				});
			}
			const five = Object.keys(mqtt).filter((k) => MQTT5_ONLY_KEYS.has(k));
			if (five.length > 0) {
				const names = five.sort().join(", ");
				diagnostics.push({
					kind: "spec-load",
					severity: "info",
					detail: `mqtt5-field-ignored: '${address}' declares MQTT 5 binding field(s) ${names}; offbook speaks MQTT 3.1.1 only, so these are not honored`,
					source: address,
				});
			}
		}
		const rawQos = mqtt?.qos;
		const bindingQos =
			rawQos === 0 || rawQos === 1 || rawQos === 2 ? rawQos : undefined;
		if (rawQos !== undefined && bindingQos === undefined) {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `binding-invalid-value: '${address}' mqtt binding qos is ${JSON.stringify(
					rawQos,
				)}; qos MUST be 0, 1 or 2, so this binding is ignored and the configured default applies`,
				source: address,
			});
		}
		const rawRetain = mqtt?.retain;
		const bindingRetain =
			typeof rawRetain === "boolean" ? rawRetain : undefined;
		if (rawRetain !== undefined && bindingRetain === undefined) {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `binding-invalid-value: '${address}' mqtt binding retain is ${JSON.stringify(
					rawRetain,
				)}; retain MUST be a boolean, so this binding is ignored and the configured default applies`,
				source: address,
			});
		}
		// §2 precedence, resolved per-field: spec MQTT binding → topicOverrides (tier 2,
		// string-equality on the {param} address, F14) → per-service default (tier 3) → global.
		// `??` (not `||`) so a legitimate qos 0 / retain false is not treated as "unset".
		const override = opts.serviceConfig?.topicOverrides?.[address];
		const qos =
			bindingQos ?? override?.qos ?? opts.serviceConfig?.qosDefault ?? 1;
		const retain =
			bindingRetain ??
			override?.retain ??
			opts.serviceConfig?.retainDefault ??
			false;
		const direction = directionOf(op.action());
		// R-040: resolved onto toClient records only — the §2 floor is a toClient
		// concept, and surfacing the flag on a fromClient row would contradict the
		// initial-state-on-from-client warning
		const initialState =
			direction === "toClient" && typeof override?.initialState === "boolean"
				? override.initialState
				: undefined;
		channels.push({
			topic: address,
			direction,
			service: opts.service,
			schema,
			validate,
			qos,
			retain,
			initialState,
			title: msg?.title() ?? undefined,
			description: ch.description() ?? msg?.description() ?? undefined,
		});
	}

	// R-040: topicOverrides is a pure lookup above, so a mistyped key or value
	// is silent there — this sweep is the loud counterpart (one warning per key,
	// never per operation, so a dual-direction address cannot double-fire)
	for (const [key, value] of Object.entries(
		opts.serviceConfig?.topicOverrides ?? {},
	)) {
		const matching = channels.filter((c) => c.topic === key);
		if (matching.length === 0) {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `override-dangling-key: '${key}' matches no channel address in service '${opts.service}', so this topicOverrides entry is ignored`,
				source: key,
			});
			continue;
		}
		const raw = value.initialState;
		if (raw !== undefined && typeof raw !== "boolean") {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `initial-state-non-boolean: '${key}' topicOverrides initialState is ${JSON.stringify(raw)}; initialState MUST be a boolean, so it is ignored and the floor applies`,
				source: key,
			});
		}
		if (raw === false && !matching.some((c) => c.direction === "toClient")) {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `initial-state-on-from-client: '${key}' has initialState: false but no toClient operation, and the initial-state floor only runs toClient, so the flag is ignored`,
				source: key,
			});
		}
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
	// R-040: an exact-address duplicate across services resolves by match order
	// (for identical addresses: services.yaml key order), so a disagreeing
	// initialState on the losing record is silently dead — surface it at the
	// only cross-service seam. Parametrized shadowing (a literal address in one
	// service shadowing a flagged {param} address in another) stays a known
	// residual, recorded in D-025.
	const crossService: Diagnostic[] = [];
	const byTopic = new Map<string, Channel[]>();
	for (const c of channels) {
		// R-040: only toClient records carry the flag
		if (c.direction !== "toClient") continue;
		const group = byTopic.get(c.topic);
		if (group) group.push(c);
		else byTopic.set(c.topic, [c]);
	}
	for (const [topic, group] of byTopic) {
		const services = [...new Set(group.map((c) => c.service))];
		if (services.length < 2) continue;
		const stances = new Set(group.map((c) => c.initialState === false));
		if (stances.size < 2) continue;
		// The match winner for an exact address is the first same-topic record in
		// flatMap order, ANY direction — `group` holds only toClient records, so a
		// same-address fromClient record declared earlier wins instead, and then
		// the engine's floor never runs there (it returns for non-toClient matches).
		const winner = channels.find((c) => c.topic === topic);
		const verdict =
			winner?.direction === "toClient"
				? `'${winner.service}' wins the match, so the other declaration is dead`
				: `a fromClient record from '${winner?.service}' wins the match, so the floor never runs there and every initialState declaration is dead`;
		crossService.push({
			kind: "spec-load",
			severity: "warning",
			detail: `initial-state-cross-service: '${topic}' is declared by ${services
				.map((s) => `'${s}'`)
				.join(" and ")} with disagreeing initialState; ${verdict}`,
			source: topic,
		});
	}
	const ordered = channels
		.map((c, i) => ({ c, i }))
		.sort((a, b) => {
			const pa = (a.c.topic.match(/\{/g) ?? []).length;
			const pb = (b.c.topic.match(/\{/g) ?? []).length;
			return pa - pb || a.i - b.i;
		});
	return {
		channels: () => channels,
		diagnostics: () => [
			...registries.flatMap((r) => [...r.diagnostics()]),
			...crossService,
		],
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
