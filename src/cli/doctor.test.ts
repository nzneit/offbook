// R-035 — `offbook doctor` checks engine: checks are data; every failure
// names a next step (docs/specs/adoption.md §3).
// [utest->R-035]
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DoctorCtx, DoctorReport } from "./doctor.ts";
import { DOCTOR_CHECKS, runDoctor, versionAtLeast } from "./doctor.ts";
import { run } from "./index.ts";
import { writeRunfile } from "./runfile.ts";

// ports for this file (repo convention: unique per file): 19130-19134, 12995

function ctxWith(over: Partial<DoctorCtx>): DoctorCtx {
	return {
		repoRoot: "/nonexistent",
		projectDir: "/nonexistent",
		runDir: join("/nonexistent", ".offbook"),
		offline: true,
		bunVersion: "1.3.14",
		ports: { ws: 19130, tcp: 12995, ctrl: 19131 },
		...over,
	};
}

// a fake offbook checkout: package.json (with or without engines.bun) and
// node_modules containing exactly `deps`
function fakeRepo(engines: string | undefined, deps: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "offbook-doctor-"));
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify(engines === undefined ? {} : { engines: { bun: engines } }),
	);
	for (const pkg of deps) {
		mkdirSync(join(root, "node_modules", pkg), { recursive: true });
		writeFileSync(join(root, "node_modules", pkg, "package.json"), "{}");
	}
	return root;
}

function byName(report: DoctorReport, name: string) {
	const found = report.checks.find((c) => c.name === name);
	if (!found) throw new Error(`no check named ${name}`);
	return found;
}

const ALL_DEPS = ["@asyncapi/parser", "ajv"];

test("versionAtLeast compares numerically, not lexicographically", () => {
	expect(versionAtLeast("1.3.14", "1.3")).toBe(true);
	expect(versionAtLeast("1.2.9", "1.3")).toBe(false);
	expect(versionAtLeast("2.0", "1.3")).toBe(true);
	expect(versionAtLeast("1.10", "1.9")).toBe(true); // the lexicographic trap
});

test("runtime: passes at/above the engines.bun floor, fails below", async () => {
	const root = fakeRepo(">=1.3", ALL_DEPS);
	const ok = await runDoctor(ctxWith({ repoRoot: root, bunVersion: "1.3.14" }));
	expect(byName(ok, "runtime").status).toBe("pass");
	const low = await runDoctor(ctxWith({ repoRoot: root, bunVersion: "1.2.9" }));
	expect(byName(low, "runtime").status).toBe("fail");
	expect(byName(low, "runtime").hint).toContain("upgrade Bun");
});

test("runtime: a checkout without engines.bun fails with a re-clone hint", async () => {
	const root = fakeRepo(undefined, ALL_DEPS);
	const report = await runDoctor(ctxWith({ repoRoot: root }));
	expect(byName(report, "runtime").status).toBe("fail");
});

test("deps: missing sentinel fails and names `bun install`", async () => {
	const root = fakeRepo(">=1.3", ["@asyncapi/parser"]); // ajv missing
	const report = await runDoctor(ctxWith({ repoRoot: root }));
	const deps = byName(report, "deps");
	expect(deps.status).toBe("fail");
	expect(deps.detail).toContain("ajv");
	expect(deps.hint).toContain("bun install");
});

test("deps: all sentinels present passes", async () => {
	const root = fakeRepo(">=1.3", ALL_DEPS);
	expect(
		byName(await runDoctor(ctxWith({ repoRoot: root })), "deps").status,
	).toBe("pass");
});

test("runDoctor: ok is false iff any check fails; order is the declared order", async () => {
	const root = fakeRepo(">=1.3", ALL_DEPS);
	const clean = await runDoctor(ctxWith({ repoRoot: root }));
	expect(clean.checks.map((c) => c.name)).toEqual(
		DOCTOR_CHECKS.map((c) => c.name),
	);
	const broken = await runDoctor(
		ctxWith({ repoRoot: fakeRepo(undefined, []) }),
	);
	expect(broken.ok).toBe(false);
});

// --- checks 3-5 (project, specs-reachable, scenarios) ---

function projectWith(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "offbook-doctor-proj-"));
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), text);
	}
	return dir;
}

const GOOD_REPO_ROOT = fakeRepo(">=1.3", ALL_DEPS);

test("project: no services.yaml is a warn pointing at init, never a fail", async () => {
	const report = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: projectWith({}) }),
	);
	const project = byName(report, "project");
	expect(project.status).toBe("warn");
	expect(project.hint).toContain("offbook init");
	expect(report.ok).toBe(true); // pre-init quickstart must stay exit 0
});

