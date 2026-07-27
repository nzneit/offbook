// R-017 — contracts §5 contract test per endpoint, driven through the real
// composition root (F11): reads (topics/state/validation/specs/diagnostics/
// scenarios/mode/pending), actions (publish/trigger/reset/mode/specs-refresh),
// the closed-union error envelope, the byte-equal example guarantee, and the
// qos/retain divergence warn-log. GET /v1/mode's lastResetSeq (D-014) is the
// offbook-check baseline.
// [itest->R-017]
// [itest->R-023]
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { type Composed, compose } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import type {
	Channel,
	Config,
	Diagnostic,
	SpecRegistry,
	StateEntry,
	Violation,
} from "#src/model/index.ts";
import { buildRegistry } from "#src/registry/index.ts";

const servers: Composed[] = [];
afterEach(async () => {
	while (servers.length) await servers.pop()?.stop();
});

const SCENARIOS = `
- name: ack-set
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: accepted, target: "{{payload.target}}" }
- name: go-offline
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: offline }
`;

function scenarioDir(text = SCENARIOS): string {
	const dir = mkdtempSync(join(tmpdir(), "offbook-cp-"));
	writeFileSync(join(dir, "50-demo.yaml"), text);
	return dir;
}

async function boot(
	n: number,
	opts: {
		overrides?: Partial<Config>;
		scenarios?: string | false;
		registry?: SpecRegistry;
		parts?: Partial<Parameters<typeof compose>[0]>;
	} = {},
) {
	const config = loadConfig({
		brokerWsPort: 18000 + n,
		brokerTcpPort: 12800 + n,
		controlPlanePort: 18800 + n,
		...opts.overrides,
	});
	const registry =
		opts.registry ??
		(await buildRegistry({
			specText: await Bun.file("src/demo/thermostat.yaml").text(),
			service: "demo",
			config,
		}));
	const logs: string[] = [];
	const server = await compose({
		config,
		registry,
		scenariosDir:
			opts.scenarios === false ? undefined : (opts.scenarios ?? scenarioDir()),
		log: (l) => logs.push(l),
		...opts.parts,
	});
	servers.push(server);
	await server.start();
	const req = (path: string, init?: RequestInit) =>
		server.app.request(path, init);
	const post = (path: string, body: unknown) =>
		req(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	return { server, config, req, post, logs };
}

// hand-built registry for paths the all-valid demo spec can't produce
function makeChannel(
	topic: string,
	direction: Channel["direction"],
	schema: object,
): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
	return {
		topic,
		direction,
		service: "stub",
		schema,
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos: 1,
		retain: false,
	};
}

function fakeRegistry(channels: Channel[]): SpecRegistry {
	return {
		channels: () => channels,
		match: (topic) => {
			const c = channels.find((ch) => ch.topic === topic);
			return c ? { channel: c, params: {} } : undefined;
		},
		matchesFilter: () => false,
	};
}

// --- F11: the control-plane module touches nothing below the seam ----------

test("F11: control-plane imports only hono + model (no engine/broker/validation/scenarios)", async () => {
	const source = await Bun.file("src/control-plane/index.ts").text();
	expect(source).not.toMatch(
		/#src\/(engine|broker|validation|scenarios|registry|compose)/,
	);
});

// --- reads ------------------------------------------------------------------

test("GET /v1/topics: full view, ?schema=false slim view, direction/service filters", async () => {
	const { req } = await boot(1);
	const full = (await (await req("/v1/topics")).json()) as {
		topics: Array<Record<string, unknown>>;
	};
	expect(full.topics.map((t) => t.topic).sort()).toEqual([
		"command/{deviceId}/set",
		"state/{deviceId}",
	]);
	for (const t of full.topics) expect(t.schema).toBeDefined();

	const slim = (await (await req("/v1/topics?schema=false")).json()) as {
		topics: Array<Record<string, unknown>>;
	};
	for (const t of slim.topics) {
		expect(t.schema).toBeUndefined(); // drops the bulky schema field ONLY
		expect(t.example).toBeDefined(); // keeps example + all else
	}

	const toClient = (await (
		await req("/v1/topics?direction=toClient")
	).json()) as { topics: Array<{ topic: string }> };
	expect(toClient.topics.map((t) => t.topic)).toEqual(["state/{deviceId}"]);
	const none = (await (await req("/v1/topics?service=ghost")).json()) as {
		topics: unknown[];
	};
	expect(none.topics).toEqual([]);
});

