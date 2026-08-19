// R-017 — the composition root (F11): the ONE place broker, engine,
// validation, scenarios, and the control-plane HTTP layer meet. Lower-layer
// capabilities flow into control-plane by injection from here; control-plane
// itself imports none of those modules. `offbook up` (tier 4) calls this
// after resolving specs; tests and `offbook demo` call it directly.
import { createBroker, fingerprintLine } from "#src/broker/index.ts";
import type { ControlPlaneCaps } from "#src/control-plane/index.ts";
import { createServer } from "#src/control-plane/index.ts";
import { createDispatchRegistry } from "#src/engine/dispatch.ts";
import { l1Floor } from "#src/engine/faker.ts";
import { createEngine } from "#src/engine/index.ts";
import { resolveEmit } from "#src/engine/resolve-emit.ts";
import type {
	Config,
	InboundEvent,
	ServerIdentity,
	SpecInfo,
	SpecRegistry,
	StateEntry,
} from "#src/model/index.ts";
import type { ScenarioRuntime } from "#src/scenarios/index.ts";
import { createScenarioRuntime } from "#src/scenarios/index.ts";
import { classifyClientPublish } from "#src/validation/classify.ts";
import {
	specQualityDiagnostics,
	uninstantiatedDiagnostics,
} from "#src/validation/diagnostics.ts";
import { createValidationLog } from "#src/validation/index.ts";

export interface ComposeParts {
	config: Config;
	registry: SpecRegistry; // initial; POST /specs/refresh may swap it
	scenariosDir?: string; // L2 tree; omitted ⇒ no scenario layer
	handlersDir?: string; // L3 tree; omitted ⇒ no handlers loaded
	seedInstances?: Record<string, Record<string, string>[]>;
	specs?: SpecInfo[]; // provenance for GET /v1/specs
	specsWarnings?: string[]; // branch-mode notice (v1 always shows one)
	// re-resolve capability behind POST /v1/specs/refresh: returns the new
	// registry + SpecInfo[]; the root hot-swaps the thunk (F19 keeps L3
	// bindings and validation on the current channel set)
	resolveSpecs?: () => Promise<{ registry: SpecRegistry; specs: SpecInfo[] }>;
	server?: ServerIdentity; // R-044: serve.ts's identity; absent in-process
	log?: (line: string) => void;
}

