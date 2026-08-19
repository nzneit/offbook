// [itest->R-044] [itest->R-045]
// Instance discovery integration: serve.ts boot-contract fatals here;
// the state-table row suite lands in this file in a later task.
// Ports for this file (repo convention: unique per file): 19430-19449,
// tcp 12490-12495 (bound by the real `up` runs below).
//
// State-table checklist (spec "The instance state table") — where each row
// is pinned:
//   row 1  cwd+token       src/cli/resolve.test.ts "row 1" + the up-bakes-identity test here
//   row 2  cwd+legacy      src/cli/resolve.test.ts "row 2" + "row 2 machine-wide" here
//   row 3  cwd+silent      src/cli/resolve.test.ts "row 3" + cli-dispatch M12 test
//   row 4  cwd wrong-token src/cli/resolve.test.ts "row 4"
//   row 5  cwd dead pid    src/cli/resolve.test.ts "row 5"
//   row 6  pointer+token   src/cli/resolve.test.ts "rows 6-8" + verb-policy tests in cli-dispatch
//   row 7  pointer skipped "rows 6-8" (silent) + "row 7 wrong-token pointer" here
//   row 8  pointer dead    "rows 6-8" (reap)
//   row 9  runfile missing src/cli/resolve.test.ts "row 9" (both branches)
//   row 10 foreign host    src/cli/resolve.test.ts (explicit path) + "row 10 foreign pointer" here
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Io } from "#src/cli/index.ts";
import { run, shouldClearFailedBoot } from "#src/cli/index.ts";
import { canonicalPath, pointerPath } from "#src/cli/registry.ts";
import { resolveInstance } from "#src/cli/resolve.ts";
import { readRunfile, writeRunfile } from "#src/cli/runfile.ts";
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

// [itest->R-046]
test("up <missing-dir> and up <file> refuse with the not-a-directory hint BEFORE any write", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "offbook-updir-"));
	const prevCwd = process.cwd();
	process.chdir(cwd);
	try {
		const missing = io();
		expect(await run(["up", "nope"], missing.io)).toBe(1);
		expect(missing.err.join("\n")).toContain(
			"is not a directory — pass your project directory",
		);
		expect(existsSync(join(cwd, "nope"))).toBe(false); // no mkdir happened
		expect(existsSync(join(cwd, ".offbook"))).toBe(false); // and no boot file anywhere

		await Bun.write(join(cwd, "a-file"), "x");
		const file = io();
		expect(await run(["up", "a-file"], file.io)).toBe(1);
		expect(file.err.join("\n")).toContain("is not a directory");
	} finally {
		process.chdir(prevCwd);
		rmSync(cwd, { recursive: true, force: true });
	}
});

// [itest->R-046]
test("up <dir>: projectDir + runDir land under the positional; a later status from the parent resolves to it", async () => {
	const projectDir = await gitSpecProject();
	const parent = dirname(projectDir);
	const dir = basename(projectDir);
	const runDir = join(projectDir, ".offbook");
	const prevCwd = process.cwd();
	const state = mkdtempSync(join(tmpdir(), "offbook-updir-state-"));
	const prevState = process.env.OFFBOOK_STATE_DIR;
	process.env.OFFBOOK_STATE_DIR = state;
	process.chdir(parent); // the flagship flow: up mock from /app
	try {
		const x = io();
		expect(
			await run(
				[
					"up",
					dir,
					"--ci",
					"--ws-port",
					"19434",
					"--tcp-port",
					"12492",
					"--ctrl-port",
					"19435",
				],
				x.io,
			),
		).toBe(0);
		expect(existsSync(join(parent, ".offbook"))).toBe(false); // never a second runDir at the launch cwd
		const boot = JSON.parse(
			await Bun.file(join(runDir, "offbook.boot.json")).text(),
		) as { projectDir?: string; config?: { runDir?: string } };
		expect(boot.projectDir).toBe(projectDir);
		expect(boot.config?.runDir).toBe(runDir);
		const identity = (await (
			await fetch("http://localhost:19435/v1/server")
		).json()) as { projectDir: string; runDir: string };
		expect(identity.projectDir).toBe(projectDir);
		// status from the parent: the strict-descendant tiebreak names it
		const s = io();
		expect(await run(["status"], s.io)).toBe(0);
		expect(s.out[0]).toContain(`offbook @ ${projectDir}`);
		expect(await run(["down", "--run-dir", runDir], io().io)).toBe(0);
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
test("row 7: a pointer-found wrong-token instance is skipped and disclosed, never silence, never touched", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-row7-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-row7-cwd-"));
	const state = mkdtempSync(join(tmpdir(), "offbook-row7-state-"));
	const runDir = join(proj, ".offbook");
	await writeRunfile(
		runDir,
		{
			pid: process.pid,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 19436,
			startedAt: "t",
			token: "e1".repeat(16),
			host: hostname(),
		},
		{ stateDir: state },
	);
	// the port answers as a DIFFERENT offbook (token mismatch)
	const identity = {
		pid: process.pid,
		token: "e2".repeat(16),
		host: hostname(),
		projectDir: "/somewhere/else",
		runDir: "/somewhere/else/.offbook",
		startedAt: "t",
		demo: false,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 19436 },
	};
	const server = Bun.serve({
		port: 19436,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/server"
				? Response.json(identity)
				: new Response("nope", { status: 404 }),
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved).toBeUndefined();
		expect(res.skipped.map((s) => s.reason)).toEqual(["wrong-token"]);
		expect(existsSync(pointerPath(state, runDir))).toBe(true); // kept
		expect(existsSync(join(runDir, "offbook.run"))).toBe(true); // kept
	} finally {
		server.stop(true);
		for (const d of [proj, cwd, state])
			rmSync(d, { recursive: true, force: true });
	}
});

// [itest->R-045]
test("row 10: a foreign-host pointer is inert — never a candidate, never reaped", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-row10-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-row10-cwd-"));
	const state = mkdtempSync(join(tmpdir(), "offbook-row10-state-"));
	// hand-write a pointer claiming another machine (its runDir does not
	// even exist here — exactly the shared-network-home shape)
	const foreignRun = canonicalPath(join(proj, "gone", ".offbook"));
	const name = `${createHash("sha256").update(foreignRun).digest("hex")}.json`;
	mkdirSync(join(state, "instances"), { recursive: true });
	await Bun.write(
		join(state, "instances", name),
		JSON.stringify({ v: 1, runDir: foreignRun, host: "some-other-machine" }),
	);
	const res = await resolveInstance({ cwd, stateDir: state });
	expect(res.resolved).toBeUndefined();
	expect(res.foreignSeen).toBe(true);
	expect(existsSync(join(state, "instances", name))).toBe(true); // never reaped
	for (const d of [proj, cwd, state])
		rmSync(d, { recursive: true, force: true });
});

