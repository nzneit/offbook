// R-045/D-032 — the shared, verb-agnostic resolver (spec "The resolver" +
// "The instance state table"). Input: cwd + the optional --run-dir; output:
// the resolved instance, the live-but-unchosen candidates, the skipped
// (alive but not proving identity) instances, and pre-formatted `(offbook:`
// notes. Side effects are EXACTLY the state-table record ops — adopt-on-
// sight, reclaim, reap, self-heal — every one guarded. NO verb policy lives
// here; what each verb does with a Resolution is index.ts's policy table.
import { existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ServerIdentity } from "#src/model/index.ts";
import { DEFAULT_CONFIG } from "#src/model/index.ts";
import { CliError } from "./client.ts";
import { guarded } from "./guard.ts";
import { M10, M14, M14missing, M15d, M17 } from "./messages.ts";
import { canonicalPath, scanPointers, writePointer } from "./registry.ts";
import type { Runfile } from "./runfile.ts";
import {
	clearRunfile,
	pidAlive,
	probeServer,
	readRunfile,
	runfilePath,
	writeRunfile,
} from "./runfile.ts";

export interface ResolvedInstance {
	runDir: string; // absolute
	run: Runfile;
	identity?: ServerIdentity; // verified rows only (absent on row 2)
	projectDir?: string; // identity's, else the boot file's
	demo: boolean;
	source: "cwd" | "registry";
}

export interface SkippedInstance {
	runDir: string;
	projectDir: string;
	pid: number;
	ctrlPort: number;
	// "dead" occurs only on the explicit --run-dir path (reclaimDead: false
	// keeps read verbs' stale-runfile reporting byte-identical to pre-D-032;
	// the cwd/registry paths reclaim dead targets instead, rows 5/8)
	reason: "silent" | "wrong-token" | "dead";
	answeringProjectDir?: string; // row 4: who actually answers the port
}

export interface Resolution {
	resolved?: ResolvedInstance;
	candidates: ResolvedInstance[]; // every verified-live instance seen
	skipped: SkippedInstance[];
	notes: string[]; // pre-formatted `(offbook:` stderr notes
	foreignSeen: boolean; // a foreign-host record was passed over (row 10)
}

// M10 as a distinct class: verbs catch it to render the wrong-host refusal
// (stderr verbatim, or the --json envelope) without run()'s `offbook: `
// renderer double-prefixing the catalog wording
export class WrongHostError extends CliError {}

// the boot file names the project truthfully without asking the server —
// readable locally for skipped/unverified instances; the runDir's parent
// is the best remaining name
async function bootProjectDir(runDir: string): Promise<string> {
	try {
		const boot = JSON.parse(
			await Bun.file(join(runDir, "offbook.boot.json")).text(),
		) as { projectDir?: string };
		if (typeof boot.projectDir === "string") return boot.projectDir;
	} catch {}
	return dirname(runDir);
}

