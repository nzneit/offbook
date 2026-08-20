// R-017 — the control-plane HTTP layer (contracts §5): every /v1/* endpoint,
// the closed-union error envelope, JSON-only, localhost dev appliance.
// Actions return promptly after INJECTING (202 = injected, never drained);
// GET /pending?wait is the explicit settle step.
//
// F11: this module receives every lower-layer capability (faker-backed
// example generation, state read, validation query, scenario trigger, emit,
// reset, mode) BY INJECTION from the composition root (src/compose/). It
// imports hono and model types ONLY — never engine/, broker/, validation/,
// or scenarios/ modules.
import { Hono } from "hono";
import type {
	Channel,
	Config,
	Diagnostic,
	DiagnosticSummary,
	ErrorCode,
	ScenarioInfo,
	ServerIdentity,
	SpecInfo,
	SpecRegistry,
	StateEntry,
	TopicInfo,
	ValidationSummary,
	Violation,
} from "#src/model/index.ts";

// Example generation through the L1 floor (F5): a schema-invalid draw or a
// rejecting faker yields { dropped } instead of an invalid payload.
export type ExampleFn = (
	channel: Channel,
	recordDrop: boolean,
) => Promise<{ payload: unknown } | { dropped: true }>;

export interface ControlPlaneCaps {
	registry(): SpecRegistry;
	example: ExampleFn;
	validation: {
		query(opts: {
			sinceSeq?: number;
			origin?: "client" | "mock";
			kind?: Violation["kind"];
			severity?: "error" | "warning";
		}): Violation[];
		summary(): ValidationSummary;
		baseline(): number;
	};
	// G9: a fromClient/unknown-topic publish re-enters the SAME inbound path
	// the broker uses for real client publishes (raw delivery + classification
	// + reactive dispatch), tagged origin 'client'
	injectInbound(msg: {
		topic: string;
		payload: unknown;
		qos?: 0 | 1 | 2;
		retain?: boolean;
	}): Promise<void>;
	// a matched toClient publish is a mock emission through the resolveEmit
	// choke-point (F13) — delivered even off-spec (observe-and-surface)
	emitMock(msg: {
		topic: string;
		payload: unknown;
		qos?: 0 | 1 | 2;
		retain?: boolean;
	}): Promise<void>;
	state(): Promise<StateEntry[]>;
	pending(): { scheduled: number; settled: boolean };
	settle(capMs?: number): Promise<{ scheduled: number; settled: boolean }>;
	trigger(
		name: string,
		opts?: { params?: Record<string, string>; payload?: unknown },
	): { name: string; stepCount: number } | undefined;
	scenarios(): ScenarioInfo[];
	diagnostics(): Diagnostic[];
	specs(): { specs: SpecInfo[]; warnings?: string[] };
	refreshSpecs(): Promise<SpecInfo[]>;
	reset(seed?: number): { seed: number };
	mode(): Config["mode"];
	setMode(mode: Config["mode"]): void;
	seed(): number;
	// the most-recent reset's violation-log baseline (0 before the first) —
	// offbook check's default window (P8, D-014)
	lastResetSeq(): number;
	// the §4 tier-3 divergence warn-log sink (off-spec never silent)
	warn(line: string): void;
	// R-044/D-032 — the /v1/server identity read; absent (undefined) on
	// identity-less boots (in-process tests, `offbook demo` one-shot): the
	// route then 404s plainly, which a prober reads as not-a-candidate
	server?: () => ServerIdentity;
}

function envelope(code: ErrorCode, message: string, details?: unknown) {
	return {
		error: { code, message, ...(details === undefined ? {} : { details }) },
	};
}