test("GET /v1/state: concrete retained topics only, ?topic= prefix filter, retain always true", async () => {
	const { req, post } = await boot(2);
	await post("/v1/publish", { topic: "state/thermostat-1", example: true });
	await req("/v1/pending?wait");
	const { state } = (await (await req("/v1/state")).json()) as {
		state: StateEntry[];
	};
	const entry = state.find((e) => e.topic === "state/thermostat-1");
	expect(entry).toBeDefined();
	expect(entry?.retain).toBe(true);
	expect(entry?.qos).toBe(1); // channel binding rode resolveEmit (F13)

	const filtered = (await (
		await req("/v1/state?topic=state/thermo")
	).json()) as { state: StateEntry[] };
	expect(filtered.state.length).toBe(state.length);
	const misses = (await (await req("/v1/state?topic=zzz")).json()) as {
		state: StateEntry[];
	};
	expect(misses.state).toEqual([]);
});

test("GET /v1/validation: sinceSeq strictly-greater + origin/kind/severity filters + summary", async () => {
	const { req, post } = await boot(3);
	const pub = (await (
		await post("/v1/publish", {
			topic: "command/thermostat-1/set",
			payload: { mode: "broil", target: 20 },
		})
	).json()) as { sinceSeq: number };
	const body = (await (
		await req(
			`/v1/validation?sinceSeq=${pub.sinceSeq}&origin=client&kind=schema&severity=error`,
		)
	).json()) as { violations: Violation[]; summary: { byKind: object } };
	expect(body.violations).toHaveLength(1);
	expect(body.violations[0]?.channel).toBe("command/{deviceId}/set");
	// zero-filled byKind, all four keys (contracts §5)
	expect(Object.keys(body.summary.byKind).sort()).toEqual([
		"decode",
		"direction",
		"schema",
		"unknown-topic",
	]);
	const later = (await (
		await req(`/v1/validation?sinceSeq=${pub.sinceSeq + 1}`)
	).json()) as { violations: Violation[] };
	expect(later.violations).toEqual([]); // strictly greater
});

test("GET /v1/specs: SpecInfo[] + branch resolutionMode + the version-not-honored notice", async () => {
	const specInfo = {
		service: "demo",
		source: "dev@org/demo:asyncapi.yaml",
		contentHash: "sha256:abc",
		channelCount: 2,
		fetchedAt: "2026-07-26T00:00:00Z",
		declaredVersion: "1.4.0",
	};
	const { req } = await boot(4, { parts: { specs: [specInfo] } });
	const body = (await (await req("/v1/specs")).json()) as {
		specs: unknown[];
		resolutionMode: string;
		warnings?: string[];
	};
	expect(body.specs).toEqual([specInfo]);
	expect(body.resolutionMode).toBe("branch"); // v1 is always branch mode
	expect(body.warnings?.[0]).toContain("NOT honored");
});

test("GET /v1/diagnostics: scenario-load + overlap + uninstantiated, summary zero-filled (F15)", async () => {
	const dir = scenarioDir(
		`${SCENARIOS}- name: broken\n- name: shadowed-twin\n  when:\n    topic: command/{deviceId}/set\n  then:\n    - emit:\n        topic: state/{{deviceId}}\n        payload: { deviceId: "{{deviceId}}", status: idle }\n`,
	);
	const { req, post } = await boot(5, { scenarios: dir });
	const body = (await (await req("/v1/diagnostics")).json()) as {
		diagnostics: Diagnostic[];
		summary: { errors: number; info: number; byKind: Record<string, number> };
	};
	const kinds = body.diagnostics.map((d) => d.kind);
	expect(kinds).toContain("scenario-load"); // 'broken' skipped-loud
	expect(kinds).toContain("overlap"); // ack-set shadows shadowed-twin
	expect(kinds).toContain("uninstantiated"); // state/{deviceId} has no instances yet
	expect(Object.keys(body.summary.byKind).sort()).toEqual([
		"overlap",
		"scenario-load",
		"spec-load",
		"uninstantiated",
	]);
	expect(body.summary.errors).toBeGreaterThanOrEqual(1);

	// EQ5: the notice clears once an instance materializes
	await post("/v1/publish", { topic: "state/thermostat-1", example: true });
	await req("/v1/pending?wait");
	const after = (await (await req("/v1/diagnostics")).json()) as {
		diagnostics: Diagnostic[];
	};
	expect(after.diagnostics.filter((d) => d.kind === "uninstantiated")).toEqual(
		[],
	);
});

