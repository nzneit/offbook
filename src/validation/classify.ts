// R-015/R-017 — the four-kind classification of a CLIENT publish (contracts
// §4), moved here from control-plane's M0 wiring (the F11 injection cleanup):
// classification is validation logic, and the control plane receives its
// results only through the injected log. Pure: event in, violation (or
// nothing) out — recording and delivery stay the caller's business, so no
// path here can block delivery (observe-and-surface).
import type {
	InboundEvent,
	SpecRegistry,
	Violation,
} from "#src/model/index.ts";

export function classifyClientPublish(
	registry: SpecRegistry,
	event: InboundEvent,
): Omit<Violation, "seq" | "observedAt"> | undefined {
	const { topic, payload } = event.message;
	const { clientId, decodeError } = event.meta;
	if (decodeError) {
		return {
			origin: "client",
			kind: "decode",
			severity: "error",
			topic,
			detail: `decode: ${decodeError}`,
			payload,
			clientId,
		};
	}
	const m = registry.match(topic);
	if (!m) {
		return {
			origin: "client",
			kind: "unknown-topic",
			severity: "error",
			topic,
			detail: "unknown-topic",
			payload,
			clientId,
		};
	}
	if (m.channel.direction !== "fromClient") {
		return {
			origin: "client",
			kind: "direction",
			severity: "error",
			topic,
			channel: m.channel.topic,
			detail: "direction: client published a toClient topic",
			payload,
			clientId,
		};
	}
	const errors = m.channel.validate(payload);
	if (errors.length > 0) {
		return {
			origin: "client",
			kind: "schema",
			severity: "error",
			topic,
			channel: m.channel.topic,
			detail: `${errors[0]?.instancePath || "/"}: ${errors[0]?.keyword}`,
			payload,
			clientId,
			errors,
		};
	}
	return undefined;
}
