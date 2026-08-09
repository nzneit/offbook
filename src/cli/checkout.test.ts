// R-042 — checkout identity: sha/dirty/unknown, origin, toplevel, ignore.
// Runs against throwaway git repos in temp dirs — never the real checkout
// (its dirty state would flake the assertions).
// [utest->R-042]
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkoutCommit,
	checkoutOrigin,
	gitIgnored,
	gitToplevel,
} from "./checkout.ts";

async function sh(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "ignore" });
	if ((await proc.exited) !== 0) throw new Error(`failed: ${args.join(" ")}`);
}

async function tempRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "offbook-checkout-"));
	await sh(dir, "git", "init", "-q", "-b", "main");
	await sh(
		dir,
		"git",
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"--allow-empty",
		"-q",
		"-m",
		"x",
	);
	return dir;
}

test("checkoutCommit: clean sha, -dirty suffix, unknown outside a repo", async () => {
	const repo = await tempRepo();
	const clean = await checkoutCommit(repo);
	expect(clean).toMatch(/^[0-9a-f]{4,}$/);
	writeFileSync(join(repo, "x.txt"), "x");
	expect(await checkoutCommit(repo)).toBe(`${clean}-dirty`);
	expect(await checkoutCommit(mkdtempSync(join(tmpdir(), "norepo-")))).toBe(
		"unknown",
	);
});

test("checkoutOrigin: undefined without a remote, the URL with one", async () => {
	const repo = await tempRepo();
	expect(await checkoutOrigin(repo)).toBeUndefined();
	await sh(
		repo,
		"git",
		"remote",
		"add",
		"origin",
		"https://git.example.com/org/offbook.git",
	);
	expect(await checkoutOrigin(repo)).toBe(
		"https://git.example.com/org/offbook.git",
	);
});

// [utest->R-042]
test("checkoutOrigin: strips userinfo from a credentialed remote; scp-like remotes round-trip unchanged", async () => {
	const credentialed = await tempRepo();
	await sh(
		credentialed,
		"git",
		"remote",
		"add",
		"origin",
		"https://user:token@example.invalid/x.git",
	);
	const sanitized = await checkoutOrigin(credentialed);
	expect(sanitized).toContain("example.invalid/x.git");
	expect(sanitized).not.toContain("user");
	expect(sanitized).not.toContain("token");

	const scp = await tempRepo();
	await sh(
		scp,
		"git",
		"remote",
		"add",
		"origin",
		"git@git.example.com:org/offbook.git",
	);
	expect(await checkoutOrigin(scp)).toBe("git@git.example.com:org/offbook.git");
});

// [utest->R-042]
test("checkoutCommit/checkoutOrigin: unknown/undefined when the dir is inside a repo but isn't its toplevel (F14)", async () => {
	const outer = await tempRepo();
	await sh(
		outer,
		"git",
		"remote",
		"add",
		"origin",
		"https://git.example.com/outer/repo.git",
	);
	// an offbook-shaped dir with no .git of its own, unpacked inside the
	// outer repo's tree — `git rev-parse --show-toplevel` from here walks up
	// to `outer`, which must NOT be mistaken for this dir's own provenance
	const offbookShaped = join(outer, "tools", "offbook");
	mkdirSync(offbookShaped, { recursive: true });
	expect(await checkoutCommit(offbookShaped)).toBe("unknown");
	expect(await checkoutOrigin(offbookShaped)).toBeUndefined();
});

test("gitToplevel resolves from a subdir; gitIgnored honors .gitignore", async () => {
	const repo = await tempRepo();
	const sub = join(repo, "mock");
	await sh(repo, "mkdir", "-p", sub);
	expect(await gitToplevel(sub)).toBe(await gitToplevel(repo));
	expect(
		await gitToplevel(mkdtempSync(join(tmpdir(), "norepo-"))),
	).toBeUndefined();
	writeFileSync(join(repo, ".gitignore"), ".claude/\n");
	expect(await gitIgnored(join(repo, ".claude/skills"), repo)).toBe(true);
	expect(await gitIgnored(join(repo, "src"), repo)).toBe(false);
});