test("GET /v1/diagnostics: the vacuous-schema spec-QUALITY flag (design §7 Mode 2)", async () => {
	const { req } = await boot(6, {
		registry: fakeRegistry([
			makeChannel("vacuous/topic", "fromClient", { type: "object" }),
			makeChannel("real/topic", "fromClient", {
				type: "object",
				required: ["a"],
				properties: { a: { type: "number" } },
			}),
		]),
		scenarios: false,
	});
	const body = (await (await req("/v1/diagnostics")).json()) as {
		diagnostics: Diagnostic[];
	};
	const flags = body.diagnostics.filter((d) => d.kind === "spec-load");
	expect(flags).toHaveLength(1);
	expect(flags[0]?.source).toBe("vacuous/topic");
	expect(flags[0]?.severity).toBe("warning");
	expect(flags[0]?.detail).toContain("constrains nothing");
});

test("GET /v1/scenarios: name · when topic · stepCount · source from the dispatch table", async () => {
	const { req } = await boot(7);
	const body = (await (await req("/v1/scenarios")).json()) as {
		scenarios: Array<Record<string, unknown>>;
	};
	expect(body.scenarios).toEqual([
		{
			name: "ack-set",
			when: "command/{deviceId}/set",
			stepCount: 1,
			source: "50-demo.yaml",
		},
		{ name: "go-offline", stepCount: 1, source: "50-demo.yaml" },
	]);
});

test("GET/POST /v1/mode: reflects flips; invalid mode → 400 bad-request envelope", async () => {
	const { req, post } = await boot(8);
	// lastResetSeq = 0 before the first reset (D-014)
	expect(await (await req("/v1/mode")).json()).toEqual({
		mode: "autonomous",
		seed: 1,
		lastResetSeq: 0,
	});
	const flipped = await post("/v1/mode", { mode: "passive" });
	expect(flipped.status).toBe(200);
	expect(await flipped.json()).toEqual({ mode: "passive", seed: 1 });
	expect(await (await req("/v1/mode")).json()).toEqual({
		mode: "passive",
		seed: 1,
		lastResetSeq: 0,
	});
	const bad = await post("/v1/mode", { mode: "chaotic" });
	expect(bad.status).toBe(400);
	expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
		"bad-request",
	);
});

test("GET /v1/pending: quiescent shape; ?wait settles; ?wait=<ms> caps", async () => {
	const { req } = await boot(9);
	expect(await (await req("/v1/pending")).json()).toEqual({
		scheduled: 0,
		settled: true,
	});
	expect(await (await req("/v1/pending?wait")).json()).toEqual({
		scheduled: 0,
		settled: true,
	});
	expect(await (await req("/v1/pending?wait=50")).json()).toEqual({
		scheduled: 0,
		settled: true,
	});
});

// --- actions -----------------------------------------------------------------

test("POST /v1/publish: byte-equal examples (GET /topics vs {example:true}) via the ONE injected faker", async () => {
	const { req, post } = await boot(10);
	const topics = (await (await req("/v1/topics")).json()) as {
		topics: Array<{ topic: string; example: unknown }>;
	};
	const viaTopics = JSON.stringify(
		topics.topics.find((t) => t.topic === "state/{deviceId}")?.example,
	);
	await post("/v1/publish", { topic: "state/thermostat-1", example: true });
	await req("/v1/pending?wait");
	const { state } = (await (await req("/v1/state")).json()) as {
		state: StateEntry[];
	};
	const emitted = state.find((e) => e.topic === "state/thermostat-1");
	// example-mode deliberately drops even the matched params (contracts §3),
	// so the emitted payload is byte-equal to the channel-level /topics example
	expect(JSON.stringify(emitted?.payload)).toBe(viaTopics);
});

