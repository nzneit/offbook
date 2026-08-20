// R-040 — the compose-root contradiction warn-log: an L3 initialState handler
// on an initialState:false channel wins, loudly; re-checked after a specs
// refresh swaps the registry.
// [utest->R-040]
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { type Composed, compose } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import type { Channel, SpecRegistry } from "#src/model/index.ts";
import { port } from "#test/ports.ts";

const servers: Composed[] = [];
afterEach(async () => {
	while (servers.length) await servers.pop()?.stop();
});

function chan(topic: string, initialState?: boolean): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile({
		type: "object",
	});
	return {
		topic,
		direction: "toClient",
		service: "t",
		schema: { type: "object" },
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos: 1,
		retain: false,
		initialState,
	};
}

function regOf(...channels: Channel[]): SpecRegistry {
	return {
		diagnostics: () => [],
		channels: () => channels,
		match: (topic) => {
			const c = channels.find((ch) => ch.topic === topic);
			return c ? { channel: c, params: {} } : undefined;
		},
		matchesFilter: () => false,
	};
}

test("contradiction warn-log: fires for a flagged channel's initialState handler, stays silent otherwise, re-checks on refresh", async () => {
	const dir = mkdtempSync(join(tmpdir(), "offbook-r040-handlers-"));
	const dispatchPath = new URL("../engine/dispatch.ts", import.meta.url)
		.pathname;
	writeFileSync(
		join(dir, "10-quiet.ts"),
		[
			`import { register } from "${dispatchPath}";`,
			`register("alerts/off", () => ({ initialState() {} }));`,
			`register("alerts/on", () => ({ initialState() {} }));`,
			"",
		].join("\n"),
	);
	const logs: string[] = [];
	const server = await compose({
		config: loadConfig({
			// Port BASES for this file (repo convention: unique per file), all
			// three really bound by compose().start(). They are allocation bases,
			// not necessarily the ports bound at runtime: port() (test/ports.ts)
			// maps each into this process's claimed band, and band 0 (a normal
			// local run) is the identity map.
			brokerWsPort: port(18120),
			brokerTcpPort: port(12920),
			controlPlanePort: port(18920),
		}),
		registry: regOf(chan("alerts/off"), chan("alerts/on")), // unflagged at boot
		handlersDir: dir,
		resolveSpecs: async () => ({
			registry: regOf(chan("alerts/off", false), chan("alerts/on")),
			specs: [],
		}),
		log: (l) => logs.push(l),
	});
	servers.push(server);
	await server.start();
	// boot registry is unflagged: no contradiction line
	expect(logs.filter((l) => l.includes("the handler wins"))).toEqual([]);
	// refresh swaps in the flagged registry: the re-check fires exactly once,
	// naming the flagged channel and the handler file — never the unflagged one
	await server.app.request("/v1/specs/refresh", { method: "POST" });
	const lines = logs.filter((l) => l.includes("the handler wins"));
	expect(lines.length).toBe(1);
	expect(lines[0]).toContain("'alerts/off'");
	expect(lines[0]).toContain("10-quiet.ts");
	expect(lines[0]).toContain("initialState: false");
	expect(lines.some((l) => l.includes("'alerts/on'"))).toBe(false);
});
