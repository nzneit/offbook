// R-016 — the L2 scenario runtime (l2 §3–§8): ordered first-match dispatch on
// the engine's reactive seam, seeded firing (cumulative ranged delays, the
// closed {{…}} vocabulary, L1 autofill), POST /trigger support, hot-reload
// (autonomous-only; swaps DEFINITIONS, never runtime state), strict/lenient
// load. Emissions go through engine.publish, so the F13 choke-point, the
// emit-time Ajv recheck, and G10 emitSource stamping all apply unchanged.
import { type FSWatcher, watch as fsWatch } from "node:fs";
import { hashToInt, mulberry32 } from "#src/engine/prng.ts";
import {
	type DelayKey,
	type EmitPartial,
	parseDelay,
} from "#src/engine/resolve-emit.ts";
import type {
	Config,
	Diagnostic,
	EmitSource,
	Faker,
	InboundEvent,
	ScenarioInfo,
	SpecRegistry,
} from "#src/model/index.ts";
import { fillRequired } from "./fill.ts";
import { type LoadedScenario, loadScenarios } from "./loader.ts";
import { matchTopic, payloadMatches, resolvePath } from "./matcher.ts";
import { OMIT, type TemplateRef, seededUuid, substitute } from "./template.ts";

// What the runtime needs back from the engine — structurally satisfied by
// Engine (engine/index.ts); the composition root wires the cycle via the
// engine's `scenarios` thunk.
export interface EngineHooks {
	publish(partial: EmitPartial, source: EmitSource, delayKey?: DelayKey): void;
	post(task: () => void | Promise<void>): void;
	now(): number;
	readonly faker: Faker;
}

export interface ScenarioRuntimeDeps {
	config: Config;
	dir: string; // the scenarios root (glob scenarios/**/*.yaml under it)
	registry: () => SpecRegistry;
	engine: EngineHooks;
	log?: (line: string) => void;
}

export interface ScenarioRuntime {
	// initial load; throws when config.strict and any scenario-load error
	// exists (fatal-at-startup — CI can't false-green, l2 §7)
	load(): Promise<void>;
	// re-glob → re-sort → re-validate → ATOMIC swap; definitions only —
	// counters and the virtual clock continue (l2 §8)
	reload(): Promise<void>;
	// dev-only affordance: false (and no watcher) in passive mode — passive
	// freezes the scenario set (G24)
	watch(): boolean;
	stopWatch(): void;
	// the engine's reactive L2 seam (L3 → L2 first-match-wins)
	onInbound(event: InboundEvent): Promise<void>;
	// POST /trigger/{name}: fires on the engine loop; undefined = unknown name
	trigger(
		name: string,
		opts?: { params?: Record<string, string>; payload?: unknown },
	): { name: string; stepCount: number } | undefined;
	scenarios(): ScenarioInfo[]; // GET /v1/scenarios projection, table order
	diagnostics(): Diagnostic[]; // scenario-load + overlap, for /diagnostics
	// re-seed helpers/delays + clear per-scenario counters; the composition
	// root calls this alongside engine.reset (contracts §5)
	reset(seed?: number): void;
}

interface Counters {
	seq: number;
	uuid: number;
}

