// R-035 — `offbook doctor` checks engine: checks are data; every failure
// names a next step (docs/specs/adoption.md §3).
// [utest->R-035]
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorCtx, DoctorReport } from "./doctor.ts";
import { DOCTOR_CHECKS, runDoctor, versionAtLeast } from "./doctor.ts";

// ports for this file (repo convention: unique per file): 19130-19133, 12995

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
