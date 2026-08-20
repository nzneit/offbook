// R-019 — `bootProject()` in-process (src/cli/boot.ts): the ONLY caller is
// src/cli/serve.ts, which always runs as a detached child process (`offbook
// up`), so no CLI-dispatch test ever exercises bootProject's own body —
// services.yaml/environments.yaml → ingestion → per-service registries →
// compose (contracts §5/G14). This test calls it directly: the happy path
// (a real project dir resolves to a working Composed + specs.lock written),
// the no-services.yaml fatal-boot error (design §7 Mode 1), and the F21
// unchanged-content-hash short-circuit exercised a second time through the
// resolveSpecs capability behind POST /v1/specs/refresh.
// [itest->R-019]
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProject } from "#src/cli/boot.ts";
import type { Composed } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import { port } from "./ports.ts";
import { gitSpecProject } from "./project-fixture.ts";

// Port BASES for this file (repo convention: unique per file): test 1 — ws
// 19150 / tcp 12998 / ctrl 19151, all three really bound; test 2 — ws 19152 /
// tcp 12999 / ctrl 19153, never bound, since bootProject rejects the missing
// services.yaml before compose(). Those are allocation bases, not necessarily
// the ports bound at runtime: each goes through port() from test/ports.ts,
// which maps it into this process's claimed band. Band 0 (a normal local run)
// is the identity map, so the numbers here are what you will see; a concurrent
// run claims a higher band and the same bases land elsewhere.
const servers: Composed[] = [];
afterEach(async () => {
	while (servers.length) await servers.pop()?.stop();
});

test("bootProject: services.yaml + environments.yaml compose a working registry, specs.lock written, F21 cache-hit re-resolve", async () => {
	const projectDir = await gitSpecProject();
	try {
		await writeFile(
			join(projectDir, "environments.yaml"),
			"environments:\n  default:\n    thermostat: '1.4.0'\n",
		);
		const config = loadConfig({
			brokerWsPort: port(19150),
			brokerTcpPort: port(12998),
			controlPlanePort: port(19151),
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

		// baseline contentHash from the INITIAL resolve, read back over the wire
		const before = (await (await composed.app.request("/v1/specs")).json()) as {
			specs: { service: string; contentHash: string }[];
		};
		expect(before.specs).toHaveLength(1);
		expect(before.specs[0]?.service).toBe("thermostat");
		expect(before.specs[0]?.contentHash).toMatch(/^sha256:/);

		// the SAME Channel instance the pre-refresh registry hands out for this
		// topic — the fact a genuine cache hit and an unconditional rebuild
		// disagree on, captured before the refresh below
		const channelBefore = composed
			.registry()
			.channels()
			.find((c) => c.topic === "state/{deviceId}");
		expect(channelBefore).toBeDefined();

		// F21: a second resolve (via POST /v1/specs/refresh's injected
		// resolveSpecs capability) hits the content-hash cache — same content,
		// same compiled registry — instead of rebuilding. The two checks below
		// prove two different things. Hash equality is the wire-level check
		// only: resolveServices computes contentHash upstream of the
		// compiled-registry cache (src/cli/boot.ts), so equality here proves
		// content stability across resolves but would still pass even if the
		// cache were deleted outright. The channel-identity check further down
		// (toBe, not toEqual) is the actual proof the cache hit skipped
		// buildRegistry: buildRegistry mints a fresh Channel object on every
		// compile, and mergeRegistries flatMaps those objects straight through
		// (src/registry/index.ts), so only a genuine cache hit — never an
		// unconditional rebuild that happens to reproduce the same hash — can
		// hand back the SAME Channel instance.
		const refreshed = await composed.app.request("/v1/specs/refresh", {
			method: "POST",
		});
		expect(refreshed.status).toBe(200);
		const body = (await refreshed.json()) as {
			specs: { service: string; contentHash: string }[];
		};
		expect(body.specs).toHaveLength(1);
		expect(body.specs[0]?.service).toBe("thermostat");
		expect(body.specs[0]?.contentHash).toBe(before.specs[0]?.contentHash);
		// post-refresh the swapped-in registry is still fully functional
		expect(
			composed
				.registry()
				.channels()
				.map((c) => c.topic)
				.sort(),
		).toEqual(["command/{deviceId}/set", "state/{deviceId}"]);
		const channelAfter = composed
			.registry()
			.channels()
			.find((c) => c.topic === "state/{deviceId}");
		expect(channelAfter).toBe(channelBefore);

		// the `log` callback bootProject was given is exercised for real, not
		// just plumbed through unused: control-plane's tier-3 divergence warn
		// (an explicit qos overriding the channel's spec-bound qos) runs
		// through that same sink, so a deliberately off-spec /publish must
		// show up in `logs`.
		const publishResp = await composed.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				topic: "state/thermostat-1",
				payload: {
					deviceId: "thermostat-1",
					status: "idle",
					target: 20,
					units: "C",
				},
				qos: 0,
			}),
		});
		expect(publishResp.status).toBe(202);
		expect(logs.some((l) => l.includes("off-spec emit"))).toBe(true);
	} finally {
		await rm(projectDir, { recursive: true, force: true });
	}
});

test("bootProject: no services.yaml is a fatal boot error naming `offbook init`", async () => {
	const projectDir = await mkdtemp(join(tmpdir(), "offbook-noservices-"));
	try {
		const config = loadConfig({
			brokerWsPort: port(19152),
			brokerTcpPort: port(12999),
			controlPlanePort: port(19153),
		});
		await expect(bootProject({ projectDir, config })).rejects.toThrow(
			/offbook init/,
		);
	} finally {
		await rm(projectDir, { recursive: true, force: true });
	}
});
