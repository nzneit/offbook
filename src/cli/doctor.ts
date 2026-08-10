// R-035 — `offbook doctor`: first-run preflight (docs/specs/adoption.md §3).
// Checks are DATA (DoctorCheck[]) — the future init-wizard substrate (D-016).
// CLI-local: no /v1 or contract change; imports no transport package (R-030 —
// dependency sentinels are checked by node_modules presence, never imported).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadEnvironments, loadServices } from "#src/config/index.ts";
import { resolveRepoUrl } from "#src/ingestion/index.ts";
import { gitToplevel } from "./checkout.ts";
import { probeOffbook, resolveRunning } from "./runfile.ts";
import {
	blockingAncestor,
	bundledSkillDir,
	compareSkillTrees,
} from "./skill.ts";

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
	checks: {
		name: string;
		status: CheckStatus;
		detail: string;
		hint?: string;
	}[];
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
			return {
				status: "fail",
				detail: `no package.json at ${ctx.repoRoot}`,
				hint: INCOMPLETE,
			};
		const pkg = JSON.parse(await Bun.file(pkgPath).text()) as {
			engines?: { bun?: string };
		};
		const floor = pkg.engines?.bun?.replace(/^[^0-9]*/, "");
		if (floor === undefined || floor === "")
			return {
				status: "fail",
				detail: "package.json declares no engines.bun floor",
				hint: INCOMPLETE,
			};
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
			(pkg) =>
				!existsSync(join(ctx.repoRoot, "node_modules", pkg, "package.json")),
		);
		return missing.length === 0
			? {
					status: "pass",
					detail: `dependencies present (${SENTINELS.join(", ")})`,
				}
			: {
					status: "fail",
					detail: `missing from node_modules: ${missing.join(", ")}`,
					hint: "run `bun install` in the offbook checkout",
				};
	},
};

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
		return {
			status: "pass",
			detail: "services.yaml + environments.yaml parse",
		};
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
	const firstErr = (await new Response(proc.stderr).text())
		.trim()
		.split("\n")[0];
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
			return {
				status: "warn",
				detail: "skipped (no services.yaml — see `project`)",
			};
		let gitHost: string | undefined;
		let services: Record<
			string,
			{ repo: string; branch?: string; gitHost?: string }
		>;
		try {
			({ gitHost, services } = await loadServices(servicesPath));
		} catch {
			return {
				status: "warn",
				detail: "skipped (services.yaml does not parse — see `project`)",
			};
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
			try {
				// per-service gitHost override wins over the global (G20, mirrors
				// ingestion/'s resolveServices precedence); resolveRepoUrl throws for
				// a slug with no host, which must become a graceful fail here.
				const url = resolveRepoUrl(svc.repo, svc.gitHost ?? gitHost);
				const err = await refUnreachable(url, branch, 5_000);
				if (err !== null)
					return {
						status: "fail",
						detail: `${name}: ${url}@${branch} unreachable (${err})`,
						hint: `check gitHost/repo/branch for '${name}' in services.yaml`,
					};
			} catch (cause) {
				return {
					status: "fail",
					detail: `${name}: ${(cause as Error).message}`,
					hint: `check gitHost/repo/branch for '${name}' in services.yaml`,
				};
			}
		}
		return {
			status: "pass",
			detail: `${names.length} service repo(s) reachable`,
		};
	},
};

