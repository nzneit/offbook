// R-019 — the project boot path `offbook up` owns (contracts §5/G14): read
// services.yaml + environments.yaml, resolve every service's branch tip
// (spec-load failure is FATAL — design §7 Mode 1: the throw aborts `up` in
// the foreground, never a half-booted mock), write specs.lock, compile one
// merged registry, and hand compose() the resolveSpecs capability behind
// POST /v1/specs/refresh (F21: unchanged content-hash skips parse + Ajv
// recompile; all-unchanged short-circuits the registry swap entirely).
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Composed } from "#src/compose/index.ts";
import { compose } from "#src/compose/index.ts";
import { loadServices } from "#src/config/index.ts";
import {
	GitRefResolver,
	resolveServices,
	StaticManifestSource,
	writeLockfile,
} from "#src/ingestion/index.ts";
import type { Config, SpecInfo, SpecRegistry } from "#src/model/index.ts";
import { buildRegistry, mergeRegistries } from "#src/registry/index.ts";

export interface ProjectBootOptions {
	projectDir: string;
	config: Config;
	environment?: string; // v1: 'default'
	log?: (line: string) => void;
}

export async function bootProject(opts: ProjectBootOptions): Promise<Composed> {
	const servicesPath = join(opts.projectDir, "services.yaml");
	if (!existsSync(servicesPath))
		throw new Error(
			`no services.yaml in ${opts.projectDir} — run \`offbook init\` (or \`offbook demo\` for the bundled spec)`,
		);
	const { gitHost, services } = await loadServices(servicesPath);
	const envPath = join(opts.projectDir, "environments.yaml");
	const requestedVersions = existsSync(envPath)
		? await new StaticManifestSource(envPath).versions(opts.environment ?? null)
		: {};
	const resolver = new GitRefResolver({ gitHost });

	// per-service compiled registries keyed by content-hash (the F21 skip).
	// R-040 invariant: the key deliberately omits ServiceConfig — safe because
	// `services` is read once at boot and immutable in-process; if services.yaml
	// ever becomes re-readable mid-process, this key must grow a config
	// fingerprint or a stale Channel.initialState is served for an unchanged spec.
	const compiled = new Map<string, { hash: string; registry: SpecRegistry }>();

	async function resolveAll(): Promise<{
		registry: SpecRegistry;
		specs: SpecInfo[];
		warnings: string[];
	}> {
		const { specs, lockfile, warnings } = await resolveServices({
			services,
			resolver,
			requestedVersions,
			environment: opts.environment,
			generatedAt: new Date().toISOString(),
		});
		await writeLockfile(join(opts.projectDir, "specs.lock"), lockfile);
		const registries: SpecRegistry[] = [];
		const infos: SpecInfo[] = [];
		for (const [name, spec] of Object.entries(specs)) {
			const cached = compiled.get(name);
			const registry =
				cached && cached.hash === spec.contentHash
					? cached.registry
					: await buildRegistry({
							specText: spec.content,
							service: name,
							config: opts.config,
							serviceConfig: services[name],
						});
			compiled.set(name, { hash: spec.contentHash, registry });
			registries.push(registry);
			infos.push({
				service: name,
				declaredVersion: spec.declaredVersion,
				specVersion: spec.specVersion,
				source: spec.source,
				contentHash: spec.contentHash,
				channelCount: registry.channels().length,
				fetchedAt: spec.fetchedAt,
			});
		}
		return { registry: mergeRegistries(registries), specs: infos, warnings };
	}

	const first = await resolveAll();

	// seedInstances live per-service in services.yaml (§6); compose takes one map
	const seedInstances: Record<string, Record<string, string>[]> = {};
	for (const sc of Object.values(services)) {
		for (const [address, instances] of Object.entries(sc.seedInstances ?? {})) {
			seedInstances[address] = [
				...(seedInstances[address] ?? []),
				...instances,
			];
		}
	}

	const scenariosDir = join(opts.projectDir, "scenarios");
	const handlersDir = join(opts.projectDir, "handlers");
	return compose({
		config: opts.config,
		registry: first.registry,
		scenariosDir: existsSync(scenariosDir) ? scenariosDir : undefined,
		handlersDir: existsSync(handlersDir) ? handlersDir : undefined,
		seedInstances,
		specs: first.specs,
		specsWarnings: first.warnings,
		resolveSpecs: async () => {
			const next = await resolveAll();
			return { registry: next.registry, specs: next.specs };
		},
		log: opts.log,
	});
}

// `offbook demo --serve` (D-015): the bundled thermostat spec + bundled chain
// scenarios, long-running — no services.yaml, no git, no specs.lock.
export async function bootDemo(opts: {
	config: Config;
	log?: (line: string) => void;
}): Promise<Composed> {
	const demoDir = join(import.meta.dir, "../demo");
	const specText = await Bun.file(join(demoDir, "thermostat.yaml")).text();
	const registry = await buildRegistry({
		specText,
		service: "demo",
		config: opts.config,
	});
	return compose({
		config: opts.config,
		registry,
		scenariosDir: join(demoDir, "scenarios"),
		// engine.start() materializes these and republishes initial retained
		// state, so the dashboard has a device before any client subscribes
		seedInstances: { "state/{deviceId}": [{ deviceId: "thermostat-1" }] },
		log: opts.log,
	});
}
