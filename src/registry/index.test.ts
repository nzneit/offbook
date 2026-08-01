import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { loadConfig, loadServices } from "#src/config/index.ts";
import { DEFAULT_CONFIG, type ServiceConfig } from "#src/model/index.ts";
import { SUPPORTED_SPEC_VERSIONS } from "#src/model/spec-version.ts";
import { buildRegistry } from "./index.ts";

// [utest->R-004]
// [utest->R-026]

const FIXTURE_DIR = `${import.meta.dir}/../../fixtures/asyncapi`;

async function demoRegistry() {
	const specText = await Bun.file("src/demo/thermostat.yaml").text();
	return buildRegistry({ specText, service: "demo", config: loadConfig() });
}

async function registryFor(fixture: string, serviceConfig?: ServiceConfig) {
	const path = `${FIXTURE_DIR}/${fixture}`;
	const specText = await Bun.file(path).text();
	// pass the fixture path as source so external $refs (external-ref.yaml → shared/common.yaml) resolve
	return buildRegistry({
		specText,
		service: "test",
		config: loadConfig(),
		serviceConfig,
		source: path,
	});
}

// serviceC in the config fixtures drives qos-overrides.yaml (README / G13):
// qosDefault 2 + retainDefault true, with a topicOverrides entry pinning telemetry to qos 0.
async function serviceC(): Promise<ServiceConfig> {
	const services = await loadServices(
		`${import.meta.dir}/../config/fixtures/services.yaml`,
	);
	return services.services.serviceC;
}

test("normalizes v3 directions onto channels", async () => {
	const reg = await demoRegistry();
	const byTopic = Object.fromEntries(reg.channels().map((c) => [c.topic, c]));
	expect(byTopic["command/{deviceId}/set"].direction).toBe("fromClient");
	expect(byTopic["state/{deviceId}"].direction).toBe("toClient");
});

test("match() resolves a concrete topic to its channel and captures params", async () => {
	const reg = await demoRegistry();
	const m = reg.match("command/thermostat-1/set");
	expect(m?.channel.topic).toBe("command/{deviceId}/set");
	expect(m?.params).toEqual({ deviceId: "thermostat-1" });
});

test("matchesFilter implements MQTT + / #", async () => {
	const reg = await demoRegistry();
	expect(reg.matchesFilter("state/#", "state/thermostat-1")).toBe(true);
	expect(reg.matchesFilter("state/+", "state/a/b")).toBe(false);
});

test("matchesFilter: '#' matches zero trailing levels; '+' requires exactly one", async () => {
	const reg = await demoRegistry();
	// MQTT-3.1.1 §4.7.1.2: "sport/#" also matches "sport" — '#' includes the parent level
	expect(reg.matchesFilter("state/#", "state")).toBe(true);
	expect(reg.matchesFilter("state/+", "state/thermostat-1")).toBe(true);
	expect(reg.matchesFilter("state/+", "state")).toBe(false);
});

test("validate() rejects an off-contract payload and accepts a valid one", async () => {
	const reg = await demoRegistry();
	const cmd = reg.match("command/thermostat-1/set")?.channel;
	expect(cmd?.validate({ mode: "broil", target: 20 }).length).toBeGreaterThan(
		0,
	);
	expect(cmd?.validate({ mode: "heat", target: 20 })).toEqual([]);
});

test("resolves retain:true on the state channel from its spec binding", async () => {
	const reg = await demoRegistry();
	const state = reg.match("state/thermostat-1")?.channel;
	expect(state?.retain).toBe(true);
	expect(state?.qos).toBe(1);
});

// --- direction normalization on the older major (v2) ---

test("normalizes v2 subscribe→toClient and publish→fromClient", async () => {
	const reg = await registryFor("v2-pubsub.yaml");
	const byTopic = Object.fromEntries(reg.channels().map((c) => [c.topic, c]));
	// subscribe: the service publishes, the client receives ⇒ toClient
	expect(byTopic["user/{userId}/notification"].direction).toBe("toClient");
	// publish: the client publishes, the service receives ⇒ fromClient
	expect(byTopic["user/{userId}/ack"].direction).toBe("fromClient");
});

// --- qos/retain precedence chain (contracts §2): binding → topicOverride → per-service → global ---

test("qos/retain tier 1: a spec MQTT binding is authoritative", async () => {
	const reg = await registryFor("qos-retain.yaml");
	const presence = reg.match("presence/thermostat-1")?.channel;
	expect(presence?.qos).toBe(2);
	expect(presence?.retain).toBe(true);
});

