// [utest->R-045] — state-table rows 1-5 (the cwd runfile) + explicit
// --run-dir addressing + the host rule. Registry rows are tested with the
// scan in resolve part 2 and test/instance-discovery.test.ts.
// Ports for this file (repo convention: unique per file): 19400-19429.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerIdentity } from "#src/model/index.ts";
import type { CliError } from "./client.ts";
import { pointerPath } from "./registry.ts";
import { resolveInstance, WrongHostError } from "./resolve.ts";
import { writeRunfile } from "./runfile.ts";

const scratch = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function identityServer(
	port: number,
	identity: Partial<ServerIdentity> & { token: string; runDir: string },
): { stop(): void } {
	const full = {
		pid: process.pid,
		host: hostname(),
		projectDir: "/tmp/unset",
		startedAt: "t",
		demo: false,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: port },
		...identity,
	} as ServerIdentity;
	const server = Bun.serve({
		port,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/server"
				? Response.json(full)
				: new Response("nope", { status: 404 }),
	});
	return { stop: () => server.stop(true) };
}

const RUN = (ctrl: number, token?: string, host?: string) => ({
	pid: process.pid,
	brokerWsPort: 1,
	brokerTcpPort: 2,
	controlPlanePort: ctrl,
	startedAt: "t",
	...(token === undefined ? {} : { token }),
	...(host === undefined ? {} : { host }),
});

