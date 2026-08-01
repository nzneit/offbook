import type { JsonSchema } from "json-schema-faker";
import { generate as jsfGenerate } from "json-schema-faker";
import type { Channel, Config, Faker, Violation } from "#src/model/index.ts";
import { hashToInt } from "./prng.ts";

// Stable sorted-key serialization, percent-encoded so the identity is
// injective (no `&`/`=`/`%` collisions between distinct param maps); empty
// string when params are absent.
// Shared F7 identity: the faker's seed key and the InstanceRegistry ledger key
// must agree on what "the same instance" is.
export function canonicalize(params?: Record<string, string>): string {
	if (!params) return "";
	return Object.keys(params)
		.sort()
		.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
		.join("&");
}

export function createFaker(config: Config): Faker {
	// Static JSF options, set once at construction. json-schema-faker 0.6.3 has
	// no `JSONSchemaFaker` singleton / `.option()` mutator (it exports plain
	// functions instead); the per-call seed is passed straight into `generate`'s
	// options on each call below, so there is no global/module state to race on
	// (D-003 consequence #3 doesn't apply to this API shape).
	// 0.6.3 does add `generateSync`, which retires D-003's async-only premise but
	// not the decision: `Faker` stays async by contract (D-020).
	const staticOptions = {
		alwaysFakeOptionals: true,
		failOnInvalidTypes: false,
	};

	return async (
		channel: Channel,
		instanceParams?: Record<string, string>,
	): Promise<unknown> => {
		// one keyed integer fed into JSF's native per-call `seed` option — no
		// second PRNG wraps its output (R4)
		const seed = hashToInt(
			`${config.seed}|${channel.topic}|${canonicalize(instanceParams)}`,
		);
		return jsfGenerate(channel.schema as JsonSchema, {
			...staticOptions,
			seed,
		});
	};
}

function rejectionViolation(
	channel: Channel,
	message: string,
): Omit<Violation, "seq" | "observedAt"> {
	return {
		origin: "mock",
		kind: "schema",
		severity: "error",
		topic: channel.topic,
		channel: channel.topic,
		detail: message,
		emitSource: { layer: "L1" },
	};
}

export async function l1Floor(
	channel: Channel,
	faker: Faker,
): Promise<
	{ payload: unknown } | { violation: Omit<Violation, "seq" | "observedAt"> }
> {
	let payload: unknown;
	try {
		payload = await faker(channel);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return {
			violation: rejectionViolation(channel, `faker rejected: ${message}`),
		};
	}

	const errors = channel.validate(payload);
	if (errors.length === 0) return { payload };

	const first = errors[0];
	return {
		violation: {
			...rejectionViolation(
				channel,
				// Stryker disable next-line OptionalChaining,StringLiteral: errors[0] is defined under the length check (the ?. exists for noUncheckedIndexedAccess), and the ?? "unknown" fallback literal is unreachable because Ajv errors always carry a keyword; the detail format itself is pinned exactly by tests
				`${first?.instancePath || "/"}: ${first?.keyword ?? "unknown"}`,
			),
			payload,
			errors,
		},
	};
}