test("project: unparseable services.yaml fails with the file named", async () => {
	const dir = projectWith({ "services.yaml": "services: [not: valid: yaml" });
	const report = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: dir }),
	);
	const project = byName(report, "project");
	expect(project.status).toBe("fail");
	expect(project.detail).toContain("services.yaml");
});

test("project: valid services.yaml + environments.yaml passes", async () => {
	const dir = projectWith({
		"services.yaml": "services: {}\n",
		"environments.yaml": "environments:\n  default: {}\n",
	});
	const report = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: dir }),
	);
	expect(byName(report, "project").status).toBe("pass");
});

// [utest->R-040]
test("project: a services.yaml carrying topicOverrides.initialState parses clean", async () => {
	const dir = projectWith({
		"services.yaml":
			"services:\n  svc:\n    repo: org/svc\n    specPath: asyncapi.yaml\n    topicOverrides:\n      'errors/{id}': { initialState: false }\n",
	});
	const report = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: dir }),
	);
	expect(byName(report, "project").status).toBe("pass");
});

test("specs-reachable: --offline and empty services both warn, never fetch", async () => {
	const dir = projectWith({ "services.yaml": "services: {}\n" });
	const offline = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: dir, offline: true }),
	);
	expect(byName(offline, "specs-reachable").detail).toContain("--offline");
	const empty = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: dir, offline: false }),
	);
	expect(byName(empty, "specs-reachable").status).toBe("warn");
	expect(byName(empty, "specs-reachable").detail).toContain("no services");
});

async function localGitRepo(): Promise<string> {
	const repo = mkdtempSync(join(tmpdir(), "offbook-doctor-repo-"));
	const git = async (...args: string[]) => {
		const p = Bun.spawn(["git", ...args], {
			cwd: repo,
			stdout: "ignore",
			stderr: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
		expect(await p.exited).toBe(0);
	};
	await git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "asyncapi.yaml"), "asyncapi: 3.0.0\n");
	await git("add", ".");
	await git("commit", "-q", "-m", "spec");
	return repo;
}

test("specs-reachable: a reachable local repo passes; a missing one fails with the service named", async () => {
	const repo = await localGitRepo();
	const good = projectWith({
		"services.yaml": `services:\n  thermostat:\n    repo: ${repo}\n    specPath: asyncapi.yaml\n    branch: main\n`,
	});
	const okReport = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: good, offline: false }),
	);
	expect(byName(okReport, "specs-reachable").status).toBe("pass");

	const bad = projectWith({
		"services.yaml":
			"services:\n  thermostat:\n    repo: /nonexistent/nowhere\n    specPath: asyncapi.yaml\n    branch: main\n",
	});
	const badReport = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: bad, offline: false }),
	);
	const check = byName(badReport, "specs-reachable");
	expect(check.status).toBe("fail");
	expect(check.detail).toContain("thermostat");
	expect(check.hint).toContain("gitHost");
}, 20_000);

test("specs-reachable: a slug repo with no gitHost anywhere fails gracefully instead of throwing", async () => {
	const dir = projectWith({
		"services.yaml":
			"services:\n  widget:\n    repo: org/thing\n    specPath: asyncapi.yaml\n",
	});
	const report = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: dir, offline: false }),
	);
	const check = byName(report, "specs-reachable");
	expect(check.status).toBe("fail");
	expect(check.detail).toContain("widget");
	expect(check.hint).toContain("gitHost");
});

test("specs-reachable: a per-service gitHost override is honored even when the global config lacks one", async () => {
	const repo = await localGitRepo();
	const host = dirname(repo);
	const slug = basename(repo);
	const dir = projectWith({
		"services.yaml": `services:\n  thermostat:\n    repo: "${slug}"\n    gitHost: "${host}"\n    specPath: asyncapi.yaml\n    branch: main\n`,
	});
	const report = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: dir, offline: false }),
	);
	expect(byName(report, "specs-reachable").status).toBe("pass");
}, 20_000);

