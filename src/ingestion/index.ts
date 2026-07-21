import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadEnvironments } from "../config/index.ts";
import type {
	LockEntry,
	Lockfile,
	ResolvedSpec,
	Resolver,
	ServiceConfig,
	VersionSource,
} from "../model/index.ts";

// ingestion/ imports NO @asyncapi/parser (G12). It shells out to `git` for fetch, and uses `yaml`
// only for (a) a shallow info.version read of the fetched spec and (b) serializing the lockfile.
// environments.yaml is read exclusively through config/'s loadEnvironments (F18 — one loader only).

// --- repo-URL resolution (G20) ---

// A full URL (scheme://…, scp-like git@host:…, or an absolute local path) is used as-is; anything
// else is treated as an 'org/name' slug to be resolved against a gitHost.
export function looksLikeUrl(repo: string): boolean {
	return (
		/^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || // scheme:// (https, ssh, file, …)
		/^git@/.test(repo) || // scp-like git@host:org/name
		repo.startsWith("/") // absolute local path
	);
}

// Full URL used as-is; an 'org/name' slug is joined onto gitHost. A slug with no gitHost is a
// config error (G20) — host-agnostic, so there is no built-in default host.
export function resolveRepoUrl(repo: string, gitHost?: string): string {
	if (looksLikeUrl(repo)) return repo;
	if (!gitHost) {
		throw new Error(
			`repo '${repo}' is an org/name slug but no gitHost is configured (G20)`,
		);
	}
	return `${gitHost.replace(/\/+$/, "")}/${repo}`;
}

// --- git shell-out (host-agnostic; reuses the host's ambient creds) ---

const decoder = new TextDecoder();

async function runGit(
	args: string[],
	cwd: string,
): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout: new Uint8Array(stdout), stderr };
}

async function git(args: string[], cwd: string): Promise<Uint8Array> {
	const { code, stdout, stderr } = await runGit(args, cwd);
	if (code !== 0)
		throw new Error(stderr.trim() || `git ${args[0]} exited ${code}`);
	return stdout;
}

function sha256Hex(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// Best-effort shallow info.version read (G12): no @asyncapi/parser, no schema interpretation — a
// spec that fetched fine but won't yaml-parse (or has no info.version) just leaves the field unset.
function readDeclaredVersion(content: string): string | undefined {
	try {
		const doc = parseYaml(content) as { info?: { version?: unknown } } | null;
		const v = doc?.info?.version;
		return v === undefined || v === null ? undefined : String(v);
	} catch {
		return undefined;
	}
}

// --- GitRefResolver (v1: branch-tip mode) ---

export interface GitRefResolverOptions {
	// global base URL for slug-form repos; per-service gitHost overrides are applied by the caller
	// (resolveServices) before it hands resolve() a repo string. v1 creds are the host's ambient git.
	gitHost?: string;
}

export class GitRefResolver implements Resolver {
	private readonly gitHost?: string;

	constructor(opts: GitRefResolverOptions = {}) {
		this.gitHost = opts.gitHost;
	}

	// Shallow-fetch the ref and record the FULL sha of exactly what we fetched (post-fetch
	// FETCH_HEAD — inherently consistent, G4). v1 only ever receives a branch tip; the by-SHA
	// frozen path + the F17 history-walk are v2. Spec-fetch failure is fatal (§7): the caller
	// aborts `up` on the thrown error rather than booting a mock with no source of truth.
	async resolve(
		repo: string,
		ref: string,
		specPath: string,
	): Promise<ResolvedSpec> {
		const repoUrl = resolveRepoUrl(repo, this.gitHost);
		const work = await mkdtemp(join(tmpdir(), "offbook-ingest-"));
		try {
			await git(["init", "-q"], work);
			try {
				await git(["fetch", "--depth", "1", repoUrl, ref], work);
			} catch (cause) {
				throw new Error(
					`spec fetch failed — ${repo}@${ref}: ${(cause as Error).message}`,
				);
			}
			const resolvedSha = decoder
				.decode(await git(["rev-parse", "FETCH_HEAD"], work))
				.trim();
			let bytes: Uint8Array;
			try {
				bytes = await git(["show", `FETCH_HEAD:${specPath}`], work);
			} catch (cause) {
				throw new Error(
					`spec fetch failed — ${repo}@${ref}: '${specPath}' not found (${(cause as Error).message})`,
				);
			}
			const content = decoder.decode(bytes);
			return {
				content,
				contentHash: `sha256:${sha256Hex(bytes)}`,
				specPath,
				resolvedRef: ref,
				resolvedSha,
				source: `${ref}@${repo}:${specPath}`, // keeps the authored repo form (slug or URL)
				declaredVersion: readDeclaredVersion(content),
				fetchedAt: new Date().toISOString(),
			};
		} finally {
			await rm(work, { recursive: true, force: true });
		}
	}
}

// --- StaticManifestSource (v1 VersionSource) ---

// env → { service: version }, read from environments.yaml THROUGH config/'s loader (F18 — ingestion
// parses no environments YAML of its own). null environment ⇒ the single v1 `default`. v2 swaps this
// for ReleaseToolingSource behind the same interface.
export class StaticManifestSource implements VersionSource {
	constructor(private readonly environmentsPath: string) {}

	async versions(environment: string | null): Promise<Record<string, string>> {
		const { environments } = await loadEnvironments(this.environmentsPath);
		return environments[environment ?? "default"] ?? {};
	}
}

// --- specs.lock writer ---

export function buildLockEntry(
	resolved: ResolvedSpec,
	requestedVersion: string,
): LockEntry {
	return {
		requestedVersion, // recorded from environments.yaml, UNHONORED in v1
		resolutionStrategy: "branch",
		resolvedRef: resolved.resolvedRef,
		resolvedSha: resolved.resolvedSha,
		specPath: resolved.specPath,
		declaredVersion: resolved.declaredVersion,
		contentHash: resolved.contentHash,
		fetchedAt: resolved.fetchedAt,
	};
}

// camelCase model → kebab-case on-disk YAML (§6 key-casing convention). declared-version is omitted
// when absent (optional); resolved-version is v2-only and never written here.
export function serializeLockfile(lock: Lockfile): string {
	return stringifyYaml({
		"lockfile-version": lock.lockfileVersion,
		environment: lock.environment,
		"resolution-mode": lock.resolutionMode,
		"generated-at": lock.generatedAt,
		services: Object.fromEntries(
			Object.entries(lock.services).map(([name, e]) => [
				name,
				{
					"requested-version": e.requestedVersion,
					"resolution-strategy": e.resolutionStrategy,
					"resolved-ref": e.resolvedRef,
					"resolved-sha": e.resolvedSha,
					"spec-path": e.specPath,
					...(e.declaredVersion !== undefined
						? { "declared-version": e.declaredVersion }
						: {}),
					"content-hash": e.contentHash,
					"fetched-at": e.fetchedAt,
				},
			]),
		),
	});
}

export async function writeLockfile(
	path: string,
	lock: Lockfile,
): Promise<void> {
	await Bun.write(path, serializeLockfile(lock));
}

// --- orchestration: resolve all services (bounded pool, F21) + build the branch-mode lockfile ---

async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(limit, items.length));
	await Promise.all(
		Array.from({ length: width }, async () => {
			for (let i = next++; i < items.length; i = next++) {
				results[i] = await fn(items[i], i);
			}
		}),
	);
	return results;
}