test("POST /v1/publish: F5 example-drop — matched:true pairs with injected:false, L1 mock violation", async () => {
	const impossible = {
		type: "object",
		required: ["x"],
		additionalProperties: false,
		properties: { x: { type: "string", const: "A", enum: ["B"] } },
	};
	const { req, post } = await boot(11, {
		registry: fakeRegistry([makeChannel("bad/topic", "toClient", impossible)]),
		scenarios: false,
	});
	const res = await post("/v1/publish", { topic: "bad/topic", example: true });
	expect(res.status).toBe(202);
	const body = (await res.json()) as {
		injected: boolean;
		matched: boolean;
		sinceSeq: number;
	};
	expect(body).toMatchObject({ matched: true, injected: false });
	const after = (await (
		await req(`/v1/validation?sinceSeq=${body.sinceSeq}`)
	).json()) as { violations: Violation[] };
	const v = after.violations.find(
		(x) => x.origin === "mock" && x.kind === "schema",
	);
	expect(v?.emitSource?.layer).toBe("L1");
});

test("POST /v1/publish: off-contract fromClient payload delivered AND surfaced as client origin (G9)", async () => {
	const { req, post } = await boot(12);
	const res = await post("/v1/publish", {
		topic: "command/thermostat-1/set",
		payload: { mode: "broil", target: 20 },
	});
	expect(res.status).toBe(202);
	const body = (await res.json()) as { sinceSeq: number };
	expect(body).toMatchObject({
		direction: "fromClient",
		matched: true,
		injected: true,
	});
	const after = (await (
		await req(`/v1/validation?sinceSeq=${body.sinceSeq}`)
	).json()) as { violations: Violation[] };
	const v = after.violations.find((x) => x.kind === "schema");
	expect(v?.origin).toBe("client");
	expect(v?.clientId).toBe("control-plane"); // config.injectedClientId
});

test("POST /v1/publish: a valid fromClient publish re-enters onInbound and fires the reactive L2 scenario", async () => {
	const { req, post } = await boot(13);
	await post("/v1/publish", {
		topic: "command/thermostat-1/set",
		payload: { mode: "heat", target: 22 },
	});
	await req("/v1/pending?wait");
	const { state } = (await (await req("/v1/state")).json()) as {
		state: StateEntry[];
	};
	const emitted = state.find((e) => e.topic === "state/thermostat-1");
	expect(emitted).toBeDefined();
	const payload = emitted?.payload as Record<string, unknown>;
	expect(payload.status).toBe("accepted");
	expect(payload.target).toBe(22); // {{payload.target}} from the injected inbound
});

test("POST /v1/publish: unknown topic still injects raw (202) + unknown-topic violation; direction null iff unmatched", async () => {
	const { req, post } = await boot(14);
	const res = await post("/v1/publish", {
		topic: "no/such/topic",
		payload: { a: 1 },
	});
	expect(res.status).toBe(202);
	const body = (await res.json()) as { sinceSeq: number };
	expect(body).toMatchObject({
		direction: null,
		matched: false,
		injected: true,
	});
	const after = (await (
		await req(`/v1/validation?sinceSeq=${body.sinceSeq}`)
	).json()) as { violations: Violation[] };
	expect(after.violations.some((v) => v.kind === "unknown-topic")).toBe(true);
});

test("POST /v1/publish: envelope codes — example-and-payload, example-on-unknown-topic, bad-request", async () => {
	const { post } = await boot(15);
	const both = await post("/v1/publish", {
		topic: "state/x",
		payload: {},
		example: true,
	});
	expect(both.status).toBe(400);
	expect(((await both.json()) as { error: { code: string } }).error.code).toBe(
		"example-and-payload",
	);
	const unk = await post("/v1/publish", { topic: "no/such", example: true });
	expect(unk.status).toBe(400);
	expect(((await unk.json()) as { error: { code: string } }).error.code).toBe(
		"example-on-unknown-topic",
	);
	const noTopic = await post("/v1/publish", { payload: { a: 1 } });
	expect(noTopic.status).toBe(400);
	expect(
		((await noTopic.json()) as { error: { code: string } }).error.code,
	).toBe("bad-request");
});

