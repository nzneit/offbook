// R-045/D-032 — the machine-local instance registry (contracts §5):
// POINTERS, NOT STATE. One file per instance,
// <stateDir>/instances/<sha256(realpath runDir)>.json, holding only
// { v, runDir, host } — ports/pid/token/startedAt live in the target's
// offbook.run and projectDir in its offbook.boot.json, so a pointer can
// only dangle, never disagree. The state dir is an EXPLICIT parameter
// everywhere; the production default (stateDirFromEnv) is injected only at
// the CLI entry points, and code that never received one throws instead of
// defaulting into the real home (test hermeticity, D-032).
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface Pointer {
	v: 1;
	runDir: string; // absolute, symlink-resolved at write time
	host: string;
}

export function stateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	if (env.OFFBOOK_STATE_DIR) return env.OFFBOOK_STATE_DIR;
	const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(base, "offbook");
}

function instancesDir(stateDir: string): string {
	if (!stateDir)
		throw new Error(
			"registry: no state dir injected — pass stateDirFromEnv() at the entry point",
		);
	return join(stateDir, "instances");
}

// realpath after the dir exists; resolve-only when it is already gone, so
// the remove path computes the same name the write path did (down's
// idempotence against nonexistent run dirs)
export function canonicalPath(p: string): string {
	const abs = resolve(p);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}

const hashOf = (canonical: string): string =>
	createHash("sha256").update(canonical).digest("hex");

export function pointerPath(stateDir: string, runDir: string): string {
	return join(instancesDir(stateDir), `${hashOf(canonicalPath(runDir))}.json`);
}

// atomic: the temp lives INSIDE instances/ (rename never crosses a
// filesystem boundary); scans only consider <64 hex>.json names, so a
// crash-leaked temp file is inert
export async function writePointer(
	stateDir: string,
	runDir: string,
): Promise<void> {
	const dir = instancesDir(stateDir);
	mkdirSync(dir, { recursive: true });
	const canonical = canonicalPath(runDir);
	const pointer: Pointer = { v: 1, runDir: canonical, host: hostname() };
	const final = join(dir, `${hashOf(canonical)}.json`);
	const tmp = `${final}.tmp${process.pid}`;
	await Bun.write(tmp, `${JSON.stringify(pointer, null, 2)}\n`);
	renameSync(tmp, final);
}

export function removePointer(stateDir: string, runDir: string): void {
	rmSync(pointerPath(stateDir, runDir), { force: true });
}

const POINTER_NAME = /^[0-9a-f]{64}\.json$/;

// Corrupt pointers are the deletion law's ONE exception: skip and reap
// (same-directory atomic writes make that state unreachable by normal
// operation). A string-identical twin under another hash: the
// realpath-keyed pointer wins, the twin is deleted on sight (D-032;
// file-identity dedupe is the R-048 fast-follow).
export async function scanPointers(
	stateDir: string,
): Promise<{ path: string; raw: string; pointer: Pointer }[]> {
	const dir = instancesDir(stateDir);
	if (!existsSync(dir)) return [];
	const entries: { path: string; raw: string; pointer: Pointer }[] = [];
	for (const name of readdirSync(dir)) {
		if (!POINTER_NAME.test(name)) continue;
		const path = join(dir, name);
		let raw: string;
		let pointer: Pointer;
		try {
			raw = await Bun.file(path).text();
			pointer = JSON.parse(raw) as Pointer;
			if (
				pointer.v !== 1 ||
				typeof pointer.runDir !== "string" ||
				typeof pointer.host !== "string"
			)
				throw new Error("bad pointer shape");
		} catch {
			rmSync(path, { force: true });
			continue;
		}
		entries.push({ path, raw, pointer });
	}
	const byRunDir = new Map<
		string,
		{ path: string; raw: string; pointer: Pointer }
	>();
	for (const e of entries) {
		const keyed = byRunDir.get(e.pointer.runDir);
		if (keyed === undefined) {
			byRunDir.set(e.pointer.runDir, e);
			continue;
		}
		const canonicalName = `${hashOf(e.pointer.runDir)}.json`;
		const winner = e.path.endsWith(canonicalName) ? e : keyed;
		const loser = winner === e ? keyed : e;
		rmSync(loser.path, { force: true });
		byRunDir.set(e.pointer.runDir, winner);
	}
	return [...byRunDir.values()];
}