// Shape-only by design (spec §3): full validation needs the resolved registry
// (a network fetch) — a live server already surfaces it via /v1/diagnostics.
const scenarios: DoctorCheck = {
	name: "scenarios",
	async run(ctx) {
		const dir = join(ctx.projectDir, "scenarios");
		if (!existsSync(dir))
			return {
				status: "warn",
				detail: "no scenarios/ directory",
				hint: `recipes: ${COOKBOOK}`,
			};
		const files = (
			await Array.fromAsync(new Bun.Glob("**/*.yaml").scan({ cwd: dir }))
		).sort();
		if (files.length === 0)
			return {
				status: "warn",
				detail: "no scenario files",
				hint: `recipes: ${COOKBOOK}`,
			};
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

async function portFree(port: number): Promise<boolean> {
	try {
		// 127.0.0.1, not "localhost": on a dual-stack host, hostname resolution
		// can hand back a DIFFERENT loopback address than an existing bind, so a
		// second Bun.listen("localhost") silently succeeds on ::1 vs 127.0.0.1
		// (matches `portListenable`/`preflightPorts`' address for the same reason).
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: { data() {} },
		});
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
		if (
			busy.some((b) => b.startsWith("ctrl")) &&
			(await probeOffbook(ctx.ports.ctrl))
		) {
			const others = busy.filter((b) => !b.startsWith("ctrl"));
			const alsoBusy =
				others.length > 0 ? `; also busy: ${others.join(", ")}` : "";
			return {
				status: "fail",
				detail: `another offbook owns the control port ${ctx.ports.ctrl}${alsoBusy}`,
				hint: "`offbook down` in that project's directory frees the control port; check the others separately if they persist",
			};
		}
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

// R-042 — check 8 (adoption.md §3): the installed skill copy vs the running
// tool's bundled skill. Warn-never-fail: a stale skill doesn't break the
// tool. Resolved from the EXAMINED dir's toplevel; the hint names the path
// because `skill install --force` resolves from CWD, which can differ when
// `doctor <elsewhere>` examines another repo.
const skillCheck: DoctorCheck = {
	name: "skill",
	async run(ctx) {
		const top = await gitToplevel(ctx.projectDir);
		if (top === undefined)
			return {
				status: "pass",
				detail: "not in a git repo (no skill to check)",
			};
		const installed = join(top, ".claude", "skills", "offbook-onboard");
		// F-followup (2026-08-10) — a `.claude`/`.claude/skills` ancestor that's
		// a regular file makes existsSync(installed) false too (an ancestor
		// component isn't a directory), so the not-installed pass below used to
		// fire and hide that install is impossible. Warn-never-fail still
		// applies; unlike the other warn states here, --force can't recover
		// this one (skill.ts's blockingAncestor guard refuses it in both
		// modes — `.claude` is not offbook's to replace).
		const blocking = blockingAncestor(installed, top);
		if (blocking !== undefined)
			return {
				status: "warn",
				detail: `${blocking} exists and is not a directory — \`offbook skill install\` cannot install here (move or remove it yourself; --force does not apply)`,
			};
		if (!existsSync(installed))
			return {
				status: "pass",
				detail:
					"onboarding skill not installed (optional — `offbook skill install` adds it)",
			};
		const src = bundledSkillDir();
		if (!existsSync(src))
			return {
				status: "warn",
				detail: `bundled skill missing from the offbook checkout (${src}) — incomplete checkout?`,
			};
		let diff: Awaited<ReturnType<typeof compareSkillTrees>>;
		try {
			diff = await compareSkillTrees(src, installed);
		} catch {
			// degenerate install (dest is a file, or an unreadable entry inside
			// it): warn-never-fail still applies — `--force` is the recovery
			return {
				status: "warn",
				detail: `installed skill unreadable/degenerate at ${installed} — \`offbook skill install --force\` replaces it`,
			};
		}
		return diff.identical
			? {
					status: "pass",
					detail: `installed skill matches the bundled one (${installed})`,
				}
			: {
					status: "warn",
					detail: `installed skill at ${installed} differs from the bundled one (${[...diff.changed, ...diff.added, ...diff.removed].length} file(s))`,
					// the hint NAMES the resolved toplevel (adoption.md §3): `skill
					// install --force` resolves from CWD, which can differ from the
					// examined dir's repo
					hint: `stale/edited skill — \`offbook skill install --force\` from ${top} refreshes it`,
				};
	},
};

export const DOCTOR_CHECKS: DoctorCheck[] = [
	runtime,
	deps,
	project,
	specsReachable,
	scenarios,
	ports,
	runfileCheck,
	skillCheck,
];

export async function runDoctor(
	ctx: DoctorCtx,
	checks: DoctorCheck[] = DOCTOR_CHECKS,
): Promise<DoctorReport> {
	const results: DoctorReport["checks"] = [];
	for (const check of checks)
		results.push({ name: check.name, ...(await check.run(ctx)) });
	return { ok: results.every((r) => r.status !== "fail"), checks: results };
}
