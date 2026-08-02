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
	InstanceRegistry,
	NormalizedMessage,
	SpecRegistry,
	Violation,
} from "#src/model/index.ts";
import { type DispatchRegistry, defaultDispatch } from "./dispatch.ts";
import { createFaker, l1Floor } from "./faker.ts";
import { createInstanceRegistry } from "./instances.ts";
import { hashToInt, mulberry32 } from "./prng.ts";
import {
	type DelayKey,
	type EmitPartial,
	resolveEmit,
} from "./resolve-emit.ts";
import { createScheduler } from "./scheduler.ts";

export type { DelayKey, EmitPartial };

export interface EngineDeps {
	config: Config;
	broker: { emit(message: NormalizedMessage): Promise<void> };
	registry: () => SpecRegistry;
	record: (v: Omit<Violation, "seq" | "observedAt">) => Violation;
	dispatch?: DispatchRegistry;
	// the L2 seam (R-016): a thunk like `registry` so the composition root can
	// wire the scenario runtime after the engine exists (it needs the engine's
	// publish/now/post/faker back); structural — engine/ never imports
	// scenarios/ (tier direction)
	scenarios?: () => L2Dispatch | undefined;
	// merged across services by the composition root: channel address → param-maps (F1, §2)
	seedInstances?: Record<string, Record<string, string>[]>;
}

export interface L2Dispatch {
	onInbound(event: InboundEvent): void | Promise<void>;
}

export interface Engine {
	loadHandlers(dir: string): Promise<string[]>;
	start(): void;
	onInbound(event: InboundEvent): void;
	onSubscribe(topic: string): void;
	tick(): void;
	startTicks(): void;
	stopTicks(): void;
	publish(partial: EmitPartial, source: EmitSource, delayKey?: DelayKey): void;
	// enqueue a run-to-completion task on the engine's single event loop (G23)
	// — the L2 trigger path posts its firing here so {{seq}}/{{uuid}} counter
	// advancement never interleaves with other dispatch units
	post(task: () => void | Promise<void>): void;
	faker: Faker;
	instances: InstanceRegistry;
	now(): number;
	pending(): { scheduled: number; settled: boolean };
	idle(): Promise<void>;
	reset(seed?: number): void;
}

const isWildcardFilter = (topic: string): boolean =>
	topic.split("/").some((level) => level === "+" || level === "#");

const isParametrized = (address: string): boolean => /\{[^}]+\}/.test(address);

const bindAddress = (address: string, params: Record<string, string>): string =>
	address.replace(/\{([^}]+)\}/g, (whole, name) => params[name] ?? whole);

