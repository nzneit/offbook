// R-045/D-032 — the message catalog (spec: docs/superpowers/specs/
// 2026-08-18-instance-discovery-design.md "Message catalog"): every
// discovery-era user-facing string lives HERE, one export per catalog id,
// so wording, stream, and exit code cannot drift between the CLI, the
// tests, and the docs (this file is the D-032 grep source). Ids are sparse:
// unchanged pre-D-032 messages keep their wordings where they already live.
// Voice: lowercase; `offbook <verb> —` / `offbook:` prefixes; hints as
// em-dash clauses with backticked commands; `control port <n>`, never bare
// `port <n>`; NEVER registry/pointer/token/endpoint vocabulary in
// human-facing text. Automation anchors (contract, D-032): the
// `offbook is not running` leading token and the `(offbook:` note prefix.

export interface InstanceRow {
	projectDir: string;
	demo: boolean;
	ws: number;
	tcp: number;
	http: number;
	pid: number;
	runDir: string;
}

// M6/M8/M9 share this shape: one identity line + one complete, double-click
// copyable command per instance — choosing is one paste, never a stdin
// prompt (agents and scripts must never hang).
export function instanceTable(rows: InstanceRow[], verb = "down"): string[] {
	return rows.flatMap((r) => [
		`  ${r.projectDir}${r.demo ? " [demo]" : ""} — ws ${r.ws} · tcp ${r.tcp} · http ${r.http} · pid ${r.pid}`,
		`    offbook ${verb} --run-dir ${r.runDir}`,
	]);
}

export const M2 = (path: string): string =>
	`offbook up: ${path} is not a directory — pass your project directory (e.g. \`offbook up mock\`)`;

export const M3 = (opts: {
	port: number;
	projectDir: string;
	runDir: string;
	demo: boolean;
	alsoBusy?: string; // pre-formatted "; also busy: ws 9001" clause or ""
}): string =>
	`another offbook owns the control port ${opts.port}${opts.alsoBusy ?? ""} (${
		opts.demo
			? `the bundled demo, started in ${opts.projectDir}`
			: `started in ${opts.projectDir}`
	}) — \`offbook down --run-dir ${opts.runDir}\` stops it from anywhere on this machine`;

export const M5 = (pid: number, projectDir: string, demo: boolean): string =>
	demo
		? `offbook down — stopped the demo (pid ${pid}, started in ${projectDir})`
		: `offbook down — stopped (pid ${pid}, started in ${projectDir})`;

export const M6 = (): string =>
	"offbook: not running (in this project) — running elsewhere on this machine:";

export const M8 = (): string =>
	"offbook: several instances are running — pick one:";

export const M9 = (): string =>
	"offbook down: one instance verified but others are not answering — pick one:";

export const M10 = (host: string, runDir: string): string =>
	`offbook: this runfile was written on ${host} — run \`offbook down\` there, or delete ${runDir}/offbook.run if that machine is gone`;

export const M11 = (): string =>
	"offbook is not running (no runfile in .offbook, and nothing else is running on this machine) — run `offbook up`, or pass --ctrl-port";

// status keeps its `offbook: not running (...)` shape with the same clause
export const M11s = (): string =>
	"offbook: not running (no runfile in .offbook, and nothing else is running on this machine)";

// replaces M11 AND M13 when the only skipped instance is cwd's own —
// never printed alongside them
export const M12 = (pid: number): string =>
	`offbook is not answering here (pid ${pid}, runfile in .offbook), and nothing else is running on this machine — \`offbook down\` stops the wedged one; \`offbook logs\` may say why`;

export const M13 = (projectDir: string, pid: number, port: number): string =>
	`(offbook: an instance in ${projectDir} (pid ${pid}) is not answering on control port ${port} — manage it from that directory or with --run-dir)`;

// the spec's row-4 "M13 variant naming both": the port ANSWERED, just as a
// different offbook — saying "not answering" there would be untrue output.
// (The spec declares this variant without pinning its wording; this is the
// plan's proposed wording — flag it with the catalog if it reads wrong.)
export const M13wrongToken = (
	projectDir: string,
	pid: number,
	port: number,
	answeringProjectDir: string,
): string =>
	`(offbook: an instance in ${projectDir} (pid ${pid}) no longer answers for control port ${port} — the offbook in ${answeringProjectDir} does; manage it from its directory or with --run-dir)`;

// one-shot: only the invocation that performed the cleanup prints it
export const M14 = (dir: string, pid: number): string =>
	`(offbook: cleaned up a stopped offbook: ${dir} — pid ${pid} is gone)`;

export const M14missing = (dir: string): string =>
	`(offbook: cleaned up a stopped offbook: ${dir} — its runfile is gone; if ports are still busy, run \`offbook doctor\`)`;

// mutating verbs on registry resolution only (reads name in-band, M16)
export const M15 = (projectDir: string, demo: boolean): string =>
	demo
		? `(offbook: using the bundled demo started in ${projectDir})`
		: `(offbook: using the offbook started in ${projectDir})`;

export const M15d = (dir: string, runDir: string): string =>
	`(offbook: the bundled demo in ${dir} is also running — \`offbook down --run-dir ${runDir}\` stops it)`;

// the in-band header: registry-resolved reads, human mode, first line
export const M16 = (
	projectDir: string,
	ws: number,
	http: number,
	demo: boolean,
): string =>
	`offbook @ ${projectDir} (ws ${ws} · http ${http})${demo ? " — the bundled demo" : ""}`;

export const M17 = (projectDir: string, runDir: string): string =>
	`(offbook: could not record this instance for manage-from-anywhere — manage it from ${projectDir} or with \`--run-dir ${runDir}\`)`;

export const M18 = (): string =>
	"offbook: this server was started by an older offbook build — restart it (`offbook down` then `offbook up`) to manage it from here";

export const M19 = (path: string, projectDir: string, runDir: string): string =>
	`(offbook: showing the local stopped log at ${path}; a live offbook runs in ${projectDir} — \`offbook logs --run-dir ${runDir}\` for its log)`;

export const M20 = (dir: string): string =>
	`the only running offbook is the bundled demo (started in ${dir}) — run \`offbook down\` to stop it, then \`offbook up <dir>\` for your mock`;

export const M21 = (): string =>
	"this skill predates manage-from-anywhere — its advice about which directory to run offbook in is now wrong; run `offbook skill install` to refresh it";

export const M22 = (): string =>
	"offbook down: the instance restarted underneath — rerun `offbook down`";

// `up` meeting state-table row 3 in its own runDir: the pid is alive and
// the control port is silent (booting, or wedged). The deletion law keeps
// both records, so the refusal borrows M12's clause and hands over the
// selector that stops it — never M11's machine-wide claim (nothing scanned).
export const M23 = (pid: number, runDir: string): string =>
	`offbook: not answering here (pid ${pid}, runfile in ${runDir}) — it may still be starting; \`offbook down --run-dir ${runDir}\` stops it if it is wedged`;

// The CLI refusal envelope (D-032): mirrors the §5 error-envelope
// convention WITHOUT touching the closed ErrorCode union — these codes
// exist only on the CLI's own --json surface. Contract: --json stdout is
// always exactly ONE JSON document; the stderr table is replaced by the
// envelope in --json mode.
export type RefusalCode =
	| "ambiguous"
	| "not-running"
	| "demo-only"
	| "wrong-host"
	| "version-skew";

export function refusalEnvelope(
	code: RefusalCode,
	message: string,
	candidates?: InstanceRow[],
): string {
	return JSON.stringify({
		error: { code, message },
		...(candidates === undefined ? {} : { candidates }),
	});
}
