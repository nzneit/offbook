import { parse as parseYaml } from "yaml";
import {
	type Config,
	DEFAULT_CONFIG,
	type ServiceConfig,
} from "../model/index.ts";

export function loadConfig(overrides: Partial<Config> = {}): Config {
	return { ...DEFAULT_CONFIG, ...overrides };
}

// Parsed shapes of the two hand-authored config files (contracts.md §6). config/ is Tier-0:
// the SOLE loader of these files, imported by BOTH registry/ and ingestion/ so neither grows
// a sibling back-edge (F18). Pure yaml — no @asyncapi/parser here.

export interface ServicesConfig {
	gitHost?: string;
	services: Record<string, ServiceConfig>;
}

export interface EnvironmentsConfig {
	environments: Record<string, Record<string, string>>;
}

function asObject(doc: unknown, file: string): Record<string, unknown> {
	if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
		throw new Error(`${file}: expected a top-level YAML map`);
	}
	return doc as Record<string, unknown>;
}

function toServiceConfig(name: string, raw: unknown): ServiceConfig {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`service '${name}': expected a map`);
	}
	const r = raw as Record<string, unknown>;
	if (typeof r.repo !== "string") {
		throw new Error(`service '${name}': missing required 'repo'`);
	}
	if (typeof r.specPath !== "string") {
		throw new Error(`service '${name}': missing required 'specPath'`);
	}
	if (
		r.qosDefault !== undefined &&
		![0, 1, 2].includes(r.qosDefault as number)
	) {
		throw new Error(`service '${name}': qosDefault must be 0, 1, or 2`);
	}
	// name is injected from the map key (wins over any stray value key); the rest pass through
	// verbatim (URL resolution + the qos/retain precedence chain are consumers' jobs).
	return { ...r, name } as ServiceConfig;
}

export function parseServices(yamlText: string): ServicesConfig {
	const doc = asObject(parseYaml(yamlText), "services.yaml");
	if (doc.gitHost !== undefined && typeof doc.gitHost !== "string") {
		throw new Error("services.yaml: 'gitHost' must be a string");
	}
	if (
		doc.services === null ||
		typeof doc.services !== "object" ||
		Array.isArray(doc.services)
	) {
		throw new Error("services.yaml: missing required 'services' map");
	}
	const services: Record<string, ServiceConfig> = {};
	for (const [name, raw] of Object.entries(
		doc.services as Record<string, unknown>,
	)) {
		services[name] = toServiceConfig(name, raw);
	}
	return { gitHost: doc.gitHost as string | undefined, services };
}

export function parseEnvironments(yamlText: string): EnvironmentsConfig {
	const doc = asObject(parseYaml(yamlText), "environments.yaml");
	if (
		doc.environments === null ||
		typeof doc.environments !== "object" ||
		Array.isArray(doc.environments)
	) {
		throw new Error("environments.yaml: missing required 'environments' map");
	}
	const environments: Record<string, Record<string, string>> = {};
	for (const [env, raw] of Object.entries(
		doc.environments as Record<string, unknown>,
	)) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error(`environment '${env}': expected a service → version map`);
		}
		const versions: Record<string, string> = {};
		// Coerce to string: an unquoted numeric-looking version parses as a number in YAML,
		// and the contract is Record<string, string>. (Quote versions to preserve them exactly.)
		for (const [service, version] of Object.entries(
			raw as Record<string, unknown>,
		)) {
			versions[service] = String(version);
		}
		environments[env] = versions;
	}
	return { environments };
}

export async function loadServices(path: string): Promise<ServicesConfig> {
	return parseServices(await Bun.file(path).text());
}

export async function loadEnvironments(
	path: string,
): Promise<EnvironmentsConfig> {
	return parseEnvironments(await Bun.file(path).text());
}
