// [utest->R-045] — state-table rows 1-5 (the cwd runfile) + explicit
// --run-dir addressing + the host rule. Registry rows are tested with the
// scan in resolve part 2 and test/instance-discovery.test.ts.
// Ports for this file (repo convention: unique per file): 19400-19429.
import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerIdentity } from "#src/model/index.ts";
import type { CliError } from "./client.ts";
import { canonicalPath, pointerPath } from "./registry.ts";
import {
	attributeCtrlPort,
	resolveInstance,
	WrongHostError,
} from "./resolve.ts";
import { readRunfile, writeRunfile } from "./runfile.ts";

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

// [utest->R-045]
test("rows 6-8: registry scan verifies by token, skips the silent, reaps the dead", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-"); // no cwd runfile: forces the scan
	// live + verified
	const liveProj = scratch("offbook-res-live-");
	const liveRun = join(liveProj, ".offbook");
	const token = "88".repeat(16);
	await writeRunfile(liveRun, RUN(19407, token), { stateDir: state });
	const server = identityServer(19407, {
		token,
		runDir: liveRun,
		projectDir: liveProj,
	});
	// live + silent (skipped)
	const silentProj = scratch("offbook-res-silent-");
	const silentRun = join(silentProj, ".offbook");
	await writeRunfile(silentRun, RUN(19408, "99".repeat(16)), {
		stateDir: state,
	});
	// dead (pointer reaped, runfile reclaimed)
	const deadProj = scratch("offbook-res-dead-");
	const deadRun = join(deadProj, ".offbook");
	const dead = Bun.spawnSync(["true"]);
	await writeRunfile(
		deadRun,
		{ ...RUN(19409, "aa".repeat(16)), pid: dead.pid ?? 4_193_996 },
		{ stateDir: state },
	);
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.runDir).toBe(liveRun); // sole verified candidate
		expect(res.resolved?.source).toBe("registry");
		expect(res.skipped.map((s) => s.runDir)).toEqual([silentRun]);
		expect(existsSync(pointerPath(state, deadRun))).toBe(false);
		expect(existsSync(pointerPath(state, silentRun))).toBe(true); // live-pid: kept
	} finally {
		server.stop();
		for (const d of [state, cwd, liveProj, silentProj, deadProj])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("row 9: pointer whose runfile is missing — self-heal from a served identity, else guarded reap", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	// heal branch: identity on the (injected) default port claims this runDir
	const healProj = scratch("offbook-res-heal-");
	const healRun = join(healProj, ".offbook");
	const token = "bb".repeat(16);
	await writeRunfile(healRun, RUN(19410, token), { stateDir: state });
	rmSync(join(healRun, "offbook.run")); // de-runfiled, pointer dangles
	const server = identityServer(19410, {
		token,
		runDir: healRun,
		projectDir: healProj,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 19410 },
	});
	try {
		const res = await resolveInstance({
			cwd,
			stateDir: state,
			selfHealProbePort: 19410,
		});
		expect(res.resolved?.runDir).toBe(healRun);
		expect(existsSync(join(healRun, "offbook.run"))).toBe(true); // rewritten
		const healed = await readRunfile(healRun);
		expect(healed?.token).toBe(token);
	} finally {
		server.stop();
	}
	// reap branch: nothing answers the probe port → pointer reaped, M14 missing variant
	const goneProj = scratch("offbook-res-gone-");
	const goneRun = join(goneProj, ".offbook");
	await writeRunfile(goneRun, RUN(19411, "cc".repeat(16)), { stateDir: state });
	rmSync(join(goneRun, "offbook.run"));
	const res2 = await resolveInstance({
		cwd,
		stateDir: state,
		selfHealProbePort: 19412, // silent
	});
	expect(existsSync(pointerPath(state, goneRun))).toBe(false);
	expect(res2.notes.some((n) => n.includes("its runfile is gone"))).toBe(true);
	for (const d of [state, cwd, healProj, goneProj])
		rmSync(d, { recursive: true, force: true });
});

