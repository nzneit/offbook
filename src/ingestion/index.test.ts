import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GitRefResolver,
	resolveRepoUrl,
	resolveServices,
	StaticManifestSource,
	serializeLockfile,
} from "./index.ts";

// [utest->R-005]

const SPEC = `asyncapi: 3.0.0
info:
  title: Widget
  version: 4.2.0
channels: {}
`;

// A throwaway git repo laid out as <base>/org/name so both the full-URL and the slug-against-gitHost
// resolution paths can fetch it. `-c user.*` scopes identity to THIS temp repo (never the user's).
let base: string;
let repoDir: string;

async function seedGit(args: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, code] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
}

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "offbook-fixture-"));
	repoDir = join(base, "org", "name");
	await mkdir(repoDir, { recursive: true });
	await seedGit(["init", "-q", "-b", "main"], repoDir);
	await writeFile(join(repoDir, "asyncapi.yaml"), SPEC);
	await seedGit(["add", "-A"], repoDir);
	await seedGit(
		["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
		repoDir,
	);
});

afterAll(async () => {
	await rm(base, { recursive: true, force: true });
});

test("resolveRepoUrl: slug resolves against gitHost, full URL used as-is, bare slug errors (G20)", () => {
	expect(resolveRepoUrl("org/svc", "https://git.example.com")).toBe(
		"https://git.example.com/org/svc",
	);
	expect(resolveRepoUrl("org/svc", "https://git.example.com/")).toBe(
		"https://git.example.com/org/svc",
	);
	expect(
		resolveRepoUrl(
			"https://other.example.com/org/svc.git",
			"https://git.example.com",
		),
	).toBe("https://other.example.com/org/svc.git");
	expect(() => resolveRepoUrl("org/svc")).toThrow(/gitHost/);
});

test("resolveRepoUrl rejects a repo/gitHost/resolved URL that starts with '-' (option-injection guard)", () => {
	// a resolved value starting with '-' is parsed by git as an option, not a
	// repository (e.g. --upload-pack=<shell command> executes on fetch)
	expect(() => resolveRepoUrl("-x", "https://git.example.com")).toThrow(
		/^repo '-x' starts with '-'/,
	);
	expect(() => resolveRepoUrl("org/svc", "-x")).toThrow(
		/^gitHost '-x' starts with '-'/,
	);
	expect(() =>
		resolveRepoUrl("org/name", '--upload-pack=sh -c "touch /tmp/ob-poc" #'),
	).toThrow(/starts with '-'/);
});

test("resolve() fetches a branch tip and records full sha + content-hash + declared-version", async () => {
	const spec = await new GitRefResolver().resolve(
		`file://${repoDir}`,
		"main",
		"asyncapi.yaml",
	);
	expect(spec.content).toContain("title: Widget");
	expect(spec.resolvedRef).toBe("main");
	expect(spec.resolvedSha).toMatch(/^[0-9a-f]{40}$/); // FULL sha, never abbreviated
	// content-hash is the byte fingerprint of exactly what was fetched
	const expected = `sha256:${new Bun.CryptoHasher("sha256").update(SPEC).digest("hex")}`;
	expect(spec.contentHash).toBe(expected);
	expect(spec.declaredVersion).toBe("4.2.0"); // shallow parser-free info.version read (G12)
	expect(spec.source.startsWith("main@")).toBe(true);
	expect(spec.source.endsWith(":asyncapi.yaml")).toBe(true);
});

test("a slug fetches against the configured gitHost (source keeps the authored slug)", async () => {
	const spec = await new GitRefResolver({ gitHost: `file://${base}` }).resolve(
		"org/name",
		"main",
		"asyncapi.yaml",
	);
	expect(spec.declaredVersion).toBe("4.2.0");
	expect(spec.source).toBe("main@org/name:asyncapi.yaml");
});

test("a missing branch is a fatal, named fetch failure (§7)", async () => {
	await expect(
		new GitRefResolver().resolve(`file://${repoDir}`, "nope", "asyncapi.yaml"),
	).rejects.toThrow(/spec fetch failed — .*@nope/);
});

