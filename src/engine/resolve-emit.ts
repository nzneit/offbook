// R-013 — the single emit-completion choke-point (contracts §3, F13/F7/CR7).
// Every engine emission passes through resolveEmit before broker.emit, so an
// authored {topic, payload} always reaches the broker at the channel-resolved
// qos/retain (never undefined — Aedes must never fall back to QoS 0 by
// accident) and every L2 ranged delay is a keyed, reproducible draw.
import type { Channel, Config, NormalizedMessage } from "#src/model/index.ts";
import { hashToInt, mulberry32 } from "./prng.ts";

export interface EmitPartial extends Partial<NormalizedMessage> {
	topic: string;
	delay?: string; // l2 §6 grammar; only the L2 runner produces this
}

export interface DelayKey {
	scenarioName: string;
	stepIndex: number;
}

const DELAY_RE = /^(\d+)(?:-(\d+))?(ms|s)$/;

export function parseDelay(
	spec: string,
	config: Config,
	key: DelayKey,
): number {
	const m = spec.match(DELAY_RE);
	if (!m)
		throw new Error(
			`malformed delay "${spec}" (expected "<n>ms|s" or "<min>-<max>ms|s")`,
		);
	const unit = m[3] === "s" ? 1000 : 1;
	const min = Number(m[1]) * unit;
	if (m[2] === undefined) return min;
	const max = Number(m[2]) * unit;
	if (max < min) throw new Error(`malformed delay "${spec}" (min > max)`);
	// one keyed draw (F7): reproducible per (seed, scenarioName, stepIndex),
	// never a shared cursor
	const draw = mulberry32(
		hashToInt(`${config.seed}|delay|${key.scenarioName}|${key.stepIndex}`),
	)();
	return min + Math.floor(draw * (max - min + 1));
}

export function resolveEmit(
	partial: EmitPartial,
	channel: Channel,
	config: Config,
	delayKey?: DelayKey,
): NormalizedMessage {
	let delayMs = partial.delayMs ?? 0;
	if (partial.delay !== undefined) {
		if (partial.delayMs !== undefined)
			throw new Error(
				"emit carries both delay and delayMs — resolve to one before the choke-point",
			);
		if (!delayKey)
			throw new Error(
				"a delay string requires a scenario delayKey (L2-only field)",
			);
		delayMs = parseDelay(partial.delay, config, delayKey);
	}
	return {
		topic: partial.topic,
		payload: partial.payload,
		qos: partial.qos ?? channel.qos ?? 1, // explicit wins, channel fills, spec default last (F13/CR7)
		retain: partial.retain ?? channel.retain ?? false,
		delayMs,
	};
}
