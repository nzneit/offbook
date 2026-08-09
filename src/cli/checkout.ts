// R-042 — identity of the running tool's checkout (adoption.md §9): under
// `bun link` every install is a live symlink to a personal checkout, so
// version identity = the checkout's git state. Also the shared git helpers
// for skill install's destination/propagation checks. CLI-local; git runs
// via Bun.spawn with stderr ignored — a missing git or non-repo degrades to
// undefined/"unknown", never a crash.
import { join } from "node:path";

export function repoRoot(): string {
	return join(import.meta.dir, "../..");
}

async function git(args: string[], cwd: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
		if ((await proc.exited) !== 0) return undefined;
		const out = (await new Response(proc.stdout).text()).trim();
		return out === "" ? undefined : out;
	} catch {
		return undefined; // git itself missing
	}
}

export async function checkoutCommit(root = repoRoot()): Promise<string> {
	const sha = await git(["rev-parse", "--short", "HEAD"], root);
	if (sha === undefined) return "unknown";
	const dirty = await git(["status", "--porcelain"], root);
	return dirty === undefined ? sha : `${sha}-dirty`;
}

export async function checkoutOrigin(
	root = repoRoot(),
): Promise<string | undefined> {
	return git(["remote", "get-url", "origin"], root);
}

export async function gitToplevel(dir: string): Promise<string | undefined> {
	return git(["rev-parse", "--show-toplevel"], dir);
}

export async function gitIgnored(path: string, cwd: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["git", "check-ignore", "-q", path], {
			cwd,
			stdout: "ignore",
			stderr: "ignore",
		});
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}
