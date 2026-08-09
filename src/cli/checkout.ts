// R-042 — identity of the running tool's checkout (adoption.md §9): under
// `bun link` every install is a live symlink to a personal checkout, so
// version identity = the checkout's git state. Also the shared git helpers
// for skill install's destination/propagation checks. CLI-local; git runs
// via Bun.spawn with stderr ignored — a missing git or non-repo degrades to
// undefined/"unknown", never a crash.
import { realpathSync } from "node:fs";
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

// F14 — `git rev-parse --show-toplevel` walks up to any enclosing repo, so an
// offbook checkout unpacked (not cloned) inside a repo of its own would
// otherwise stamp that outer repo's sha/origin as its provenance. Only trust
// git state when `root` IS the repo's toplevel, not merely inside one.
async function isRepoRoot(root: string): Promise<boolean> {
	const top = await gitToplevel(root);
	if (top === undefined) return false;
	try {
		return realpathSync(top) === realpathSync(root);
	} catch {
		return false;
	}
}

export async function checkoutCommit(root = repoRoot()): Promise<string> {
	if (!(await isRepoRoot(root))) return "unknown";
	const sha = await git(["rev-parse", "--short", "HEAD"], root);
	if (sha === undefined) return "unknown";
	const dirty = await git(["status", "--porcelain"], root);
	return dirty === undefined ? sha : `${sha}-dirty`;
}

// R-042/F1 — the origin is embedded verbatim into committed artifacts (the
// init README's clone line, the skill install stamp): strip any userinfo
// (`https://user:token@host/...`) so a credentialed remote never lands in
// git history. scp-like remotes (`git@host:path`) aren't URL-parseable and
// carry a conventional username, not a secret — pass them through unchanged.
export async function checkoutOrigin(
	root = repoRoot(),
): Promise<string | undefined> {
	if (!(await isRepoRoot(root))) return undefined;
	const url = await git(["remote", "get-url", "origin"], root);
	if (url === undefined) return undefined;
	try {
		const u = new URL(url);
		u.username = "";
		u.password = "";
		return u.toString();
	} catch {
		return url; // scp-like (git@host:path): no embeddable secret
	}
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