test("POST /v1/publish: explicit qos/retain emits at the override AND fires the divergence warn-log", async () => {
	const { req, post, logs } = await boot(16);
	// state channel binding is qos 1 / retain true — override both
	await post("/v1/publish", {
		topic: "state/thermostat-1",
		example: true,
		qos: 0,
		retain: false,
	});
	await req("/v1/pending?wait");
	expect(logs.find((l) => l.includes("qos=0 overrides channel"))).toBeDefined();
	expect(
		logs.find((l) => l.includes("retain=false overrides channel")),
	).toBeDefined();
	// retain:false override means nothing landed in the retained store
	const { state } = (await (await req("/v1/state")).json()) as {
		state: StateEntry[];
	};
	expect(state).toEqual([]);
	// spec-faithful publish (no overrides) warns nothing
	logs.length = 0;
	await post("/v1/publish", { topic: "state/thermostat-1", example: true });
	expect(logs.filter((l) => l.includes("overrides channel"))).toEqual([]);
});

test("POST /v1/trigger/{name}: 202 {scenario, fired, sinceSeq}; 404 unknown-scenario envelope", async () => {
	const { req, post } = await boot(17);
	const res = await post("/v1/trigger/go-offline", {
		params: { deviceId: "t7" },
	});
	expect(res.status).toBe(202);
	const body = (await res.json()) as { scenario: string; fired: boolean };
	expect(body).toMatchObject({ scenario: "go-offline", fired: true });
	await req("/v1/pending?wait");
	const { state } = (await (await req("/v1/state")).json()) as {
		state: StateEntry[];
	};
	expect(
		(state.find((e) => e.topic === "state/t7")?.payload as { status: string })
			?.status,
	).toBe("offline");

	const missing = await post("/v1/trigger/ghost", {});
	expect(missing.status).toBe(404);
	expect(
		((await missing.json()) as { error: { code: string } }).error.code,
	).toBe("unknown-scenario");
});

test("POST /v1/reset: {reset, seed, sinceSeq}; seed change reflects in GET /v1/mode", async () => {
	const { req, post } = await boot(18);
	const res = await post("/v1/reset", {});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		reset: boolean;
		seed: number;
		sinceSeq: number;
	};
	expect(body.reset).toBe(true);
	expect(body.seed).toBe(1);
	expect(typeof body.sinceSeq).toBe("number");

	const reseeded = (await (await post("/v1/reset", { seed: 42 })).json()) as {
		seed: number;
		sinceSeq: number;
	};
	expect(reseeded.seed).toBe(42);
	// the retained baseline now mirrors the latest reset's sinceSeq (D-014)
	expect(await (await req("/v1/mode")).json()).toEqual({
		mode: "autonomous",
		seed: 42,
		lastResetSeq: reseeded.sinceSeq,
	});
	const bad = await post("/v1/reset", { seed: "nope" });
	expect(bad.status).toBe(400);
});

test("POST /v1/specs/refresh: hot-swaps the running registry through the thunk (F19)", async () => {
	const swapped = fakeRegistry([
		makeChannel("swapped/topic", "toClient", {
			type: "object",
			required: ["a"],
			properties: { a: { type: "number" } },
		}),
	]);
	const newSpecs = [
		{
			service: "demo",
			source: "dev@org/demo:asyncapi.yaml",
			contentHash: "sha256:new",
			channelCount: 1,
			fetchedAt: "2026-07-26T00:00:00Z",
		},
	];
	const { req } = await boot(19, {
		parts: {
			resolveSpecs: async () => ({ registry: swapped, specs: newSpecs }),
		},
	});
	const res = await req("/v1/specs/refresh", { method: "POST" });
	expect(res.status).toBe(200);
	expect(((await res.json()) as { specs: unknown[] }).specs).toEqual(newSpecs);
	// the swap is visible everywhere the thunk reaches
	const topics = (await (await req("/v1/topics")).json()) as {
		topics: Array<{ topic: string }>;
	};
	expect(topics.topics.map((t) => t.topic)).toEqual(["swapped/topic"]);
	const specs = (await (await req("/v1/specs")).json()) as {
		specs: unknown[];
	};
	expect(specs.specs).toEqual(newSpecs);
});