export interface ResolveServicesResult {
	specs: Record<string, ResolvedSpec>;
	lockfile: Lockfile;
	warnings: string[];
}

// Resolve every service's branch tip via a bounded pool (F21 — concurrent, not serial), then build
// the v1 branch-mode lockfile and emit one honesty warning per service naming its branch (design §7:
// branch mode is liveness — never lie about fidelity). A single fetch failure rejects the whole call
// (spec-load is fatal, §7). `generatedAt` is injected so the lockfile is deterministic under test.
export async function resolveServices(opts: {
	services: Record<string, ServiceConfig>;
	resolver: Resolver;
	requestedVersions?: Record<string, string>;
	environment?: string;
	generatedAt: string;
	concurrency?: number;
}): Promise<ResolveServicesResult> {
	const entries = Object.entries(opts.services);
	const resolved = await mapPool(
		entries,
		opts.concurrency ?? 8,
		async ([name, sc]) => {
			const ref = sc.branch ?? "main";
			// per-service gitHost override wins over the resolver's global (G20); a full URL passes through.
			const repo =
				sc.gitHost && !looksLikeUrl(sc.repo)
					? resolveRepoUrl(sc.repo, sc.gitHost)
					: sc.repo;
			try {
				return {
					name,
					ref,
					spec: await opts.resolver.resolve(repo, ref, sc.specPath),
				};
			} catch (cause) {
				throw new Error(`service '${name}': ${(cause as Error).message}`);
			}
		},
	);

	const services: Record<string, LockEntry> = {};
	const warnings: string[] = [];
	for (const { name, ref, spec } of resolved) {
		services[name] = buildLockEntry(spec, opts.requestedVersions?.[name] ?? "");
		warnings.push(
			`service '${name}': resolved on branch tip '${ref}' — live, not frozen (resolution-mode: branch)`,
		);
	}

	return {
		specs: Object.fromEntries(resolved.map((r) => [r.name, r.spec])),
		lockfile: {
			lockfileVersion: 1,
			environment: opts.environment ?? "default",
			resolutionMode: "branch",
			generatedAt: opts.generatedAt,
			services,
		},
		warnings,
	};
}
