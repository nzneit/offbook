// R-042 — `offbook skill install` (adoption.md §9): copy the bundled skill
// into the app repo's .claude/skills/offbook-onboard/. No positional — the
// destination is the git toplevel from cwd (fork f: a [dir] positional
// means "project dir" on init/doctor, and `skill install mock/` by analogy
// would install where no session looks); --dest is the explicit escape
// hatch. "Different" = byte-level tree equality, stamp excluded; --force =
// clean-replace (overlay would orphan old files and jam every compare).
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
	checkoutCommit,
	checkoutOrigin,
	gitIgnored,
	gitToplevel,
	repoRoot,
} from "./checkout.ts";
import { CliError } from "./client.ts";
import type { Io } from "./index.ts";

const SKILL_NAME = "offbook-onboard";
const STAMP = ".installed-from";

export function bundledSkillDir(): string {
	return join(repoRoot(), "skills", SKILL_NAME);
}

// F11 — the stamp's sourcePath is only meaningful on the installing machine;
// relativizing a homedir prefix to `~` keeps a committed username/home-layout
// detail out of teammates' clones. Best effort: an exact prefix match on
// `homedir()`, nothing fancier (no envvar expansion, no case-folding).
function relativizeHome(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

async function listFiles(dir: string): Promise<string[]> {
	return (
		await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir, dot: true }))
	)
		.filter((f) => basename(f) !== STAMP)
		.sort();
}

export async function compareSkillTrees(
	srcDir: string,
	destDir: string,
): Promise<{
	identical: boolean;
	changed: string[];
	added: string[];
	removed: string[];
}> {
	const src = await listFiles(srcDir);
	const dest = await listFiles(destDir);
	const srcSet = new Set(src);
	const destSet = new Set(dest);
	const added = dest.filter((f) => !srcSet.has(f)); // present only in the install
	const removed = src.filter((f) => !destSet.has(f));
	const changed: string[] = [];
	for (const f of src.filter((x) => destSet.has(x))) {
		const [a, b] = await Promise.all([
			Bun.file(join(srcDir, f)).arrayBuffer(),
			Bun.file(join(destDir, f)).arrayBuffer(),
		]);
		if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) changed.push(f);
	}
	return {
		identical: added.length + removed.length + changed.length === 0,
		changed,
		added,
		removed,
	};
}

async function copySkill(srcDir: string, destDir: string): Promise<void> {
	for (const f of await listFiles(srcDir))
		await Bun.write(join(destDir, f), Bun.file(join(srcDir, f)));
	await Bun.write(
		join(destDir, STAMP),
		`${JSON.stringify(
			{
				version:
					(
						JSON.parse(
							await Bun.file(join(repoRoot(), "package.json")).text(),
						) as {
							version?: string;
						}
					).version ?? "0.0.0",
				commit: await checkoutCommit(),
				installedAt: new Date().toISOString(),
				// best effort: only meaningful on the installing machine; a homedir
				// prefix is relativized to `~` so the stamp doesn't commit one
				// dev's username/home layout into every teammate's clone (F11)
				sourcePath: relativizeHome(repoRoot()),
				// observed at install time, never authored (adoption.md §9); omitted
				// when the checkout has no remote — the skill's locator wording then
				// falls back to "ask a teammate"
				...(await checkoutOrigin().then((o) =>
					o === undefined ? {} : { originUrl: o },
				)),
			},
			null,
			2,
		)}\n`,
	);
}

export async function cmdSkill(rest: string[], io: Io): Promise<number> {
	const [sub, ...flags] = rest;
	if (sub !== "install") {
		io.err(
			"usage: offbook skill install [--dest <dir>] [--force] — install the onboarding skill into this repo's .claude/skills/",
		);
		return 1;
	}
	let dest: string | undefined;
	let force = false;
	for (let i = 0; i < flags.length; i++) {
		if (flags[i] === "--force") force = true;
		else if (flags[i] === "--dest") {
			const value = flags[++i];
			// missing OR another flag swallowed as the path (e.g. `--dest --force`
			// would silently install into a dir literally named "--force")
			if (value === undefined || value.startsWith("-"))
				throw new CliError("skill install: --dest needs a directory");
			dest = value;
		} else throw new CliError(`skill install: unknown flag '${flags[i]}'`);
	}

	let targetRoot: string;
	if (dest !== undefined) {
		targetRoot = resolve(dest);
		const top = await gitToplevel(targetRoot);
		// F13: `git rev-parse --show-toplevel` returns the physical (symlink-
		// resolved) path while `targetRoot` stays logical — compare realpaths,
		// not the raw strings, or a repo reached via a symlink spuriously warns
		// even when --dest names the toplevel exactly.
		if (top !== undefined && realpathSync(top) !== realpathSync(targetRoot))
			io.err(
				"⚠ --dest is below the repo toplevel — a Claude Code session at the repo root won't discover a skill installed here",
			);
		if (top === undefined)
			io.err(
				"⚠ --dest is not inside a git repo — the skill cannot propagate to teammates from here",
			);
	} else {
		const top = await gitToplevel(process.cwd());
		if (top === undefined)
			throw new CliError(
				"skill install: not inside a git repository — cd into your app repo (or pass --dest <dir>)",
			);
		targetRoot = top;
	}

	const destDir = join(targetRoot, ".claude", "skills", SKILL_NAME);
	const srcDir = bundledSkillDir();
	if (!existsSync(srcDir))
		throw new CliError(
			`skill install: bundled skill missing at ${srcDir} — the offbook checkout looks incomplete`,
		);

	if (existsSync(destDir)) {
		if (!statSync(destDir).isDirectory()) {
			// dest exists but isn't a directory (e.g. a stray file left behind) —
			// nothing to compare; --force is the only offbook-native way out
			if (!force)
				throw new CliError(
					`skill install: ${destDir} exists and is not a directory — \`offbook skill install --force\` replaces it`,
				);
			rmSync(destDir, { recursive: true, force: true }); // clean-replace, never overlay
		} else {
			let diff: Awaited<ReturnType<typeof compareSkillTrees>> | undefined;
			try {
				diff = await compareSkillTrees(srcDir, destDir);
			} catch {
				diff = undefined; // an unreadable entry: can't certify identity either way
			}
			if (diff?.identical) {
				io.out(`offbook skill install: already up to date (${destDir})`);
				return 0;
			}
			if (!force) {
				if (diff === undefined)
					io.err(
						`offbook skill install: ${destDir} is unreadable/degenerate — \`offbook skill install --force\` replaces it`,
					);
				else {
					io.err(
						`offbook skill install: ${destDir} differs from the bundled skill:`,
					);
					for (const f of diff.changed) io.err(`  changed: ${f}`);
					for (const f of diff.added) io.err(`  only in install: ${f}`);
					for (const f of diff.removed) io.err(`  missing from install: ${f}`);
				}
				io.err(
					"local edits are drift — upstream them, or `--force` to clean-replace",
				);
				return 1;
			}
			rmSync(destDir, { recursive: true, force: true }); // clean-replace, never overlay
		}
	}
	await copySkill(srcDir, destDir);
	if (await gitIgnored(destDir, targetRoot))
		io.err(
			"⚠ .claude/ is gitignored here — the skill won't propagate; un-ignore it or teammates never see it",
		);
	io.out(
		`offbook skill install: installed to ${destDir} — commit it so teammates get the skill`,
	);
	return 0;
}
