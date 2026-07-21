import type { ErrorObject } from "ajv";

export type Direction = "toClient" | "fromClient";

export interface NormalizedMessage {
	topic: string;
	payload: unknown;
	qos?: 0 | 1 | 2;
	retain?: boolean;
	delayMs?: number;
}

export interface InboundEvent {
	message: NormalizedMessage;
	meta: {
		clientId: string;
		seq: number;
		receivedAt: number;
		decodeError?: string;
	};
}

export interface Channel {
	topic: string;
	direction: Direction;
	service: string;
	schema: object;
	validate: (payload: unknown) => SchemaError[];
	qos?: 0 | 1 | 2;
	retain?: boolean;
	title?: string;
	description?: string;
}

export interface SpecRegistry {
	match(
		topic: string,
	): { channel: Channel; params: Record<string, string> } | undefined;
	matchesFilter(filter: string, topic: string): boolean;
	channels(): readonly Channel[];
}

export interface Config {
	seed: number;
	fixedEpoch: number;
	tickIntervalMs: number;
	wallClock: boolean;
	mode: "autonomous" | "passive";
	strict: boolean;
	maxViolations: number;
	maxEvents: number;
	injectedClientId: string;
	brokerWsPort: number;
	brokerTcpPort: number;
	controlPlanePort: number;
	runDir: string;
}

export const DEFAULT_CONFIG: Config = {
	seed: 1,
	fixedEpoch: 1_700_000_000_000,
	tickIntervalMs: 1000,
	wallClock: false,
	mode: "autonomous",
	strict: false,
	maxViolations: 10_000,
	maxEvents: 0,
	injectedClientId: "control-plane",
	brokerWsPort: 9001,
	brokerTcpPort: 1883,
	controlPlanePort: 9080,
	runDir: ".offbook",
};

// contracts.md §6 — per-service spec location + qos/retain config tiers.
// `name` is the services.yaml map key (injected by config/'s loader, not in the value).
export interface ServiceConfig {
	name: string;
	repo: string; // full URL used as-is, OR an 'org/name' slug resolved against gitHost (G20)
	gitHost?: string; // per-service base URL override for the slug form
	specPath: string; // v1: a fixed path
	branch?: string; // v1 ref selection; default 'main'
	qosDefault?: 0 | 1 | 2; // per-service default qos — tier 3 of the §2 precedence chain
	retainDefault?: boolean; // per-service default retain — tier 3
	// per-topic override — tier 2; key = channel address (the {param} form), string-equality matched (F14)
	topicOverrides?: Record<string, { qos?: 0 | 1 | 2; retain?: boolean }>;
	// channel address → list of param-maps; pre-materializes a deterministic demo set (F1, §2)
	seedInstances?: Record<string, Record<string, string>[]>;
}

// contracts.md §6 — spec ingestion (design §7 seams, v1). GitRefResolver + StaticManifestSource
// behind stable interfaces; semver→ref resolution + the by-SHA frozen reader are v2.
export interface ResolvedSpec {
	content: string; // raw spec text (YAML/JSON)
	contentHash: string; // "sha256:…" — our byte fingerprint
	specPath: string;
	resolvedRef: string; // the selection input (branch in v1; tag/sha in v2)
	resolvedSha: string; // FULL canonical commit sha — the pin, never abbreviated
	source: string; // human origin, e.g. "dev@org/service-b:asyncapi.yaml"
	declaredVersion?: string; // info.version — shallow parser-free read by ingestion/ (G12); best-effort
	fetchedAt: string; // ISO8601
}

// v1+v2: GitRefResolver. The v1↔v2 difference is ref selection only — signature is stable (§6).
export interface Resolver {
	resolve(repo: string, ref: string, specPath: string): Promise<ResolvedSpec>;
}

// v1: StaticManifestSource (reads environments.yaml via config/'s loader). v2: ReleaseToolingSource.
export interface VersionSource {
	versions(environment: string | null): Promise<Record<string, string>>;
}

export interface Lockfile {
	lockfileVersion: number;
	environment: string;
	resolutionMode: "branch" | "pinned";
	generatedAt: string; // ISO8601
	services: Record<string, LockEntry>;
}

export interface LockEntry {
	requestedVersion: string; // from environments.yaml — recorded, UNHONORED in v1
	resolutionStrategy: "branch"; // v2 adds git-tag | release-branch | manual | …
	resolvedRef: string;
	resolvedSha: string; // FULL canonical commit sha — never abbreviated
	specPath: string;
	declaredVersion?: string; // info.version
	contentHash: string; // "sha256:…"
	fetchedAt: string; // ISO8601
	resolvedVersion?: string; // v2 only — semver after range policy
}

export type Faker = (
	channel: Channel,
	instanceParams?: Record<string, string>,
) => Promise<unknown>;

export interface TopicInfo {
	topic: string;
	direction: Direction;
	service: string;
	title?: string;
	description?: string;
	schema: object;
	example?: unknown;
	qos?: 0 | 1 | 2;
	retain?: boolean;
}

export type ViolationKind = "schema" | "direction" | "unknown-topic" | "decode";

export type SchemaError = Omit<ErrorObject, "data" | "schema">;

export type EmitSource = {
	layer: "L1" | "L2" | "L3";
	scenarioName?: string;
	stepIndex?: number;
};

export interface Violation {
	seq: number;
	observedAt: string;
	origin: "client" | "mock";
	kind: ViolationKind;
	severity: "error" | "warning";
	topic: string;
	channel?: string;
	detail: string;
	payload?: unknown;
	clientId?: string;
	errors?: SchemaError[];
	emitSource?: EmitSource;
}

export interface StateEntry {
	topic: string;
	payload: unknown;
	qos?: 0 | 1 | 2;
	retain: true;
}

export interface ValidationSummary {
	errors: number;
	warnings: number;
	byOrigin: { client: number; mock: number };
	byKind: Record<ViolationKind, number>;
	oldestSeq: number;
	distinct: { total: number; client: number; mock: number };
}