test("qos/retain global fallback: no binding + no service config → qos 1, retain false", async () => {
	const reg = await registryFor("qos-overrides.yaml");
	const alerts = reg.match("alerts/d1")?.channel;
	expect(alerts?.qos).toBe(1);
	expect(alerts?.retain).toBe(false);
});

test("qos/retain tier 3: per-service qosDefault/retainDefault fills an unbound channel", async () => {
	const reg = await registryFor("qos-overrides.yaml", await serviceC());
	const alerts = reg.match("alerts/d1")?.channel;
	expect(alerts?.qos).toBe(2); // serviceC.qosDefault
	expect(alerts?.retain).toBe(true); // serviceC.retainDefault
});

test("qos/retain tier 2: a topicOverrides entry beats the per-service default (F14 string-equality)", async () => {
	const reg = await registryFor("qos-overrides.yaml", await serviceC());
	const telemetry = reg.match("telemetry/d1")?.channel;
	// qos 0 is distinct from BOTH the per-service default (2) and global (1) — unambiguously the override tier
	expect(telemetry?.qos).toBe(0);
	expect(telemetry?.retain).toBe(false);
});

test("qos/retain precedence: a spec binding beats a topicOverrides entry (tier 1 > tier 2)", async () => {
	const svc: ServiceConfig = {
		name: "svc",
		repo: "org/svc",
		specPath: "x.yaml",
		topicOverrides: { "presence/{deviceId}": { qos: 0, retain: false } },
	};
	const reg = await registryFor("qos-retain.yaml", svc);
	const presence = reg.match("presence/d1")?.channel;
	expect(presence?.qos).toBe(2); // the binding wins over the override
	expect(presence?.retain).toBe(true);
});

// --- the §5 correctness bar: every fixture parses; composition + external-ref edges ---

test("parses every fixture in fixtures/asyncapi/ into channels (the §5 correctness bar)", async () => {
	const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".yaml"));
	expect(files.length).toBeGreaterThanOrEqual(6);
	for (const f of files) {
		const reg = await registryFor(f);
		expect(reg.channels().length).toBeGreaterThan(0);
	}
});

test("composition: validates allOf+oneOf on BOTH the toClient and fromClient paths", async () => {
	const reg = await registryFor("composition.yaml");
	const events = reg.match("events/temp")?.channel; // send → toClient
	const submissions = reg.match("submit/temp")?.channel; // receive → fromClient
	expect(events?.direction).toBe("toClient");
	expect(submissions?.direction).toBe("fromClient");
	const good = {
		id: "e1",
		ts: "2020-01-01T00:00:00Z",
		detail: { kind: "sensor", value: 1 },
	};
	// matches exactly one oneOf branch (SensorReading) — valid on both directions
	expect(events?.validate(good)).toEqual([]);
	expect(submissions?.validate(good)).toEqual([]);
	// matches zero oneOf branches (SensorReading needs `value`; kind≠alarm) — rejected client-side too
	const bad = {
		id: "e1",
		ts: "2020-01-01T00:00:00Z",
		detail: { kind: "sensor" },
	};
	expect((submissions?.validate(bad) ?? []).length).toBeGreaterThan(0);
});

test("external-ref: bundles a cross-file $ref (+$id base) into an Ajv standalone schema", async () => {
	const ch = (await registryFor("external-ref.yaml")).match(
		"telemetry/node-1",
	)?.channel;
	const rec = {
		nodeId: "node-1",
		recordedAt: "2020-01-01T00:00:00Z",
		value: 1,
	};
	// the external Identifier's `pattern` was inlined by the parser's bundling and IS enforced
	expect(ch?.validate(rec)).toEqual([]);
	// negative case: a nodeId violating the external pattern (uppercase/underscore) is rejected
	expect(
		(ch?.validate({ ...rec, nodeId: "BAD_ID" }) ?? []).length,
	).toBeGreaterThan(0);
});

test("external-ref: a $ref-sibling keyword is not enforced, which is draft-07-correct (D-018)", async () => {
	const ch = (await registryFor("external-ref.yaml")).match(
		"telemetry/node-1",
	)?.channel;
	// nodeId carries `minLength: 3` as a $ref sibling. draft-07 ignores $ref siblings, and it is
	// the dialect both spec majors declare and the parser emits, so a 2-char (pattern-valid) id is
	// accepted BY DESIGN rather than by accident (D-018 supersedes D-005's deferred spike). Pinned
	// so that a future dialect change, which would start enforcing it, is loud.
	expect(
		ch?.validate({
			nodeId: "ab",
			recordedAt: "2020-01-01T00:00:00Z",
			value: 1,
		}),
	).toEqual([]);
});

