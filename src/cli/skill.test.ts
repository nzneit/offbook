// R-042 — skill install semantics (adoption.md §9, forks c/f): fresh copy
// (stamp written), identical no-op, present-different refusal (exit 1,
// divergence listed), --force clean-replace, stamp excluded from compare,
// bare/unknown subcommand usage, toplevel resolution, outside-a-repo
// error, --dest override + warnings, --dest swallowing a flag as its value.
// [utest->R-042]
import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "./index.ts";
import { run } from "./index.ts";
import { bundledSkillDir, compareSkillTrees } from "./skill.ts";

function io(): { out: string[]; err: string[]; io: Io } {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

async function sh(cwd: string, ...args: string[]): Promise<void> {
	const p = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "ignore" });
	if ((await p.exited) !== 0) throw new Error(`failed: ${args.join(" ")}`);
}

async function tempAppRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "offbook-skill-"));
	await sh(dir, "git", "init", "-q", "-b", "main");
	return dir;
}

const DEST = (repo: string) =>
	join(repo, ".claude", "skills", "offbook-onboard");

test("bare `offbook skill` and unknown subcommands are usage errors (exit 1)", async () => {
	const a = io();
	expect(await run(["skill"], a.io)).toBe(1);
	expect(a.err[0]).toContain("usage: offbook skill install");
	expect(await run(["skill", "uninstall"], io().io)).toBe(1);
});

test("--dest with a missing/flag-shaped value is refused, never swallows the next flag as the path", async () => {
	const a = io();
	expect(await run(["skill", "install", "--dest", "--force"], a.io)).toBe(1);
	expect(a.err.join("\n")).toContain("--dest needs a directory");
});

test("fresh install into --dest: copies SKILL.md, writes the stamp", async () => {
	const repo = await tempAppRepo();
	const a = io();
	expect(await run(["skill", "install", "--dest", repo], a.io)).toBe(0);
	expect(existsSync(join(DEST(repo), "SKILL.md"))).toBe(true);
	const stamp = JSON.parse(
		await Bun.file(join(DEST(repo), ".installed-from")).text(),
	);
	expect(typeof stamp.commit).toBe("string");
	expect(typeof stamp.sourcePath).toBe("string");
	expect(typeof stamp.installedAt).toBe("string");
	// F11: a homedir prefix is relativized to `~`, never committed raw — this
	// checkout lives under $HOME in every environment the gate runs in (local
	// dev, CI runners), so the stamp should read as a `~`-relative path
	expect(stamp.sourcePath).not.toContain("/home/");
	expect(stamp.sourcePath.startsWith("~")).toBe(true);
});

test("identical re-install is a no-op; stamp is excluded from the compare", async () => {
	const repo = await tempAppRepo();
	expect(await run(["skill", "install", "--dest", repo], io().io)).toBe(0);
	const again = io();
	expect(await run(["skill", "install", "--dest", repo], again.io)).toBe(0);
	expect(again.out[0]).toContain("already up to date");
	expect(
		(await compareSkillTrees(bundledSkillDir(), DEST(repo))).identical,
	).toBe(true);
});

test("present-different refuses with the divergence (exit 1); --force clean-replaces", async () => {
	const repo = await tempAppRepo();
	expect(await run(["skill", "install", "--dest", repo], io().io)).toBe(0);
	writeFileSync(join(DEST(repo), "SKILL.md"), "edited\n");
	writeFileSync(join(DEST(repo), "orphan.md"), "old\n");
	const refused = io();
	expect(await run(["skill", "install", "--dest", repo], refused.io)).toBe(1);
	expect(refused.err.join("\n")).toContain("changed: SKILL.md");
	expect(refused.err.join("\n")).toContain("only in install: orphan.md");
	expect(
		await run(["skill", "install", "--dest", repo, "--force"], io().io),
	).toBe(0);
	expect(existsSync(join(DEST(repo), "orphan.md"))).toBe(false); // clean-replace, not overlay
});

test("degenerate dest (a file, not a directory): refuses without --force, cleans and installs with --force", async () => {
	const repo = await tempAppRepo();
	mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
	writeFileSync(DEST(repo), "not a directory\n");
	const refused = io();
	expect(await run(["skill", "install", "--dest", repo], refused.io)).toBe(1);
	expect(refused.err.join("\n")).toContain("exists and is not a directory");
	expect(refused.err.join("\n")).toContain("--force");
	expect(existsSync(DEST(repo))).toBe(true); // untouched — no recovery attempted
	expect(
		await run(["skill", "install", "--dest", repo, "--force"], io().io),
	).toBe(0);
	expect(existsSync(join(DEST(repo), "SKILL.md"))).toBe(true);
});

// [utest->R-042]
test("--dest to a plain (non-repo) dir warns and proceeds, unlike the no-dest path (F19)", async () => {
	const plain = mkdtempSync(join(tmpdir(), "offbook-skill-plain-"));
	const a = io();
	expect(await run(["skill", "install", "--dest", plain], a.io)).toBe(0);
	expect(a.err.join("\n")).toContain(
		"not inside a git repo — the skill cannot propagate",
	);
	expect(
		existsSync(join(plain, ".claude", "skills", "offbook-onboard", "SKILL.md")),
	).toBe(true);
});