test("scenarios: well-formed list passes; bad YAML, non-list, and missing name/then fail; empty dir warns", async () => {
	const base = { "services.yaml": "services: {}\n" };
	const good = projectWith({
		...base,
		"scenarios/00-ok.yaml":
			'- name: ack\n  when:\n    topic: command/{deviceId}/set\n  then:\n    - emit:\n        topic: state/{{deviceId}}\n        payload: { deviceId: "{{deviceId}}" }\n',
		"scenarios/10-on-demand.yaml":
			"- name: kick\n  then:\n    - emit:\n        topic: state/x\n        payload: {}\n", // no `when` — on-demand-only is VALID
	});
	expect(
		byName(
			await runDoctor(ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: good })),
			"scenarios",
		).status,
	).toBe("pass");

	const badYaml = projectWith({
		...base,
		"scenarios/00-bad.yaml": "- name: [broken",
	});
	expect(
		byName(
			await runDoctor(
				ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: badYaml }),
			),
			"scenarios",
		).status,
	).toBe("fail");

	const notList = projectWith({
		...base,
		"scenarios/00-map.yaml": "name: solo\n",
	});
	const notListCheck = byName(
		await runDoctor(ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: notList })),
		"scenarios",
	);
	expect(notListCheck.status).toBe("fail");
	expect(notListCheck.detail).toContain("list");

	const noThen = projectWith({
		...base,
		"scenarios/00-nothen.yaml": "- name: hollow\n",
	});
	expect(
		byName(
			await runDoctor(
				ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: noThen }),
			),
			"scenarios",
		).status,
	).toBe("fail");

	const emptyDir = projectWith({ ...base, "scenarios/.keep": "" });
	expect(
		byName(
			await runDoctor(
				ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: emptyDir }),
			),
			"scenarios",
		).status,
	).toBe("warn");
});

// --- checks 6-7 (ports, runfile) + the verb ---

test("ports: a busy port fails and names it; free ports pass", async () => {
	// 127.0.0.1: Bun.listen("localhost") on a dual-stack host can bind a
	// DIFFERENT loopback address than a prior "localhost" bind (::1 vs
	// 127.0.0.1), so `portFree` uses 127.0.0.1 too — this test's fake
	// occupant must contend on the exact same address.
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 19130,
		socket: { data() {} },
	});
	try {
		const busy = await runDoctor(
			ctxWith({
				repoRoot: GOOD_REPO_ROOT,
				projectDir: projectWith({}),
				ports: { ws: 19130, tcp: 12995, ctrl: 19131 },
			}),
		);
		const check = byName(busy, "ports");
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("19130");
	} finally {
		listener.stop(true);
	}
	const free = await runDoctor(
		ctxWith({
			repoRoot: GOOD_REPO_ROOT,
			projectDir: projectWith({}),
			ports: { ws: 19130, tcp: 12995, ctrl: 19131 },
		}),
	);
	expect(byName(free, "ports").status).toBe("pass");
});

// [itest->R-043]
test("ports: a busy ctrl port that answers as offbook attributes it instead of a generic busy detail", async () => {
	const server = Bun.serve({
		port: 19134,
		fetch: () => Response.json({ mode: "passive" }),
	});
	try {
		const attributed = await runDoctor(
			ctxWith({
				repoRoot: GOOD_REPO_ROOT,
				projectDir: projectWith({}),
				ports: { ws: 19130, tcp: 12995, ctrl: 19134 },
			}),
		);
		const check = byName(attributed, "ports");
		expect(check.status).toBe("fail");
		expect(check.detail).toContain(
			"an offbook from another directory owns these ports",
		);
	} finally {
		server.stop(true);
	}
});

test("runfile: absent passes; stale (alive pid, dead port) warns with a `down` hint; live passes as already-up", async () => {
	const none = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: projectWith({}) }),
	);
	expect(byName(none, "runfile").status).toBe("pass");

	const staleDir = mkdtempSync(join(tmpdir(), "offbook-doctor-stale-"));
	await writeRunfile(staleDir, {
		pid: process.pid, // alive, but the control port answers nothing → stale
		brokerWsPort: 19130,
		brokerTcpPort: 12995,
		controlPlanePort: 19132,
		startedAt: "2026-07-29T00:00:00.000Z",
	});
	const stale = await runDoctor(
		ctxWith({
			repoRoot: GOOD_REPO_ROOT,
			projectDir: projectWith({}),
			runDir: staleDir,
		}),
	);
	const staleCheck = byName(stale, "runfile");
	expect(staleCheck.status).toBe("warn");
	expect(staleCheck.hint).toContain("offbook down");

	// live: a fake control plane answering GET /v1/mode marks the runfile live
	const server = Bun.serve({
		port: 19133,
		fetch: () => Response.json({ mode: "passive" }),
	});
	try {
		const liveDir = mkdtempSync(join(tmpdir(), "offbook-doctor-live-"));
		await writeRunfile(liveDir, {
			pid: process.pid,
			brokerWsPort: 19130,
			brokerTcpPort: 12995,
			controlPlanePort: 19133,
			startedAt: "2026-07-29T00:00:00.000Z",
		});
		const live = await runDoctor(
			ctxWith({
				repoRoot: GOOD_REPO_ROOT,
				projectDir: projectWith({}),
				runDir: liveDir,
			}),
		);
		expect(byName(live, "runfile").status).toBe("pass");
		expect(byName(live, "ports").detail).toContain("already up");
	} finally {
		server.stop(true);
	}
});