// [itest->R-045]
test("row 2 machine-wide: a legacy instance discovered via pointer surfaces as skipped (M13), never silence", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-row2mw-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-row2mw-cwd-"));
	const state = mkdtempSync(join(tmpdir(), "offbook-row2mw-state-"));
	const runDir = join(proj, ".offbook");
	await writeRunfile(
		runDir,
		{
			pid: process.pid,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 19437,
			startedAt: "t",
		},
		{ stateDir: state },
	);
	const legacy = Bun.serve({
		port: 19437,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/mode"
				? Response.json({ mode: "autonomous" })
				: new Response("nope", { status: 404 }),
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved).toBeUndefined(); // legacy proves nothing machine-wide
		expect(res.skipped).toHaveLength(1); // ...but is DISCLOSED, not silent
	} finally {
		legacy.stop(true);
		for (const d of [proj, cwd, state])
			rmSync(d, { recursive: true, force: true });
	}
});

// [itest->R-044] — the launch-token granularity, pinned end to end: the
// token is the LINEAGE's (constant across --watch respawns), the pid the
// incarnation's; absolute boot-file paths keep the respawn correct even
// after the launch cwd is deleted out from under it
test("--watch respawn with the launch cwd deleted: same token, new pid, correct runfile", async () => {
	const projectDir = await gitSpecProject();
	mkdirSync(join(projectDir, "handlers"), { recursive: true }); // must exist at boot for the watcher
	const runDir = join(projectDir, ".offbook");
	const launchCwd = mkdtempSync(join(tmpdir(), "offbook-respawn-cwd-"));
	const state = mkdtempSync(join(tmpdir(), "offbook-respawn-state-"));
	const prevState = process.env.OFFBOOK_STATE_DIR;
	const prevCwd = process.cwd();
	process.env.OFFBOOK_STATE_DIR = state;
	process.chdir(launchCwd);
	try {
		expect(
			await run(
				[
					"up",
					projectDir,
					"--watch",
					"--ws-port",
					"19438",
					"--tcp-port",
					"12493",
					"--ctrl-port",
					"19439",
				],
				io().io,
			),
		).toBe(0);
		const first = await readRunfile(runDir);
		const token = first?.token;
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		// delete the launch cwd out from under the running server
		process.chdir(projectDir);
		rmSync(launchCwd, { recursive: true, force: true });
		// a handlers/ change forces the whole-process respawn (EH1)
		await Bun.write(join(projectDir, "handlers", "touch.ts"), "export {};\n");
		const deadline = Date.now() + 30_000;
		let second = await readRunfile(runDir);
		while (
			(second === undefined || second.pid === first?.pid) &&
			Date.now() < deadline
		) {
			await Bun.sleep(300);
			second = await readRunfile(runDir);
		}
		expect(second?.pid).not.toBe(first?.pid); // new incarnation
		expect(second?.token).toBe(token); // same lineage
		// the respawned server answers /v1/server with the SAME token
		const answered = { token: "", pid: 0 };
		const deadline2 = Date.now() + 30_000;
		while (Date.now() < deadline2) {
			try {
				const id = (await (
					await fetch("http://localhost:19439/v1/server")
				).json()) as { token: string; pid: number };
				if (id.pid === second?.pid) {
					answered.token = id.token;
					answered.pid = id.pid;
					break;
				}
			} catch {}
			await Bun.sleep(300);
		}
		expect(answered.token).toBe(token as string);
		expect(answered.pid).toBe(second?.pid as number);
	} finally {
		process.chdir(prevCwd);
		await run(["down", "--run-dir", runDir], { out: () => {}, err: () => {} });
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		if (prevState === undefined) delete process.env.OFFBOOK_STATE_DIR;
		else process.env.OFFBOOK_STATE_DIR = prevState;
		rmSync(state, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 120_000);