test("no positional: outside a git repo errors with a next step; --dest below toplevel and gitignored targets warn", async () => {
	const noRepo = mkdtempSync(join(tmpdir(), "offbook-norepo-"));
	const prev = process.cwd();
	try {
		process.chdir(noRepo);
		const a = io();
		expect(await run(["skill", "install"], a.io)).toBe(1);
		expect(a.err.join("\n")).toContain("not inside a git repository");
	} finally {
		process.chdir(prev);
	}
	const repo = await tempAppRepo();
	const sub = join(repo, "mock");
	mkdirSync(sub, { recursive: true });
	const below = io();
	expect(await run(["skill", "install", "--dest", sub], below.io)).toBe(0);
	expect(below.err.join("\n")).toContain("below the repo toplevel");
	const ignored = await tempAppRepo();
	writeFileSync(join(ignored, ".gitignore"), ".claude/\n");
	const warned = io();
	expect(await run(["skill", "install", "--dest", ignored], warned.io)).toBe(0);
	expect(warned.err.join("\n")).toContain("won't propagate");
});

// [utest->R-042]
test("--dest naming the toplevel through a symlink: no spurious below-toplevel warning; the genuine below-toplevel case still warns (F13)", async () => {
	const repo = await tempAppRepo();
	// `git rev-parse --show-toplevel` returns the physical path; a symlinked
	// --dest kept the logical path pre-fix, so the two never string-matched
	// even when --dest names the toplevel exactly (F13)
	const linkParent = mkdtempSync(join(tmpdir(), "offbook-skill-link-"));
	const link = join(linkParent, "repo");
	symlinkSync(repo, link, "dir");
	const viaSymlink = io();
	expect(await run(["skill", "install", "--dest", link], viaSymlink.io)).toBe(
		0,
	);
	expect(viaSymlink.err.join("\n")).not.toContain("below the repo toplevel");

	const sub = join(repo, "mock2");
	mkdirSync(sub, { recursive: true });
	const below = io();
	expect(await run(["skill", "install", "--dest", sub], below.io)).toBe(0);
	expect(below.err.join("\n")).toContain("below the repo toplevel");
});

// [utest->R-042]
test("--force through a symlinked .claude warns, installs at the resolved location, and deletes only the skill leaf (F9)", async () => {
	const repo = await tempAppRepo();
	// a dotfiles-managed .claude: symlinked to a sibling dir outside the repo
	const sibling = mkdtempSync(join(tmpdir(), "offbook-dotfiles-"));
	symlinkSync(sibling, join(repo, ".claude"), "dir");
	const marker = join(sibling, "unrelated-dotfile.txt");
	writeFileSync(marker, "keep me\n");

	const first = io();
	expect(await run(["skill", "install", "--dest", repo], first.io)).toBe(0);
	const resolvedSibling = realpathSync(sibling); // beware /tmp symlinks
	expect(first.err.join("\n")).toContain("resolves outside this repo");
	expect(first.err.join("\n")).toContain(resolvedSibling);
	// the propagation advice must be corrected, not just appended
	expect(first.out.join("\n")).not.toContain(
		"commit it so teammates get the skill",
	);
	const installedSkill = join(resolvedSibling, "skills", "offbook-onboard");
	expect(existsSync(join(installedSkill, "SKILL.md"))).toBe(true);

	writeFileSync(join(installedSkill, "SKILL.md"), "edited\n");
	const second = io();
	expect(
		await run(["skill", "install", "--dest", repo, "--force"], second.io),
	).toBe(0);
	expect(second.err.join("\n")).toContain("resolves outside this repo");
	expect(await Bun.file(join(installedSkill, "SKILL.md")).text()).not.toBe(
		"edited\n",
	); // clean-replaced back to the bundled content
	expect(existsSync(marker)).toBe(true); // deletion stayed bounded to the leaf
});

test("no positional: installs at the git toplevel resolved from a subdir cwd", async () => {
	// the default-destination SUCCESS path (§6 "toplevel destination
	// resolution") — every other install test uses --dest
	const repo = await tempAppRepo();
	const sub = join(repo, "mock");
	mkdirSync(sub, { recursive: true });
	const prev = process.cwd();
	try {
		process.chdir(sub);
		expect(await run(["skill", "install"], io().io)).toBe(0);
	} finally {
		process.chdir(prev);
	}
	// compare via the toplevel git itself reports — mkdtemp paths can differ
	// from git's resolved toplevel on symlinked tmpdirs
	const { gitToplevel } = await import("./checkout.ts");
	const top = (await gitToplevel(repo)) ?? repo;
	expect(
		existsSync(join(top, ".claude", "skills", "offbook-onboard", "SKILL.md")),
	).toBe(true);
});
