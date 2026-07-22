import { generate as jsfGenerate } from "json-schema-faker";
import type { JsonSchema } from "json-schema-faker";
import type { Channel, Config, Faker, Violation } from "../model/index.ts";
import { hashToInt } from "./prng.ts";

// stable sorted-key serialization; empty string when params are absent.
function canonicalize(params?: Record<string, string>): string {
	if (!params) return "";
	return Object.keys(params)
		.sort()
		.map((k) => `${k}=${params[k]}`)
		.join("&");
}

export function createFaker(config: Config): Faker {
	// Static JSF options, set once at construction. json-schema-faker 0.6.2 has
	// no `JSONSchemaFaker` singleton / `.option()` mutator (it exports plain
	// functions instead); the per-call seed is passed straight into `generate`'s
	// options on each call below, so there is no global/module state to race on
	// (D-003 consequence #3 doesn't apply to this API shape).
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
				`${first?.instancePath || "/"}: ${first?.keyword ?? "unknown"}`,
			),
			payload,
			errors,
		},
	};
}
