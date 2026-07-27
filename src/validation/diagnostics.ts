// R-017 — dev-time diagnostic computations for GET /v1/diagnostics
// (contracts §5): the vacuous-schema spec-QUALITY flag (design §7 Mode 2) and
// the 'uninstantiated' teaching notice (EQ5). Both are pure functions the
// composition root snapshots per request, so 'uninstantiated' clears itself
// the moment an instance materializes.
import type {
	Channel,
	Diagnostic,
	InstanceSnapshot,
} from "#src/model/index.ts";

const isParametrized = (address: string): boolean => /\{[^}]+\}/.test(address);

// A channel whose schema asserts effectively nothing: {}, true, or
// type:object with neither properties nor required. A client publish
// validates GREEN while the contract checked nothing — false confidence.
// Scoped tight to the unambiguous vacuous shapes, NOT a graded quality score.
function isVacuous(schema: object): boolean {
	const s = schema as Record<string, unknown>;
	const keys = Object.keys(s).filter((k) => k !== "$schema");
	if (keys.length === 0) return true;
	return (
		s.type === "object" &&
		s.properties === undefined &&
		s.required === undefined &&
		keys.every((k) => k === "type" || k === "additionalProperties")
	);
}

export function specQualityDiagnostics(
	channels: readonly Channel[],
): Diagnostic[] {
	return channels
		.filter((c) => isVacuous(c.schema))
		.map((c) => ({
			kind: "spec-load" as const,
			severity: "warning" as const,
			detail: `'${c.topic}' validates green but its schema constrains nothing — passing here is unverified`,
			source: c.topic,
		}));
}

// EQ5: each parametrized toClient channel with ZERO materialized instances,
// counted from the engine's InstanceRegistry LEDGER (never the async
// getState() retained store).
export function uninstantiatedDiagnostics(
	channels: readonly Channel[],
	snapshot: InstanceSnapshot,
): Diagnostic[] {
	const materialized = new Set(snapshot.instances.map((i) => i.channelAddress));
	return channels
		.filter(
			(c) =>
				c.direction === "toClient" &&
				isParametrized(c.topic) &&
				!materialized.has(c.topic),
		)
		.map((c) => ({
			kind: "uninstantiated" as const,
			severity: "info" as const,
			detail: `'${c.topic}' has no instances yet — subscribe to a concrete topic, send a matching command, or add seedInstances`,
			source: c.topic,
		}));
}
