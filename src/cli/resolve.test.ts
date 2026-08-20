// [utest->R-045] — state-table rows 1-5 (the cwd runfile) + explicit
// --run-dir addressing + the host rule. Registry rows are tested with the
// scan in resolve part 2 and test/instance-discovery.test.ts.
// Ports for this file (repo convention: unique per file): 19400-19429 and
// 19300-19317 (the second block belongs to the mutation-hardening round).
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
import { M14, M15d } from "./messages.ts";
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
		// the resolved instance is also the (only) candidate seen, and nothing
		// foreign was passed over on the way
		expect(res.candidates.map((c) => c.runDir)).toEqual([runDir]);
		expect(res.foreignSeen).toBe(false);
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
		// a legacy instance never claims to be the bundled demo — the demo flag
		// decides the stage-3 tiebreak, and nothing here has told us either way
		expect(res.resolved?.demo).toBe(false);
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
	expect(res.foreignSeen).toBe(false); // nothing on another host was passed over
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
		expect(res.candidates.map((c) => c.runDir)).toEqual([runDir]);
		// the explicit path never scans the registry, so it can neither have
		// seen a foreign record nor have cleaned anything up
		expect(res.foreignSeen).toBe(false);
		expect(res.notes).toStrictEqual([]);
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
		expect(res.candidates).toStrictEqual([]); // nothing live to offer a verb
		expect(res.notes).toStrictEqual([]); // reporting a stale runfile is not a cleanup
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
		expect(res.skipped[0]?.reason).toBe("silent");
		expect(existsSync(pointerPath(state, deadRun))).toBe(false);
		expect(existsSync(pointerPath(state, silentRun))).toBe(true); // live-pid: kept
		// the reap is reported once, naming the instance it cleaned up
		expect(res.notes).toEqual([M14(deadProj, dead.pid ?? 4_193_996)]);
		expect(res.foreignSeen).toBe(false); // every record scanned was this host's
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
test("row 9 heals the cwd's OWN dangling pointer", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-cwdheal-");
	const runDir = join(proj, ".offbook");
	const token = "b1".repeat(16);
	await writeRunfile(runDir, RUN(19424, token), { stateDir: state });
	rmSync(join(runDir, "offbook.run")); // de-runfiled while standing in its own project
	const server = identityServer(19424, { token, runDir, projectDir: proj });
	try {
		const res = await resolveInstance({
			cwd: proj,
			stateDir: state,
			selfHealProbePort: 19424,
		});
		expect(res.resolved?.runDir).toBe(runDir);
		expect(existsSync(join(runDir, "offbook.run"))).toBe(true); // rewritten
		expect((await readRunfile(runDir))?.token).toBe(token);
		// spec row 9 resolves "then row 6": a healed instance reports source
		// "registry" even in its own cwd — the M16 header discloses the heal
		expect(res.resolved?.source).toBe("registry");
	} finally {
		server.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(proj, { recursive: true, force: true });
	}
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
test("tiebreak stage 2: the sole strict descendant wins from a parent cwd", async () => {
	const state = scratch("offbook-res-state-");
	const base = scratch("offbook-res-stage2-");
	const cwd = join(base, "app");
	mkdirSync(cwd, { recursive: true });
	const descProj = join(base, "app", "mock"); // a strict DESCENDANT of cwd
	mkdirSync(descProj, { recursive: true });
	const descRun = join(descProj, ".offbook");
	const otherProj = scratch("offbook-res-stage2other-"); // unrelated to cwd
	const otherRun = join(otherProj, ".offbook");
	const descTok = "b2".repeat(16);
	const otherTok = "b3".repeat(16);
	await writeRunfile(descRun, RUN(19425, descTok), { stateDir: state });
	await writeRunfile(otherRun, RUN(19426, otherTok), { stateDir: state });
	const descSrv = identityServer(19425, {
		token: descTok,
		runDir: descRun,
		projectDir: descProj,
	});
	const otherSrv = identityServer(19426, {
		token: otherTok,
		runDir: otherRun,
		projectDir: otherProj,
	});
	try {
		// neither candidate is an ancestor-or-equal of cwd → stage 1 is empty;
		// only the descendant is contained BY cwd → stage 2's sole winner
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.projectDir).toBe(descProj);
	} finally {
		descSrv.stop();
		otherSrv.stop();
		for (const d of [state, base, otherProj])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("tiebreak stage 3: the sole non-demo wins over a live demo, with the demo-passed-over note", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const projA = scratch("offbook-res-real-");
	const projD = scratch("offbook-res-demo-");
	const runA = join(projA, ".offbook");
	// the demo's run dir deliberately sits a level deeper than the default, so
	// the note has to name the served projectDir, not the run dir's parent
	const runD = join(projD, "nested", ".offbook");
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
		// exactly one note, for the demo that was passed over — never for the
		// winner — and it names the demo's project, not its run dir's parent
		expect(res.notes.filter((n) => n.includes("the bundled demo in"))).toEqual([
			M15d(projD, runD),
		]);
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

// [utest->R-045] — per-pointer failure isolation (each pointer's mapper body
// now has its own try/catch): a genuinely THROWING mapper is hard to force
// portably (rmSync EPERM etc.), so this pins the observable contract instead
// — a malformed pointer whose runDir is a FILE, not a directory (so its
// runfile path can never exist, forcing row 9's branch), must not stop a
// healthy live+verified pointer scanned in the same Promise.all from
// resolving.
// NB: nothing here THROWS — this pins "a dangling pointer reaped in the same
// pass does not disturb a healthy candidate"; the per-pointer catch itself is
// correct by inspection (no portable way to force a mapper throw non-root)
test("a dangling pointer reaped in the same pass does not disturb the healthy candidate", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	// healthy: live + verified
	const healthyProj = scratch("offbook-res-healthy-");
	const healthyRun = join(healthyProj, ".offbook");
	const token = "b4".repeat(16);
	await writeRunfile(healthyRun, RUN(19427, token), { stateDir: state });
	const server = identityServer(19427, {
		token,
		runDir: healthyRun,
		projectDir: healthyProj,
	});
	// weird: a pointer whose runDir is a FILE — runfilePath(runDir) can never
	// exist, so the scan takes row 9's branch for it; hand-write the pointer
	// JSON directly (writePointer's canonicalPath still resolves through it
	// fine since the path DOES exist, just as a file, not a directory)
	const weirdBase = scratch("offbook-res-weird-");
	const weirdRunDir = join(weirdBase, "notadir");
	await Bun.write(weirdRunDir, "not a directory");
	mkdirSync(join(state, "instances"), { recursive: true });
	const weirdRaw = `${JSON.stringify({
		v: 1,
		runDir: canonicalPath(weirdRunDir),
		host: hostname(),
	})}\n`;
	await Bun.write(pointerPath(state, weirdRunDir), weirdRaw);
	try {
		const res = await resolveInstance({
			cwd,
			stateDir: state,
			selfHealProbePort: 19429, // silent: the weird pointer takes the reap path
		});
		expect(res.resolved?.runDir).toBe(healthyRun);
	} finally {
		server.stop();
		for (const d of [state, cwd, healthyProj, weirdBase])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("row 10 in cwd: a foreign-host runfile is inert — never reclaimed, never a candidate, and it marks foreignSeen", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-foreigncwd-");
	const runDir = join(cwd, ".offbook");
	const dead = Bun.spawnSync(["true"]);
	await writeRunfile(
		runDir,
		{
			...RUN(19314, "c2".repeat(16), "some-other-machine"),
			pid: dead.pid ?? 4_193_994,
		},
		{ stateDir: state },
	);
	const res = await resolveInstance({ cwd, stateDir: state });
	expect(res.resolved).toBeUndefined();
	expect(res.foreignSeen).toBe(true);
	expect(res.skipped).toStrictEqual([]);
	// the host rule outranks the dead-pid reclaim: that pid is a pid on ANOTHER
	// machine, so neither the runfile nor its record is ours to delete
	expect(res.notes).toStrictEqual([]);
	expect(existsSync(join(runDir, "offbook.run"))).toBe(true);
	expect(existsSync(pointerPath(state, runDir))).toBe(true);
	rmSync(state, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

// [utest->R-045]
test("row 10 via the registry: a locally-recorded runfile written on another host is inert too", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const proj = scratch("offbook-res-foreignreg-");
	const runDir = join(proj, ".offbook");
	const dead = Bun.spawnSync(["true"]);
	// the POINTER is this host's (the record was written here); the runfile it
	// points at says otherwise — a state dir shared over NFS, or a project dir
	// mounted on two machines
	await writeRunfile(
		runDir,
		{
			...RUN(19315, "c3".repeat(16), "some-other-machine"),
			pid: dead.pid ?? 4_193_993,
		},
		{ stateDir: state },
	);
	const res = await resolveInstance({ cwd, stateDir: state });
	expect(res.resolved).toBeUndefined();
	expect(res.candidates).toStrictEqual([]);
	expect(res.foreignSeen).toBe(true);
	expect(res.notes).toStrictEqual([]);
	expect(existsSync(join(runDir, "offbook.run"))).toBe(true);
	expect(existsSync(pointerPath(state, runDir))).toBe(true);
	for (const d of [state, cwd, proj])
		rmSync(d, { recursive: true, force: true });
});

// [utest->R-045]
test("a skipped instance is named by its boot file, and by the run dir's parent when that file cannot name it", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-boot-");
	const runDir = join(proj, ".offbook");
	const dead = Bun.spawnSync(["true"]);
	await writeRunfile(
		runDir,
		{ ...RUN(19313, "c1".repeat(16)), pid: dead.pid ?? 4_193_992 },
		{ stateDir: state },
	);
	const namedProjectDir = async (): Promise<string | undefined> =>
		(
			await resolveInstance({
				cwd: "/tmp",
				runDirFlag: runDir,
				stateDir: state,
			})
		).skipped[0]?.projectDir;
	// no boot file: the run dir's parent is the best remaining name
	expect(await namedProjectDir()).toBe(proj);
	// the boot file names the project truthfully without asking the server —
	// which matters exactly here, where the server cannot be asked
	const elsewhere = join(proj, "not-the-parent");
	await Bun.write(
		join(runDir, "offbook.boot.json"),
		JSON.stringify({ projectDir: elsewhere }),
	);
	expect(await namedProjectDir()).toBe(elsewhere);
	// a boot file that carries no string projectDir falls back rather than
	// naming the instance `undefined`
	await Bun.write(
		join(runDir, "offbook.boot.json"),
		JSON.stringify({ projectDir: 42 }),
	);
	expect(await namedProjectDir()).toBe(proj);
	await Bun.write(join(runDir, "offbook.boot.json"), "{not json");
	expect(await namedProjectDir()).toBe(proj);
	rmSync(state, { recursive: true, force: true });
	rmSync(proj, { recursive: true, force: true });
});

// [utest->R-045]
test("a token mismatch is never excused by a matching runDir (once a runfile carries a token, the token is the proof)", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-tokenmismatch-");
	const runDir = join(cwd, ".offbook");
	await writeRunfile(runDir, RUN(19300, "c4".repeat(16)), { stateDir: state });
	// the answerer claims THIS runDir — but under a different launch token, so
	// it is a later instance (or a port reuse), not the one the runfile names
	const server = identityServer(19300, {
		token: "c5".repeat(16),
		runDir,
		projectDir: cwd,
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved).toBeUndefined();
		expect(res.skipped[0]?.reason).toBe("wrong-token");
	} finally {
		server.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("--run-dir uses the dir's OWN runfile, never a nested .offbook, when both exist", async () => {
	const state = scratch("offbook-res-state-");
	const outer = scratch("offbook-res-outerrun-");
	const inner = join(outer, ".offbook");
	const dead = Bun.spawnSync(["true"]);
	const pid = dead.pid ?? 4_193_991;
	await writeRunfile(
		outer,
		{ ...RUN(19316, "c6".repeat(16)), pid },
		{
			stateDir: state,
		},
	);
	await writeRunfile(
		inner,
		{ ...RUN(19317, "c7".repeat(16)), pid },
		{
			stateDir: state,
		},
	);
	const res = await resolveInstance({
		cwd: "/tmp",
		runDirFlag: outer,
		stateDir: state,
	});
	// the .offbook convenience is a FALLBACK for project dirs, not a preference
	expect(res.skipped[0]?.runDir).toBe(outer);
	expect(res.skipped[0]?.ctrlPort).toBe(19316);
	rmSync(state, { recursive: true, force: true });
	rmSync(outer, { recursive: true, force: true });
});

// [utest->R-045]
test("a silent cwd instance never hides the registry's live one", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-silentcwd-");
	const cwdRun = join(cwd, ".offbook");
	// live pid, nothing listening on 19301: row 3, resolves nothing
	await writeRunfile(cwdRun, RUN(19301, "c8".repeat(16)), { stateDir: state });
	const liveProj = scratch("offbook-res-livereg-");
	const liveRun = join(liveProj, ".offbook");
	const token = "c9".repeat(16);
	await writeRunfile(liveRun, RUN(19302, token), { stateDir: state });
	const server = identityServer(19302, {
		token,
		runDir: liveRun,
		projectDir: liveProj,
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		// the cwd's own record is the ONLY one rows 1-5 already handled; every
		// other pointer is still the registry pass's business
		expect(res.resolved?.runDir).toBe(liveRun);
		expect(res.resolved?.source).toBe("registry");
		expect(res.skipped.map((s) => s.runDir)).toEqual([cwdRun]);
	} finally {
		server.stop();
		for (const d of [state, cwd, liveProj])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("row 9 never heals from an identity naming another runDir or another host — it reaps instead", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const strangerProj = scratch("offbook-res-healstranger-");
	const aProj = scratch("offbook-res-heala-");
	const aRun = join(aProj, ".offbook");
	await writeRunfile(aRun, RUN(19303, "d1".repeat(16)), { stateDir: state });
	rmSync(join(aRun, "offbook.run")); // dangling pointer → row 9
	// (a) somebody answers the probe port, but for a DIFFERENT run dir: healing
	// from it would invent a runfile for an instance that does not exist
	let server = identityServer(19303, {
		token: "d1".repeat(16),
		runDir: join(strangerProj, ".offbook"),
		projectDir: strangerProj,
	});
	try {
		const res = await resolveInstance({
			cwd,
			stateDir: state,
			selfHealProbePort: 19303,
		});
		expect(existsSync(join(aRun, "offbook.run"))).toBe(false);
		expect(existsSync(pointerPath(state, aRun))).toBe(false); // reaped instead
		expect(res.notes.some((n) => n.includes("its runfile is gone"))).toBe(true);
		expect(res.resolved).toBeUndefined();
	} finally {
		server.stop();
	}
	// (b) the identity names the right run dir but ran on another host: a
	// healed runfile would carry that host and be inert forever after
	const bProj = scratch("offbook-res-healb-");
	const bRun = join(bProj, ".offbook");
	await writeRunfile(bRun, RUN(19304, "d2".repeat(16)), { stateDir: state });
	rmSync(join(bRun, "offbook.run"));
	server = identityServer(19304, {
		token: "d2".repeat(16),
		runDir: bRun,
		projectDir: bProj,
		host: "some-other-machine",
	});
	try {
		const res = await resolveInstance({
			cwd,
			stateDir: state,
			selfHealProbePort: 19304,
		});
		expect(existsSync(join(bRun, "offbook.run"))).toBe(false);
		expect(existsSync(pointerPath(state, bRun))).toBe(false);
		expect(res.resolved).toBeUndefined();
	} finally {
		server.stop();
		for (const d of [state, cwd, strangerProj, aProj, bProj])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("a healed instance is re-recorded under its canonical pointer name", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const proj = scratch("offbook-res-healreg-");
	const runDir = join(proj, ".offbook");
	const token = "d3".repeat(16);
	mkdirSync(runDir, { recursive: true });
	mkdirSync(join(state, "instances"), { recursive: true });
	// the only record of this instance is a twin under a non-canonical name
	// (and its runfile is missing, so row 9 applies)
	const twin = join(state, "instances", `${"d".repeat(64)}.json`);
	await Bun.write(
		twin,
		`${JSON.stringify({ v: 1, runDir: canonicalPath(runDir), host: hostname() })}\n`,
	);
	const server = identityServer(19305, { token, runDir, projectDir: proj });
	try {
		const res = await resolveInstance({
			cwd,
			stateDir: state,
			selfHealProbePort: 19305,
		});
		expect(res.resolved?.runDir).toBe(runDir);
		expect((await readRunfile(runDir))?.token).toBe(token);
		// every runfile writer is a registry writer (D-032): the heal restores
		// the RECORD too, not just the runfile
		expect(existsSync(pointerPath(state, runDir))).toBe(true);
	} finally {
		server.stop();
		for (const d of [state, cwd, proj])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("a pointer another process removed mid-scan is not reported as cleaned up", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const proj = scratch("offbook-res-vanish-");
	const runDir = join(proj, ".offbook");
	await writeRunfile(runDir, RUN(19306, "d4".repeat(16)), { stateDir: state });
	rmSync(join(runDir, "offbook.run")); // dangling → the reap branch
	const ptr = pointerPath(state, runDir);
	// the self-heal probe fires between the scan's read and the guard's
	// re-read: delete the pointer inside that window (a concurrent offbook
	// reaping the same record) — the reap must abort AND stay quiet
	const server = Bun.serve({
		port: 19306,
		fetch: () => {
			require("node:fs").rmSync(ptr, { force: true });
			return new Response("nope", { status: 404 });
		},
	});
	try {
		const res = await resolveInstance({
			cwd,
			stateDir: state,
			selfHealProbePort: 19306,
		});
		expect(existsSync(ptr)).toBe(false);
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
test("tiebreak: the served projectDir decides, not the run dir's parent", async () => {
	const state = scratch("offbook-res-state-");
	const base = scratch("offbook-res-projof-");
	const proj = join(base, "repo");
	const cwd = join(proj, "sub");
	mkdirSync(cwd, { recursive: true });
	// started with --run-dir: the run dir sits OUTSIDE the project it serves
	const runDir = join(base, "runs", "a");
	const token = "d5".repeat(16);
	await writeRunfile(runDir, RUN(19307, token), { stateDir: state });
	const other = scratch("offbook-res-projofother-");
	const otherRun = join(other, ".offbook");
	const otherTok = "d6".repeat(16);
	await writeRunfile(otherRun, RUN(19308, otherTok), { stateDir: state });
	const srv = identityServer(19307, { token, runDir, projectDir: proj });
	const otherSrv = identityServer(19308, {
		token: otherTok,
		runDir: otherRun,
		projectDir: other,
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.candidates).toHaveLength(2); // two live: the tiebreak really ran
		expect(res.resolved?.runDir).toBe(runDir); // stage 1, on the SERVED project
		expect(res.resolved?.projectDir).toBe(proj);
	} finally {
		srv.stop();
		otherSrv.stop();
		for (const d of [state, base, other])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("tiebreak: two live instances that both contain cwd stay ambiguous — stage 2 takes strict descendants only", async () => {
	const state = scratch("offbook-res-state-");
	const base = scratch("offbook-res-nested-");
	const cwd = join(base, "repo");
	mkdirSync(cwd, { recursive: true });
	// both were started with --run-dir, so neither leaves a runfile in cwd —
	// rows 1-5 do not fire and the registry pass has to choose
	const innerRun = join(base, "runs", "repo");
	const outerRun = join(base, "runs", "base");
	const innerTok = "e1".repeat(16);
	const outerTok = "e2".repeat(16);
	await writeRunfile(innerRun, RUN(19309, innerTok), { stateDir: state });
	await writeRunfile(outerRun, RUN(19310, outerTok), { stateDir: state });
	const innerSrv = identityServer(19309, {
		token: innerTok,
		runDir: innerRun,
		projectDir: cwd, // equal to cwd
	});
	const outerSrv = identityServer(19310, {
		token: outerTok,
		runDir: outerRun,
		projectDir: base, // an ancestor of cwd
	});
	try {
		// stage 1 needs EXACTLY one ancestor-or-equal and finds two; the equal
		// one is not a strict descendant, so stage 2 finds none — guessing
		// between a project and its parent is what the refusal exists to avoid
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.candidates).toHaveLength(2);
		expect(res.resolved).toBeUndefined();
	} finally {
		innerSrv.stop();
		outerSrv.stop();
		for (const d of [state, base]) rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-044]
test("attributeCtrlPort attributes nothing to a foreign-host answer, nor to a runDir holding no runfile", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-attrneg-");
	const runDir = join(proj, ".offbook");
	const token = "e3".repeat(16);
	await writeRunfile(runDir, RUN(19311, token), { stateDir: state });
	// the runfile agrees on the token, but the answer claims another machine —
	// a tunnelled port, not a local instance to name
	const foreign = identityServer(19311, {
		token,
		runDir,
		projectDir: proj,
		host: "some-other-machine",
	});
	try {
		expect(await attributeCtrlPort(19311)).toBeUndefined();
	} finally {
		foreign.stop();
	}
	// the claimed run dir holds no runfile at all: nothing proves the claim
	const orphan = identityServer(19312, {
		token,
		runDir: join(proj, "no-such-run-dir"),
		projectDir: proj,
	});
	try {
		expect(await attributeCtrlPort(19312)).toBeUndefined();
	} finally {
		orphan.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(proj, { recursive: true, force: true });
	}
});
