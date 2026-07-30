// R-019 — `bootProject()` in-process (src/cli/boot.ts): the ONLY caller is
// src/cli/serve.ts, which always runs as a detached child process (`offbook
// up`), so no CLI-dispatch test ever exercises bootProject's own body —
// services.yaml/environments.yaml → ingestion → per-service registries →
// compose (contracts §5/G14). This test calls it directly: the happy path
// (a real project dir resolves to a working Composed + specs.lock written),
// the no-services.yaml fatal-boot error (design §7 Mode 1), and the F21
// unchanged-content-hash short-circuit exercised a second time through the
// resolveSpecs capability behind POST /v1/specs/refresh.
// [utest->R-019]
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProject } from "#src/cli/boot.ts";
import type { Composed } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import { gitSpecProject } from "./project-fixture.ts";

// ports unique to this file: ws 19150 / tcp 12998 / ctrl 19151
const servers: Composed[] = [];
afterEach(async () => {
	while (servers.length) await servers.pop()?.stop();
});

test("bootProject: services.yaml + environments.yaml compose a working registry, specs.lock written, F21 cache-hit re-resolve", async () => {
	const projectDir = await gitSpecProject();
	await writeFile(
		join(projectDir, "environments.yaml"),
		"environments:\n  default:\n    thermostat: '1.4.0'\n",
	);
	const config = loadConfig({
		brokerWsPort: 19150,
		brokerTcpPort: 12998,
		controlPlanePort: 19151,
	});
	const logs: string[] = [];
	const composed = await bootProject({
		projectDir,
		config,
		log: (l) => logs.push(l),
	});
	servers.push(composed);
	await composed.start();

	// the merged registry reflects the fixture's bundled thermostat spec —
	// both channels present (fromClient + toClient), so this is a real
	// composed stack, not a stub
	expect(
		composed
			.registry()
			.channels()
			.map((c) => c.topic)
			.sort(),
	).toEqual(["command/{deviceId}/set", "state/{deviceId}"]);
	expect(existsSync(join(projectDir, "specs.lock"))).toBe(true);

	// F21: a second resolve (via POST /v1/specs/refresh's injected
	// resolveSpecs capability, boot.ts lines 108-111) hits the content-hash
	// cache — same content, same compiled registry — instead of rebuilding.
	const refreshed = await composed.app.request("/v1/specs/refresh", {
		method: "POST",
	});
	expect(refreshed.status).toBe(200);
	const body = (await refreshed.json()) as {
		specs: { service: string; contentHash: string }[];
	};
	expect(body.specs).toHaveLength(1);
	expect(body.specs[0]?.service).toBe("thermostat");
	expect(body.specs[0]?.contentHash).toMatch(/^sha256:/);
	// post-refresh the swapped-in registry is still fully functional
	expect(
		composed
			.registry()
			.channels()
			.map((c) => c.topic)
			.sort(),
	).toEqual(["command/{deviceId}/set", "state/{deviceId}"]);
});

test("bootProject: no services.yaml is a fatal boot error naming `offbook init`", async () => {
	const projectDir = await mkdtemp(join(tmpdir(), "offbook-noservices-"));
	const config = loadConfig({
		brokerWsPort: 19152,
		brokerTcpPort: 12999,
		controlPlanePort: 19153,
	});
	await expect(bootProject({ projectDir, config })).rejects.toThrow(
		/offbook init/,
	);
});
