# Adoption Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make offbook foolproof to adopt: README front door + adopter guides, an `offbook doctor` preflight verb, a first-run error audit, and executable doc-rot gates (R-034–R-036, spec: `docs/specs/adoption.md`).

**Architecture:** Docs carry concepts and recipes; fool-proofing lives in the tool at the moment of failure. `doctor` is a checks-as-data engine (`DoctorCheck[]` in `src/cli/doctor.ts`) rendered by a thin `cmdDoctor` verb in `src/cli/index.ts`. The README quickstart and cookbook recipes are *executable docs*: tests extract their fenced blocks and run/load them, so doc drift fails `bun test`.

**Tech Stack:** TypeScript/Bun, `bun test`, existing `src/config`/`src/ingestion`/`src/scenarios` loaders, `scripts/check-docs.ts` doc gate.

## Global Constraints

- **Spec is canonical:** `docs/specs/adoption.md` (R-034–R-036, D-016). On any conflict between this plan and the spec, the spec governs.
- **Frozen contracts:** NO `/v1` endpoint or `Diagnostic.kind` change. `doctor` is CLI-local.
- **Transport isolation (R-030):** `src/cli/doctor.ts` must not import `aedes`/`mqtt`/`ws`/any transport package. Dependency sentinels are checked by `node_modules` file existence, never by import.
- **Import style (D-013):** upward reaches use `#src/...`; same-directory imports stay relative with explicit `.ts` (`./doctor.ts`); enforced by `test/import-style.test.ts`.
- **Test tags:** every new TEST file carries its arrow-tag comment (`// [utest->R-###]` / `// [itest->R-###]`) in the header; `bun scripts/check-docs.ts` verifies both directions once REQUIREMENTS traces flip in Task 9.
- **Ports are unique per test file.** This plan's allocations (none used elsewhere in the repo): doctor tests `19130 19131 19132 19133 12995`; quickstart gate `19120 12994 19894 19994`; audit pins `19140 19141 12996 12997 19896 19897`.
- **`bun test <single-file>` may exit 1 with zero failures** (per-file coverage floor). Judge single-file runs by the failure count in the output; gate on full `bun test`.
- **Run `bun scripts/check-docs.ts` before every commit.** It must stay green mid-campaign (it will: REQUIREMENTS traces only flip in Task 9).
- **Commit messages:** plain `-m`, no trailers of any kind.
- **Default ports (for docs and doctor):** ws `9001`, tcp `1883`, control plane `9080`; demo-app `9090`.
- **The bundled demo spec** (`src/demo/thermostat.yaml`) is the recipe target: `command/{deviceId}/set` (fromClient; payload `{mode: heat|cool|off, target: 5..35}`, both required, `additionalProperties: false`) and `state/{deviceId}` (toClient, QoS 1 retained; payload requires `deviceId, status, target, units`, optional `updatedAt: number`, `status ∈ accepted|heating|cooling|idle|offline`, `units ∈ C|F`, `additionalProperties: false`).
- **L2 grammar facts** (canonical: `docs/specs/l2-scenarios.md`): a scenario file is a YAML **list**; each entry has `name` (required, globally unique), `when` (OPTIONAL — absent ⇒ on-demand-only, fired via `offbook scenario <name>`), `then` (list of `emit` steps). Single braces `{x}` capture in `when.topic`; double braces `{{x}}` substitute in emissions; `delay: 50-80ms` ranges are seeded-deterministic; `payloadMatch` is subset equality, no operators.

---

### Task 1: `engines.bun` + the doctor checks engine (runtime, deps)

**Files:**
- Modify: `package.json` (add `engines`)
- Create: `src/cli/doctor.ts`
- Test: `src/cli/doctor.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (later tasks rely on these exact names): `type CheckStatus = "pass" | "warn" | "fail"`; `interface CheckResult { status: CheckStatus; detail: string; hint?: string }`; `interface DoctorCtx { repoRoot: string; projectDir: string; runDir: string; offline: boolean; bunVersion: string; ports: { ws: number; tcp: number; ctrl: number } }`; `interface DoctorCheck { name: string; run(ctx: DoctorCtx): Promise<CheckResult> }`; `interface DoctorReport { ok: boolean; checks: { name: string; status: CheckStatus; detail: string; hint?: string }[] }`; `const DOCTOR_CHECKS: DoctorCheck[]`; `function runDoctor(ctx: DoctorCtx, checks?: DoctorCheck[]): Promise<DoctorReport>`; `function versionAtLeast(actual: string, floor: string): boolean`.

- [ ] **Step 1: Add the engines floor to package.json**

In `package.json`, directly after the `"private": true,` line, add:

```json
	"engines": {
		"bun": ">=1.3"
	},
```

(The repo develops against Bun 1.3.14; the floor is the developed-against `major.minor` per spec §3 — never a guessed-lower bound.)

- [ ] **Step 2: Write the failing tests**

Create `src/cli/doctor.test.ts`:

```ts
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
	expect(byName(await runDoctor(ctxWith({ repoRoot: root })), "deps").status).toBe("pass");
});

