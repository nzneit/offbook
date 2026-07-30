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

test("external-ref: bundles a cross-file $ref (+$id base) into an Ajv-2020 standalone schema", async () => {
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

test("external-ref: KNOWN LIMITATION (D-005, §12.4) — a $ref-sibling keyword under 2020-12 is dropped", async () => {
	const ch = (await registryFor("external-ref.yaml")).match(
		"telemetry/node-1",
	)?.channel;
	// nodeId carries `minLength: 3` as a $ref sibling. @asyncapi/parser normalizes to draft-07,
	// which drops $ref siblings — so a 2-char (pattern-valid) id is WRONGLY accepted. This test
	// pins that limitation; it flips red when the 2020-12 schema-parser spike lands (revisit D-005).
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
	// names the supported range and the remedy, not just the problem
	await expect(attempt).rejects.toThrow(/2\.0\.0/);
	await expect(attempt).rejects.toThrow(/asyncapi convert/);
});

// [utest->R-037]
test("refuses a spec with no asyncapi field", async () => {
	await expect(
		buildRegistry({
			specText: "info: { title: T, version: 1.0.0 }",
			service: "nover",
			config: DEFAULT_CONFIG,
		}),
	).rejects.toThrow(/unsupported AsyncAPI version/);
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