export function createScenarioRuntime(
	deps: ScenarioRuntimeDeps,
): ScenarioRuntime {
	const { config, engine } = deps;
	const log =
		deps.log ?? ((line: string) => console.error(`[offbook] ${line}`));
	let table: LoadedScenario[] = [];
	let diags: Diagnostic[] = [];
	let seed = config.seed;
	// per-scenario {{seq}}/{{uuid}} counters (contracts §3 F7 category (ii)):
	// keyed by name OUTSIDE the table, so hot-reload swaps never touch them;
	// only reset() clears
	const counters = new Map<string, Counters>();
	let watcher: FSWatcher | undefined;
	let reloadTimer: ReturnType<typeof setTimeout> | undefined;

	function countersFor(name: string): Counters {
		let c = counters.get(name);
		if (!c) {
			c = { seq: 0, uuid: 0 };
			counters.set(name, c);
		}
		return c;
	}

	async function doLoad(): Promise<void> {
		const result = await loadScenarios(deps.dir, {
			registry: deps.registry(),
			faker: engine.faker,
			config: { ...config, seed },
		});
		if (config.strict) {
			const errs = result.diagnostics.filter((d) => d.severity === "error");
			if (errs.length > 0)
				throw new Error(
					`scenario load failed (strict): ${errs.length} error(s)\n${errs
						.map((d) => `  - [${d.source}] ${d.detail}`)
						.join("\n")}`,
				);
		}
		// atomic swap: the old table serves until the new one is fully built
		table = result.table;
		diags = result.diagnostics;
	}

	// One scenario firing — a single run-to-completion unit (G23): counter
	// advancement and keyed draws happen in walk order, awaits only on the
	// keyed L1 faker.
	async function fire(
		entry: LoadedScenario,
		boundParams: Record<string, string>,
		inboundPayload: unknown,
	): Promise<void> {
		const s = entry.scenario;
		const c = countersFor(s.name);
		const params: Record<string, string> = { ...boundParams };
		// a missing param is seed-faked deterministically (keyed draw, F7
		// category (i)) — the same value on every firing under one seed
		const paramValue = (name: string): string => {
			let v = params[name];
			if (v === undefined) {
				const rand = mulberry32(hashToInt(`${seed}|param|${s.name}|${name}`));
				v = `${name}-${Math.floor(rand() * 0x100000000)
					.toString(16)
					.padStart(8, "0")}`;
				params[name] = v;
			}
			return v;
		};

		let inbound = inboundPayload;
		let inboundDrawn = inbound !== undefined;
		const fireNow = engine.now();
		let cum = 0;
		for (let i = 0; i < s.then.length; i++) {
			const step = s.then[i];
			if (!step) continue;
			const { topic, payload, delay } = step.emit;
			// relative/cumulative multi-step timing (l2 §6): step i's absolute
			// offset = Σ delays 1..i, each a keyed draw — the runner pre-parses
			// (same parseDelay, same key) because the scheduler takes offsets
			// from schedule time, not from the previous emit
			if (delay !== undefined)
				cum += parseDelay(
					delay,
					{ ...config, seed },
					{ scenarioName: s.name, stepIndex: i },
				);
			// {{payload.*}} on a hand-fired scenario without a body: seed-fake
			// the inbound from the when-channel, once per firing (l2 §8)
			if (entry.stepUsesInbound[i] && !inboundDrawn) {
				inboundDrawn = true;
				if (entry.whenChannel) {
					try {
						inbound = await engine.faker(entry.whenChannel);
					} catch {
						// leave undefined: fields omit and the autofill/recheck surfaces
					}
				}
			}
			// {{now}} is the LOGICAL clock at this step's delivery (l2 §5): it
			// advances by the FULL seeded delay of each step even though the
			// default scheduler delivers on the next event-loop task
			const nowAt = fireNow + cum;
			const resolve = (ref: TemplateRef): unknown => {
				switch (ref.kind) {
					case "param":
						return paramValue(ref.name);
					case "payload":
						return resolvePath(inbound, ref.path);
					case "uuid":
						// run-seed advanced by the per-scenario counter — NOT keyed by
						// step, which would repeat the UUID every firing (l2 §5)
						return seededUuid(
							mulberry32(hashToInt(`${seed}|uuid|${s.name}|${c.uuid++}`)),
						);
					case "seq":
						return ++c.seq;
					case "now":
						return nowAt;
				}
			};
			const rawTopic = substitute(topic, resolve);
			const concreteTopic =
				typeof rawTopic === "string" ? rawTopic : String(topic);
			let outPayload = substitute(payload, resolve);
			if (outPayload === OMIT) outPayload = undefined;
			const m = deps.registry().match(concreteTopic);
			if (m) {
				let base: unknown;
				try {
					base = await engine.faker(
						m.channel,
						Object.keys(m.params).length > 0 ? m.params : undefined,
					);
				} catch {
					// F5: a rejecting faker leaves the gaps; the emit-time Ajv
					// recheck drops-and-surfaces, never silent
				}
				outPayload = fillRequired(outPayload, m.channel.schema, base);
			}
			// an unmatched topic still publishes: engine.publish surfaces the
			// mock unknown-topic violation AND delivers raw (observe-and-surface)
			engine.publish(
				{ topic: concreteTopic, payload: outPayload, delayMs: cum },
				{ layer: "L2", scenarioName: s.name, stepIndex: i },
			);
		}
	}

	// loud swap (l2 §8): surface what changed + any new errors on every reload
	async function reloadLoud(): Promise<void> {
		const before = new Set(table.map((e) => e.scenario.name));
		await doLoad();
		const after = table.map((e) => e.scenario.name);
		const added = after.filter((n) => !before.has(n)).length;
		const removed = [...before].filter((n) => !after.includes(n)).length;
		const errors = diags.filter((d) => d.severity === "error").length;
		log(
			`scenarios reloaded: ${after.length} loaded (+${added}/-${removed}), ${errors} load error(s)`,
		);
	}

	return {
		load: doLoad,

		reload: reloadLoud,

		watch() {
			// passive quiesces the scenario set (G24): loaded once at startup,
			// no watcher — the dispatch table is deterministic across a CI window
			if (config.mode === "passive") return false;
			if (watcher) return true;
			watcher = fsWatch(deps.dir, { recursive: true }, () => {
				if (reloadTimer) clearTimeout(reloadTimer);
				reloadTimer = setTimeout(() => {
					reloadLoud().catch((e: unknown) =>
						log(
							`scenario hot-reload failed: ${e instanceof Error ? e.message : e}`,
						),
					);
				}, 50);
			});
			return true;
		},

		stopWatch() {
			if (reloadTimer) clearTimeout(reloadTimer);
			reloadTimer = undefined;
			watcher?.close();
			watcher = undefined;
		},

		async onInbound(event) {
			// within L2, the FIRST matching scenario wins (l2 §2): walk the
			// sorted table top-to-bottom, topic + payloadMatch in one pass
			for (const entry of table) {
				const w = entry.scenario.when;
				if (!w) continue;
				const params = matchTopic(w.topic, event.message.topic);
				if (!params) continue;
				if (!payloadMatches(w.payloadMatch, event.message.payload)) continue;
				await fire(entry, params, event.message.payload);
				return;
			}
		},

		trigger(name, opts) {
			const entry = table.find((e) => e.scenario.name === name);
			if (!entry) return undefined;
			// fire as its own run-to-completion unit on the engine loop (G23)
			engine.post(() => fire(entry, opts?.params ?? {}, opts?.payload));
			return { name, stepCount: entry.scenario.then.length };
		},

		scenarios() {
			return table.map((e) => ({
				name: e.scenario.name,
				when: e.scenario.when?.topic,
				stepCount: e.scenario.then.length,
				source: e.source,
			}));
		},

		diagnostics: () => [...diags],

		reset(newSeed) {
			if (newSeed !== undefined) seed = newSeed;
			counters.clear();
		},
	};
}