test("runDoctor: ok is false iff any check fails; order is the declared order", async () => {
	const root = fakeRepo(">=1.3", ALL_DEPS);
	const clean = await runDoctor(ctxWith({ repoRoot: root }));
	expect(clean.checks.map((c) => c.name)).toEqual(DOCTOR_CHECKS.map((c) => c.name));
	const broken = await runDoctor(ctxWith({ repoRoot: fakeRepo(undefined, []) }));
	expect(broken.ok).toBe(false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test src/cli/doctor.test.ts`
Expected: FAIL — cannot resolve `./doctor.ts`.

- [ ] **Step 4: Implement the checks engine**

Create `src/cli/doctor.ts`:

```ts
// R-035 — `offbook doctor`: first-run preflight (docs/specs/adoption.md §3).
// Checks are DATA (DoctorCheck[]) — the future init-wizard substrate (D-016).
// CLI-local: no /v1 or contract change; imports no transport package (R-030 —
// dependency sentinels are checked by node_modules presence, never imported).
import { existsSync } from "node:fs";
import { join } from "node:path";

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
	status: CheckStatus;
	detail: string;
	hint?: string;
}

export interface DoctorCtx {
	repoRoot: string; // the offbook checkout — engines.bun + node_modules live here
	projectDir: string; // the adopter project under examination
	runDir: string;
	offline: boolean;
	bunVersion: string; // injected so tests can fake it
	ports: { ws: number; tcp: number; ctrl: number };
}

export interface DoctorCheck {
	name: string;
	run(ctx: DoctorCtx): Promise<CheckResult>;
}

export interface DoctorReport {
	ok: boolean;
	checks: { name: string; status: CheckStatus; detail: string; hint?: string }[];
}

// numeric major.minor compare — "1.10" >= "1.9" (never lexicographic)
export function versionAtLeast(actual: string, floor: string): boolean {
	const [amaj = 0, amin = 0] = actual.split(".").map(Number);
	const [fmaj = 0, fmin = 0] = floor.split(".").map(Number);
	return amaj > fmaj || (amaj === fmaj && amin >= fmin);
}

const INCOMPLETE = "the offbook checkout looks incomplete — re-clone it";

const runtime: DoctorCheck = {
	name: "runtime",
	async run(ctx) {
		const pkgPath = join(ctx.repoRoot, "package.json");
		if (!existsSync(pkgPath))
			return { status: "fail", detail: `no package.json at ${ctx.repoRoot}`, hint: INCOMPLETE };
		const pkg = JSON.parse(await Bun.file(pkgPath).text()) as {
			engines?: { bun?: string };
		};
		const floor = pkg.engines?.bun?.replace(/^[^0-9]*/, "");
		if (floor === undefined || floor === "")
			return { status: "fail", detail: "package.json declares no engines.bun floor", hint: INCOMPLETE };
		return versionAtLeast(ctx.bunVersion, floor)
			? { status: "pass", detail: `bun ${ctx.bunVersion} (floor ${floor})` }
			: {
					status: "fail",
					detail: `bun ${ctx.bunVersion} is below the floor ${floor}`,
					hint: `upgrade Bun to >= ${floor} (https://bun.sh)`,
				};
	},
};

// resolvable ⇒ `bun install` ran (spec §3 names these two sentinels)
const SENTINELS = ["@asyncapi/parser", "ajv"];

const deps: DoctorCheck = {
	name: "deps",
	async run(ctx) {
		const missing = SENTINELS.filter(
			(pkg) => !existsSync(join(ctx.repoRoot, "node_modules", pkg, "package.json")),
		);
		return missing.length === 0
			? { status: "pass", detail: `dependencies present (${SENTINELS.join(", ")})` }
			: {
					status: "fail",
					detail: `missing from node_modules: ${missing.join(", ")}`,
					hint: "run `bun install` in the offbook checkout",
				};
	},
};

export const DOCTOR_CHECKS: DoctorCheck[] = [runtime, deps];

export async function runDoctor(
	ctx: DoctorCtx,
	checks: DoctorCheck[] = DOCTOR_CHECKS,
): Promise<DoctorReport> {
	const results: DoctorReport["checks"] = [];
	for (const check of checks)
		results.push({ name: check.name, ...(await check.run(ctx)) });
	return { ok: results.every((r) => r.status !== "fail"), checks: results };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/cli/doctor.test.ts`
Expected: all tests PASS (exit code may still be 1 from the per-file coverage floor — judge by the failure count).

- [ ] **Step 6: Full-suite sanity + commit**

```bash
bun test && bun scripts/check-docs.ts
git add package.json src/cli/doctor.ts src/cli/doctor.test.ts
git commit -m "feat: doctor checks engine — engines.bun floor, runtime + deps checks (R-035)"
```

---

### Task 2: doctor checks 3–5 (project, specs-reachable, scenarios)

**Files:**
- Modify: `src/cli/doctor.ts`
- Test: `src/cli/doctor.test.ts` (extend)

**Interfaces:**
- Consumes (Task 1): `DoctorCheck`, `CheckResult`, `DoctorCtx`, `DOCTOR_CHECKS`, `runDoctor`.
- Consumes (repo): `loadServices(path)` / `loadEnvironments(path)` from `#src/config/index.ts` (verify `loadEnvironments`'s exact call form at `src/config/index.ts:108` before use); `resolveRepoUrl(repo, gitHost?)` from `#src/ingestion/index.ts`; `parse as parseYaml` from `yaml` (the parser `config/` already uses).
- Produces: checks named `project`, `specs-reachable`, `scenarios` appended to `DOCTOR_CHECKS` in that order.

- [ ] **Step 1: Write the failing tests (append to `src/cli/doctor.test.ts`)**

```ts
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
	const report = await runDoctor(ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: dir }));
	const project = byName(report, "project");
	expect(project.status).toBe("fail");
	expect(project.detail).toContain("services.yaml");
});

test("project: valid services.yaml + environments.yaml passes", async () => {
	const dir = projectWith({
		"services.yaml": "services: {}\n",
		"environments.yaml": "environments:\n  default: {}\n",
	});
	const report = await runDoctor(ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: dir }));
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
		"services.yaml": `services:\n  thermostat:\n    repo: /nonexistent/nowhere\n    specPath: asyncapi.yaml\n    branch: main\n`,
	});
	const badReport = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: bad, offline: false }),
	);
	const check = byName(badReport, "specs-reachable");
	expect(check.status).toBe("fail");
	expect(check.detail).toContain("thermostat");
	expect(check.hint).toContain("gitHost");
}, 20_000);

test("scenarios: well-formed list passes; bad YAML, non-list, and missing name/then fail; empty dir warns", async () => {
	const base = { "services.yaml": "services: {}\n" };
	const good = projectWith({
		...base,
		"scenarios/00-ok.yaml":
			"- name: ack\n  when:\n    topic: command/{deviceId}/set\n  then:\n    - emit:\n        topic: state/{{deviceId}}\n        payload: { deviceId: \"{{deviceId}}\" }\n",
		"scenarios/10-on-demand.yaml":
			"- name: kick\n  then:\n    - emit:\n        topic: state/x\n        payload: {}\n", // no `when` — on-demand-only is VALID
	});
	expect(byName(await runDoctor(ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: good })), "scenarios").status).toBe("pass");

	const badYaml = projectWith({ ...base, "scenarios/00-bad.yaml": "- name: [broken" });
	expect(byName(await runDoctor(ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: badYaml })), "scenarios").status).toBe("fail");

	const notList = projectWith({ ...base, "scenarios/00-map.yaml": "name: solo\n" });
	const notListCheck = byName(await runDoctor(ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: notList })), "scenarios");
	expect(notListCheck.status).toBe("fail");
	expect(notListCheck.detail).toContain("list");

	const noThen = projectWith({ ...base, "scenarios/00-nothen.yaml": "- name: hollow\n" });
	expect(byName(await runDoctor(ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: noThen })), "scenarios").status).toBe("fail");

	const emptyDir = projectWith({ ...base, "scenarios/.keep": "" });
	expect(byName(await runDoctor(ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: emptyDir })), "scenarios").status).toBe("warn");
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test src/cli/doctor.test.ts`
Expected: new tests FAIL — `no check named project`.

- [ ] **Step 3: Implement checks 3–5 (append to `src/cli/doctor.ts`, before `DOCTOR_CHECKS`)**

Add imports at the top (D-013: upward reaches via `#src/`):

```ts
import { loadEnvironments, loadServices } from "#src/config/index.ts";
import { resolveRepoUrl } from "#src/ingestion/index.ts";
import { parse as parseYaml } from "yaml";
```

Append the checks:

```ts
const WIRING_GUIDE = "docs/guides/wiring-your-service.md";
const COOKBOOK = "docs/guides/scenario-cookbook.md";

const project: DoctorCheck = {
	name: "project",
	async run(ctx) {
		const servicesPath = join(ctx.projectDir, "services.yaml");
		if (!existsSync(servicesPath))
			return {
				status: "warn",
				detail: `no services.yaml in ${ctx.projectDir}`,
				hint: "not an offbook project — `offbook init`, or cd to one; `offbook demo` needs none",
			};
		try {
			await loadServices(servicesPath);
		} catch (cause) {
			return {
				status: "fail",
				detail: `services.yaml: ${(cause as Error).message}`,
				hint: `fix services.yaml — see ${WIRING_GUIDE}`,
			};
		}
		const envPath = join(ctx.projectDir, "environments.yaml");
		if (existsSync(envPath)) {
			try {
				await loadEnvironments(envPath);
			} catch (cause) {
				return {
					status: "fail",
					detail: `environments.yaml: ${(cause as Error).message}`,
					hint: `fix environments.yaml — see ${WIRING_GUIDE}`,
				};
			}
		}
		return { status: "pass", detail: "services.yaml + environments.yaml parse" };
	},
};

// `git ls-remote --exit-code <url> <ref>`: 0 = ref exists; 2 = repo reachable
// but no such ref; 128 = unreachable. Bounded by a kill timer.
async function refUnreachable(
	url: string,
	ref: string,
	timeoutMs: number,
): Promise<string | null> {
	const proc = Bun.spawn(["git", "ls-remote", "--exit-code", url, ref], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	const code = await proc.exited;
	clearTimeout(timer);
	if (code === 0) return null;
	const firstErr = (await new Response(proc.stderr).text()).trim().split("\n")[0];
	return firstErr === "" || firstErr === undefined
		? `git ls-remote exited ${code}`
		: firstErr;
}

const specsReachable: DoctorCheck = {
	name: "specs-reachable",
	async run(ctx) {
		if (ctx.offline) return { status: "warn", detail: "skipped (--offline)" };
		const servicesPath = join(ctx.projectDir, "services.yaml");
		if (!existsSync(servicesPath))
			return { status: "warn", detail: "skipped (no services.yaml — see `project`)" };
		let gitHost: string | undefined;
		let services: Record<string, { repo: string; branch?: string }>;
		try {
			({ gitHost, services } = await loadServices(servicesPath));
		} catch {
			return { status: "warn", detail: "skipped (services.yaml does not parse — see `project`)" };
		}
		const names = Object.keys(services);
		if (names.length === 0)
			return {
				status: "warn",
				detail: "no services configured yet",
				hint: `add your first service — ${WIRING_GUIDE}`,
			};
		for (const name of names) {
			const svc = services[name];
			const branch = svc.branch ?? "main";
			const url = resolveRepoUrl(svc.repo, gitHost);
			const err = await refUnreachable(url, branch, 5_000);
			if (err !== null)
				return {
					status: "fail",
					detail: `${name}: ${url}@${branch} unreachable (${err})`,
					hint: `check gitHost/repo/branch for '${name}' in services.yaml`,
				};
		}
		return { status: "pass", detail: `${names.length} service repo(s) reachable` };
	},
};

// Shape-only by design (spec §3): full validation needs the resolved registry
// (a network fetch) — a live server already surfaces it via /v1/diagnostics.
const scenarios: DoctorCheck = {
	name: "scenarios",
	async run(ctx) {
		const dir = join(ctx.projectDir, "scenarios");
		if (!existsSync(dir))
			return { status: "warn", detail: "no scenarios/ directory", hint: `recipes: ${COOKBOOK}` };
		const files = (
			await Array.fromAsync(new Bun.Glob("**/*.yaml").scan({ cwd: dir }))
		).sort();
		if (files.length === 0)
			return { status: "warn", detail: "no scenario files", hint: `recipes: ${COOKBOOK}` };
		for (const rel of files) {
			let doc: unknown;
			try {
				doc = parseYaml(await Bun.file(join(dir, rel)).text());
			} catch (cause) {
				return {
					status: "fail",
					detail: `${rel}: ${(cause as Error).message}`,
					hint: `fix the YAML — ${COOKBOOK}`,
				};
			}
			if (doc === null || doc === undefined) continue; // empty file: fine
			if (!Array.isArray(doc))
				return {
					status: "fail",
					detail: `${rel}: expected a YAML list of scenarios`,
					hint: `each file is a list — ${COOKBOOK}`,
				};
			for (const [i, s] of doc.entries()) {
				const entry = s as { name?: unknown; then?: unknown };
				if (
					typeof s !== "object" ||
					s === null ||
					typeof entry.name !== "string" ||
					!Array.isArray(entry.then)
				)
					return {
						status: "fail",
						detail: `${rel}[${i}]: a scenario needs 'name' and a 'then' list ('when' is optional)`,
						hint: COOKBOOK,
					};
			}
		}
		return {
			status: "pass",
			detail: `${files.length} scenario file(s) well-formed (full validation: \`offbook diagnostics\` when up)`,
		};
	},
};
```

Update the registration line:

```ts
export const DOCTOR_CHECKS: DoctorCheck[] = [
	runtime,
	deps,
	project,
	specsReachable,
	scenarios,
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/cli/doctor.test.ts`
Expected: all PASS (coverage-floor exit caveat applies).

- [ ] **Step 5: Full-suite sanity + commit**

```bash
bun test && bun scripts/check-docs.ts
git add src/cli/doctor.ts src/cli/doctor.test.ts
git commit -m "feat: doctor project/specs-reachable/scenarios checks (R-035)"
```

---

### Task 3: doctor checks 6–7 (ports, runfile) + the `doctor` verb

**Files:**
- Modify: `src/cli/doctor.ts` (two checks)
- Modify: `src/cli/index.ts` (cmdDoctor, VERBS, USAGE)
- Test: `src/cli/doctor.test.ts` (extend)

**Interfaces:**
- Consumes (Task 1/2): the doctor module; (repo): `resolveRunning` from `./runfile.ts` (same-dir, D-013); in `index.ts`: `parseFlags`, `runDirOf`, `Io`, `CliError` conventions, `readRunfile` (already imported there).
- Produces: `cmdDoctor(rest: string[], io: Io): Promise<number>` in `index.ts`; USAGE line for `doctor`; final `DOCTOR_CHECKS` order `runtime, deps, project, specs-reachable, scenarios, ports, runfile`.

- [ ] **Step 1: Write the failing tests (append to `src/cli/doctor.test.ts`)**

Add to the imports: `import { run } from "./index.ts";` and `import { writeRunfile } from "./runfile.ts";`

```ts
// --- checks 6-7 (ports, runfile) + the verb ---

test("ports: a busy port fails and names it; free ports pass", async () => {
	const listener = Bun.listen({ hostname: "localhost", port: 19130, socket: { data() {} } });
	try {
		const busy = await runDoctor(
			ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: projectWith({}), ports: { ws: 19130, tcp: 12995, ctrl: 19131 } }),
		);
		const check = byName(busy, "ports");
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("19130");
	} finally {
		listener.stop(true);
	}
	const free = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: projectWith({}), ports: { ws: 19130, tcp: 12995, ctrl: 19131 } }),
	);
	expect(byName(free, "ports").status).toBe("pass");
});