// [utest->R-037]
test("refuses a 1.x spec with an actionable, branded error", async () => {
	const spec = `asyncapi: '1.2.0'
info: { title: Legacy, version: 1.0.0 }
topics:
  t.one:
    publish:
      payload: { type: object }
`;
	const attempt = buildRegistry({
		specText: spec,
		service: "legacy",
		config: DEFAULT_CONFIG,
	});
	await expect(attempt).rejects.toThrow(
		/unsupported AsyncAPI version "1\.2\.0"/,
	);
	// names EVERY tested version and the remedy, not just the problem. Built from
	// the constant, so the assertion cannot drift from what the message renders.
	for (const v of SUPPORTED_SPEC_VERSIONS) {
		await expect(attempt).rejects.toThrow(v);
	}
	await expect(attempt).rejects.toThrow(/asyncapi convert/);
});

// [utest->R-037]
test("a malformed spec surfaces the parser's own diagnostics, not a version error", async () => {
	// A YAML syntax error is not a version problem, and `asyncapi convert` is not
	// its remedy. Spec-load failure is fatal and aborts `up` (design §7 Mode 1),
	// so this message is the whole error an adopter sees (R-036, D-019).
	const err = (await buildRegistry({
		specText: "asyncapi: 3.0.0\ninfo: {title: T\n  bad indent: ][",
		service: "svc-a",
		config: DEFAULT_CONFIG,
	}).catch((e: unknown) => e as Error)) as Error;
	expect(err).toBeInstanceOf(Error);
	expect(err.message).toMatch(/failed to parse spec/);
	expect(err.message).toMatch(/flow/); // the parser's own YAML syntax wording
	expect(err.message).not.toMatch(/unsupported AsyncAPI version/);
	expect(err.message).not.toMatch(/asyncapi convert/);
});

// [utest->R-037]
test("an unquoted `asyncapi: 2.6` is refused before the parser's TypeError", async () => {
	// `asyncapi: 2.6` is a YAML float, not a string, and the parser dies on it
	// inside getSemver with a raw `patchWithRc.split` TypeError stack. The gate
	// catches it first because String(2.6) is "2.6", which is not a tested
	// version. This is why readSpecVersion normalizes with String() (D-019).
	const err = (await buildRegistry({
		specText: "asyncapi: 2.6\ninfo: { title: T, version: 1.0.0 }\nchannels: {}",
		service: "floaty",
		config: DEFAULT_CONFIG,
	}).catch((e: unknown) => e as Error)) as Error;
	expect(err).toBeInstanceOf(Error);
	expect(err.message).toMatch(/unsupported AsyncAPI version "2\.6"/);
	expect(err.message).not.toMatch(/patchWithRc/);
});

// [utest->R-037]
test("a version inside the old range but outside the tested set is still refused", async () => {
	// 2.7.0 sits INSIDE "2.0.0 through 3.1.0" while being untested, which is
	// exactly why the message names the set instead of a range (D-019).
	const err = (await buildRegistry({
		specText:
			"asyncapi: '2.7.0'\ninfo: { title: T, version: 1.0.0 }\nchannels: {}",
		service: "future",
		config: DEFAULT_CONFIG,
	}).catch((e: unknown) => e as Error)) as Error;
	expect(err).toBeInstanceOf(Error);
	expect(err.message).toMatch(/unsupported AsyncAPI version "2\.7\.0"/);
	expect(err.message).not.toMatch(/through/);
});

// [utest->R-037]
test("a spec with no asyncapi field defers to the parser's diagnosis", async () => {
	// Not offbook's call to make: the parser names the real problem precisely,
	// and guessing "unsupported version" here mislabels an empty file, an HTML
	// error page from a bad repo URL, and a wrong spec-path alike (D-019).
	const err = (await buildRegistry({
		specText: "info: { title: T, version: 1.0.0 }",
		service: "nover",
		config: DEFAULT_CONFIG,
	}).catch((e: unknown) => e as Error)) as Error;
	expect(err).toBeInstanceOf(Error);
	expect(err.message).toMatch(/failed to parse spec/);
	expect(err.message).toMatch(/This is not an AsyncAPI document/);
	expect(err.message).not.toMatch(/unsupported AsyncAPI version/);
});

