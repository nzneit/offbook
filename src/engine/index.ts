// The engine composition (contracts §3): trigger paths (reactive L3→[L2 seam],
// proactive L3→L1, tick L3), the emit path (resolveEmit → pre-emit Ajv recheck
// → drop-and-surface F5 / broker.emit), and G10 emitSource stamping. The
// broker arrives as a structural {emit} — engine/ never imports broker/
// (transport isolation); the registry arrives as a thunk (F19 hot-swap); the
// validation log arrives as a record function (composition-root seam, F11).
import type {
	Config,
	EmitSource,
	Faker,
	InboundEvent,
	NormalizedMessage,
	SpecRegistry,
	Violation,
} from "../model/index.ts";
import { type DispatchRegistry, defaultDispatch } from "./dispatch.ts";
import { createFaker, l1Floor } from "./faker.ts";
import { hashToInt, mulberry32 } from "./prng.ts";
import { type DelayKey, type EmitPartial, resolveEmit } from "./resolve-emit.ts";
import { createScheduler } from "./scheduler.ts";

export type { DelayKey, EmitPartial };

export interface EngineDeps {
	config: Config;
	broker: { emit(message: NormalizedMessage): Promise<void> };
	registry: () => SpecRegistry;
	record: (v: Omit<Violation, "seq" | "observedAt">) => Violation;
	dispatch?: DispatchRegistry;
}

export interface Engine {
	loadHandlers(dir: string): Promise<string[]>;
	onInbound(event: InboundEvent): void;
	onSubscribe(topic: string): void;
	tick(): void;
	startTicks(): void;
	stopTicks(): void;
	publish(partial: EmitPartial, source: EmitSource, delayKey?: DelayKey): void;
	faker: Faker;
	now(): number;
	pending(): { scheduled: number; settled: boolean };
	idle(): Promise<void>;
	reset(seed?: number): void;
}

export function createEngine(deps: EngineDeps): Engine {
	const { config, broker, registry, record } = deps;
	const dispatch = deps.dispatch ?? defaultDispatch;
	const scheduler = createScheduler(config);
	let seed = config.seed;
	let faker = createFaker(config);
	let tickIndex = 0;

	function stampViolation(
		v: Omit<Violation, "seq" | "observedAt" | "emitSource">,
		source: EmitSource,
	): void {
		record({ ...v, emitSource: source });
	}

	// the one emit path — everything mock passes through here (G10/F5/F13)
	function publish(partial: EmitPartial, source: EmitSource, delayKey?: DelayKey): void {
		const m = registry().match(partial.topic);
		if (!m) {
			// surfaced loudly AND still delivered — observe-and-surface applies to
			// mock traffic symmetrically; defaults qos 1 / retain false (no channel
			// to resolve against)
			stampViolation(
				{
					origin: "mock",
					kind: "unknown-topic",
					severity: "error",
					topic: partial.topic,
					detail: "unknown-topic: mock emit matches no channel",
					payload: partial.payload,
				},
				source,
			);
			scheduler.scheduleEmit(partial.delayMs ?? 0, async () => {
				await broker.emit({
					topic: partial.topic,
					payload: partial.payload,
					qos: partial.qos ?? 1,
					retain: partial.retain ?? false,
					delayMs: undefined,
				});
			});
			return;
		}
		const channel = m.channel;
		const msg = resolveEmit(partial, channel, { ...config, seed }, delayKey);
		scheduler.scheduleEmit(msg.delayMs ?? 0, async () => {
			const errors = channel.validate(msg.payload);
			if (errors.length > 0) {
				// F5 drop-and-surface; no keyed re-draw (D-008)
				const first = errors[0];
				stampViolation(
					{
						origin: "mock",
						kind: "schema",
						severity: "error",
						topic: msg.topic,
						channel: channel.topic,
						detail: `${first?.instancePath || "/"}: ${first?.keyword ?? "unknown"}`,
						payload: msg.payload,
						errors,
					},
					source,
				);
				return;
			}
			await broker.emit({ ...msg, delayMs: undefined });
		});
	}

	function makeCtx(invocationKey: string) {
		const rand = mulberry32(hashToInt(`${seed}|ctx|${invocationKey}`));
		return {
			publish: (msg: Partial<NormalizedMessage> & { topic: string }) =>
				publish(msg, { layer: "L3" as const }),
			random: () => rand(),
			now: () => scheduler.now(),
		};
	}

	function dispatchTick(): void {
		const idx = tickIndex++;
		for (const { handler, registration } of dispatch.all()) {
			handler.tick?.(
				makeCtx(`tick|${idx}|${registration.modulePath}|${registration.order}`),
			);
		}
	}

	return {
		async loadHandlers(dir) {
			const paths = await dispatch.loadHandlers(dir);
			dispatch.instantiate();
			return paths;
		},

		onInbound(event) {
			scheduler.post(() => {
				const sel = dispatch.select(event.message.topic, registry());
				// L3 → [L2 seam: the scenario runner slots in here, R-016] ; no L1 on
				// the reactive path (contracts §3 trigger table)
				sel?.handler.onInbound?.(
					event,
					makeCtx(
						`inbound|${event.meta.seq}|${sel.registration.modulePath}|${sel.registration.order}`,
					),
				);
			});
		},

		onSubscribe(topic) {
			scheduler.post(async () => {
				const reg = registry();
				const m = reg.match(topic);
				if (!m) return;
				const sel = dispatch.select(topic, reg);
				if (sel?.handler.initialState) {
					sel.handler.initialState(
						topic,
						makeCtx(
							`subscribe|${topic}|${sel.registration.modulePath}|${sel.registration.order}`,
						),
					);
					return;
				}
				// L1 is the proactive floor: keyed per instance params (F7)
				const out = await l1Floor(m.channel, (ch) => faker(ch, m.params));
				if ("violation" in out) {
					record(out.violation); // already L1-stamped by l1Floor
					return; // floor stays empty on failure (F5, D-008)
				}
				publish({ topic, payload: out.payload }, { layer: "L1" });
			});
		},

		tick() {
			if (config.mode === "passive") return; // F10: passive fires no ticks
			scheduler.advanceTick(dispatchTick);
		},

		startTicks() {
			if (config.mode === "passive" || !config.wallClock) return;
			scheduler.startWallTicks(dispatchTick);
		},

		stopTicks: () => scheduler.stopTicks(),

		publish,

		get faker() {
			return faker;
		},

		now: () => scheduler.now(),
		pending: () => scheduler.pending(),
		idle: () => scheduler.idle(),

		reset(newSeed) {
			scheduler.reset();
			if (newSeed !== undefined) seed = newSeed;
			faker = createFaker({ ...config, seed });
			tickIndex = 0;
			dispatch.instantiate(); // fresh L3 instances — factories, not reused state
		},
	};
}