test("runfile: absent passes; stale (alive pid, dead port) warns with a `down` hint; live passes as already-up", async () => {
	const none = await runDoctor(ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: projectWith({}) }));
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
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: projectWith({}), runDir: staleDir }),
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
			ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: projectWith({}), runDir: liveDir }),
		);
		expect(byName(live, "runfile").status).toBe("pass");
		expect(byName(live, "ports").detail).toContain("already up");
	} finally {
		server.stop(true);
	}
});

test("`offbook doctor` verb: --json shape, exit codes, USAGE listing", async () => {
	const outLines: string[] = [];
	const io = { out: (l: string) => outLines.push(l), err: () => {} };
	const clean = projectWith({ "services.yaml": "services: {}\n" });
	const cleanDir = mkdtempSync(join(tmpdir(), "offbook-doctor-run-"));
	expect(await run(["doctor", clean, "--offline", "--json", "--run-dir", cleanDir], io)).toBe(0);
	const report = JSON.parse(outLines.join("\n")) as DoctorReport;
	expect(report.checks.map((c) => c.name)).toEqual([
		"runtime",
		"deps",
		"project",
		"specs-reachable",
		"scenarios",
		"ports",
		"runfile",
	]);
	expect(report.ok).toBe(true);

	const broken = projectWith({ "services.yaml": "services: [not: valid: yaml" });
	expect(await run(["doctor", broken, "--offline", "--run-dir", cleanDir], { out: () => {}, err: () => {} })).toBe(1);

	const usage: string[] = [];
	await run([], { out: () => {}, err: (l: string) => usage.push(l) });
	expect(usage.join("\n")).toContain("doctor");
});
```

Note: the verb test's `run(["doctor", ...])` uses real `Bun.version` and the real repo root — both healthy in CI by construction (the suite itself is running under them). The default ports (9001/1883/9080) may be busy on a dev machine, which is why the `--json`/exit-0 assertion uses a project with no runfile: if this proves flaky because a real offbook is up locally, assert `report.checks.length === 7` instead of `report.ok` and drop the `ok` expectation — exit-code coverage stays via the broken-project case. Prefer the strict version first.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test src/cli/doctor.test.ts`
Expected: FAIL — `no check named ports`, and `run(["doctor"...])` exits 1 with usage (unknown verb).