// D-003: the injected example fn is async — sequential for-of, never
// Promise.all, so draws stay in channel order.
export async function buildTopicInfo(
	registry: SpecRegistry,
	example: ExampleFn,
	filter?: { direction?: string; service?: string },
): Promise<TopicInfo[]> {
	const infos: TopicInfo[] = [];
	for (const c of registry.channels()) {
		if (filter?.direction && c.direction !== filter.direction) continue;
		if (filter?.service && c.service !== filter.service) continue;
		const floor = await example(c, false);
		infos.push({
			topic: c.topic,
			direction: c.direction,
			service: c.service,
			title: c.title,
			description: c.description,
			schema: c.schema,
			example: "payload" in floor ? floor.payload : undefined,
			qos: c.qos,
			retain: c.retain,
			// R-040: only-when-suppressed — undefined serializes as absent
			initialState: c.initialState === false ? (false as const) : undefined,
		});
	}
	return infos;
}

// F15: mirrors ValidationSummary; all four kinds always present, zero-filled.
export function diagnosticSummary(diags: Diagnostic[]): DiagnosticSummary {
	const summary: DiagnosticSummary = {
		errors: 0,
		warnings: 0,
		info: 0,
		byKind: {
			"scenario-load": 0,
			overlap: 0,
			"spec-load": 0,
			uninstantiated: 0,
		},
	};
	for (const d of diags) {
		summary.byKind[d.kind]++;
		if (d.severity === "error") summary.errors++;
		else if (d.severity === "warning") summary.warnings++;
		else summary.info++;
	}
	return summary;
}