export async function compose(parts: ComposeParts) {
	const { config } = parts;
	const log =
		parts.log ?? ((line: string) => console.error(`[offbook] ${line}`));
	let registry = parts.registry;
	let specs = parts.specs ?? [];
	let seed = config.seed;
	let lastResetBaseline = 0;

	const broker = createBroker(config);
	const vlog = createValidationLog(config);
	let runtime: ScenarioRuntime | undefined;
	const engine = createEngine({
		config,
		broker: { emit: (m) => broker.emit(m) },
		registry: () => registry,
		record: vlog.record,
		scenarios: () => runtime,
		seedInstances: parts.seedInstances,
		// each composed server owns its dispatch registry: the process-wide
		// defaultDispatch would share L3 handlers across every engine in the
		// process (the 2026-08-13 CI incident); loadHandlers routes handler-file
		// registrations here via the free register()'s active-loader slot
		dispatch: createDispatchRegistry(),
	});
	if (parts.scenariosDir !== undefined)
		runtime = createScenarioRuntime({
			config,
			dir: parts.scenariosDir,
			registry: () => registry,
			engine,
			log,
		});

	// R-040: config says "no initial state", the handler says otherwise — the
	// handler wins (L3 stays most-specific on every path); surface the
	// contradiction, never silently prefer either side. Pure over
	// (loaded handlers × current registry): re-run after every registry swap.
	const warnInitialStateContradictions = () => {
		for (const h of engine.handlers()) {
			if (!h.hasInitialState) continue;
			const flagged = registry
				.channels()
				.some(
					(c) =>
						c.topic === h.pattern &&
						c.direction === "toClient" &&
						c.initialState === false,
				);
			if (flagged)
				log(
					`channel '${h.pattern}' has initialState: false but handler '${h.modulePath}' defines initialState — the handler wins`,
				);
		}
	};

	// the ONE inbound pipeline (G9): classification (validation, never
	// blocking) + reactive dispatch — shared verbatim by real broker clients
	// and HTTP-injected publishes
	function inbound(event: InboundEvent): void {
		const violation = classifyClientPublish(registry, event);
		if (violation) vlog.record(violation);
		engine.onInbound(event);
	}
	broker.onInbound(inbound);
	broker.onSubscribe(({ topic }) => engine.onSubscribe(topic));
	// D-015: every connect/subscribe/publish fingerprint becomes a structured
	// log line (the R-007 capture surface) — offbook.log via serve.ts's sink
	broker.onFingerprint((event) => log(fingerprintLine(event)));

	const serverIdentity = parts.server;

	const caps: ControlPlaneCaps = {
		registry: () => registry,

		// one injected faker behind BOTH GET /topics examples and
		// POST /publish {example:true} — byte-equal by construction (CR1/F11)
		async example(channel, recordDrop) {
			const floor = await l1Floor(channel, engine.faker);
			if ("payload" in floor) return { payload: floor.payload };
			if (recordDrop) vlog.record(floor.violation);
			return { dropped: true };
		},

		validation: {
			query: vlog.query,
			summary: vlog.summary,
			baseline: vlog.baseline,
		},

		async injectInbound({ topic, payload, qos, retain }) {
			const m = registry.match(topic);
			// raw delivery first — validation never blocks it
			await broker.emit({
				topic,
				payload,
				qos: qos ?? m?.channel.qos ?? 1,
				retain: retain ?? m?.channel.retain ?? false,
				delayMs: undefined,
			});
			inbound({
				message: { topic, payload },
				meta: {
					clientId: config.injectedClientId,
					seq: 0, // engine re-stamps (contracts §1)
					receivedAt: Date.now(),
				},
			});
		},

		async emitMock({ topic, payload, qos, retain }) {
			const m = registry.match(topic);
			// materialization rule (ii), contracts §2: a mock emit binding
			// concrete params on a parametrized toClient channel records the
			// instance (also clears its 'uninstantiated' notice)
			if (m && Object.keys(m.params).length > 0)
				engine.instances.materialize(m.channel.topic, m.params);
			// the F13 choke-point: explicit wins, channel fills, spec default last
			const msg = m
				? resolveEmit({ topic, payload, qos, retain }, m.channel, config)
				: { topic, payload, qos: qos ?? 1, retain: retain ?? false };
			await broker.emit({ ...msg, delayMs: undefined });
			// observe-and-surface: an explicit off-spec payload EMITS and records
			// a mock violation (unlike generated payloads, which F5-drop)
			if (m) {
				const errors = m.channel.validate(payload);
				if (errors.length > 0)
					vlog.record({
						origin: "mock",
						kind: "schema",
						severity: "error",
						topic,
						channel: m.channel.topic,
						detail: `${errors[0]?.instancePath || "/"}: ${errors[0]?.keyword}`,
						payload,
						errors,
					});
			}
		},

		async state(): Promise<StateEntry[]> {
			const retained = await broker.getState();
			return [...retained.entries()]
				.map(([topic, m]) => ({
					topic,
					payload: m.payload,
					qos: m.qos,
					retain: true as const,
				}))
				.sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
		},

		pending: () => engine.pending(),

		async settle(capMs) {
			if (capMs === undefined) await engine.idle();
			else
				await Promise.race([
					engine.idle(),
					new Promise((r) => setTimeout(r, capMs)),
				]);
			return engine.pending();
		},

		trigger: (name, opts) =>
			runtime ? runtime.trigger(name, opts) : undefined,

		scenarios: () => runtime?.scenarios() ?? [],

		diagnostics: () => [
			...(runtime?.diagnostics() ?? []),
			...registry.diagnostics(),
			...specQualityDiagnostics(registry.channels()),
			...uninstantiatedDiagnostics(
				registry.channels(),
				engine.instances.snapshot(),
			),
		],

		specs: () => ({
			specs,
			warnings:
				parts.specsWarnings ??
				(specs.length > 0
					? [
							"requested versions in environments.yaml are recorded but NOT honored; fetching branch tips",
						]
					: []),
		}),

		async refreshSpecs() {
			if (!parts.resolveSpecs) return specs;
			const next = await parts.resolveSpecs();
			registry = next.registry; // hot-swap; F19 lazy dispatch survives it
			specs = next.specs;
			warnInitialStateContradictions(); // R-040: the flag set may have changed
			return specs;
		},

		reset(newSeed) {
			if (newSeed !== undefined) seed = newSeed;
			engine.reset(newSeed);
			runtime?.reset(newSeed);
			lastResetBaseline = vlog.baseline();
			return { seed };
		},

		mode: () => config.mode,

		setMode(mode) {
			// the one config field mutable outside reset (contracts §1a);
			// passive also freezes the scenario set (G24 — no hot-reload swaps
			// inside a CI window)
			config.mode = mode;
			if (mode === "passive") {
				engine.stopTicks();
				runtime?.stopWatch();
			} else {
				engine.startTicks();
				runtime?.watch();
			}
		},

		seed: () => seed,

		lastResetSeq: () => lastResetBaseline,

		server: serverIdentity === undefined ? undefined : () => serverIdentity,

		warn: (line) => log(line),
	};

	const app = createServer(config, caps);
	let httpServer: { stop(): void } | undefined;

	return {
		config,
		app,
		broker,
		engine,
		runtime,
		log: vlog,
		caps,
		registry: () => registry,
		// the most-recent reset's log baseline (`offbook check` reads since it)
		resetBaseline: () => lastResetBaseline,
		async start() {
			await broker.start();
			if (parts.handlersDir !== undefined)
				await engine.loadHandlers(parts.handlersDir);
			warnInitialStateContradictions();
			// strict mode: a scenario-load error aborts startup in the
			// foreground (l2 §7) — the throw propagates to the caller
			await runtime?.load();
			engine.start();
			engine.startTicks();
			// l2 §8 hot-reload: swaps definitions on file change, logging each
			// swap; self-gates to a no-op in passive (G24)
			runtime?.watch();
			httpServer = Bun.serve({
				port: config.controlPlanePort,
				fetch: app.fetch,
			});
		},
		async stop() {
			runtime?.stopWatch();
			engine.stopTicks();
			httpServer?.stop();
			await broker.stop();
		},
	};
}

export type Composed = Awaited<ReturnType<typeof compose>>;