- [ ] **Step 3: Implement checks 6–7 (append to `src/cli/doctor.ts`)**

Add to the same-dir imports: `import { resolveRunning } from "./runfile.ts";`

```ts
async function portFree(port: number): Promise<boolean> {
	try {
		const listener = Bun.listen({ hostname: "localhost", port, socket: { data() {} } });
		listener.stop(true);
		return true;
	} catch {
		return false;
	}
}

const ports: DoctorCheck = {
	name: "ports",
	async run(ctx) {
		const running = await resolveRunning(ctx.runDir);
		if (running?.live === true) {
			const r = running.run;
			return {
				status: "pass",
				detail: `offbook already up (pid ${r.pid}: ws ${r.brokerWsPort}, tcp ${r.brokerTcpPort}, ctrl ${r.controlPlanePort})`,
			};
		}
		const busy: string[] = [];
		const labeled: [string, number][] = [
			["ws", ctx.ports.ws],
			["tcp", ctx.ports.tcp],
			["ctrl", ctx.ports.ctrl],
		];
		for (const [label, port] of labeled)
			if (!(await portFree(port))) busy.push(`${label} ${port}`);
		return busy.length === 0
			? {
					status: "pass",
					detail: `ports free (ws ${ctx.ports.ws}, tcp ${ctx.ports.tcp}, ctrl ${ctx.ports.ctrl})`,
				}
			: {
					status: "fail",
					detail: `port(s) busy: ${busy.join(", ")}`,
					hint: "stop the other process, or pass --ws-port/--tcp-port/--ctrl-port to `offbook up`",
				};
	},
};

const runfileCheck: DoctorCheck = {
	name: "runfile",
	async run(ctx) {
		const resolved = await resolveRunning(ctx.runDir);
		if (resolved === undefined)
			return { status: "pass", detail: "no runfile (nothing running here)" };
		return resolved.live
			? { status: "pass", detail: `live (pid ${resolved.run.pid})` }
			: {
					status: "warn",
					detail: `stale runfile (pid ${resolved.run.pid} not answering)`,
					hint: "`offbook down` cleans it up",
				};
	},
};
```

Final registration order:

```ts
export const DOCTOR_CHECKS: DoctorCheck[] = [
	runtime,
	deps,
	project,
	specsReachable,
	scenarios,
	ports,
	runfileCheck,
];
```

- [ ] **Step 4: Wire the verb into `src/cli/index.ts`**

Imports (top of file, with the other same-dir imports):

```ts
import type { CheckStatus, DoctorCtx } from "./doctor.ts";
import { DOCTOR_CHECKS, runDoctor } from "./doctor.ts";
```

Add the command (beside the other cmdX functions, e.g. after `cmdInit`):

```ts
// --- doctor (R-035 — preflight; adoption.md §3; CLI-local, no /v1) ---

const DOCTOR_GLYPH: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗" };

async function cmdDoctor(rest: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(rest, {
		offline: { type: "boolean" },
		json: { type: "boolean" },
		"run-dir": { type: "string" },
	});
	const runDir = runDirOf(values);
	const run = await readRunfile(runDir); // live or stale: its ports are the ones that matter
	const ctx: DoctorCtx = {
		repoRoot: join(import.meta.dir, "../.."),
		projectDir: positionals[0] ?? ".",
		runDir,
		offline: values.offline === true,
		bunVersion: Bun.version,
		ports: run
			? { ws: run.brokerWsPort, tcp: run.brokerTcpPort, ctrl: run.controlPlanePort }
			: { ws: 9001, tcp: 1883, ctrl: 9080 },
	};
	const report = await runDoctor(ctx);
	if (values.json === true) {
		io.out(JSON.stringify(report));
	} else {
		for (const c of report.checks) {
			io.out(`${DOCTOR_GLYPH[c.status]} ${c.name} — ${c.detail}`);
			if (c.hint !== undefined) io.out(`    ↳ ${c.hint}`);
		}
		const fails = report.checks.filter((c) => c.status === "fail").length;
		io.out(fails === 0 ? "doctor: ok" : `doctor: ${fails} problem(s)`);
	}
	return report.ok ? 0 : 1;
}
```