export function createEngine(deps: EngineDeps): Engine {
	const { config, broker, registry, record } = deps;
	const dispatch = deps.dispatch ?? defaultDispatch;
	const scheduler = createScheduler(config);
	const instances = createInstanceRegistry();
	let seed = config.seed;
	let faker = createFaker(config);
	let tickIndex = 0;
	let inboundSeq = 0;

	function stampViolation(
		v: Omit<Violation, "seq" | "observedAt" | "emitSource">,
		source: EmitSource,
	): void {
		record({ ...v, emitSource: source });
	}

	// the one emit path — everything mock passes through here (G10/F5/F13)
	function publish(
		partial: EmitPartial,
		source: EmitSource,
		delayKey?: DelayKey,
	): void {
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
		// materialization rule (ii): any mock emit that binds concrete params on a
		// parametrized toClient channel records the instance — this is how a
		// fromClient command's reactive state publish lands in the ledger (§2/F1)
		if (channel.direction === "toClient" && Object.keys(m.params).length > 0)
			instances.materialize(channel.topic, m.params);
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
						// Stryker disable next-line OptionalChaining,StringLiteral: errors[0] is defined under the length > 0 guard (the ?. exists for noUncheckedIndexedAccess), and the ?? "unknown" fallback literal is unreachable because Ajv errors always carry a keyword; the detail format itself is pinned exactly by tests
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

	// The one initial-state task (§2/G3): record the instance in the ledger when
	// the concrete topic binds params, then publish via L3 initialState if
	// registered, else the L1 floor. Used by concrete subscribes, startup
	// (eager + seedInstances), and the reset republish — same keyed draws
	// everywhere, so every path replays byte-identically under one seed (F7).
	function materializeAndPublish(topic: string): void {
		scheduler.post(async () => {
			const reg = registry();
			const m = reg.match(topic);
			// initial state is a toClient concept — a subscribe on a fromClient
			// channel gets nothing from the mock
			if (m?.channel.direction !== "toClient") return;
			if (Object.keys(m.params).length > 0)
				instances.materialize(m.channel.topic, m.params);
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
			// R-040: a reactive-only channel declares it has no initial state
			// (topicOverrides initialState: false) — the floor is off on every leg
			// through this function; the ledger record above, L3 initialState
			// handlers, and all L2/L3 emissions stay untouched
			if (m.channel.initialState === false) return;
			// L1 is the proactive floor: keyed per instance params (F7)
			const out = await l1Floor(m.channel, (ch) => faker(ch, m.params));
			if ("violation" in out) {
				record(out.violation); // already L1-stamped by l1Floor
				return; // floor stays empty on failure (F5, D-008)
			}
			// Stryker disable next-line ObjectLiteral,StringLiteral: the floor payload was already Ajv-rechecked by l1Floor with the same validate, so this source stamp can only surface via a violation that is unreachable here; the emission shape itself is pinned by the floor-path tests
			publish({ topic, payload: out.payload }, { layer: "L1" });
		});
	}

	// Initial-state sweep (§2): eager non-parametrized toClient channels first
	// (spec-derived each time, never ledger entries), then the ledger's recorded
	// set in materialization order — deterministic for a fixed script.
	function republishInitialState(): void {
		for (const ch of registry().channels()) {
			// Stryker disable next-line ConditionalExpression: the direction half is masked, materializeAndPublish re-checks direction and returns for non-toClient channels; the parametrization half and the whole condition are pinned by the start() tests
			if (ch.direction === "toClient" && !isParametrized(ch.topic))
				materializeAndPublish(ch.topic);
		}
		for (const inst of instances.snapshot().instances)
			materializeAndPublish(bindAddress(inst.channelAddress, inst.params));
	}

	return {
		async loadHandlers(dir) {
			const paths = await dispatch.loadHandlers(dir);
			dispatch.instantiate();
			return paths;
		},

		start() {
			// seedInstances pre-materializes the deterministic demo set (§2/F1);
			// an entry that doesn't resolve to a toClient channel instance is
			// surfaced loudly, never skipped silent (tier-3 /diagnostics adds the
			// config-lint view, R-017)
			const reg = registry();
			for (const [address, paramList] of Object.entries(
				deps.seedInstances ?? {},
			)) {
				for (const params of paramList) {
					const topic = bindAddress(address, params);
					const m = isWildcardFilter(topic) ? undefined : reg.match(topic);
					if (m?.channel.direction !== "toClient") {
						stampViolation(
							{
								origin: "mock",
								kind: "unknown-topic",
								severity: "error",
								topic,
								detail: `seedInstances: '${address}' with ${JSON.stringify(params)} does not resolve to a toClient channel instance`,
							},
							{ layer: "L1" },
						);
						continue;
					}
					if (Object.keys(m.params).length > 0)
						instances.materialize(m.channel.topic, m.params);
				}
			}
			republishInitialState();
		},

		onInbound(event) {
			// meta.seq is engine-owned (contracts §1): re-stamp at arrival so the
			// counter is reset-scoped and replay survives broker-side seq drift
			const stamped: InboundEvent = {
				...event,
				meta: { ...event.meta, seq: ++inboundSeq },
			};
			scheduler.post(async () => {
				const sel = dispatch.select(stamped.message.topic, registry());
				// L3 → L2 first-match-wins, no L1 on the reactive path (contracts §3
				// trigger table). A registered L3 handler owns the WHOLE topic and
				// shadows L2 even without an onInbound hook (l2 §0: real logic means
				// handing the topic to L3). The await keeps the L2 firing inside
				// this run-to-completion unit (G23/D-003).
				if (sel) {
					sel.handler.onInbound?.(
						stamped,
						makeCtx(
							`inbound|${stamped.meta.seq}|${sel.registration.modulePath}|${sel.registration.order}`,
						),
					);
					return;
				}
				await deps.scenarios?.()?.onInbound(stamped);
			});
		},

		onSubscribe(topic) {
			// a wildcard subscribe never invents params (§2/F6): replay is Aedes'
			// native retained delivery from its own store (R3), not engine work
			if (isWildcardFilter(topic)) return;
			materializeAndPublish(topic);
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

		post: (task) => scheduler.post(task),

		get faker() {
			return faker;
		},

		instances,

		now: () => scheduler.now(),
		pending: () => scheduler.pending(),
		idle: () => scheduler.idle(),

		reset(newSeed) {
			const snap = instances.snapshot(); // captured at reset (§2)
			scheduler.reset();
			if (newSeed !== undefined) seed = newSeed;
			faker = createFaker({ ...config, seed });
			tickIndex = 0;
			inboundSeq = 0;
			dispatch.instantiate(); // fresh L3 instances — factories, not reused state
			// the materialization half (§2/§5): restore EXACTLY the recorded set —
			// seed instances + those materialized since — then republish its initial
			// state re-seeded, so post-reset /state is deterministic by construction
			instances.restore(snap);
			republishInitialState();
		},
	};
}