test("row 1: live cwd runfile + matching token resolves (source cwd) and adopts a pointer", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-cwd-");
	const runDir = join(cwd, ".offbook");
	const token = "11".repeat(16);
	await writeRunfile(runDir, RUN(19400, token), { stateDir: state });
	rmSync(pointerPath(state, runDir), { force: true }); // adopt-on-sight must rewrite it
	const server = identityServer(19400, { token, runDir, projectDir: cwd });
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.source).toBe("cwd");
		expect(res.resolved?.identity?.token).toBe(token);
		expect(res.resolved?.projectDir).toBe(cwd);
		expect(existsSync(pointerPath(state, runDir))).toBe(true);
	} finally {
		server.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("row 2: legacy /v1/mode answer resolves live-unverified locally and adopts", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-cwd-");
	const runDir = join(cwd, ".offbook");
	await writeRunfile(runDir, RUN(19401), { stateDir: state });
	rmSync(pointerPath(state, runDir), { force: true });
	const legacy = Bun.serve({
		port: 19401,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/mode"
				? Response.json({ mode: "autonomous" })
				: new Response("nope", { status: 404 }),
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.source).toBe("cwd");
		expect(res.resolved?.identity).toBeUndefined(); // live-unverified
		expect(existsSync(pointerPath(state, runDir))).toBe(true);
	} finally {
		legacy.stop(true);
		rmSync(state, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("row 3: live pid, silent port — skipped, runfile kept, nothing resolved", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-cwd-");
	const runDir = join(cwd, ".offbook");
	await writeRunfile(runDir, RUN(19402, "22".repeat(16)), { stateDir: state });
	const res = await resolveInstance({ cwd, stateDir: state });
	expect(res.resolved).toBeUndefined();
	expect(res.skipped).toHaveLength(1);
	expect(res.skipped[0].reason).toBe("silent");
	expect(existsSync(join(runDir, "offbook.run"))).toBe(true); // live-pid: only ever skipped
	rmSync(state, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

test("row 4: wrong token — the port belongs to someone else; skipped, never reclaimed", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-cwd-");
	const runDir = join(cwd, ".offbook");
	await writeRunfile(runDir, RUN(19403, "33".repeat(16)), { stateDir: state });
	const server = identityServer(19403, {
		token: "44".repeat(16), // NOT the runfile's
		runDir: "/somewhere/else/.offbook",
		projectDir: "/somewhere/else",
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved).toBeUndefined();
		expect(res.skipped[0]?.reason).toBe("wrong-token");
		expect(res.skipped[0]?.answeringProjectDir).toBe("/somewhere/else");
		expect(existsSync(join(runDir, "offbook.run"))).toBe(true);
	} finally {
		server.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("row 5: dead pid — reclaimed (runfile + pointer gone), M14 note, falls through", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-cwd-");
	const runDir = join(cwd, ".offbook");
	const dead = Bun.spawnSync(["true"]);
	await writeRunfile(
		runDir,
		{ ...RUN(19404, "55".repeat(16)), pid: dead.pid ?? 4_193_997 },
		{ stateDir: state },
	);
	const res = await resolveInstance({ cwd, stateDir: state });
	expect(res.resolved).toBeUndefined();
	expect(existsSync(join(runDir, "offbook.run"))).toBe(false);
	expect(existsSync(pointerPath(state, runDir))).toBe(false);
	expect(res.notes.some((n) => n.startsWith("(offbook: cleaned up"))).toBe(
		true,
	);
	rmSync(state, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

test("--run-dir accepts a projectDir whose .offbook holds the runfile; no registry fallback", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-proj-");
	const runDir = join(proj, ".offbook");
	const token = "66".repeat(16);
	await writeRunfile(runDir, RUN(19405, token), { stateDir: state });
	const server = identityServer(19405, { token, runDir, projectDir: proj });
	try {
		const res = await resolveInstance({
			cwd: "/tmp",
			runDirFlag: proj, // the CONVENIENCE form: projectDir, not runDir
			stateDir: state,
		});
		expect(res.resolved?.runDir).toBe(runDir);
		expect(res.resolved?.source).toBe("cwd"); // precise addressing: no naming duty
	} finally {
		server.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(proj, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("explicit-path dead pid is reported, not reclaimed", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-proj-");
	const runDir = join(proj, ".offbook");
	const dead = Bun.spawnSync(["true"]);
	await writeRunfile(
		join(proj, ".offbook"),
		{ ...RUN(19406, "88".repeat(16)), pid: dead.pid ?? 4_193_990 },
		{ stateDir: state },
	);
	try {
		const res = await resolveInstance({
			cwd: "/tmp",
			runDirFlag: join(proj, ".offbook"),
			stateDir: state,
		});
		expect(res.resolved).toBeUndefined();
		expect(res.skipped[0]?.reason).toBe("dead");
		expect(existsSync(join(runDir, "offbook.run"))).toBe(true); // NOT reclaimed
		expect(existsSync(pointerPath(state, runDir))).toBe(true);
	} finally {
		rmSync(state, { recursive: true, force: true });
		rmSync(proj, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("pre-D-032 runfile without a token: the served identity's runDir vouches for it (ours fallback)", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-proj-");
	const runDir = join(proj, ".offbook");
	await writeRunfile(runDir, RUN(19407), { stateDir: state });
	let server = identityServer(19407, {
		token: "99".repeat(16),
		runDir,
		projectDir: proj,
	});
	try {
		const res = await resolveInstance({ cwd: proj, stateDir: state });
		expect(res.resolved?.source).toBe("cwd");
		expect(res.resolved?.identity?.token).toBe("99".repeat(16));
	} finally {
		server.stop();
	}
	// negative: the served identity claims a DIFFERENT runDir — the
	// runDir-match fallback must fail, not silently accept any identity
	await writeRunfile(runDir, RUN(19407), { stateDir: state });
	server = identityServer(19407, {
		token: "99".repeat(16),
		runDir: "/somewhere/else/.offbook",
		projectDir: "/elsewhere",
	});
	try {
		const res = await resolveInstance({ cwd: proj, stateDir: state });
		expect(res.resolved).toBeUndefined();
		expect(res.skipped[0]?.reason).toBe("wrong-token");
	} finally {
		server.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(proj, { recursive: true, force: true });
	}
});

test("row 10 on the explicit path: a foreign-host runfile refuses with the wrote-on-host message, exit 2", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-proj-");
	const runDir = join(proj, ".offbook");
	await writeRunfile(
		runDir,
		RUN(19408, "77".repeat(16), "some-other-machine"),
		{
			stateDir: state,
		},
	);
	await expect(
		resolveInstance({ cwd: "/tmp", runDirFlag: runDir, stateDir: state }),
	).rejects.toThrow("written on some-other-machine");
	try {
		await resolveInstance({ cwd: "/tmp", runDirFlag: runDir, stateDir: state });
	} catch (cause) {
		expect((cause as CliError).exitCode).toBe(2);
		expect(cause).toBeInstanceOf(WrongHostError);
	}
	rmSync(state, { recursive: true, force: true });
	rmSync(proj, { recursive: true, force: true });
});