test("a missing spec path is a fatal, named fetch failure (§7)", async () => {
	await expect(
		new GitRefResolver().resolve(`file://${repoDir}`, "main", "missing.yaml"),
	).rejects.toThrow(/spec fetch failed — .*missing\.yaml.*not found/);
});

test("StaticManifestSource.versions reads env→version via config/'s environments.yaml loader", async () => {
	const src = new StaticManifestSource(
		`${import.meta.dir}/../config/fixtures/environments.yaml`,
	);
	const v = await src.versions("default");
	expect(v).toEqual({ serviceA: "1.4.7", serviceB: "2.0.1" });
	expect(await src.versions(null)).toEqual(v); // null ⇒ the single v1 `default`
});

test("resolveServices resolves all services (bounded), warns per branch, builds a branch-mode lockfile", async () => {
	const { specs, lockfile, warnings } = await resolveServices({
		services: {
			svc: {
				name: "svc",
				repo: "org/name",
				specPath: "asyncapi.yaml",
				branch: "main",
			},
		},
		resolver: new GitRefResolver({ gitHost: `file://${base}` }),
		requestedVersions: { svc: "9.9.9" },
		generatedAt: "2026-07-11T00:00:00.000Z",
	});

	expect(specs.svc.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
	expect(lockfile.resolutionMode).toBe("branch");
	expect(lockfile.services.svc.requestedVersion).toBe("9.9.9"); // recorded, unhonored (v1)
	expect(lockfile.services.svc.declaredVersion).toBe("4.2.0");
	// [utest->R-037] the `asyncapi` field rides the same parser-free read
	expect(lockfile.services.svc.specVersion).toBe("3.0.0");
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("branch tip 'main'"); // honesty warning names the branch

	const yaml = serializeLockfile(lockfile);
	expect(yaml).toContain("resolution-mode: branch"); // kebab on disk
	expect(yaml).toContain("resolved-sha: ");
	expect(yaml).toContain("requested-version: ");
	expect(yaml).not.toContain("resolvedSha"); // not camelCase
});

// [utest->R-037]
test("the lockfile records the AsyncAPI spec version beside the declared version", () => {
	const lock = serializeLockfile({
		lockfileVersion: 1,
		environment: "default",
		resolutionMode: "branch",
		generatedAt: "2026-07-30T00:00:00.000Z",
		services: {
			svc: {
				requestedVersion: "1.0.0",
				resolutionStrategy: "branch",
				resolvedRef: "main",
				resolvedSha: "0".repeat(40),
				specPath: "asyncapi.yaml",
				declaredVersion: "4.2.0",
				specVersion: "3.1.0",
				contentHash: "sha256:abc",
				fetchedAt: "2026-07-30T00:00:00.000Z",
			},
		},
	});
	expect(lock).toContain("spec-version: 3.1.0");
	expect(lock).toContain("declared-version: 4.2.0");
});

// [utest->R-037]
test("spec-version is omitted when the asyncapi field is unreadable", () => {
	const lock = serializeLockfile({
		lockfileVersion: 1,
		environment: "default",
		resolutionMode: "branch",
		generatedAt: "2026-07-30T00:00:00.000Z",
		services: {
			svc: {
				requestedVersion: "1.0.0",
				resolutionStrategy: "branch",
				resolvedRef: "main",
				resolvedSha: "0".repeat(40),
				specPath: "asyncapi.yaml",
				contentHash: "sha256:abc",
				fetchedAt: "2026-07-30T00:00:00.000Z",
			},
		},
	});
	expect(lock).not.toContain("spec-version");
});

test("ingestion/ imports no @asyncapi/parser (G12 — parser-free)", async () => {
	const src = await Bun.file(`${import.meta.dir}/index.ts`).text();
	// guard the import edge, not mentions of the name in prose comments
	expect(src).not.toMatch(/from\s+["']@asyncapi\/parser["']/);
});