// [utest->R-037]
test("accepts every version in the supported contract", async () => {
	for (const v of SUPPORTED_SPEC_VERSIONS) {
		const spec = v.startsWith("3.")
			? `asyncapi: ${v}
info: { title: T, version: 1.0.0 }
channels:
  c: { address: t/one, messages: { M: { payload: { type: object, properties: { a: { type: string } } } } } }
operations:
  o: { action: send, channel: { $ref: '#/channels/c' } }
`
			: `asyncapi: ${v}
info: { title: T, version: 1.0.0 }
channels:
  t/one:
    subscribe:
      operationId: s
      message:
        payload: { type: object, properties: { a: { type: string } } }
`;
		const reg = await buildRegistry({
			specText: spec,
			service: "s",
			config: DEFAULT_CONFIG,
		});
		expect(reg.channels().length, `version ${v} should yield one channel`).toBe(
			1,
		);
	}
});

// [utest->R-038]
test("a multi-format payload still VALIDATES (the wrapper must be unwrapped)", async () => {
	const reg = await registryFor("multi-format.yaml");
	const reading = reg.match("reading/s1")?.channel;
	expect(reading).toBeDefined();
	// the schema handed to Ajv must be the payload schema, not the wrapper
	expect(Object.keys(reading?.schema as object)).not.toContain("schemaFormat");
	expect(Object.keys(reading?.schema as object)).not.toContain("schema");
	// conforming payload passes
	expect(reading?.validate({ sensorId: "s1", celsius: 21.5 })).toEqual([]);
	// and the tripwire: garbage must NOT pass. Before the unwrap every one of
	// these validated green, which is the false-negative class R-028 forbids.
	expect(
		reading?.validate({ sensorId: 42, celsius: "hot" }).length,
	).toBeGreaterThan(0);
	expect(reading?.validate({ unrelated: true }).length).toBeGreaterThan(0);
	expect(reading?.validate("not-an-object").length).toBeGreaterThan(0);
	expect(reading?.validate(null).length).toBeGreaterThan(0);
});

// [utest->R-038]
test("the multi-format wrapper is unwrapped on the client-publish path too", async () => {
	const reg = await registryFor("multi-format.yaml");
	const calibrate = reg.match("calibrate/s1")?.channel;
	expect(calibrate?.direction).toBe("fromClient");
	expect(calibrate?.validate({ offset: 0.5 })).toEqual([]);
	expect(calibrate?.validate({ offset: "half" }).length).toBeGreaterThan(0);
	expect(calibrate?.validate({}).length).toBeGreaterThan(0);
});

// [utest->R-038]
// Inline rather than a fixture on purpose: json-schema-faker 0.6.2 cannot draw a
// valid draft-07 tuple (it emits objects with numeric keys, e.g.
// [{"0":"ab","1":1.5}], failing the Ajv recheck 10/10 regardless of
// additionalItems or minItems). A tuple channel in fixtures/asyncapi/ would
// therefore fail the R-027 faker-floor spike and flip D-008's measured verdict,
// which is a separate question from the dialect this test pins. See D-018.
test("draft-07 tuple `items` validates positionally instead of crashing the build", async () => {
	const spec = `asyncapi: 3.0.0
info: { title: T, version: 1.0.0 }
channels:
  c:
    address: window/{sensorId}
    parameters:
      sensorId:
        description: sensor instance id
    messages:
      Window:
        payload:
          type: array
          items:
            - type: string
            - type: number
          additionalItems: false
operations:
  o: { action: send, channel: { $ref: '#/channels/c' } }
`;
	// under the old 2020-12 stamp this THREW out of buildRegistry, uncaught
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const window = reg.match("window/s1")?.channel;
	expect(window).toBeDefined();
	expect(window?.validate(["a", 1])).toEqual([]);
	// wrong order and wrong type at position 1 are both caught
	expect(window?.validate([1, "a"]).length).toBeGreaterThan(0);
	expect(window?.validate(["a", "b"]).length).toBeGreaterThan(0);
	// additionalItems: false is honored under draft-07 (2020-12 ignores it)
	expect(window?.validate(["a", 1, "extra"]).length).toBeGreaterThan(0);
});

// [utest->R-038]
test("channel schemas declare the draft-07 dialect they are validated under", async () => {
	const reg = await registryFor("thermostat.yaml");
	const schema = reg.channels()[0].schema as { $schema?: string };
	expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
});