// `_config` is unused today. Kept (underscored) rather than dropped because
// removing it changes an exported function's arity, which is a refactor and not
// part of a dependency bump — biome 2's noUnusedFunctionParameters is what
// surfaced it (D-023).
export function createServer(_config: Config, caps: ControlPlaneCaps) {
	const app = new Hono();

	// --- reads ---

	app.get("/v1/topics", async (c) => {
		const topics = await buildTopicInfo(caps.registry(), caps.example, {
			direction: c.req.query("direction"),
			service: c.req.query("service"),
		});
		// ?schema=false — the slim discovery view drops the bulky `schema`
		// field ONLY (keeps example + all else)
		if (c.req.query("schema") === "false")
			return c.json({
				topics: topics.map(({ schema: _schema, ...rest }) => rest),
			});
		return c.json({ topics });
	});

	app.get("/v1/state", async (c) => {
		const prefix = c.req.query("topic");
		const state = (await caps.state()).filter(
			(e) => prefix === undefined || e.topic.startsWith(prefix),
		);
		return c.json({ state });
	});

	app.get("/v1/validation", (c) => {
		const sinceSeq = c.req.query("sinceSeq");
		const violations = caps.validation.query({
			sinceSeq: sinceSeq === undefined ? undefined : Number(sinceSeq),
			origin: c.req.query("origin") as "client" | "mock" | undefined,
			kind: c.req.query("kind") as Violation["kind"] | undefined,
			severity: c.req.query("severity") as "error" | "warning" | undefined,
		});
		return c.json({ violations, summary: caps.validation.summary() });
	});

	app.get("/v1/specs", (c) => {
		const { specs, warnings } = caps.specs();
		// v1 is always branch mode, so the version-not-honored notice always
		// shows (EQ2; pinned/--frozen is v2)
		return c.json({ specs, resolutionMode: "branch", warnings });
	});

	app.get("/v1/diagnostics", (c) => {
		const diagnostics = caps.diagnostics();
		return c.json({ diagnostics, summary: diagnosticSummary(diagnostics) });
	});

	app.get("/v1/scenarios", (c) => c.json({ scenarios: caps.scenarios() }));

	app.get("/v1/mode", (c) =>
		c.json({
			mode: caps.mode(),
			seed: caps.seed(),
			lastResetSeq: caps.lastResetSeq(),
		}),
	);

	app.get("/v1/server", (c) =>
		caps.server === undefined ? c.notFound() : c.json(caps.server()),
	);

	app.get("/v1/pending", async (c) => {
		const wait = c.req.query("wait");
		if (wait === undefined) return c.json(caps.pending());
		// ?wait blocks server-side until scheduled === 0 (EC1); ?wait=<ms>
		// caps the wait — settled reports whether it reached 0 or hit the cap
		const capMs = wait === "" ? undefined : Number(wait);
		return c.json(
			await caps.settle(Number.isFinite(capMs) ? capMs : undefined),
		);
	});

	// --- actions (202 = injected, never drained) ---

	app.post("/v1/publish", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			topic?: string;
			payload?: unknown;
			example?: boolean;
			qos?: 0 | 1 | 2;
			retain?: boolean;
		};
		if (!body.topic)
			return c.json(envelope("bad-request", "topic is required"), 400);
		if (body.payload !== undefined && body.example)
			return c.json(
				envelope("example-and-payload", "provide payload XOR example"),
				400,
			);

		const sinceSeq = caps.validation.baseline();
		const m = caps.registry().match(body.topic);
		let payload: unknown;
		if (body.example) {
			if (!m)
				return c.json(
					envelope(
						"example-on-unknown-topic",
						"cannot generate an example for an unknown topic",
					),
					400,
				);
			const floor = await caps.example(m.channel, true);
			if ("dropped" in floor) {
				// F5 drop-and-surface: the mock declines to emit the invalid
				// payload; the sole case where matched pairs with injected:false
				return c.json(
					{
						topic: body.topic,
						direction: m.channel.direction,
						matched: true,
						injected: false,
						sinceSeq,
					},
					202,
				);
			}
			payload = floor.payload;
		} else {
			payload = body.payload;
		}

		// tier-3 divergence warn-log: an explicit qos/retain differing from the
		// channel binding is an intentional off-spec emit — never silent
		if (m) {
			const boundQos = m.channel.qos ?? 1;
			const boundRetain = m.channel.retain ?? false;
			if (body.qos !== undefined && body.qos !== boundQos)
				caps.warn(
					`/publish qos=${body.qos} overrides channel '${m.channel.topic}' binding qos=${boundQos} — off-spec emit`,
				);
			if (body.retain !== undefined && body.retain !== boundRetain)
				caps.warn(
					`/publish retain=${body.retain} overrides channel '${m.channel.topic}' binding retain=${boundRetain} — off-spec emit`,
				);
		}

		const msg = {
			topic: body.topic,
			payload,
			qos: body.qos,
			retain: body.retain,
		};
		if (m && m.channel.direction === "toClient") await caps.emitMock(msg);
		else await caps.injectInbound(msg); // fromClient or unknown → client re-entry (G9)

		return c.json(
			{
				topic: body.topic,
				direction: m ? m.channel.direction : null,
				matched: !!m,
				injected: true,
				sinceSeq,
			},
			202,
		);
	});

	app.post("/v1/trigger/:name", async (c) => {
		const name = c.req.param("name");
		const body = (await c.req.json().catch(() => ({}))) as {
			params?: Record<string, string>;
			payload?: unknown;
		};
		const sinceSeq = caps.validation.baseline();
		const fired = caps.trigger(name, {
			params: body.params,
			payload: body.payload,
		});
		if (!fired)
			return c.json(
				envelope("unknown-scenario", `no scenario named '${name}'`),
				404,
			);
		return c.json({ scenario: name, fired: true, sinceSeq }, 202);
	});

	app.post("/v1/reset", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { seed?: number };
		if (body.seed !== undefined && typeof body.seed !== "number")
			return c.json(envelope("bad-request", "seed must be a number"), 400);
		const sinceSeq = caps.validation.baseline();
		const { seed } = caps.reset(body.seed);
		return c.json({ reset: true, seed, sinceSeq });
	});

	app.post("/v1/mode", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { mode?: string };
		if (body.mode !== "autonomous" && body.mode !== "passive")
			return c.json(
				envelope("bad-request", "mode must be 'autonomous' or 'passive'"),
				400,
			);
		caps.setMode(body.mode);
		return c.json({ mode: caps.mode(), seed: caps.seed() });
	});

	app.post("/v1/specs/refresh", async (c) =>
		c.json({ specs: await caps.refreshSpecs() }),
	);

	return app;
}

export type ControlPlaneApp = ReturnType<typeof createServer>;