// [utest->R-045]
test("tiebreak: ancestor-or-equal beats descendant beats sole-non-demo; prefix siblings never match; ambiguity refuses nothing here (resolver reports)", async () => {
	const state = scratch("offbook-res-state-");
	const base = scratch("offbook-res-tie-");
	// candidate A: projectDir = base/repo (an ANCESTOR of cwd base/repo/sub)
	// candidate B: projectDir = base/repo-wip (a PREFIX SIBLING — must not match)
	const aProj = join(base, "repo");
	const bProj = join(base, "repo-wip");
	const cwd = join(base, "repo", "sub");
	for (const d of [aProj, bProj, cwd]) mkdirSync(d, { recursive: true });
	const aRun = join(aProj, ".offbook");
	const bRun = join(bProj, ".offbook");
	const aTok = "dd".repeat(16);
	const bTok = "ee".repeat(16);
	await writeRunfile(aRun, RUN(19413, aTok), { stateDir: state });
	await writeRunfile(bRun, RUN(19414, bTok), { stateDir: state });
	const aSrv = identityServer(19413, {
		token: aTok,
		runDir: aRun,
		projectDir: aProj,
	});
	const bSrv = identityServer(19414, {
		token: bTok,
		runDir: bRun,
		projectDir: bProj,
	});
	try {
		// stage 1: cwd inside A only → A wins even with B live
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.projectDir).toBe(aProj);
		// from an UNRELATED cwd both are live and unrelated → ambiguous
		const other = scratch("offbook-res-other-");
		const amb = await resolveInstance({ cwd: other, stateDir: state });
		expect(amb.resolved).toBeUndefined();
		expect(amb.candidates).toHaveLength(2);
		rmSync(other, { recursive: true, force: true });
	} finally {
		aSrv.stop();
		bSrv.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(base, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("tiebreak stage 3: the sole non-demo wins over a live demo, with the demo-passed-over note", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const projA = scratch("offbook-res-real-");
	const projD = scratch("offbook-res-demo-");
	const runA = join(projA, ".offbook");
	const runD = join(projD, ".offbook");
	const tokA = "f1".repeat(16);
	const tokD = "f2".repeat(16);
	await writeRunfile(runA, RUN(19415, tokA), { stateDir: state });
	await writeRunfile(runD, RUN(19416, tokD), { stateDir: state });
	const srvA = identityServer(19415, {
		token: tokA,
		runDir: runA,
		projectDir: projA,
	});
	const srvD = identityServer(19416, {
		token: tokD,
		runDir: runD,
		projectDir: projD,
		demo: true,
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.projectDir).toBe(projA);
		expect(res.resolved?.demo).toBe(false);
		expect(res.notes.some((n) => n.includes("the bundled demo in"))).toBe(true);
	} finally {
		srvA.stop();
		srvD.stop();
		for (const d of [state, cwd, projA, projD])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-044]
test("attributeCtrlPort: names the owner only when the claimed runfile carries the served token", async () => {
	const proj = scratch("offbook-res-attr-");
	const runDir = join(proj, ".offbook");
	const state = scratch("offbook-res-state-");
	const token = "f3".repeat(16);
	await writeRunfile(runDir, RUN(19417, token), { stateDir: state });
	const server = identityServer(19417, { token, runDir, projectDir: proj });
	try {
		expect(await attributeCtrlPort(19417)).toEqual({
			projectDir: proj,
			runDir,
			demo: false,
		});
	} finally {
		server.stop();
	}
	// claim without proof: served token differs from the runfile's
	const liar = identityServer(19418, {
		token: "f4".repeat(16),
		runDir,
		projectDir: proj,
	});
	try {
		expect(await attributeCtrlPort(19418)).toBeUndefined();
	} finally {
		liar.stop();
	}
	expect(await attributeCtrlPort(19419)).toBeUndefined(); // silence
	rmSync(proj, { recursive: true, force: true });
	rmSync(state, { recursive: true, force: true });
});

// [utest->R-045]
test("guarded site #1: a pointer rewritten between the scan read and the unlink survives the reap", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const proj = scratch("offbook-res-g1-");
	const runDir = join(proj, ".offbook");
	await writeRunfile(runDir, RUN(19420, "a1".repeat(16)), { stateDir: state });
	rmSync(join(runDir, "offbook.run")); // dangling pointer → the reap branch
	const ptr = pointerPath(state, runDir);
	// the self-heal probe fires between the scan's read and the guard's
	// re-read — a fetch side effect deterministically lands INSIDE the race
	// window: rewrite the pointer's bytes (same content, new formatting)
	const rewritten = `${JSON.stringify({ v: 1, runDir: canonicalPath(runDir), host: hostname() })}\n`;
	const server = Bun.serve({
		port: 19420,
		fetch: () => {
			require("node:fs").writeFileSync(ptr, rewritten);
			return new Response("nope", { status: 404 }); // not a heal answer
		},
	});
	try {
		const res = await resolveInstance({
			cwd,
			stateDir: state,
			selfHealProbePort: 19420,
		});
		expect(existsSync(ptr)).toBe(true); // freshness guard skipped the unlink
		expect(res.notes.some((n) => n.includes("its runfile is gone"))).toBe(
			false,
		);
	} finally {
		server.stop(true);
		for (const d of [state, cwd, proj])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("guarded site #5: the self-heal skips when a runfile reappeared before the write", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const proj = scratch("offbook-res-g5-");
	const runDir = join(proj, ".offbook");
	const token = "a2".repeat(16);
	await writeRunfile(runDir, RUN(19421, token), { stateDir: state });
	rmSync(join(runDir, "offbook.run")); // dangling → the heal branch
	// the identity answer's fetch side effect recreates offbook.run inside
	// the race window (a respawn winning the race); the heal must NOT
	// overwrite it
	const raced = `${JSON.stringify({ ...RUN(19421, token), pid: 424242 })}\n`;
	const identity = {
		pid: process.pid,
		token,
		host: hostname(),
		projectDir: proj,
		runDir,
		startedAt: "t",
		demo: false,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 19421 },
	};
	const server = Bun.serve({
		port: 19421,
		fetch: (req) => {
			require("node:fs").writeFileSync(join(runDir, "offbook.run"), raced);
			return new URL(req.url).pathname === "/v1/server"
				? Response.json(identity)
				: new Response("nope", { status: 404 });
		},
	});
	try {
		await resolveInstance({ cwd, stateDir: state, selfHealProbePort: 19421 });
		const kept = await readRunfile(runDir);
		expect(kept?.pid).toBe(424242); // the raced writer's file survived
	} finally {
		server.stop(true);
		for (const d of [state, cwd, proj])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("tiebreak: a symlinked cwd matches its real subtree (stage 1 through realpath, against a live competitor)", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-symproj-");
	const other = scratch("offbook-res-symother-");
	const runDir = join(proj, ".offbook");
	const otherRun = join(other, ".offbook");
	const token = "a3".repeat(16);
	const otherTok = "a4".repeat(16);
	await writeRunfile(runDir, RUN(19422, token), { stateDir: state });
	await writeRunfile(otherRun, RUN(19423, otherTok), { stateDir: state });
	const server = identityServer(19422, { token, runDir, projectDir: proj });
	const competitor = identityServer(19423, {
		token: otherTok,
		runDir: otherRun,
		projectDir: other,
	});
	const linkParent = scratch("offbook-res-symlink-");
	const link = join(linkParent, "alias");
	symlinkSync(proj, link);
	const cwd = join(link, "sub");
	mkdirSync(cwd, { recursive: true });
	try {
		// two live candidates force the tiebreak: cwd addressed VIA the
		// symlink still realpaths into proj's subtree, so stage 1 finds
		// exactly one ancestor-or-equal — the symlinked project, not the
		// competitor
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.projectDir).toBe(proj);
	} finally {
		server.stop();
		competitor.stop();
		for (const d of [state, linkParent, proj, other])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("an unreadable registry degrades to cwd-scoped behavior with the could-not-record note, never a throw", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	rmSync(join(state, "instances"), { recursive: true, force: true });
	await Bun.write(join(state, "instances"), "a FILE where the dir should be");
	const res = await resolveInstance({ cwd, stateDir: state });
	expect(res.resolved).toBeUndefined();
	expect(res.candidates).toEqual([]);
	expect(
		res.notes.some((n) => n.startsWith("(offbook: could not record")),
	).toBe(true);
	rmSync(state, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});