// [utest->R-039]
test("an mqtt CHANNEL binding is reported as ignored, not silently dropped", async () => {
	const spec = `asyncapi: 3.0.0
info: { title: T, version: 1.0.0 }
channels:
  c:
    address: t/chanbound
    bindings: { mqtt: { qos: 2, retain: true } }
    messages: { M: { payload: { type: object, properties: { a: { type: string } } } } }
operations:
  o: { action: send, channel: { $ref: '#/channels/c' } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	// MQTT defines qos/retain on the OPERATION only: the Channel Binding Object
	// "MUST NOT contain any properties" at every binding version, so the values
	// are ignored and the channel keeps the global defaults.
	expect(reg.match("t/chanbound")?.channel.qos).toBe(1);
	const found = reg
		.diagnostics()
		.filter((d) => d.detail.startsWith("binding-on-channel:"));
	expect(found.length).toBe(1);
	expect(found[0].kind).toBe("spec-load");
	expect(found[0].severity).toBe("warning");
	expect(found[0].source).toBe("t/chanbound");
});

// [utest->R-039]
test("a clean spec produces no registry diagnostics", async () => {
	const reg = await registryFor("thermostat.yaml");
	expect(reg.diagnostics()).toEqual([]);
});

// [utest->R-038]
test("post-draft-07 keywords are surfaced, since draft-07 ignores them silently", async () => {
	const spec = `asyncapi: 3.0.0
info: { title: T, version: 1.0.0 }
channels:
  c:
    address: t/modern
    messages:
      M:
        payload:
          type: object
          required: [items]
          properties:
            items:
              type: array
              prefixItems:
                - type: string
          unevaluatedProperties: false
operations:
  o: { action: send, channel: { $ref: '#/channels/c' } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const found = reg
		.diagnostics()
		.filter((d) => d.detail.startsWith("dialect-mismatch:"));
	expect(found.length).toBe(1);
	expect(found[0].severity).toBe("warning");
	expect(found[0].source).toBe("t/modern");
	// names every offending keyword so the author can fix them all at once
	expect(found[0].detail).toContain("prefixItems");
	expect(found[0].detail).toContain("unevaluatedProperties");
});

// [utest->R-038]
test("$defs and definitions are NOT reported: both work under draft-07", async () => {
	// the repo's own shared/common.yaml uses $defs, so flagging it would cry wolf
	const reg = await registryFor("external-ref.yaml");
	expect(
		reg.diagnostics().filter((d) => d.detail.startsWith("dialect-mismatch:")),
	).toEqual([]);
});

// [utest->R-038]
test("a schema that will not compile yields violations, never a crash and never green", async () => {
	const spec = `asyncapi: 3.0.0
info: { title: T, version: 1.0.0 }
channels:
  c:
    address: t/broken
    messages:
      M:
        payload:
          type: object
          properties:
            bad:
              type: string
              pattern: '['
operations:
  o: { action: send, channel: { $ref: '#/channels/c' } }
`;
	// does not throw: discovery is a v1 floor that must survive a weak spec
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const broken = reg.match("t/broken")?.channel;
	expect(broken).toBeDefined();
	// and it must NOT validate green, which would be false confidence
	const errs = broken?.validate({ anything: true }) ?? [];
	expect(errs.length).toBe(1);
	expect(errs[0].keyword).toBe("offbook:schema-compile-failed");
	const found = reg
		.diagnostics()
		.filter((d) => d.detail.startsWith("schema-compile-failed:"));
	expect(found.length).toBe(1);
	expect(found[0].severity).toBe("error");
	expect(found[0].source).toBe("t/broken");
});

// [utest->R-038]
test("a v2 message.oneOf union validates EITHER variant, not just the first", async () => {
	const spec = `asyncapi: 2.6.0
info: { title: T, version: 1.0.0 }
channels:
  t/union:
    subscribe:
      operationId: s
      message:
        oneOf:
          - payload: { type: object, required: [a], additionalProperties: false, properties: { a: { type: string } } }
          - payload: { type: object, required: [b], additionalProperties: false, properties: { b: { type: number } } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const union = reg.match("t/union")?.channel;
	expect(union?.validate({ a: "x" })).toEqual([]);
	// before the anyOf, variant two was reported as a violation because only
	// messages()[0] was read
	expect(union?.validate({ b: 2 })).toEqual([]);
	// and something matching NEITHER variant is still caught
	expect(union?.validate({ c: true }).length).toBeGreaterThan(0);
});

// [utest->R-038]
test("a single-message operation keeps its schema unwrapped by anyOf", async () => {
	const reg = await registryFor("thermostat.yaml");
	const schema = reg.channels()[0].schema as Record<string, unknown>;
	expect(schema.anyOf).toBeUndefined();
	expect(schema.type).toBe("object");
});

// [utest->R-039]
test("the oldest supported major parses, inverts direction, and its binding is read", async () => {
	const reg = await registryFor("v2-oldest.yaml");
	const telemetry = reg.match("legacy/d1/telemetry")?.channel;
	const command = reg.match("legacy/d1/command")?.channel;
	// v2 subscribe = messages PRODUCED by the application (the service) ⇒ toClient
	expect(telemetry?.direction).toBe("toClient");
	// v2 publish = messages CONSUMED by the application ⇒ the client sends them
	expect(command?.direction).toBe("fromClient");
	expect(telemetry?.qos).toBe(2);
	expect(telemetry?.retain).toBe(true);
	expect(reg.diagnostics()).toEqual([]);
});

// [utest->R-039]
test("an out-of-range binding qos is rejected and falls through the precedence chain", async () => {
	// 2.x maps `mqtt` to an empty schema, so qos 9 parses clean upstream and
	// would otherwise reach a Channel typed 0 | 1 | 2
	const spec = `asyncapi: 2.6.0
info: { title: T, version: 1.0.0 }
channels:
  t/bad:
    subscribe:
      operationId: s
      bindings:
        mqtt: { qos: 9, retain: "yes" }
      message:
        payload: { type: object, properties: { a: { type: string } } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
		serviceConfig: {
			name: "s",
			repo: "x",
			specPath: "y",
			qosDefault: 0,
			retainDefault: true,
		},
	});
	const ch = reg.match("t/bad")?.channel;
	// falls through to the per-service default (tier 3), NOT clamped and NOT propagated
	expect(ch?.qos).toBe(0);
	expect(ch?.retain).toBe(true);
	const bad = reg
		.diagnostics()
		.filter((d) => d.detail.startsWith("binding-invalid-value:"));
	expect(bad.length).toBe(2);
	expect(bad.every((d) => d.severity === "warning")).toBe(true);
});

