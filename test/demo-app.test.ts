import { expect, test } from "bun:test";
// R-033 — demo-app: build smoke, proxy server, pure UI logic
// (docs/specs/demo-app.md §5/§8).
// [itest->R-033]
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDemoAppServer,
	parseFingerprintLines,
} from "#demo-app/server.ts";
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
	expect((bundle?.connect?.ws as { path: string }).path).toBe("/");
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
	} finally {
		server.stop(true);
		deadServer.stop(true);
		await composed.stop();
		await rm(dir, { recursive: true, force: true });
	}
}, 30_000);