// segment-boundary containment on realpath'd absolutes: /x/repo never
// contains /x/repo-wip
export function containsOrEqual(ancestor: string, descendant: string): boolean {
	const rel = relative(ancestor, descendant);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

interface ExamineOutcome {
	resolved?: ResolvedInstance;
	skipped?: SkippedInstance;
	note?: string;
	foreign?: boolean;
}

// state-table rows 1-5 for one runDir (also rows 6-8 when source is
// "registry" — the caller handles row 9's missing-runfile self-heal).
// reclaimDead=false is the explicit --run-dir mode: report the dead
// runfile as skipped ("dead") instead of reclaiming, keeping read verbs'
// stale-runfile output byte-identical to pre-D-032; `down` does its own
// explicit-path cleanup (it always cleared dead runfiles).
async function examineRunDir(
	runDir: string,
	source: "cwd" | "registry",
	stateDir: string,
	reclaimDead = true,
): Promise<ExamineOutcome> {
	const run = await readRunfile(runDir);
	if (run === undefined) return {};
	if (run.host !== undefined && run.host !== hostname())
		return { foreign: true }; // row 10: inert — never a candidate, never reaped
	if (!pidAlive(run.pid)) {
		if (!reclaimDead)
			return {
				skipped: {
					runDir,
					projectDir: await bootProjectDir(runDir),
					pid: run.pid,
					ctrlPort: run.controlPlanePort,
					reason: "dead",
				},
			};
		// row 5 / row 8: target provably dead — reclaim, guarded (site #2:
		// the runfile must still name the pid judged dead)
		const acted = await guarded({
			read: () => readRunfile(runDir),
			expect: (cur) => cur !== undefined && cur.pid === run.pid,
			act: () => clearRunfile(runDir, { stateDir }),
		});
		return acted ? { note: M14(dirname(runDir), run.pid) } : {};
	}
	const probe = await probeServer(run.controlPlanePort);
	if (probe.kind === "server") {
		const id = probe.identity;
		const ours =
			run.token !== undefined
				? id.token === run.token
				: canonicalPath(id.runDir) === canonicalPath(runDir); // pre-D-032 runfile, post-D-032 server
		if (ours) {
			// row 1 / row 6: verified. Adopt-on-sight (best-effort — a broken
			// registry never blocks resolution)
			try {
				await writePointer(stateDir, runDir);
			} catch {}
			return {
				resolved: {
					runDir,
					run,
					identity: id,
					projectDir: id.projectDir,
					demo: id.demo,
					source,
				},
			};
		}
		// row 4 / row 7: the port belongs to someone else — the pid may be
		// reused; never signal, never reclaim, only skip (the note names BOTH)
		return {
			skipped: {
				runDir,
				projectDir: await bootProjectDir(runDir),
				pid: run.pid,
				ctrlPort: run.controlPlanePort,
				reason: "wrong-token",
				answeringProjectDir: id.projectDir,
			},
		};
	}
	if (probe.kind === "legacy" && source === "cwd") {
		// row 2: pre-D-032 server, locally manageable (live-unverified);
		// adopt so it surfaces machine-wide as skipped rather than silence
		try {
			await writePointer(stateDir, runDir);
		} catch {}
		return {
			resolved: {
				runDir,
				run,
				projectDir: await bootProjectDir(runDir),
				demo: false,
				source,
			},
		};
	}
	// row 3 (silent: booting or wedged) and row 7's legacy-elsewhere case:
	// skipped, surfaced by M13, never reaped — a live pid is only ever skipped
	return {
		skipped: {
			runDir,
			projectDir: await bootProjectDir(runDir),
			pid: run.pid,
			ctrlPort: run.controlPlanePort,
			reason: "silent",
		},
	};
}

export async function resolveInstance(opts: {
	cwd: string;
	runDirFlag?: string;
	stateDir: string;
	selfHealProbePort?: number;
}): Promise<Resolution> {
	const { stateDir } = opts;
	const notes: string[] = [];
	const skipped: SkippedInstance[] = [];
	let foreignSeen = false;

	// --run-dir: precise addressing, NO registry fallback (what makes the
	// refusal tables' selectors exact). Convenience: a projectDir whose
	// .offbook holds the runfile counts — users think in project directories.
	if (opts.runDirFlag !== undefined) {
		let runDir = resolve(opts.cwd, opts.runDirFlag);
		if (
			!existsSync(runfilePath(runDir)) &&
			existsSync(runfilePath(join(runDir, DEFAULT_CONFIG.runDir)))
		)
			runDir = join(runDir, DEFAULT_CONFIG.runDir);
		const run = await readRunfile(runDir);
		if (run?.host !== undefined && run.host !== hostname())
			throw new WrongHostError(M10(run.host, runDir), 2); // row 10, pid-only path
		// reclaimDead: false — the explicit path REPORTS a dead runfile
		// (stale wording, byte-identical to pre-D-032) instead of deleting it
		const out = await examineRunDir(runDir, "cwd", stateDir, false);
		if (out.note !== undefined) notes.push(out.note);
		if (out.skipped !== undefined) skipped.push(out.skipped);
		return {
			resolved: out.resolved,
			candidates: out.resolved === undefined ? [] : [out.resolved],
			skipped,
			notes,
			foreignSeen: false,
		};
	}

	// rows 1-5: the cwd runfile — a LIVE cwd runfile wins outright
	const cwdRunDir = resolve(opts.cwd, DEFAULT_CONFIG.runDir);
	const cwdOut = await examineRunDir(cwdRunDir, "cwd", stateDir);
	if (cwdOut.note !== undefined) notes.push(cwdOut.note);
	if (cwdOut.foreign === true) foreignSeen = true;
	if (cwdOut.skipped !== undefined) skipped.push(cwdOut.skipped);
	if (cwdOut.resolved !== undefined)
		return {
			resolved: cwdOut.resolved,
			candidates: [cwdOut.resolved],
			skipped,
			notes,
			foreignSeen,
		};

	// rows 6-10: the registry scan — candidates probed concurrently (cost
	// bounded by reaping plus the n=1 discipline). Best-effort always: an
	// unreadable state dir degrades to cwd-scoped behavior with the
	// catalog's degradation note — registry failures never fail a verb.
	const candidates: ResolvedInstance[] = [];
	const selfHealPort =
		opts.selfHealProbePort ?? DEFAULT_CONFIG.controlPlanePort;
	try {
		const pointers = (await scanPointers(stateDir)).filter(
			(p) => p.pointer.runDir !== canonicalPath(cwdRunDir), // rows 1-5 covered cwd's own
		);
		await Promise.all(
			pointers.map(async ({ path, raw, pointer }) => {
				if (pointer.host !== hostname()) {
					foreignSeen = true; // row 10: inert
					return;
				}
				if (!existsSync(runfilePath(pointer.runDir))) {
					// row 9 — self-heal probe FIRST: /v1/server on the default
					// control port answering with this pointer's runDir means
					// alive-but-de-runfiled; rewrite the runfile from the served
					// identity (guarded site #5), then treat as row 6
					const probe = await probeServer(selfHealPort);
					if (
						probe.kind === "server" &&
						canonicalPath(probe.identity.runDir) === pointer.runDir
					) {
						const id = probe.identity;
						const healedRun: Runfile = {
							pid: id.pid,
							brokerWsPort: id.ports.brokerWsPort,
							brokerTcpPort: id.ports.brokerTcpPort,
							controlPlanePort: id.ports.controlPlanePort,
							startedAt: id.startedAt,
							token: id.token,
							host: id.host,
						};
						await guarded({
							// site #5: the runfile must STILL be missing at write time
							read: () => readRunfile(pointer.runDir),
							expect: (cur) => cur === undefined,
							act: async () => {
								await writeRunfile(pointer.runDir, healedRun, { stateDir });
							},
						});
						candidates.push({
							runDir: pointer.runDir,
							run: healedRun,
							identity: id,
							projectDir: id.projectDir,
							demo: id.demo,
							source: "registry",
						});
						return;
					}
					// row 9 reap branch — guarded site #1: the pointer file must be
					// unchanged since the scan read it AND the target still absent,
					// re-verified immediately before the unlink
					const reaped = await guarded({
						read: () =>
							Bun.file(path)
								.text()
								.catch(() => ""),
						expect: (cur) =>
							cur !== "" &&
							cur === raw &&
							!existsSync(runfilePath(pointer.runDir)),
						act: () => rmSync(path, { force: true }),
					});
					if (reaped) notes.push(M14missing(dirname(pointer.runDir)));
					return;
				}
				const out = await examineRunDir(pointer.runDir, "registry", stateDir);
				if (out.note !== undefined) notes.push(out.note);
				if (out.foreign === true) foreignSeen = true;
				if (out.skipped !== undefined) skipped.push(out.skipped);
				if (out.resolved !== undefined) candidates.push(out.resolved);
			}),
		);
	} catch {
		// M17 is the catalog's degradation message; its recovery selector
		// points at the cwd run dir (the only instance still addressable)
		notes.push(M17(opts.cwd, cwdRunDir));
		return { candidates: [], skipped, notes, foreignSeen };
	}

	if (candidates.length === 1)
		return { resolved: candidates[0], candidates, skipped, notes, foreignSeen };
	if (candidates.length === 0)
		return { candidates, skipped, notes, foreignSeen };

	// several live: the three-stage tiebreak on realpath'd projectDirs.
	// stage 1: sole ancestor-or-equal of cwd; stage 2: sole strict
	// descendant; stage 3: sole non-demo (the forgotten-demo day), with the
	// passed-over demo named (M15d). Otherwise: ambiguous — the verb refuses.
	const cwdReal = canonicalPath(opts.cwd);
	const projOf = (c: ResolvedInstance): string =>
		canonicalPath(c.projectDir ?? dirname(c.runDir));
	const stage1 = candidates.filter((c) => containsOrEqual(projOf(c), cwdReal));
	if (stage1.length === 1)
		return { resolved: stage1[0], candidates, skipped, notes, foreignSeen };
	const stage2 = candidates.filter(
		(c) => containsOrEqual(cwdReal, projOf(c)) && projOf(c) !== cwdReal,
	);
	if (stage2.length === 1)
		return { resolved: stage2[0], candidates, skipped, notes, foreignSeen };
	const nonDemo = candidates.filter((c) => !c.demo);
	if (nonDemo.length === 1) {
		for (const d of candidates.filter((c) => c.demo))
			notes.push(M15d(d.projectDir ?? dirname(d.runDir), d.runDir));
		return { resolved: nonDemo[0], candidates, skipped, notes, foreignSeen };
	}
	return { candidates, skipped, notes, foreignSeen };
}

// M3's verification (R-044): the port-answerer CLAIMS a runDir; the runfile
// AT that runDir carrying the same token proves the claim — discovery never
// invents facts. undefined = attribute nothing (callers keep the generic
// pre-D-032 wording).
export async function attributeCtrlPort(
	port: number,
): Promise<{ projectDir: string; runDir: string; demo: boolean } | undefined> {
	const probe = await probeServer(port);
	if (probe.kind !== "server") return undefined;
	const id = probe.identity;
	if (id.host !== hostname()) return undefined;
	const run = await readRunfile(id.runDir);
	if (run === undefined || run.token !== id.token) return undefined;
	return { projectDir: id.projectDir, runDir: id.runDir, demo: id.demo };
}
