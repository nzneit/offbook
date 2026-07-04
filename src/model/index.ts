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