// [utest->R-039]
test("a misspelled binding key is reported against the official key set", async () => {
	const spec = `asyncapi: 2.6.0
info: { title: T, version: 1.0.0 }
channels:
  t/typo:
    subscribe:
      operationId: s
      bindings:
        mqtt: { qos: 1, retian: true }
      message:
        payload: { type: object, properties: { a: { type: string } } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const unknown = reg
		.diagnostics()
		.filter((d) => d.detail.startsWith("binding-unknown-key:"));
	expect(unknown.length).toBe(1);
	expect(unknown[0].detail).toContain("retian");
});

// [utest->R-039]
test("MQTT-5-only binding fields are reported as unhonored", async () => {
	const spec = `asyncapi: 3.0.0
info: { title: T, version: 1.0.0 }
channels:
  c: { address: t/five, messages: { M: { payload: { type: object, properties: { a: { type: string } } } } } }
operations:
  o:
    action: send
    channel: { $ref: '#/channels/c' }
    bindings: { mqtt: { qos: 1, messageExpiryInterval: 60 } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const five = reg
		.diagnostics()
		.filter((d) => d.detail.startsWith("mqtt5-field-ignored:"));
	expect(five.length).toBe(1);
	expect(five[0].detail).toContain("messageExpiryInterval");
	expect(five[0].severity).toBe("info");
});

// [utest->R-039]
test("a vendor extension key on an mqtt binding is legal, not an unknown key", async () => {
	const spec = `asyncapi: 3.0.0
info: { title: T, version: 1.0.0 }
channels:
  c: { address: t/ext, messages: { M: { payload: { type: object, properties: { a: { type: string } } } } } }
operations:
  o:
    action: send
    channel: { $ref: '#/channels/c' }
    bindings: { mqtt: { qos: 2, x-vendor-thing: true } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	// the official binding schema permits ^x-[\w\d\.\x2d_]+$ via patternProperties,
	// which the derived key set ignored because it read only `properties` (D-019)
	expect(
		reg
			.diagnostics()
			.filter((d) => d.detail.startsWith("binding-unknown-key:")),
	).toEqual([]);
	// and the legal fields on the same binding still take effect: qos 2 differs
	// from the global default of 1, so this assertion is not vacuous
	expect(reg.match("t/ext")?.channel.qos).toBe(2);
});
