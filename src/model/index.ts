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
	// Registry-time spec-QUALITY findings (D-018): problems discoverable only
	// while building the catalog, so they cannot be recomputed from Channel
	// later (binding placement, dialect mismatch, a schema that would not
	// compile). Collected once at build; the composition root merges them into
	// GET /v1/diagnostics beside the computed ones. Uses the existing closed
	// `spec-load` kind with a machine-greppable `detail` tag prefix.
	diagnostics(): readonly Diagnostic[];
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
	specVersion?: string; // the `asyncapi` version — shallow parser-free read (G12); best-effort
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
	specVersion?: string; // the `asyncapi` version of the fetched spec
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

// contracts.md §2 — engine-owned instance lifecycle (F1). The materialization LEDGER, NOT a mirror
// of current retained state (that is Aedes', read via getState / native delivery, R3). Declared in
// model/, driven by the engine. (BrokerModule itself is homed in broker/ — build-plan §2.)
export interface InstanceRegistry {
	materialize(channelAddress: string, params: Record<string, string>): void; // idempotent
	snapshot(): InstanceSnapshot; // captured at reset
	restore(s: InstanceSnapshot): void; // re-materializes EXACTLY the snapshot set, re-seeded
}

export interface InstanceSnapshot {
	instances: { channelAddress: string; params: Record<string, string> }[];
}

// contracts.md §3 — behavior-engine registration. A FACTORY — re-instantiated on reset for clean
// deterministic state.
export type HandlerFactory = () => Handler;

export interface Handler {
	onInbound?(event: InboundEvent, ctx: HandlerContext): void; // reactive
	initialState?(topic: string, ctx: HandlerContext): void; // proactive (on subscribe)
	tick?(ctx: HandlerContext): void; // autonomous mode
}

export interface HandlerContext {
	publish(msg: Partial<NormalizedMessage> & { topic: string }): void; // routed through the scheduler
	random(): number; // seeded PRNG draw (deterministic)
	now(): number; // LOGICAL clock: fixedEpoch + Σ(seeded delays) — NOT wall-clock (G5)
}

// contracts.md §3a — the normalized, parsed shape of an L2 scenario (canonical type; transcribed
// from l2-scenarios.md §9). scenarios/ and control-plane both import it.
export interface Scenario {
	name: string; // globally unique; keys POST /trigger/{name}, the validation log, and reset
	when?: WhenClause; // present ⇒ reactive; absent ⇒ on-demand-only
	then: EmitStep[]; // ordered, ≥1 step
}

export interface WhenClause {
	topic: string; // {param} captures + MQTT +/#; must resolve to a fromClient channel
	payloadMatch?: Record<string, unknown>; // subset equality; extra fields ignored
}

export interface EmitStep {
	emit: {
		topic: string; // {{substitution}}; must resolve to a toClient channel
		payload: unknown; // {{substitution}}; omitted required fields seed-faked by L1, then Ajv-rechecked
		delay?: string; // "<n>ms|s" or "<min>-<max>ms|s"; omitted ⇒ 0; relative/cumulative across steps
	};
}

// contracts.md §5 — control-plane read DTOs.
export interface SpecInfo {
	service: string;
	declaredVersion?: string; // info.version — parser-free shallow read by ingestion/ (G12); NOT requested
	specVersion?: string; // the `asyncapi` version — which spec major this service is on
	source: string;
	contentHash: string;
	channelCount: number;
	fetchedAt: string; // ISO8601; spec provenance/age for trust calibration (design §7 Mode 3)
}

export interface ScenarioInfo {
	name: string;
	when?: string; // the reactive trigger topic (absent ⇒ on-demand/trigger-only)
	stepCount: number;
	source: string; // scenario file path
}

export interface Diagnostic {
	kind: "scenario-load" | "overlap" | "spec-load" | "uninstantiated";
	severity: "error" | "warning" | "info";
	detail: string;
	source?: string; // machine-filterable (channel address for uninstantiated/spec-load); no `channel` field
	scenarioName?: string;
}

export interface DiagnosticSummary {
	errors: number;
	warnings: number;
	info: number;
	byKind: Record<
		"scenario-load" | "overlap" | "spec-load" | "uninstantiated",
		number
	>; // all four keys always present, zero-filled
}

// Closed set of error-envelope codes; the CLI/CI branch on this union, no ad-hoc strings. NB there
// is NO 'unknown-topic' code — an unmatched /publish returns 202 + raises an 'unknown-topic'
// VIOLATION (§4), not an error envelope; that name lives only as a ViolationKind.
export type ErrorCode =
	| "unknown-scenario" // POST /trigger/{name} with no such scenario
	| "bad-request" // malformed body / params (generic 400)
	| "example-on-unknown-topic" // POST /publish { example: true } on an unknown topic
	| "example-and-payload"; // POST /publish with BOTH payload and example present
