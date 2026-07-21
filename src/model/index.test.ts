import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "./index.ts";
import type {
	Channel,
	Config,
	Diagnostic,
	DiagnosticSummary,
	Direction,
	EmitSource,
	EmitStep,
	ErrorCode,
	Faker,
	Handler,
	HandlerContext,
	HandlerFactory,
	InboundEvent,
	InstanceRegistry,
	InstanceSnapshot,
	LockEntry,
	Lockfile,
	NormalizedMessage,
	ResolvedSpec,
	Resolver,
	Scenario,
	ScenarioInfo,
	SchemaError,
	ServiceConfig,
	SpecInfo,
	SpecRegistry,
	StateEntry,
	TopicInfo,
	ValidationSummary,
	VersionSource,
	Violation,
	ViolationKind,
	WhenClause,
} from "./index.ts";

// R-001 exhaustiveness guard. Every contracts.md §1–6 type must be present + exported from model/,
// with the single documented exception of BrokerModule (homed in broker/ per build-plan §2). The
// model/ acceptance is inherently compile-time ("tsc clean; every type present and exported" —
// build-plan#tier-0), so each type occupies a slot below: a missing or renamed export fails the
// `import type` above AND this mapped type under `tsc --noEmit` (the CI/pre-commit typecheck), which
// is the real assertion. `bun test` only runs the runtime checks that follow.
type _R001Coverage = {
	// §1 normalized message model
	Direction: Direction;
	NormalizedMessage: NormalizedMessage;
	InboundEvent: InboundEvent;
	Channel: Channel;
	SpecRegistry: SpecRegistry;
	// §1a runtime config
	Config: Config;
	// §2 broker-adjacent (BrokerModule excepted — broker/)
	InstanceRegistry: InstanceRegistry;
	InstanceSnapshot: InstanceSnapshot;
	// §3 behavior engine
	HandlerFactory: HandlerFactory;
	Handler: Handler;
	HandlerContext: HandlerContext;
	Faker: Faker;
	// §3a scenario model
	Scenario: Scenario;
	WhenClause: WhenClause;
	EmitStep: EmitStep;
	// §4 validation
	ViolationKind: ViolationKind;
	SchemaError: SchemaError;
	EmitSource: EmitSource;
	Violation: Violation;
	// §5 control-plane DTOs
	TopicInfo: TopicInfo;
	StateEntry: StateEntry;
	SpecInfo: SpecInfo;
	ScenarioInfo: ScenarioInfo;
	Diagnostic: Diagnostic;
	DiagnosticSummary: DiagnosticSummary;
	ValidationSummary: ValidationSummary;
	ErrorCode: ErrorCode;
	// §6 spec ingestion & config
	ServiceConfig: ServiceConfig;
	ResolvedSpec: ResolvedSpec;
	Resolver: Resolver;
	VersionSource: VersionSource;
	Lockfile: Lockfile;
	LockEntry: LockEntry;
};

test("model/ exports every contracts.md §1–6 type (R-001, compile-time exhaustiveness)", () => {
	// The assertion lives in `tsc --noEmit`: the `import type` block + this reference force every
	// §1–6 type to resolve, so a missing/renamed export fails the typecheck. This runtime line just
	// keeps the guard file present in `bun test`.
	const _cover: _R001Coverage | undefined = undefined;
	expect(_cover).toBeUndefined();
});

test("DEFAULT_CONFIG has the frozen port + seed defaults", () => {
	expect(DEFAULT_CONFIG.seed).toBe(1);
	expect(DEFAULT_CONFIG.brokerWsPort).toBe(9001);
	expect(DEFAULT_CONFIG.brokerTcpPort).toBe(1883);
	expect(DEFAULT_CONFIG.controlPlanePort).toBe(9080);
	expect(DEFAULT_CONFIG.mode).toBe("autonomous");
	expect(DEFAULT_CONFIG.wallClock).toBe(false);
	expect(DEFAULT_CONFIG.maxViolations).toBe(10_000);
});
