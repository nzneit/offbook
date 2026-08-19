// R-019/R-044 — the G14 runfile (contracts §5 process management): `offbook
// up` writes `<runDir>/offbook.run` (pid + the three ports + startedAt +
// the per-launch token + host, D-032); management verbs resolve cwd-first,
// then the machine-local instance registry (the pre-D-032 clause was
// "up/down/logs/status resolve it identically"). Liveness = IDENTITY: pid
// alive AND the control port answering GET /v1/server with the runfile's
// token — pid-alone would trust a reused PID (P7), and pid+port-alone
// would trust whoever answers the port (D-032).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ServerIdentity } from "#src/model/index.ts";

export interface Runfile {
	pid: number;
	brokerWsPort: number;
	brokerTcpPort: number;
	controlPlanePort: number;
	startedAt: string;
	token?: string; // R-044: launch lineage id; absent on pre-D-032 runfiles
	host?: string; // R-044: os.hostname() at launch; absent pre-D-032
}

export const runfilePath = (runDir: string): string =>
	join(runDir, "offbook.run");
export const logPath = (runDir: string): string => join(runDir, "offbook.log");

// D-030 — offbook.log IS a parse surface (the R-043 status/staleness parsers,
// demo-app's fingerprint proxy), and a color-forcing parent shell would make
// Bun ANSI-wrap every console line the detached server writes there. Both
// server spawn sites (launchDetached, the --watch respawn) pass this env.
// Deleting FORCE_COLOR is the load-bearing half — Bun gives it precedence
// over NO_COLOR, so asserting NO_COLOR alone would not stop the wrapping;
// CLICOLOR_FORCE covers deps honoring the BSD convention. NO_COLOR=1 covers
// deps honoring the no-color.org convention, but the `debug` family does
// not: DEBUG_COLORS takes precedence and NO_COLOR is never consulted, and
// mqtt-packet (a direct aedes dependency, in the server's runtime graph) is
// debug-instrumented — so DEBUG_COLORS is deleted too. DEBUG itself passes
// through: a debug-logging run still works, uncolored (debug falls back to
// isatty(stderr), false for the redirected log). In-process handlers
// inherit this env by design: their console output lands in the same log.
export function logSafeEnv(
	parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env = { ...parent };
	delete env.FORCE_COLOR;
	delete env.CLICOLOR_FORCE;
	delete env.DEBUG_COLORS;
	env.NO_COLOR = "1";
	return env;
}

export async function readRunfile(
	runDir: string,
): Promise<Runfile | undefined> {
	const path = runfilePath(runDir);
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(await Bun.file(path).text()) as Runfile;
		return typeof raw.pid === "number" &&
			typeof raw.controlPlanePort === "number"
			? raw
			: undefined;
	} catch {
		return undefined; // corrupt runfile = stale (the caller reclaims it)
	}
}

export async function writeRunfile(runDir: string, run: Runfile) {
	mkdirSync(runDir, { recursive: true });
	await Bun.write(runfilePath(runDir), `${JSON.stringify(run, null, 2)}\n`);
}

export function clearRunfile(runDir: string): void {
	rmSync(runfilePath(runDir), { force: true });
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		// EPERM = the pid EXISTS but is not ours to signal — alive (D-032);
		// reading it as dead invited reclaiming a live instance's records
		return (cause as NodeJS.ErrnoException).code === "EPERM";
	}
}

// "answers as offbook": GET /v1/mode returns 200 with a mode field.
export async function probeOffbook(
	port: number,
	timeoutMs = 500,
): Promise<boolean> {
	try {
		const res = await fetch(`http://localhost:${port}/v1/mode`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return false;
		const body = (await res.json()) as { mode?: string };
		return body.mode === "autonomous" || body.mode === "passive";
	} catch {
		return false;
	}
}

export type ServerProbe =
	| { kind: "server"; identity: ServerIdentity }
	| { kind: "legacy" } // pre-D-032 offbook: /v1/mode answers, no /v1/server
	| { kind: "silent" };

// The identity probe (R-044). One retry with a doubled timeout before
// concluding not-answering — a loaded machine's slow first answer must not
// read as a wedged instance.
export async function probeServer(
	port: number,
	timeoutMs = 500,
): Promise<ServerProbe> {
	const once = async (t: number): Promise<ServerProbe> => {
		try {
			const res = await fetch(`http://localhost:${port}/v1/server`, {
				signal: AbortSignal.timeout(t),
			});
			if (res.ok) {
				const body = (await res.json()) as ServerIdentity;
				return typeof body.token === "string" &&
					typeof body.runDir === "string" &&
					typeof body.pid === "number"
					? { kind: "server", identity: body }
					: { kind: "silent" }; // answers, but not as offbook
			}
			// an HTTP answer without /v1/server: pre-D-032 offbook or a
			// foreign server — the mode probe discriminates
			return (await probeOffbook(port, t))
				? { kind: "legacy" }
				: { kind: "silent" };
		} catch {
			return { kind: "silent" };
		}
	};
	const first = await once(timeoutMs);
	if (first.kind !== "silent") return first;
	return once(timeoutMs * 2);
}

// The one liveness read every process verb shares: no runfile → undefined;
// otherwise the runfile plus whether it names a LIVE offbook (pid alive AND
// control port answering — a dead pid or silent port marks it stale, P7).
export async function resolveRunning(
	runDir: string,
): Promise<{ run: Runfile; live: boolean } | undefined> {
	const run = await readRunfile(runDir);
	if (!run) return undefined;
	const live = pidAlive(run.pid) && (await probeOffbook(run.controlPlanePort));
	return { run, live };
}