// [utest->R-042]
test("doctor skill check: non-repo pass, absent pass, identical pass, edited warn", async () => {
	const noRepo = mkdtempSync(join(tmpdir(), "doctor-skill-"));
	// biome-ignore lint/style/noNonNullAssertion: exact pattern from the brief
	const skillOnly = DOCTOR_CHECKS.find((c) => c.name === "skill")!;
	const r1 = await runDoctor(ctxWith({ projectDir: noRepo }), [skillOnly]);
	expect(r1.checks[0]).toMatchObject({ status: "pass" });

	const repo = mkdtempSync(join(tmpdir(), "doctor-skill-repo-"));
	const git = async (...args: string[]) => {
		const p = Bun.spawn(["git", ...args], {
			cwd: repo,
			stdout: "ignore",
			stderr: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
		expect(await p.exited).toBe(0);
	};
	await git("init", "-q", "-b", "main");
	const r2 = await runDoctor(ctxWith({ projectDir: repo }), [skillOnly]);
	expect(r2.checks[0].detail).toContain("not installed");

	const iox = { out: () => {}, err: () => {} };
	expect(await run(["skill", "install", "--dest", repo], iox)).toBe(0);
	const r3 = await runDoctor(ctxWith({ projectDir: repo }), [skillOnly]);
	expect(r3.checks[0]).toMatchObject({ status: "pass" });

	writeFileSync(
		join(repo, ".claude/skills/offbook-onboard/SKILL.md"),
		"edited\n",
	);
	// examine from a SUBDIRECTORY, not the toplevel itself — otherwise the
	// hint's `${top}` is indistinguishable from a `${ctx.projectDir}` bug
	const sub = join(repo, "app");
	mkdirSync(sub);
	const resolvedTop = realpathSync(repo); // beware /tmp symlinks
	const r4 = await runDoctor(ctxWith({ projectDir: sub }), [skillOnly]);
	expect(r4.checks[0].status).toBe("warn");
	expect(r4.checks[0].hint).toContain("offbook skill install --force");
	expect(r4.checks[0].hint).toContain(resolvedTop);
	expect(r4.checks[0].hint).not.toContain(join(resolvedTop, "app"));
	expect(r4.ok).toBe(true); // warn never fails doctor
});

// [utest->R-042]
test("doctor skill check: dest is a file (degenerate install) warns instead of crashing runDoctor", async () => {
	const repo = mkdtempSync(join(tmpdir(), "doctor-skill-degenerate-"));
	const git = async (...args: string[]) => {
		const p = Bun.spawn(["git", ...args], {
			cwd: repo,
			stdout: "ignore",
			stderr: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@t",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@t",
			},
		});
		expect(await p.exited).toBe(0);
	};
	await git("init", "-q", "-b", "main");
	mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
	writeFileSync(join(repo, ".claude", "skills", "offbook-onboard"), "x\n");
	const report = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: repo }),
	);
	expect(report.checks).toHaveLength(8);
	const skill = byName(report, "skill");
	expect(skill.status).toBe("warn");
	expect(skill.detail).toContain("unreadable/degenerate");
	expect(skill.detail).toContain("--force");
	expect(report.ok).toBe(true); // warn never fails doctor
});

test("`offbook doctor` verb: --json shape, exit codes, USAGE listing", async () => {
	const outLines: string[] = [];
	const io = { out: (l: string) => outLines.push(l), err: () => {} };
	const clean = projectWith({ "services.yaml": "services: {}\n" });
	const cleanDir = mkdtempSync(join(tmpdir(), "offbook-doctor-run-"));
	expect(
		await run(
			["doctor", clean, "--offline", "--json", "--run-dir", cleanDir],
			io,
		),
	).toBe(0);
	const report = JSON.parse(outLines.join("\n")) as DoctorReport;
	expect(report.checks.map((c) => c.name)).toEqual([
		"runtime",
		"deps",
		"project",
		"specs-reachable",
		"scenarios",
		"ports",
		"runfile",
		"skill",
	]);
	expect(report.ok).toBe(true);

	const broken = projectWith({
		"services.yaml": "services: [not: valid: yaml",
	});
	expect(
		await run(["doctor", broken, "--offline", "--run-dir", cleanDir], {
			out: () => {},
			err: () => {},
		}),
	).toBe(1);

	const usage: string[] = [];
	await run([], { out: () => {}, err: (l: string) => usage.push(l) });
	expect(usage.join("\n")).toContain("doctor");
});
