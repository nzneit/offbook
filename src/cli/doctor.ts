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
