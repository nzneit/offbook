// R-033 — `offbook demo --serve` + bootDemo (docs/specs/demo-app.md §4):
// bundled spec + bundled chain scenarios over the standard machinery.
// [itest->R-033]
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAsync } from "mqtt";
import { parseFingerprintLines } from "#demo-app/server.ts";
import { bootDemo } from "#src/cli/boot.ts";
import { run } from "#src/cli/index.ts";
import { logPath, readRunfile } from "#src/cli/runfile.ts";
import { loadConfig } from "#src/config/index.ts";
import type { StateEntry } from "#src/model/index.ts";

test("bootDemo composes the bundled spec + chain scenarios; a heat command chains to heating", async () => {
	// in-process ports: ws 19110 / tcp 12991 / ctrl 19891
	const config = loadConfig({
		brokerWsPort: 19110,
		brokerTcpPort: 12991,
		controlPlanePort: 19891,
		mode: "passive", // reactive scenarios still fire; no autonomous ticks
		wallClock: false, // virtual clock — the 100-900ms delays are instant
	});
	const composed = await bootDemo({ config });
	await composed.start();
	try {
		const scenarios = (await (
			await composed.app.request("/v1/scenarios")
		).json()) as { scenarios: { name: string }[] };
		expect(scenarios.scenarios.map((s) => s.name).sort()).toEqual([
			"set-cool",
			"set-heat",
			"set-off",
		]);
		// seedInstances gave the demo device retained initial state at boot
		const state0 = (await (await composed.app.request("/v1/state")).json()) as {
			state: StateEntry[];
		};
		expect(state0.state.some((e) => e.topic === "state/thermostat-1")).toBe(
			true,
		);

		await composed.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				topic: "command/thermostat-1/set",
				payload: { mode: "heat", target: 23 },
			}),
		});
		await composed.app.request("/v1/pending?wait");
		const state = (await (await composed.app.request("/v1/state")).json()) as {
			state: StateEntry[];
		};
		const final = state.state.find((e) => e.topic === "state/thermostat-1");
		expect((final?.payload as { status: string } | undefined)?.status).toBe(
			"heating",
		);
		expect((final?.payload as { target: number } | undefined)?.target).toBe(23);
	} finally {
		await composed.stop();
	}
}, 30_000);

test("demo --serve: detached boot, fingerprint line in offbook.log, down cleans up", async () => {
	// spawned ports: ws 19111 / tcp 12992 / ctrl 19892
	const dir = mkdtempSync(join(tmpdir(), "offbook-demo-serve-"));
	const runDir = join(dir, ".offbook");
	const flags = [
		"--run-dir",
		runDir,
		"--ws-port",
		"19111",
		"--tcp-port",
		"12992",
		"--ctrl-port",
		"19892",
	];
	const out: string[] = [];
	const errs: string[] = [];
	try {
		const code = await run(["demo", "--serve", ...flags], {
			out: (l) => out.push(l),
			err: (l) => errs.push(l),
		});
		if (code !== 0) throw new Error(`demo --serve failed:\n${errs.join("\n")}`);
		expect(out.join("\n")).toContain("ws://localhost:19111");

		// the bundled scenarios are live on the spawned server
		const scenarios = (await (
			await fetch("http://localhost:19892/v1/scenarios")
		).json()) as { scenarios: { name: string }[] };
		expect(scenarios.scenarios.map((s) => s.name)).toContain("set-heat");

		// a real ws client's connect lands as a ws-connect line in offbook.log
		const client = await connectAsync("ws://localhost:19111", {
			forceNativeWebSocket: true,
			reconnectPeriod: 0,
			clientId: "demo-serve-probe",
		});
		await client.endAsync();
		let logged = "";
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			logged = await Bun.file(logPath(runDir))
				.text()
				.catch(() => "");
			if (logged.includes("ws-connect ")) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const line = logged
			.split("\n")
			.find((l) => l.includes("ws-connect ") && l.includes("demo-serve-probe"));
		expect(line).toBeDefined();

		// weld: the REAL log parses through the same function the proxy uses
		expect(
			parseFingerprintLines(logged, "demo-serve-probe")?.connect,
		).toBeDefined();

		expect(
			await run(["down", "--run-dir", runDir], {
				out: () => {},
				err: () => {},
			}),
		).toBe(0);
	} finally {
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);
