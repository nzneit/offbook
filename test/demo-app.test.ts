import { expect, test } from "bun:test";
// R-033 — demo-app: build smoke, proxy server, pure UI logic
// (docs/specs/demo-app.md §5/§8).
// [itest->R-033]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDemoAppServer,
	parseFingerprintLines,
} from "#demo-app/server.ts";
import { buildCapture } from "#demo-app/src/capture.ts";
import { checklistReduce, initialChecklist } from "#demo-app/src/checklist.ts";
import { distinctRows } from "#demo-app/src/distinct.ts";
import { compose } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import { buildRegistry } from "#src/registry/index.ts";

test("the webapp bundles for the browser with zero unresolved imports", async () => {
	const result = await Bun.build({
		entrypoints: ["demo-app/src/main.tsx"],
		target: "browser",
	});
	expect(result.logs.filter((l) => l.level === "error")).toEqual([]);
	expect(result.success).toBe(true);
	expect(result.outputs.length).toBeGreaterThan(0);
}, 30_000);

const SAMPLE_LOG = [
	"[offbook] 2026-07-26T10:00:00.000Z listening — http :9080 · ws :9001 · tcp :1883 · mode autonomous · seed 42",
	'[offbook] 2026-07-26T10:00:05.000Z ws-connect {"clientId":"demo-app-x1","protocolLevel":4,"passwordPresent":false,"keepalive":60,"clean":true,"ws":{"path":"/","subprotocolsOffered":["mqtt"],"subprotocolSelected":"mqtt"}}',
	'[offbook] 2026-07-26T10:00:05.100Z mqtt-subscribe {"clientId":"demo-app-x1","topic":"state/#","qos":1}',
	'[offbook] 2026-07-26T10:00:06.000Z mqtt-publish {"clientId":"demo-app-x1","qos":1,"retain":false}',
	'[offbook] 2026-07-26T10:00:07.000Z ws-connect {"clientId":"someone-else","passwordPresent":false,"ws":{"path":"/","subprotocolsOffered":[]}}',
].join("\n");

test("parseFingerprintLines: filters by clientId, groups by kind, survives junk", () => {
	const bundle = parseFingerprintLines(SAMPLE_LOG, "demo-app-x1");
	expect(bundle?.connect?.protocolLevel).toBe(4);
	expect((bundle?.connect?.ws as { path: string } | undefined)?.path).toBe("/");
	expect(bundle?.subscribes).toEqual([
		{ clientId: "demo-app-x1", topic: "state/#", qos: 1 },
	]);
	expect(bundle?.publishes).toEqual([
		{ clientId: "demo-app-x1", qos: 1, retain: false },
	]);
	expect(parseFingerprintLines(SAMPLE_LOG, "nobody")).toBeUndefined();
	expect(
		parseFingerprintLines("garbage\nws-connect notjson{", "x"),
	).toBeUndefined();
	const tornJson = "[offbook] 2026-07-26T10:00:08.000Z ws-connect {bad: json}";
	expect(parseFingerprintLines(tornJson, "demo-app-x1")).toBeUndefined();
	const withTorn = `${SAMPLE_LOG}\n${tornJson}`;
	expect(parseFingerprintLines(withTorn, "demo-app-x1")?.subscribes).toEqual([
		{ clientId: "demo-app-x1", topic: "state/#", qos: 1 },
	]);
});