(`parseFlags`, `runDirOf`, `Io`, and `readRunfile` already exist in `index.ts` — reuse, do not redefine. If `parseFlags` rejects positionals for flag-only specs, follow `cmdInit`'s exact pattern for reading `positionals[0]`.)

Register in `VERBS`:

```ts
	doctor: cmdDoctor,
```

Add to `USAGE` (after the `init` line):

```
  doctor [dir] [--offline] [--json]  preflight: runtime, deps, config, spec reachability, ports
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/cli/doctor.test.ts`
Expected: all PASS.

- [ ] **Step 6: Full suite + commit**

```bash
bun test && bun scripts/check-docs.ts
git add src/cli/doctor.ts src/cli/doctor.test.ts src/cli/index.ts
git commit -m "feat: offbook doctor — ports/runfile checks + verb wiring (R-035)"
```

---

### Task 4: README + the executable quickstart gate

**Files:**
- Create: `README.md`
- Test: `test/readme-quickstart.test.ts`

**Interfaces:**
- Consumes: `run` from `#src/cli/index.ts`; `readRunfile` from `#src/cli/runfile.ts`; `demo --serve` semantics (detached; returns after readiness); `demo-app/serve.ts` flags `--port/--ctrl-port/--run-dir`.
- Produces: `README.md` whose two `sh quickstart`-tagged fences contain exactly `offbook demo --serve` and `bun run demo-app` (the gate pins this).

- [ ] **Step 1: Write the failing gate test**

Create `test/readme-quickstart.test.ts`:

```ts
// R-034/R-036 — the README quickstart is executable (adoption.md §4): the
// canonical sequence runs end-to-end, and the README's tagged fences must
// match it token-for-token (execution appends ONLY --run-dir + port flags).
// [itest->R-034]
// [itest->R-036]
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "#src/cli/index.ts";
import { readRunfile } from "#src/cli/runfile.ts";

// ports for this file: ws 19120 / tcp 12994 / ctrl 19894 / demo-app 19994
const WS = "19120";
const TCP = "12994";
const CTRL = "19894";
const APP = "19994";
const REPO_ROOT = join(import.meta.dir, "..");

function quickstartFences(text: string): string[] {
	const lines: string[] = [];
	for (const m of text.matchAll(/```sh quickstart\n([\s\S]*?)```/g))
		for (const raw of m[1].split("\n")) {
			const line = raw.trim();
			if (line !== "" && !line.startsWith("#")) lines.push(line);
		}
	return lines;
}

test("README quickstart: fences match the canonical sequence, and it executes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "offbook-quickstart-"));
	const runDir = join(dir, ".offbook");
	const io = { out: () => {}, err: () => {} };
	let app: ReturnType<typeof Bun.spawn> | undefined;
	try {
		// the canonical sequence — execution may append ONLY --run-dir and ports
		const canonical = [
			{
				line: "offbook demo --serve",
				exec: async () => {
					expect(
						await run(
							["demo", "--serve", "--run-dir", runDir, "--ws-port", WS, "--tcp-port", TCP, "--ctrl-port", CTRL],
							io,
						),
					).toBe(0);
				},
			},
			{
				line: "bun run demo-app",
				exec: async () => {
					// `bun run demo-app` = `bun demo-app/serve.ts` (package.json script)
					app = Bun.spawn(
						[process.execPath, "demo-app/serve.ts", "--port", APP, "--ctrl-port", CTRL, "--run-dir", runDir],
						{ cwd: REPO_ROOT, stdout: "ignore", stderr: "ignore" },
					);
				},
			},
		];

		const readme = await Bun.file(join(REPO_ROOT, "README.md")).text();
		expect(quickstartFences(readme)).toEqual(canonical.map((c) => c.line));

		for (const step of canonical) await step.exec();

		// the quickstart's promise: the page serves and /v1 proxies through
		const deadline = Date.now() + 10_000;
		let ready = false;
		while (Date.now() < deadline && !ready) {
			ready = await fetch(`http://localhost:${APP}/`)
				.then((r) => r.ok)
				.catch(() => false);
			if (!ready) await new Promise((r) => setTimeout(r, 100));
		}
		expect(ready).toBe(true);
		expect((await fetch(`http://localhost:${APP}/v1/topics`)).ok).toBe(true);

		// teardown is part of the documented sequence
		expect(await run(["down", "--run-dir", runDir], io)).toBe(0);
	} finally {
		app?.kill();
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/readme-quickstart.test.ts`
Expected: FAIL — no `README.md`.

- [ ] **Step 3: Write `README.md`**

Create `README.md` at the repo root with exactly this content (the two tagged fences are pinned by the gate — do not reword them):

````markdown
# Offbook

Mock your MQTT-over-WebSockets backend from its AsyncAPI specs — so contract
breaks and async bugs surface at dev time, not deploy time.

Offbook boots a real MQTT broker (WebSockets + TCP) that behaves like the
services your app talks to: it replays their retained state, answers commands
with spec-faithful emissions on seeded-deterministic timing, and validates
every message in both directions against the AsyncAPI contracts — surfacing
violations loudly without ever blocking delivery, exactly like the
payload-agnostic broker in production.

## Mental model

```
your app ──── ws://localhost:9001 ────► offbook broker
                                          │ specs in:  services.yaml → your git host (AsyncAPI)
                                          │ behavior:  scenarios/*.yaml (L2 recipes)
                                          ▼
                              violations & state out:
                       `offbook validation` · `offbook state` · demo app
                       control plane (HTTP): localhost:9080
```

Your app connects exactly as it would to the real backend. Offbook plays the
other side of every topic and tells you when either side breaks the contract.

## Prerequisites

- [Bun](https://bun.sh) >= 1.3 (the `engines.bun` floor in `package.json`)
- git access to the host your AsyncAPI spec repos live on

## Quickstart (zero config)

```sh
git clone <internal-git>/offbook && cd offbook
bun install
bun link        # puts `offbook` on your PATH (once)
```

```sh quickstart
offbook demo --serve
bun run demo-app
```

Open <http://localhost:9090>: a thermostat dashboard driven entirely by a
mocked service. Send a command and watch state chain back. Click **Break the
schema** and watch the violation land in the feed within a second.

Done? Ctrl-C the demo-app, then `offbook down`.

If anything fails: `offbook doctor` — it checks your runtime, dependencies,
config, spec reachability, and ports, and tells you the next step.

## Your own service

```sh
offbook init
# edit services.yaml — point it at your service's AsyncAPI spec repo
offbook up
```

Full walkthrough: [wiring your service](docs/guides/wiring-your-service.md).

## Commands

| lifecycle | verbs |
|-----------|-------|
| run       | `up` · `down` · `status` · `logs` · `demo` |
| observe   | `topics` · `state` · `validation` · `diagnostics` · `check` |
| interact  | `publish` · `scenario` · `scenarios` · `mode` · `reset` |
| maintain  | `init` · `specs` · `doctor` |

`offbook` with no arguments prints full usage with flags.

## Guides

- [Getting started](docs/guides/getting-started.md) — from the demo to your first real spec
- [Wiring your service](docs/guides/wiring-your-service.md) — services.yaml, environments, specs.lock
- [Scenario cookbook](docs/guides/scenario-cookbook.md) — paste-able L2 recipes
- [The daily loop](docs/guides/daily-loop.md) — offbook alongside your dev server and in CI

Contributing, or how this repo itself is organized: [AGENTS.md](AGENTS.md).
````

`<internal-git>` is a deliberate reader-substituted placeholder (spec §2) — do not replace it with a real host.

- [ ] **Step 4: Run the gate to verify it passes**

Run: `bun test test/readme-quickstart.test.ts`
Expected: PASS (~5-10s: it boots the real demo server and demo-app).

- [ ] **Step 5: Full suite + commit**

```bash
bun test && bun scripts/check-docs.ts
git add README.md test/readme-quickstart.test.ts
git commit -m "docs: README front door + executable quickstart gate (R-034, R-036)"
```

---

### Task 5: guides — getting-started, wiring-your-service, daily-loop

**Files:**
- Create: `docs/guides/getting-started.md`
- Create: `docs/guides/wiring-your-service.md`
- Create: `docs/guides/daily-loop.md`

**Interfaces:**
- Consumes: the CLI verb surface (USAGE in `src/cli/index.ts`) and `init`'s scaffold texts (`INIT_SERVICES`/`INIT_ENVIRONMENTS` in `src/cli/index.ts` around line 1177) — every command and file shown must match what the tool actually prints/scaffolds. Verify each against the source before writing it down.
- Produces: three guides that Task 7's link gate and `README.md`'s links resolve against. The cookbook link (`scenario-cookbook.md`) is written in Task 6 — cross-links to it are fine (the link gate only lands in Task 7, after both).

- [ ] **Step 1: Write `docs/guides/getting-started.md`**

````markdown
# Getting started

You ran the README quickstart and saw the thermostat demo. This guide maps
what you saw onto the pieces you'll use with your own service, then hands
off to [wiring your service](wiring-your-service.md).

## What the demo showed

- `offbook demo --serve` booted a real MQTT broker (ws `:9001`, tcp `:1883`)
  and a control plane (`:9080`) from a bundled AsyncAPI spec plus bundled
  scenario recipes — detached, exactly like `offbook up` (`offbook status`,
  `offbook logs`, `offbook down` all work on it).
- The webapp connected over WebSockets like any client. Retained state
  painted the dashboard before anything was published; publishing
  `command/thermostat-1/set` made scenarios answer on `state/thermostat-1`.
- The break buttons produced contract violations: surfaced in the feed and
  in `offbook validation` — but still delivered. Offbook never blocks a
  message; it surfaces the break loudly. That is deliberate: the production
  broker is payload-agnostic too.

## The same, from the terminal

With the demo still up:

```sh
offbook topics        # every topic: direction, example payload
offbook state         # retained state right now
offbook publish command/thermostat-1/set --example --wait
offbook validation -v # violations, oldest first
```

`offbook topics` is the contract at a glance: "you send" topics are what your
app publishes; "you receive" topics are what the mock emits.

## Your own project

```sh
mkdir my-mock && cd my-mock
offbook init
```

`init` scaffolds `services.yaml`, `environments.yaml`, `scenarios/`, and
`handlers/`. Next: [wiring your service](wiring-your-service.md). Whenever
something misbehaves along the way: `offbook doctor`.
````

- [ ] **Step 2: Write `docs/guides/wiring-your-service.md`**

````markdown
# Wiring your service

Goal: `offbook up` boots a mock of **your** service from its AsyncAPI spec.
Prerequisite: `offbook init` ran in your project directory
([getting started](getting-started.md)).

## 1. Point services.yaml at the spec

```yaml
gitHost: https://git.example.com   # base URL for org/name repo slugs
services:
  my-service:
    repo: org/my-service   # slug (resolved against gitHost), full URL, or absolute path
    specPath: asyncapi.yaml
    branch: main
```

- `repo` — where the spec lives. Three forms: an `org/name` slug (joined to
  `gitHost`), a full git URL, or an absolute local path (handy for trying a
  spec you have checked out).
- `specPath` — the AsyncAPI document's path inside that repo.
- `branch` — v1 fetches branch tips (`main` if omitted).

Multiple services merge into one mock: add one entry per service.

## 2. environments.yaml (optional in v1)

```yaml
environments:
  default: {}
```

v1 records requested versions per environment but fetches branch tips; leave
it scaffolded as-is unless you already know you need it.

## 3. First `offbook up`

```sh
offbook up
offbook topics
```

`up` fetches each spec at its branch tip, records exactly what it fetched
(commit SHA + content hash) to `specs.lock`, compiles the merged contract,
and boots. `offbook topics` shows what got ingested — check the directions
("you send" / "you receive") match your mental model before going further.

A fetch failure aborts `up` (no half-booted mock). The error names the
service; `offbook doctor` checks all repos' reachability in one pass.

## 4. Keeping specs fresh

```sh
offbook specs          # provenance: what was fetched, when, which SHA
offbook specs update   # re-resolve branch tips + hot-swap the running mock
offbook up --watch     # re-resolve periodically while developing
```

## 5. Make it answer: scenarios

An ingested spec gives you topics, retained state, and validation. To make
the mock *react* (ack commands, chain state changes), add L2 scenarios:
[scenario cookbook](scenario-cookbook.md).
````

- [ ] **Step 3: Write `docs/guides/daily-loop.md`**

````markdown
# The daily loop

Offbook earns its keep when it is simply *there* every time you develop —
not a tool you remember to reach for.

## Alongside your dev server

Keep the mock project in your app repo (say `mock/`), and add scripts next
to your dev entry:

```json
{
	"scripts": {
		"mock:up": "cd mock && offbook up",
		"mock:down": "cd mock && offbook down"
	}
}
```

`offbook up` is detached: run `mock:up` once in the morning; your app then
connects to `ws://localhost:9001` whenever it starts. `offbook status` tells
you what's running and on which ports.

## While developing

- `offbook validation --watch` in a spare terminal: every contract break —
  yours or the spec's — lands there the moment it happens.
- `offbook publish <topic> --example` fakes any backend emission on demand;
  `offbook scenario <name>` fires a scripted moment (device offline, error
  burst) while you watch your UI.
- `offbook reset` returns to the seeded baseline when state drifts.

## In CI

`offbook check` exits nonzero iff the client broke the contract since the
last reset — the dev-time gate, promoted:

```sh
offbook up --ci        # passive mode: no autonomous emissions
# ... run your app's integration tests against ws://localhost:9001 ...
offbook check          # fails the job on client contract breaks
offbook down
```

## When something is off

`offbook doctor` first — runtime, deps, config, spec reachability, ports,
stale state. Then `offbook diagnostics` for scenario/spec load issues, and
`offbook logs -f` to watch the server live.
````

- [ ] **Step 4: Verify every command shown actually exists**

Run: `bun bin/offbook 2>&1 | head -30` and cross-check each verb/flag used in the three guides (`topics`, `state`, `publish --example --wait`, `validation -v`, `validation --watch`, `init`, `up --watch`, `up --ci`, `specs`, `specs update`, `scenario`, `reset`, `check`, `status`, `logs -f`, `down`, `doctor`) appears in USAGE. Fix any drift in the guide (not the tool).

- [ ] **Step 5: Commit**

```bash
bun scripts/check-docs.ts
git add docs/guides/
git commit -m "docs: getting-started, wiring-your-service, daily-loop guides (R-034)"
```

---

### Task 6: scenario cookbook + the executable cookbook gate

**Files:**
- Create: `docs/guides/scenario-cookbook.md`
- Test: `test/guides-cookbook.test.ts`

**Interfaces:**
- Consumes: `loadConfig` from `#src/config/index.ts`; `createFaker` from `#src/engine/faker.ts`; `buildRegistry` from `#src/registry/index.ts`; `buildTable` from `#src/scenarios/loader.ts` (signature: `buildTable(files: {source: string; text: string}[], deps: {registry, faker, config})` → `{table, diagnostics}`); the bundled demo spec `src/demo/thermostat.yaml`.
- Produces: a cookbook whose every ` ```yaml scenario `-tagged fence loads with zero diagnostics against the demo registry.

- [ ] **Step 1: Write the failing gate test**

Create `test/guides-cookbook.test.ts`:

```ts
// R-034/R-036 — every cookbook recipe is a loadable scenario file
// (adoption.md §4): extracted from the tagged fences and loaded against the
// bundled demo spec's registry with zero diagnostics — no vacuous recipes.
// [itest->R-034]
// [itest->R-036]
import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "#src/config/index.ts";
import { createFaker } from "#src/engine/faker.ts";
import { buildRegistry } from "#src/registry/index.ts";
import { buildTable } from "#src/scenarios/loader.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const GUIDE = join(REPO_ROOT, "docs/guides/scenario-cookbook.md");
const DEMO_SPEC = join(REPO_ROOT, "src/demo/thermostat.yaml");

test("every `yaml scenario` fence in the cookbook loads clean against the demo spec", async () => {
	const text = await Bun.file(GUIDE).text();
	const fences = [...text.matchAll(/```yaml scenario\n([\s\S]*?)```/g)].map((m) => m[1]);
	expect(fences.length).toBeGreaterThanOrEqual(4); // ack, chain, on-demand, deterministic-values

	const config = loadConfig({});
	const registry = await buildRegistry({
		specText: await Bun.file(DEMO_SPEC).text(),
		service: "demo",
		config,
	});
	const faker = createFaker(config);
	for (const [i, yaml] of fences.entries()) {
		const { diagnostics } = await buildTable([{ source: `recipe-${i}.yaml`, text: yaml }], {
			registry,
			faker,
			config,
		});
		expect(diagnostics).toEqual([]);
	}
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/guides-cookbook.test.ts`
Expected: FAIL — no `scenario-cookbook.md`.

- [ ] **Step 3: Write `docs/guides/scenario-cookbook.md`**

Every recipe below is written against the bundled demo thermostat spec
(`command/{deviceId}/set` in, `state/{deviceId}` out) so the gate can load
them for real; adapt topic and payload names to your own spec when pasting.

````markdown
# Scenario cookbook

L2 scenarios make the mock *react*: files of YAML recipes in `scenarios/`,
loaded in sorted-filename order. This page is task-oriented; the format's
canonical reference is [`docs/specs/l2-scenarios.md`](../specs/l2-scenarios.md)
— if this page ever disagrees with it, this page is wrong.

The two-brace rule: single braces **capture** (`{deviceId}` in `when.topic`
binds the value), double braces **substitute** (`{{deviceId}}` writes it
back out). Delays like `50-80ms` draw from the run's seed: deterministic
per seed, never wall-clock-random.

All recipes below target the bundled demo spec (`offbook demo --serve`) so
you can paste and try them; swap in your own topics and payload fields.

## Ack a command

Answer any `command/{deviceId}/set` with an `accepted` state echoing the
requested target:

```yaml scenario
- name: ack-set
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: accepted
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 50-80ms
```

`{{payload.target}}` reaches into the inbound message; `{{now}}` is the
seeded logical clock (a number).

## Chain state changes

`payloadMatch` narrows the trigger (subset equality, no operators); multiple
`emit` steps chain with independent delays — accepted first, then heating:

```yaml scenario
- name: chain-heat
  when:
    topic: command/{deviceId}/set
    payloadMatch: { mode: heat }
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: accepted
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 100-250ms
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: heating
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 400-900ms
```

## A scripted moment, on demand

No `when` means nothing triggers it automatically — you fire it by name
while watching your UI (`{{deviceId}}` binds from `--param`):

```yaml scenario
- name: device-offline
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: offline
          target: 20
          units: C
          updatedAt: "{{now}}"
```

```sh
offbook scenario device-offline --param deviceId=thermostat-1
```

## Deterministic changing values

`{{seq}}` counts per scenario (1, 2, 3, …) and `{{uuid}}` derives from the
run seed — reproducible across runs with the same seed:

```yaml scenario
- name: drifting-target
  when:
    topic: command/{deviceId}/set
    payloadMatch: { mode: cool }
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: cooling
          target: "{{seq}}"
          units: C
          updatedAt: "{{now}}"
        delay: 100-250ms
```

## Checking your work

- `offbook scenarios` — what loaded (and from which file)
- `offbook diagnostics` — load problems, param-resolvability errors
- `offbook doctor` — includes a well-formedness pass over `scenarios/`
- fire it: `offbook publish command/thermostat-1/set --payload '{"mode":"heat","target":23}' --wait`
````

- [ ] **Step 4: Run the gate to verify it passes**

Run: `bun test test/guides-cookbook.test.ts`
Expected: PASS. If a recipe draws a diagnostic, fix the *recipe* (the demo
spec and loader are correct); typical causes: a payload field the schema
forbids (`additionalProperties: false`), a bare `{x}` on an emit field, an
unresolvable `{{param}}`.

- [ ] **Step 5: Full suite + commit**

```bash
bun test && bun scripts/check-docs.ts
git add docs/guides/scenario-cookbook.md test/guides-cookbook.test.ts
git commit -m "docs: scenario cookbook + executable recipe gate (R-034, R-036)"
```

---

### Task 7: relative-link gate in check-docs

**Files:**
- Modify: `scripts/check-docs.ts`
- Test: `scripts/check-docs.test.ts` (extend)

**Interfaces:**
- Consumes: check-docs' existing structure — exported pure check functions + a `main()` that aggregates `errors`; its `read(rel)` helper and `ROOT` constant.
- Produces: `checkLinks(files: {path: string; text: string}[], exists: (rel: string) => boolean): string[]`, wired into `main()` over `README.md` + `docs/guides/*.md`.

- [ ] **Step 1: Write the failing tests (append to `scripts/check-docs.test.ts`)**

Also add this tag line to the file's header comment block (Task 9 flips R-034's TEST trace to include this file):

```ts
// [utest->R-034]
```

```ts
import { checkLinks } from "./check-docs.ts";

test("checkLinks flags a relative link to a missing file, with the source named", () => {
  const errs = checkLinks(
    [{ path: "README.md", text: "see [guide](docs/guides/nope.md) for more" }],
    () => false,
  );
  expect(errs.length).toBe(1);
  expect(errs[0]).toContain("README.md");
  expect(errs[0]).toContain("docs/guides/nope.md");
});

test("checkLinks resolves relative to the linking file and strips fragments", () => {
  const seen: string[] = [];
  checkLinks(
    [{ path: "docs/guides/a.md", text: "[b](b.md#section) and [up](../specs/adoption.md)" }],
    (rel) => { seen.push(rel); return true; },
  );
  expect(seen).toEqual(["docs/guides/b.md", "docs/specs/adoption.md"]);
});

test("checkLinks ignores absolute URLs, mailto, and in-page anchors", () => {
  const errs = checkLinks(
    [{ path: "README.md", text: "[a](https://bun.sh) [b](mailto:x@y.z) [c](#quickstart)" }],
    () => false,
  );
  expect(errs).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test scripts/check-docs.test.ts`
Expected: FAIL — `checkLinks` is not exported.

- [ ] **Step 3: Implement `checkLinks` and wire it into `main()`**

In `scripts/check-docs.ts`, add `dirname` to the `node:path` import, then add (beside the other exported checks):

```ts
// R-034 — adopter docs must not rot: every relative markdown link in
// README.md + docs/guides/ resolves to a real file (fragments ignored, v1).
export function checkLinks(
  files: { path: string; text: string }[],
  exists: (rel: string) => boolean,
): string[] {
  const errs: string[] = [];
  for (const f of files)
    for (const m of f.text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z+.-]*:/.test(target) || target.startsWith("#")) continue;
      const rel = target.split("#")[0];
      if (rel === "") continue;
      const resolved = join(dirname(f.path), rel);
      if (!exists(resolved)) errs.push(`${f.path}: broken link → ${target}`);
    }
  return errs;
}
```

In `main()`, before the `errors` array, gather the adopter docs:

```ts
  const adopterDocs: { path: string; text: string }[] = [];
  const readme = read("README.md");
  if (readme !== null) adopterDocs.push({ path: "README.md", text: readme });
  const guidesDir = join(ROOT, "docs/guides");
  if (existsSync(guidesDir))
    for (const name of readdirSync(guidesDir).filter((n) => n.endsWith(".md")))
      adopterDocs.push({ path: `docs/guides/${name}`, text: readFileSync(join(guidesDir, name), "utf8") });
```

and add to the `errors` aggregation:

```ts
    ...checkLinks(adopterDocs, (rel) => existsSync(join(ROOT, rel))),
```

(`existsSync`, `readdirSync`, `readFileSync`, `join` are already imported in this file — verify, add any that are missing.)

- [ ] **Step 4: Run to verify green, both layers**

Run: `bun test scripts/check-docs.test.ts` — PASS.
Run: `bun scripts/check-docs.ts` — `ok` (the real README/guides links all resolve; if not, fix the doc).

- [ ] **Step 5: Full suite + commit**

```bash
bun test && bun scripts/check-docs.ts
git add scripts/check-docs.ts scripts/check-docs.test.ts
git commit -m "feat: relative-link gate over README + guides in check-docs (R-034)"
```

---

### Task 8: first-run error audit

**Files:**
- Modify: `src/cli/index.ts` (5 message sites)
- Test: `test/cli-dispatch.test.ts` (pins; add tag `// [itest->R-036]` to the header comment)

The audited path (spec §4): clone → demo → init → wire-real-spec → up → first publish. Client-verb not-running errors (`src/cli/client.ts:30,34`), `logs`' no-log error, and `init`'s refuse-overwrite already meet the bar — no change. The five sites below do not:

| # | site (verify line, it may have drifted) | current | change to |
|---|---|---|---|
| 1 | `src/cli/index.ts:80` — `parseFlags` catch | bare util message, e.g. `Unknown option '--bogus'` | append `` ` — run \`offbook\` with no arguments for usage` `` |
| 2 | `src/cli/index.ts:706` — `cmdPublish` | `publish: missing <topic>` | `` `publish: missing <topic> — \`offbook topics\` lists what the client may send` `` |
| 3 | `src/cli/index.ts:755` — `cmdScenario` | `scenario: missing <name>` | `` `scenario: missing <name> — \`offbook scenarios\` lists what's loaded` `` |
| 4 | `src/cli/index.ts:~841` — `preflightPort` | `port ${port} in use — another broker/server? set ${flag} (P7)` | `` `port ${port} in use — another broker/server? set ${flag} (P7); \`offbook doctor\` checks all three ports` `` |
| 5 | `src/cli/index.ts:~911` — `cmdUp` readiness failure | prints `offbook up: server failed to start — ${logPath} ends:` + log tail | after the tail, add: `io.err("(try \`offbook doctor\` — it checks config, spec reachability, and ports)");` |

Sites 4 and 5 get the doctor cross-reference because doctor checks 6 and 3–5 genuinely diagnose them (spec §4: no blanket suffix — do not add it anywhere else).

- [ ] **Step 1: Write the failing pins (append to `test/cli-dispatch.test.ts`; add the `// [itest->R-036]` tag line to the header comment)**

```ts
// --- R-036 first-run error audit: every error names a next step ---
// ports for these pins: 19140/19141, 12996/12997, 19896/19897

test("unknown flag points at usage", async () => {
	const err: string[] = [];
	await run(["topics", "--bogus"], { out: () => {}, err: (l) => err.push(l) });
	expect(err.join("\n")).toContain("for usage");
});

test("bare publish/scenario point at their listing verbs", async () => {
	const pubErr: string[] = [];
	await run(["publish"], { out: () => {}, err: (l) => pubErr.push(l) });
	expect(pubErr.join("\n")).toContain("offbook topics");
	const scnErr: string[] = [];
	await run(["scenario"], { out: () => {}, err: (l) => scnErr.push(l) });
	expect(scnErr.join("\n")).toContain("offbook scenarios");
});

test("up: busy port and failed boot both point at doctor", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "offbook-audit-"));
	try {
		// busy ws port → preflight fails before any spawn
		const listener = Bun.listen({ hostname: "localhost", port: 19140, socket: { data() {} } });
		try {
			const busyErr: string[] = [];
			expect(
				await run(
					["up", "--run-dir", join(tmp, "a"), "--ws-port", "19140", "--tcp-port", "12996", "--ctrl-port", "19896"],
					{ out: () => {}, err: (l) => busyErr.push(l) },
				),
			).not.toBe(0);
			expect(busyErr.join("\n")).toContain("offbook doctor");
		} finally {
			listener.stop(true);
		}

		// no services.yaml in cwd → the spawned server dies at boot → doctor hint
		const bootErr: string[] = [];
		expect(
			await run(
				["up", "--run-dir", join(tmp, "b"), "--ws-port", "19141", "--tcp-port", "12997", "--ctrl-port", "19897"],
				{ out: () => {}, err: (l) => bootErr.push(l) },
			),
		).not.toBe(0);
		expect(bootErr.join("\n")).toContain("offbook doctor");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}, 60_000); // the failed-boot case rides out `up`'s full readiness deadline
```

(Use the imports the file already has — `run`, `mkdtempSync`, `tmpdir`, `join`; add `rmSync` from `node:fs` and any of these that are missing. The failed-boot case relies on the test process's cwd being the repo root, which has no `services.yaml` — true under `bun test`.)

- [ ] **Step 2: Run to verify the pins fail**

Run: `bun test test/cli-dispatch.test.ts`
Expected: the four new pins FAIL (messages lack the pointers); pre-existing tests still pass.

- [ ] **Step 3: Apply the five message changes**

Make the edits from the table above, exactly. Site 1's catch block becomes:

```ts
		throw new CliError(
			`${(cause as Error).message} — run \`offbook\` with no arguments for usage`,
		);
```

- [ ] **Step 4: Run to verify the pins pass, then the neighbors**

Run: `bun test test/cli-dispatch.test.ts` — all PASS.
Also run: `bun test src/cli` — doctor/other cli tests unaffected.

- [ ] **Step 5: Full suite + commit**

```bash
bun test && bun scripts/check-docs.ts
git add src/cli/index.ts test/cli-dispatch.test.ts
git commit -m "feat: first-run error audit — every path error names a next step (R-036)"
```

---

### Task 9: paper trail — flip R-034–R-036 to tested, AGENTS.md, full gates

**Files:**
- Modify: `REQUIREMENTS.md` (three entries)
- Modify: `AGENTS.md` (doc map + status)

**Interfaces:**
- Consumes: everything landed in Tasks 1–8 (the traces below must exist exactly).

- [ ] **Step 1: Flip the three registry entries**

In `REQUIREMENTS.md`, for each of the three entries added at spec time, change `**STATUS**: specified` to `**STATUS**: tested` and insert `**IMPL**:`/`**TEST**:` lines after `**COVERS**:`:

- R-034: `**IMPL**: README.md, docs/guides/, scripts/check-docs.ts` · `**TEST**: test/readme-quickstart.test.ts, test/guides-cookbook.test.ts, scripts/check-docs.test.ts`
- R-035: `**IMPL**: src/cli/doctor.ts, src/cli/index.ts, package.json` · `**TEST**: src/cli/doctor.test.ts`
- R-036: `**IMPL**: src/cli/index.ts, README.md, docs/guides/scenario-cookbook.md` · `**TEST**: test/readme-quickstart.test.ts, test/guides-cookbook.test.ts, test/cli-dispatch.test.ts`

- [ ] **Step 2: Update AGENTS.md**

- Doc map: change the planned line to `- **`README.md` + `docs/guides/`** — adopter-facing **derived** docs: on any conflict, `contracts.md`/`l2-scenarios.md` win — fix the guide.` (drop the "*(planned, R-034)*" marker).
- Status: `31 of 36` → `34 of 36`, and replace the "Next up: the adoption surface…" sentence with: `The adoption surface is `tested` (R-034–R-036: README + guides with executable quickstart/cookbook gates, `offbook doctor`, the first-run error audit — docs/specs/adoption.md).`

- [ ] **Step 3: Verify the checker agrees, both directions**

Run: `bun scripts/check-docs.ts`
Expected: `check-docs: ok — 36 requirements, 16 decisions, 0 intake file(s).` A missing/dangling arrow tag or trace errors here — fix the tag, not the checker.

- [ ] **Step 4: Run every gate**

```bash
bun test
bun scripts/check-docs.ts
bun run lint
bunx tsc --noEmit
```

Expected: all green (0 test failures; biome clean; tsc clean).

- [ ] **Step 5: Commit**

```bash
git add REQUIREMENTS.md AGENTS.md
git commit -m "docs: R-034-R-036 tested — adoption surface complete"
```
