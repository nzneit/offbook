// R-019 — the G14 runfile (contracts §5 process management): `offbook up`
// writes `<runDir>/offbook.run` (pid + the three ports + startedAt);
// up/down/logs/status resolve it identically. Liveness = pid alive AND the
// control port answers as offbook (GET /v1/mode) — pid-alone would trust a
// reused PID (P7).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface Runfile {
	pid: number;
	brokerWsPort: number;
	brokerTcpPort: number;
	controlPlanePort: number;
	startedAt: string;
}

export const runfilePath = (runDir: string): string =>
	join(runDir, "offbook.run");
export const logPath = (runDir: string): string => join(runDir, "offbook.log");

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
	} catch {
		return false;
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