test("proxy: /v1 pass-through when offbook is up; 502 when unreachable; /spike/fingerprint 200/404", async () => {
	// compose on ws 19112 / tcp 12993 / ctrl 19893; demo-app on 19991
	const config = loadConfig({
		brokerWsPort: 19112,
		brokerTcpPort: 12993,
		controlPlanePort: 19893,
	});
	const registry = await buildRegistry({
		specText: await Bun.file("src/demo/thermostat.yaml").text(),
		service: "demo",
		config,
	});
	const composed = await compose({ config, registry });
	await composed.start();
	const dir = mkdtempSync(join(tmpdir(), "offbook-demo-app-"));
	writeFileSync(join(dir, "offbook.log"), SAMPLE_LOG);
	const server = createDemoAppServer({
		port: 19991,
		ctrlPort: 19893,
		runDir: dir,
	});
	// a second demo-app pointing at a dead control port for the 502 case
	const deadServer = createDemoAppServer({
		port: 19992,
		ctrlPort: 19899,
		runDir: dir,
	});
	try {
		const mode = (await (
			await fetch("http://localhost:19991/v1/mode")
		).json()) as { mode: string };
		expect(mode.mode).toBe("autonomous");

		const dead = await fetch("http://localhost:19992/v1/mode");
		expect(dead.status).toBe(502);
		expect(await dead.json()).toEqual({ error: "offbook-unreachable" });

		const fp = await fetch(
			"http://localhost:19991/spike/fingerprint?clientId=demo-app-x1",
		);
		expect(fp.status).toBe(200);
		const bundle = (await fp.json()) as { subscribes: unknown[] };
		expect(bundle.subscribes).toHaveLength(1);

		const none = await fetch(
			"http://localhost:19991/spike/fingerprint?clientId=nobody",
		);
		expect(none.status).toBe(404);
		expect(await none.json()).toEqual({ error: "no-fingerprint" });

		const index = await fetch("http://localhost:19991/");
		expect(index.status).toBe(200);
		expect(await index.text()).toContain('<div id="root">');

		const posted = await fetch("http://localhost:19991/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ topic: "state/thermostat-1", example: true }),
		});
		expect(posted.status).toBe(202);
		const postedBody = (await posted.json()) as {
			matched: boolean;
			injected: boolean;
		};
		expect(postedBody.matched).toBe(true);
		expect(postedBody.injected).toBe(true);
	} finally {
		server.stop(true);
		deadServer.stop(true);
		await composed.stop();
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);

test("static routes: /, /main.js, and the catch-all 404", async () => {
	const root = mkdtempSync(join(tmpdir(), "demo-app-root-"));
	mkdirSync(join(root, "dist"));
	writeFileSync(join(root, "index.html"), '<div id="root"></div>');
	writeFileSync(join(root, "dist/main.js"), "// stub bundle");
	const server = createDemoAppServer({
		port: 19993,
		ctrlPort: 19899,
		runDir: root,
		root,
	});
	try {
		expect(await (await fetch("http://localhost:19993/")).text()).toContain(
			'<div id="root">',
		);
		const js = await fetch("http://localhost:19993/main.js");
		expect(js.status).toBe(200);
		expect(await js.text()).toBe("// stub bundle");
		expect((await fetch("http://localhost:19993/nope")).status).toBe(404);
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});

test("checklist: events check items off; reconnects count without unchecking", () => {
	let s = initialChecklist;
	s = checklistReduce(s, { type: "ws-upgrade" });
	s = checklistReduce(s, { type: "connack" });
	s = checklistReduce(s, { type: "suback", qos: 1 });
	expect(s.done["ws-upgrade"]).toBe(true);
	expect(s.done.connack).toBe(true);
	expect(s.done.suback).toBe(true);
	expect(s.grantedQos).toBe(1);
	expect(s.done.retained).toBe(false);
	s = checklistReduce(s, { type: "reconnect" });
	expect(s.reconnects).toBe(1);
	expect(s.done.connack).toBe(true); // history is not rewritten
});

test("distinctRows collapses repeats on origin·kind·channel·instancePath·keyword", () => {
	const v = (seq: number, kind: string, instancePath = "/mode") => ({
		seq,
		origin: "client",
		kind,
		topic: "command/thermostat-1/set",
		channel: "command/{deviceId}/set",
		detail: "x",
		errors: [{ instancePath, keyword: "enum", message: "must be equal" }],
	});
	const rows = distinctRows([v(2, "schema"), v(3, "decode"), v(1, "schema")]);
	expect(rows).toHaveLength(2);
	// row order: descending by latest seq (decode seq 3 first)
	expect(rows.map((r) => r.latest.kind)).toEqual(["decode", "schema"]);
	const schema = rows.find((r) => r.latest.kind === "schema");
	expect(schema?.count).toBe(2);
	expect(schema?.latest.seq).toBe(2); // latest wins by seq, not by array position
});

test("buildCapture: server view wins, client options fill, qos/retain from observations", () => {
	const capture = buildCapture({
		clientOptions: {
			wsUrl: "ws://localhost:9001",
			clientId: "demo-app-abc",
			protocolVersion: 4,
			keepalive: 60,
			clean: true,
			username: undefined,
			passwordPresent: false,
		},
		probe: { subprotocolSelected: "mqtt" },
		fingerprint: {
			connect: {
				clientId: "demo-app-abc",
				protocolLevel: 4,
				keepalive: 30,
				clean: false,
				username: "alice",
				passwordPresent: false,
				ws: {
					path: "/",
					subprotocolsOffered: ["mqtt"],
					subprotocolSelected: "mqtt",
				},
			},
			subscribes: [{ clientId: "demo-app-abc", topic: "state/#", qos: 1 }],
			publishes: [{ clientId: "demo-app-abc", qos: 1, retain: false }],
		},
	});
	expect(capture).toMatchObject({
		source: "demo-app",
		wsUrl: "ws://localhost:9001",
		path: "/",
		subprotocol: "mqtt",
		protocolLevel: 4,
		clientIdPattern: "demo-app-*",
		auth: { username: "alice", passwordPresent: false },
		keepalive: 30,
		clean: false,
		qosUsed: [1],
		retainUsed: false,
	});
	expect(typeof capture.capturedAt).toBe("string");

	const fallback = buildCapture({
		clientOptions: {
			wsUrl: "ws://localhost:9001",
			clientId: "mqttjs_ab12",
			protocolVersion: 4,
			keepalive: 60,
			clean: true,
			passwordPresent: false,
		},
		probe: { subprotocolSelected: "mqtt" },
	});
	expect(fallback).toMatchObject({
		subprotocol: "mqtt", // probe fills when no fingerprint
		keepalive: 60,
		clean: true,
		clientIdPattern: "mqttjs_ab12*", // literal prefix, never bare "*"
		qosUsed: [],
		retainUsed: false,
	});
});
