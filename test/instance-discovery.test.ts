// [itest->R-044] [itest->R-045]
// Instance discovery integration: serve.ts boot-contract fatals here;
// the state-table row suite lands in this file in a later task.
// Ports for this file (repo convention: unique per file): 19430-19449,
// tcp 12490-12495 (bound by the real `up` runs below).
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "#src/cli/index.ts";
import { run, shouldClearFailedBoot } from "#src/cli/index.ts";
import { pointerPath } from "#src/cli/registry.ts";
import { readRunfile } from "#src/cli/runfile.ts";
import { gitSpecProject } from "./project-fixture.ts";

const SERVE = join(import.meta.dir, "../src/cli/serve.ts");

async function spawnServe(
	boot: object,
): Promise<{ code: number; err: string }> {
	const dir = mkdtempSync(join(tmpdir(), "offbook-serve-fatal-"));
	const bootPath = join(dir, "offbook.boot.json");
	await Bun.write(bootPath, JSON.stringify(boot));
	const proc = Bun.spawn([process.execPath, SERVE, bootPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	const err = await new Response(proc.stderr).text();
	rmSync(dir, { recursive: true, force: true });
	return { code, err };
}

// [itest->R-044]
test("serve: a relative runDir in the boot file is a fatal boot error (no ports bound)", async () => {
	const { code, err } = await spawnServe({
		projectDir: "/tmp/nowhere",
		config: { runDir: ".offbook" },
		demo: true,
		token: "aa".repeat(16),
	});
	expect(code).toBe(1);
	expect(err).toContain("relative runDir");
	expect(err).toContain("offbook up");
}, 20_000);

// [itest->R-044]
test("serve: a missing launch token is a fatal boot error", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "offbook-serve-notoken-"));
	const { code, err } = await spawnServe({
		projectDir: "/tmp/nowhere",
		config: { runDir },
		demo: true,
	});
	expect(code).toBe(1);
	expect(err).toContain("no launch token");
	rmSync(runDir, { recursive: true, force: true });
}, 20_000);

function io(): { out: string[]; err: string[]; io: Io } {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

// [itest->R-044] [itest->R-045]
test("up bakes identity: boot file token + absolute paths; /v1/server answers it; runfile + pointer agree; down unregisters", async () => {
	const projectDir = await gitSpecProject();
	const runDir = join(projectDir, ".offbook");
	const prevCwd = process.cwd();
	const state = mkdtempSync(join(tmpdir(), "offbook-idstate-"));
	const prevState = process.env.OFFBOOK_STATE_DIR;
	process.env.OFFBOOK_STATE_DIR = state;
	process.chdir(projectDir);
	try {
		const x = io();
		expect(
			await run(
				[
					"up",
					"--ci",
					"--ws-port",
					"19430",
					"--tcp-port",
					"12490",
					"--ctrl-port",
					"19431",
				],
				x.io,
			),
		).toBe(0);
		const boot = JSON.parse(
			await Bun.file(join(runDir, "offbook.boot.json")).text(),
		) as { token?: string; projectDir?: string; config?: { runDir?: string } };
		expect(boot.token).toMatch(/^[0-9a-f]{32}$/);
		expect(boot.projectDir?.startsWith("/")).toBe(true);
		expect(boot.config?.runDir?.startsWith("/")).toBe(true);
		const identity = (await (
			await fetch("http://localhost:19431/v1/server")
		).json()) as {
			token: string;
			runDir: string;
			projectDir: string;
			demo: boolean;
		};
		expect(identity.token).toBe(boot.token as string);
		expect(identity.demo).toBe(false);
		const runfile = await readRunfile(runDir);
		expect(runfile?.token).toBe(boot.token);
		expect(typeof runfile?.host).toBe("string");
		expect(existsSync(pointerPath(state, runDir))).toBe(true);
		expect(await run(["down"], io().io)).toBe(0);
		expect(existsSync(pointerPath(state, runDir))).toBe(false); // no leftover pointer
	} finally {
		process.chdir(prevCwd);
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		process.env.OFFBOOK_STATE_DIR = prevState;
		rmSync(state, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 90_000);

// [itest->R-045]
test("up with an unwritable state dir prints the could-not-record note and still serves (M17)", async () => {
	const projectDir = await gitSpecProject();
	const runDir = join(projectDir, ".offbook");
	const prevCwd = process.cwd();
	const blocked = mkdtempSync(join(tmpdir(), "offbook-blocked-"));
	const blockedFile = join(blocked, "state-is-a-file");
	await Bun.write(blockedFile, "x");
	const prevState = process.env.OFFBOOK_STATE_DIR;
	process.env.OFFBOOK_STATE_DIR = blockedFile;
	process.chdir(projectDir);
	try {
		const x = io();
		expect(
			await run(
				[
					"up",
					"--ci",
					"--ws-port",
					"19432",
					"--tcp-port",
					"12491",
					"--ctrl-port",
					"19433",
				],
				x.io,
			),
		).toBe(0);
		expect(x.err.join("\n")).toContain(
			"(offbook: could not record this instance for manage-from-anywhere",
		);
		expect(await run(["down"], io().io)).toBe(0);
	} finally {
		process.chdir(prevCwd);
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		process.env.OFFBOOK_STATE_DIR = prevState;
		rmSync(blocked, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 90_000);

// [utest->R-044] — guarded site #4's precondition, pinned pure (the
// concurrent-up race cannot be staged against a real 30s boot)
test("shouldClearFailedBoot: our dead spawn clears; a repointed runfile or another token on the port survives", () => {
	const spawned = { pid: 41, token: "cc".repeat(16) };
	const ours = {
		pid: 41,
		brokerWsPort: 1,
		brokerTcpPort: 2,
		controlPlanePort: 3,
		startedAt: "t",
		token: spawned.token,
	};
	const silent = { kind: "silent" as const };
	// our own failed boot: clear
	expect(shouldClearFailedBoot(spawned, { run: ours, probe: silent })).toBe(
		true,
	);
	// a concurrent up repointed the runfile: its registration survives
	expect(
		shouldClearFailedBoot(spawned, {
			run: { ...ours, pid: 42, token: "dd".repeat(16) },
			probe: silent,
		}),
	).toBe(false);
	// the runfile is already gone: nothing to clear
	expect(
		shouldClearFailedBoot(spawned, { run: undefined, probe: silent }),
	).toBe(false);
	// another launch answers the port: the winner survives
	expect(
		shouldClearFailedBoot(spawned, {
			run: ours,
			probe: {
				kind: "server",
				identity: {
					pid: 43,
					token: "ee".repeat(16),
					host: "h",
					projectDir: "/w",
					runDir: "/w/.offbook",
					startedAt: "t",
					demo: false,
					ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 3 },
				},
			},
		}),
	).toBe(false);
	// a legacy probe (pre-D-032 answerer) is never a concurrent-up winner; the clear proceeds
	expect(
		shouldClearFailedBoot(spawned, { run: ours, probe: { kind: "legacy" } }),
	).toBe(true);
	// pid mismatch: the runfile was repointed or corrupted
	expect(
		shouldClearFailedBoot(spawned, {
			run: { ...ours, pid: 42 },
			probe: silent,
		}),
	).toBe(false);
	// token mismatch: the runfile was repointed or corrupted
	expect(
		shouldClearFailedBoot(spawned, {
			run: { ...ours, token: "dd".repeat(16) },
			probe: silent,
		}),
	).toBe(false);
});
