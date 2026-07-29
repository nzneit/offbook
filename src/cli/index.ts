// R-019 — the CLI dispatch backbone (build-plan tier 4): a thin client over
// the /v1 HTTP API. Read/action verbs resolve the control-plane port
// (--ctrl-port, else the runfile of a live offbook) and render the response;
// up/down/logs/status are process management over the G14 runfile
// (contracts §5) — never HTTP. `demo` and the no-server `topics` fallback
// boot/read the bundled demo spec locally (M0's zero-config discovery floor).
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compose } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import type { ExampleFn } from "#src/control-plane/index.ts";
import { buildTopicInfo } from "#src/control-plane/index.ts";
import { createFaker, l1Floor } from "#src/engine/faker.ts";
import type {
	Config,
	Diagnostic,
	DiagnosticSummary,
	ScenarioInfo,
	SpecInfo,
	StateEntry,
	TopicInfo,
	ValidationSummary,
	Violation,
} from "#src/model/index.ts";
import { DEFAULT_CONFIG } from "#src/model/index.ts";
import { buildRegistry } from "#src/registry/index.ts";
import type { Api } from "./client.ts";
import { CliError, api, resolveCtrlPort } from "./client.ts";
import {
	clearRunfile,
	logPath,
	pidAlive,
	probeOffbook,
	readRunfile,
	resolveRunning,
	writeRunfile,
} from "./runfile.ts";

const DEMO_SPEC = `${import.meta.dir}/../demo/thermostat.yaml`;

export interface Io {
	out(line: string): void;
	err(line: string): void;
}

const consoleIo: Io = {
	out: (l) => console.log(l),
	err: (l) => console.error(l),
};

// --- small shared helpers ---

type FlagValues = Record<string, string | boolean | string[] | undefined>;
type FlagSpec = Record<
	string,
	{ type: "string" | "boolean"; multiple?: true; short?: string }
>;

const COMMON: FlagSpec = {
	"run-dir": { type: "string" },
	"ctrl-port": { type: "string" },
};

function parseFlags(
	args: string[],
	options: FlagSpec,
): { values: FlagValues; positionals: string[] } {
	try {
		// parseArgs types multiples as (string | boolean)[]; ours are all string
		return parseArgs({
			args,
			options,
			allowPositionals: true,
			strict: true,
		}) as unknown as { values: FlagValues; positionals: string[] };
	} catch (cause) {
		throw new CliError((cause as Error).message);
	}
}

const str = (v: string | boolean | string[] | undefined): string | undefined =>
	typeof v === "string" ? v : undefined;

function toInt(value: string, flag: string): number {
	const n = Number(value);
	if (!Number.isInteger(n))
		throw new CliError(`${flag}: not an integer: '${value}'`);
	return n;
}

function parseJson(value: string, flag: string): unknown {
	try {
		return JSON.parse(value);
	} catch (cause) {
		throw new CliError(`${flag}: invalid JSON (${(cause as Error).message})`);
	}
}

const runDirOf = (values: FlagValues): string =>
	str(values["run-dir"]) ?? DEFAULT_CONFIG.runDir;

async function clientFor(values: FlagValues): Promise<Api> {
	return api(await resolveCtrlPort(runDirOf(values), str(values["ctrl-port"])));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const glyph = (severity: string): string =>
	severity === "error" ? "✗" : severity === "warning" ? "⚠" : "ℹ";

const shortHash = (h: string): string => h.replace(/^sha256:/, "").slice(0, 8);

// P2: spec age shows NEUTRALLY (no stale threshold) — the dev weighs it.
function specAge(fetchedAt: string, now = Date.now()): string {
	const ms = now - Date.parse(fetchedAt);
	if (!Number.isFinite(ms) || ms < 0) return "";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function phraseDirection(d: TopicInfo["direction"]): string {
	return d === "toClient" ? "client receives" : "client sends";
}

// --- topics (server-backed, with the M0 zero-config demo-spec fallback) ---

async function demoTopicInfo(): Promise<TopicInfo[]> {
	const config = loadConfig();
	const specText = await Bun.file(DEMO_SPEC).text();
	const registry = await buildRegistry({ specText, service: "demo", config });
	// the CLI composes its own example capability (F11 constrains the
	// control-plane module, not the CLI)
	const faker = createFaker(config);
	const example: ExampleFn = async (channel) => {
		const floor = await l1Floor(channel, faker);
		return "payload" in floor ? { payload: floor.payload } : { dropped: true };
	};
	return buildTopicInfo(registry, example);
}

// ER1: the human topics view renders FIELDS, never a raw JSON-Schema
// fragment — allOf flattens into one field list, oneOf/anyOf are marked as
// variants (a `grep '"type":'` over the default output finds nothing).
interface SchemaNode {
	type?: string;
	properties?: Record<string, SchemaNode>;
	required?: string[];
	allOf?: SchemaNode[];
	oneOf?: SchemaNode[];
	anyOf?: SchemaNode[];
	enum?: unknown[];
	items?: SchemaNode;
}

function mergeAllOf(s: SchemaNode): SchemaNode {
	if (!s.allOf) return s;
	const properties = { ...(s.properties ?? {}) };
	const required = new Set(s.required ?? []);
	for (const branch of s.allOf) {
		const b = mergeAllOf(branch);
		Object.assign(properties, b.properties ?? {});
		for (const r of b.required ?? []) required.add(r);
	}
	return { ...s, allOf: undefined, properties, required: [...required] };
}

function typeLabel(def: SchemaNode): string {
	if (def.enum) return `enum(${def.enum.map((v) => String(v)).join("|")})`;
	if (def.type === "array")
		return `array<${def.items ? typeLabel(def.items) : "any"}>`;
	if (def.type) return def.type;
	if (def.allOf) return typeLabel(mergeAllOf(def));
	if (def.oneOf) return `one of ${def.oneOf.length} variants`;
	if (def.anyOf) return `any of ${def.anyOf.length} variants`;
	return "any";
}

function fieldRowLines(s: SchemaNode, indent: string): string[] {
	if (!s.properties) return [];
	return Object.entries(s.properties).map(
		([name, def]) =>
			`${indent}- ${name}${s.required?.includes(name) ? " (required)" : ""}: ${typeLabel(def)}`,
	);
}

function fieldLines(schema: object, indent = "      "): string[] {
	const s = mergeAllOf(schema as SchemaNode);
	const lines = fieldRowLines(s, indent);
	const variants = s.oneOf
		? { mark: "one of", branches: s.oneOf }
		: s.anyOf
			? { mark: "any of", branches: s.anyOf }
			: undefined;
	if (variants) {
		lines.push(
			`${indent}${variants.mark} ${variants.branches.length} variant(s):`,
		);
		variants.branches.forEach((branch, i) => {
			lines.push(`${indent}  variant ${i + 1}:`);
			lines.push(...fieldRowLines(mergeAllOf(branch), `${indent}    `));
		});
	}
	return lines;
}

export interface TopicRenderOpts {
	compact?: boolean;
	examples?: boolean; // default true; --no-examples clears it
	schema?: boolean; // opt-in raw JSON-Schema block
}

export function renderTopicList(
	topics: TopicInfo[],
	opts: TopicRenderOpts = {},
): string {
	if (opts.compact)
		return topics
			.map((t) => `${t.topic}  [${phraseDirection(t.direction)}]  ${t.service}`)
			.join("\n");
	return topics
		.map((t) => {
			const lines = [`${t.topic}  [${phraseDirection(t.direction)}]`];
			lines.push(...fieldLines(t.schema));
			if (opts.examples !== false && t.example !== undefined)
				lines.push(`    example: ${JSON.stringify(t.example)}`);
			if (opts.schema) lines.push(`    schema: ${JSON.stringify(t.schema)}`);
			return lines.join("\n");
		})
		.join("\n\n");
}

// M0 gate ii: the zero-config discovery floor over the bundled demo spec.
export async function renderTopics(argv: string[]): Promise<string> {
	const topics = await demoTopicInfo();
	if (argv.includes("--json")) return JSON.stringify(topics, null, 2);
	return renderTopicList(topics);
}

async function cmdTopics(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		...COMMON,
		json: { type: "boolean" },
		compact: { type: "boolean" },
		"no-examples": { type: "boolean" },
		schema: { type: "boolean" },
		receives: { type: "boolean" },
		sends: { type: "boolean" },
	});
	if (values.receives && values.sends)
		throw new CliError("topics: --receives and --sends are mutually exclusive");
	const direction = values.receives
		? "toClient"
		: values.sends
			? "fromClient"
			: undefined;
	const query = direction ? `?direction=${direction}` : "";
	let topics: TopicInfo[];
	let note: string | undefined;
	if (values["ctrl-port"] !== undefined) {
		const a = await clientFor(values);
		topics = ((await a.get(`/v1/topics${query}`)) as { topics: TopicInfo[] })
			.topics;
	} else {
		const running = await resolveRunning(runDirOf(values));
		if (running?.live) {
			const a = api(running.run.controlPlanePort);
			topics = ((await a.get(`/v1/topics${query}`)) as { topics: TopicInfo[] })
				.topics;
		} else {
			topics = (await demoTopicInfo()).filter(
				(t) => direction === undefined || t.direction === direction,
			);
			note =
				"(no running offbook — showing the bundled demo spec; `offbook up` serves your project's topics)";
		}
	}
	if (values.json) {
		io.out(JSON.stringify(topics, null, 2));
		return 0;
	}
	if (note) io.out(note);
	io.out(
		renderTopicList(topics, {
			compact: values.compact === true,
			examples: values["no-examples"] !== true,
			schema: values.schema === true,
		}),
	);
	return 0;
}

// --- demo (ephemeral process command — contracts §5/G14) ---

export async function runDemo(
	portOffset = 0,
): Promise<{ caught: Violation; output: string }> {
	const config = loadConfig({
		brokerWsPort: 9001 + portOffset,
		brokerTcpPort: 1883 + portOffset,
		controlPlanePort: 9080 + portOffset,
	});
	const specText = await Bun.file(DEMO_SPEC).text();
	const registry = await buildRegistry({ specText, service: "demo", config });
	const server = await compose({ config, registry });
	await server.start();
	try {
		// seed populated (retained, per the state channel binding) state
		await server.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ topic: "state/thermostat-1", example: true }),
		});
		// scripted off-contract publish
		const pub = await (
			await server.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					topic: "command/thermostat-1/set",
					payload: { mode: "broil", target: 20 },
				}),
			})
		).json();
		const after = await (
			await server.app.request(`/v1/validation?sinceSeq=${pub.sinceSeq}`)
		).json();
		const caught = (after.violations as Violation[]).find(
			(v) => v.kind === "schema",
		);
		if (!caught)
			throw new Error("demo: expected a schema violation to be caught");
		const output = `offbook demo: published off-contract to command/thermostat-1/set → caught ${caught.kind}/${caught.origin}: ${caught.detail}`;
		return { caught, output };
	} finally {
		await server.stop();
	}
}

// --- reads ---

async function cmdState(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		...COMMON,
		json: { type: "boolean" },
		topic: { type: "string" },
	});
	const a = await clientFor(values);
	const qs = values.topic
		? `?topic=${encodeURIComponent(str(values.topic) ?? "")}`
		: "";
	const { state } = (await a.get(`/v1/state${qs}`)) as { state: StateEntry[] };
	if (values.json) {
		io.out(JSON.stringify(state, null, 2));
		return 0;
	}
	if (state.length === 0) {
		io.out("(no retained state)");
		return 0;
	}
	for (const e of state) io.out(`${e.topic}  ${JSON.stringify(e.payload)}`);
	return 0;
}

async function cmdScenarios(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		...COMMON,
		json: { type: "boolean" },
	});
	const a = await clientFor(values);
	const { scenarios } = (await a.get("/v1/scenarios")) as {
		scenarios: ScenarioInfo[];
	};
	if (values.json) {
		io.out(JSON.stringify(scenarios, null, 2));
		return 0;
	}
	if (scenarios.length === 0) {
		io.out("(no scenarios loaded)");
		return 0;
	}
	for (const s of scenarios)
		io.out(
			`${s.name} — ${s.when ? `on ${s.when}` : "trigger-only"} · ${s.stepCount} step(s) · ${s.source}`,
		);
	return 0;
}

// EQ6: the human headline for kind:'schema' is COMPOSED from errors[0] +
// the payload value at its instancePath — `detail` stays the stable machine
// rendering and is never re-worded.
function valueAt(payload: unknown, instancePath: string): unknown {
	if (!instancePath) return undefined; // root: echoing the whole payload is noise
	let cur = payload;
	for (const seg of instancePath.split("/").slice(1)) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[
			seg.replace(/~1/g, "/").replace(/~0/g, "~")
		];
	}
	return cur;
}

function headline(v: Violation): string {
	const e = v.errors?.[0];
	if (v.kind === "schema" && e) {
		const got = valueAt(v.payload, e.instancePath);
		return `${e.instancePath || "/"} ${e.message ?? e.keyword}${got === undefined ? "" : ` (got ${JSON.stringify(got)})`}`;
	}
	return v.detail;
}

// ER2/design §5: the distinct-violation key — structural signature, never the
// raw payload value (origin · kind · channel · errors[0] location).
const distinctKey = (v: Violation): string =>
	[
		v.origin,
		v.kind,
		v.channel ?? v.topic,
		v.errors?.[0]?.instancePath ?? "",
		v.errors?.[0]?.keyword ?? "",
	].join("·");

async function cmdValidation(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		...COMMON,
		json: { type: "boolean" },
		verbose: { type: "boolean", short: "v" },
		watch: { type: "boolean" },
		interval: { type: "string" },
		since: { type: "string" },
		origin: { type: "string" },
		kind: { type: "string" },
		severity: { type: "string" },
	});
	if (values.watch === true && values.json === true)
		throw new CliError("validation: --watch and --json are mutually exclusive");
	const a = await clientFor(values);
	const since =
		values.since !== undefined
			? toInt(str(values.since) ?? "", "--since")
			: undefined;
	const filterQs = () => {
		const qs = new URLSearchParams();
		for (const k of ["origin", "kind", "severity"] as const)
			if (values[k] !== undefined) qs.set(k, str(values[k]) ?? "");
		return qs;
	};
	const qs = filterQs();
	if (since !== undefined) qs.set("sinceSeq", String(since));
	const query = qs.size > 0 ? `?${qs}` : "";
	const res = (await a.get(`/v1/validation${query}`)) as {
		violations: Violation[];
		summary: ValidationSummary;
	};
	if (values.json) {
		// --json round-trips GET /v1/validation exactly (raw errors[] intact)
		io.out(JSON.stringify(res, null, 2));
		return 0;
	}
	// one line per DISTINCT violation, repeats collapsed to ×N (design §5)
	const groups = new Map<
		string,
		{ first: Violation; count: number; firstSeq: number; lastSeq: number }
	>();
	for (const v of res.violations) {
		const g = groups.get(distinctKey(v));
		if (!g)
			groups.set(distinctKey(v), {
				first: v,
				count: 1,
				firstSeq: v.seq,
				lastSeq: v.seq,
			});
		else {
			g.count++;
			g.lastSeq = v.seq;
		}
	}
	for (const g of groups.values()) {
		const seqs =
			g.count > 1 ? `#${g.firstSeq}…#${g.lastSeq}` : `#${g.firstSeq}`;
		io.out(
			`×${g.count} ${glyph(g.first.severity)} ${g.first.origin} ${g.first.kind} ${g.first.topic} — ${headline(g.first)} · ${seqs}`,
		);
		if (values.verbose) {
			const v = g.first;
			if (v.channel) io.out(`      channel: ${v.channel}`);
			if (v.clientId) io.out(`      client: ${v.clientId}`);
			if (v.payload !== undefined)
				io.out(`      payload: ${JSON.stringify(v.payload)}`);
			for (const e of v.errors ?? [])
				io.out(
					`      error: ${e.instancePath || "/"} ${e.keyword} — ${e.message ?? ""}`,
				);
		}
	}
	const s = res.summary;
	io.out(
		`— ${groups.size} distinct shown (${res.violations.length} total) · log distinct ${s.distinct.total} (${s.distinct.client} client / ${s.distinct.mock} mock) · client ${s.byOrigin.client} / mock ${s.byOrigin.mock}`,
	);
	if (values.watch !== true) return 0;
	// EO2: poll ?sinceSeq= (strictly-greater) and render each new entry
	// within one interval
	const interval =
		values.interval !== undefined
			? toInt(str(values.interval) ?? "", "--interval")
			: 1000;
	let last = res.violations.reduce((m, v) => Math.max(m, v.seq), since ?? 0);
	while (true) {
		await sleep(interval);
		const pollQs = filterQs();
		pollQs.set("sinceSeq", String(last));
		const next = (await a.get(`/v1/validation?${pollQs}`)) as {
			violations: Violation[];
		};
		for (const v of next.violations) {
			io.out(
				`×1 ${glyph(v.severity)} ${v.origin} ${v.kind} ${v.topic} — ${headline(v)} · #${v.seq}`,
			);
			last = Math.max(last, v.seq);
		}
	}
}

const diagnosticLine = (d: Diagnostic): string =>
	`${glyph(d.severity)} ${d.kind}${d.source ? ` ${d.source}` : ""} — ${d.detail}`;

async function cmdDiagnostics(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		...COMMON,
		json: { type: "boolean" },
		watch: { type: "boolean" },
		interval: { type: "string" },
	});
	if (values.watch === true && values.json === true)
		throw new CliError(
			"diagnostics: --watch and --json are mutually exclusive",
		);
	const a = await clientFor(values);
	const res = (await a.get("/v1/diagnostics")) as {
		diagnostics: Diagnostic[];
		summary: DiagnosticSummary;
	};
	if (values.json) {
		io.out(JSON.stringify(res, null, 2));
		return 0;
	}
	for (const d of res.diagnostics) io.out(diagnosticLine(d));
	io.out(
		`— ${res.summary.errors} error(s) · ${res.summary.warnings} warning(s) · ${res.summary.info} info`,
	);
	if (values.watch !== true) return 0;
	// EO3: diagnostics carry no seq — poll and diff-render unseen entries
	const interval =
		values.interval !== undefined
			? toInt(str(values.interval) ?? "", "--interval")
			: 1000;
	const key = (d: Diagnostic) => `${d.kind}·${d.source ?? ""}·${d.detail}`;
	const seen = new Set(res.diagnostics.map(key));
	while (true) {
		await sleep(interval);
		const next = (await a.get("/v1/diagnostics")) as {
			diagnostics: Diagnostic[];
		};
		for (const d of next.diagnostics) {
			if (seen.has(key(d))) continue;
			seen.add(key(d));
			io.out(diagnosticLine(d));
		}
	}
}

function renderSpecs(
	io: Io,
	specs: SpecInfo[],
	resolutionMode?: string,
	warnings?: string[],
): void {
	if (specs.length === 0) io.out("(no specs — demo or ephemeral boot?)");
	for (const s of specs)
		io.out(
			`${s.service}: ${s.source} @ ${shortHash(s.contentHash)} · ${s.channelCount} channel(s) · fetched ${s.fetchedAt}${s.declaredVersion ? ` · declares v${s.declaredVersion}` : ""}`,
		);
	if (resolutionMode) io.out(`resolution-mode: ${resolutionMode}`);
	for (const w of warnings ?? []) io.out(`⚠ ${w}`);
}

async function cmdSpecs(rest: string[], io: Io): Promise<number> {
	const update = rest[0] === "update";
	const { values } = parseFlags(update ? rest.slice(1) : rest, {
		...COMMON,
		json: { type: "boolean" },
	});
	const a = await clientFor(values);
	if (update) {
		const { specs } = (await a.post("/v1/specs/refresh")) as {
			specs: SpecInfo[];
		};
		if (values.json) {
			io.out(JSON.stringify(specs, null, 2));
			return 0;
		}
		io.out(`specs refreshed (${specs.length} service(s))`);
		renderSpecs(io, specs);
		return 0;
	}
	const res = (await a.get("/v1/specs")) as {
		specs: SpecInfo[];
		resolutionMode: string;
		warnings?: string[];
	};
	if (values.json) {
		io.out(JSON.stringify(res, null, 2));
		return 0;
	}
	renderSpecs(io, res.specs, res.resolutionMode, res.warnings);
	return 0;
}

async function cmdMode(rest: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(rest, {
		...COMMON,
		json: { type: "boolean" },
	});
	const a = await clientFor(values);
	const res = (
		positionals.length > 0
			? await a.post("/v1/mode", { mode: positionals[0] })
			: await a.get("/v1/mode")
	) as { mode: string; seed: number };
	if (values.json) io.out(JSON.stringify(res, null, 2));
	else io.out(`mode: ${res.mode} · seed ${res.seed}`);
	return 0;
}

// --- actions ---

async function settleAfter(a: Api, io: Io): Promise<void> {
	const p = (await a.get("/v1/pending?wait")) as {
		scheduled: number;
		settled: boolean;
	};
	io.out(`settled: ${p.settled} (scheduled ${p.scheduled})`);
}

// The R-020 payload family (EQ1/EQ4), shared by publish and scenario:
// --example | --payload <json> | --payload - (stdin) | --payload-file <path>,
// mutually exclusive; publish treats bare as --example, scenario as "none"
// (the trigger seed-fakes the inbound).
const PAYLOAD_FLAGS: FlagSpec = {
	payload: { type: "string" },
	"payload-file": { type: "string" },
	example: { type: "boolean" },
};

async function payloadBody(
	values: FlagValues,
	opts: { bareIsExample: boolean },
): Promise<{ payload?: unknown; example?: true }> {
	const given = [
		values.example === true ? "--example" : undefined,
		values.payload !== undefined ? "--payload" : undefined,
		values["payload-file"] !== undefined ? "--payload-file" : undefined,
	].filter((f): f is string => f !== undefined);
	if (given.length > 1)
		throw new CliError(`${given.join(" and ")} are mutually exclusive`);
	if (values.example === true) return { example: true };
	if (values.payload !== undefined) {
		const raw = str(values.payload) ?? "";
		if (raw === "-")
			return { payload: parseJson(await Bun.stdin.text(), "--payload -") };
		return { payload: parseJson(raw, "--payload") };
	}
	if (values["payload-file"] !== undefined) {
		const path = str(values["payload-file"]) ?? "";
		let text: string;
		try {
			text = await Bun.file(path).text();
		} catch (cause) {
			throw new CliError(
				`--payload-file: cannot read '${path}' (${(cause as Error).message})`,
			);
		}
		return { payload: parseJson(text, `--payload-file ${path}`) };
	}
	return opts.bareIsExample ? { example: true } : {};
}

async function cmdPublish(rest: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(rest, {
		...COMMON,
		...PAYLOAD_FLAGS,
		qos: { type: "string" },
		retain: { type: "boolean" },
		force: { type: "boolean" },
		wait: { type: "boolean" },
	});
	const topic = positionals[0];
	if (!topic) throw new CliError("publish: missing <topic>");
	const body: Record<string, unknown> = {
		topic,
		...(await payloadBody(values, { bareIsExample: true })), // bare = --example (EQ1)
	};
	if (values.qos !== undefined)
		body.qos = toInt(str(values.qos) ?? "", "--qos");
	if (values.retain) body.retain = true;

	const a = await clientFor(values);
	const res = (await a.post("/v1/publish", body)) as {
		topic: string;
		direction: TopicInfo["direction"] | null;
		matched: boolean;
		injected: boolean;
		sinceSeq: number;
	};
	if (!res.matched) {
		io.out(
			`⚠ unknown topic '${topic}' — published raw; an unknown-topic violation was raised (offbook validation --since ${res.sinceSeq})`,
		);
		if (!values.force) {
			io.err("offbook publish: unmatched topic (pass --force to accept)");
			return 1; // EQ1
		}
	} else if (!res.injected) {
		// F5 drop-and-surface: the sole matched && !injected case (D-004)
		io.err(
			`offbook publish: the generated example failed its schema recheck — the mock declined to emit (offbook validation --since ${res.sinceSeq})`,
		);
		return 1;
	} else {
		io.out(
			`injected → ${topic} [${res.direction ? phraseDirection(res.direction) : "?"}] · violation baseline #${res.sinceSeq}`,
		);
	}
	if (values.wait) await settleAfter(a, io);
	return 0;
}

async function cmdScenario(rest: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(rest, {
		...COMMON,
		param: { type: "string", multiple: true },
		payload: { type: "string" },
		"payload-file": { type: "string" },
		wait: { type: "boolean" },
	});
	const name = positionals[0];
	if (!name) throw new CliError("scenario: missing <name>");
	const params: Record<string, string> = {};
	for (const p of (values.param as string[] | undefined) ?? []) {
		const i = p.indexOf("=");
		if (i <= 0) throw new CliError(`--param: expected k=v, got '${p}'`);
		params[p.slice(0, i)] = p.slice(i + 1);
	}
	const body: Record<string, unknown> = {};
	if (Object.keys(params).length > 0) body.params = params;
	// EQ4: the same --payload* family as publish; bare = seed-faked inbound
	const fromFlags = await payloadBody(values, { bareIsExample: false });
	if ("payload" in fromFlags) body.payload = fromFlags.payload;
	const a = await clientFor(values);
	const res = (await a.post(
		`/v1/trigger/${encodeURIComponent(name)}`,
		body,
	)) as { scenario: string; fired: boolean; sinceSeq: number };
	io.out(
		`fired → scenario '${res.scenario}' · violation baseline #${res.sinceSeq}`,
	);
	if (values.wait) await settleAfter(a, io);
	return 0;
}

async function cmdReset(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		...COMMON,
		seed: { type: "string" },
	});
	const a = await clientFor(values);
	const body =
		values.seed !== undefined
			? { seed: toInt(str(values.seed) ?? "", "--seed") }
			: {};
	const res = (await a.post("/v1/reset", body)) as {
		reset: boolean;
		seed: number;
		sinceSeq: number;
	};
	io.out(`reset — seed ${res.seed} · violation baseline #${res.sinceSeq}`);
	return 0;
}

async function cmdCheck(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		...COMMON,
		since: { type: "string" },
	});
	const a = await clientFor(values);
	// default window = the server-retained last-reset baseline (P8, D-014)
	const since =
		values.since !== undefined
			? toInt(str(values.since) ?? "", "--since")
			: ((await a.get("/v1/mode")) as { lastResetSeq: number }).lastResetSeq;
	const { violations } = (await a.get(`/v1/validation?sinceSeq=${since}`)) as {
		violations: Violation[];
	};
	const breaks = violations.filter((v) => v.origin === "client");
	const window = since > 0 ? ` since #${since}` : "";
	if (breaks.length === 0) {
		io.out(`offbook check: clean — no client violations${window}`);
		return 0;
	}
	const distinct = new Set(
		breaks.map(
			(v) =>
				`${v.kind}·${v.channel ?? v.topic}·${v.errors?.[0]?.instancePath ?? ""}·${v.errors?.[0]?.keyword ?? ""}`,
		),
	).size;
	io.out(
		`offbook check: ${breaks.length} client violation(s)${window} — ${distinct} distinct contract break(s) (offbook validation)`,
	);
	return 1; // P8: nonzero on client contract breaks
}

// --- process management (G14 — runfile, never HTTP) ---

function preflightPort(port: number, flag: string): void {
	try {
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: { data() {} },
		});
		listener.stop(true);
	} catch {
		throw new CliError(
			`port ${port} in use — another broker/server? set ${flag} (P7)`,
		);
	}
}

// shared by `up` and `demo --serve` (G14): guards, preflight, boot file,
// detached spawn with the log APPENDED, runfile, readiness probe.
// Returns the child pid, or null after printing the refusal/failure.
async function launchDetached(
	spec: {
		runDir: string;
		config: Config;
		boot: {
			projectDir: string;
			config: Partial<Config>;
			environment?: string;
			watch?: boolean;
			demo?: boolean;
		};
	},
	io: Io,
): Promise<number | null> {
	const { runDir, config } = spec;
	const existing = await resolveRunning(runDir);
	if (existing?.live) {
		io.err(
			`offbook: already running (pid ${existing.run.pid}, ports ws ${existing.run.brokerWsPort} / tcp ${existing.run.brokerTcpPort} / http ${existing.run.controlPlanePort}) — run \`offbook down\` first`,
		);
		return null;
	}
	if (existing) {
		io.out(`(reclaiming stale runfile — pid ${existing.run.pid} is gone)`);
		clearRunfile(runDir);
	}
	preflightPort(config.brokerWsPort, "brokerWsPort or --ws-port");
	preflightPort(config.brokerTcpPort, "brokerTcpPort or --tcp-port");
	preflightPort(config.controlPlanePort, "controlPlanePort or --ctrl-port");
	mkdirSync(runDir, { recursive: true });
	const bootFile = join(runDir, "offbook.boot.json");
	await Bun.write(bootFile, JSON.stringify(spec.boot, null, 2));
	const logFd = openSync(logPath(runDir), "a");
	const serveEntry = fileURLToPath(new URL("./serve.ts", import.meta.url));
	const child = spawn(process.execPath, [serveEntry, bootFile], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
	});
	closeSync(logFd);
	child.unref();
	const pid = child.pid;
	if (pid === undefined) throw new CliError("up: failed to spawn the server");
	await writeRunfile(runDir, {
		pid,
		brokerWsPort: config.brokerWsPort,
		brokerTcpPort: config.brokerTcpPort,
		controlPlanePort: config.controlPlanePort,
		startedAt: new Date().toISOString(),
	});
	const deadline = Date.now() + 30_000;
	let ready = false;
	while (Date.now() < deadline) {
		if (await probeOffbook(config.controlPlanePort, 300)) {
			ready = true;
			break;
		}
		if (!pidAlive(pid)) break;
		await sleep(100);
	}
	if (!ready) {
		clearRunfile(runDir);
		io.err(`offbook up: server failed to start — ${logPath(runDir)} ends:`);
		const tail = (
			await Bun.file(logPath(runDir))
				.text()
				.catch(() => "")
		)
			.trimEnd()
			.split("\n")
			.slice(-15);
		for (const line of tail) io.err(`  ${line}`);
		return null;
	}
	return pid;
}

async function cmdUp(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		"run-dir": { type: "string" },
		ci: { type: "boolean" },
		strict: { type: "boolean" },
		watch: { type: "boolean" },
		seed: { type: "string" },
		env: { type: "string" },
		"ws-port": { type: "string" },
		"tcp-port": { type: "string" },
		"ctrl-port": { type: "string" },
	});
	const runDir = runDirOf(values);

	// two boot profiles: interactive default vs --ci (co-set, EH1/F10);
	// --strict stays an independent flag (--frozen is v2)
	const ci = values.ci === true;
	if (ci && values.watch === true)
		io.out("(--watch is ignored under --ci — a CI window never restarts, EH1)");
	const watch = values.watch === true && !ci;
	const overrides: Partial<Config> = {
		runDir,
		mode: ci ? "passive" : "autonomous",
		wallClock: !ci,
		strict: ci ? true : values.strict === true,
	};
	if (values.seed !== undefined)
		overrides.seed = toInt(str(values.seed) ?? "", "--seed");
	if (values["ws-port"] !== undefined)
		overrides.brokerWsPort = toInt(str(values["ws-port"]) ?? "", "--ws-port");
	if (values["tcp-port"] !== undefined)
		overrides.brokerTcpPort = toInt(
			str(values["tcp-port"]) ?? "",
			"--tcp-port",
		);
	if (values["ctrl-port"] !== undefined)
		overrides.controlPlanePort = toInt(
			str(values["ctrl-port"]) ?? "",
			"--ctrl-port",
		);
	const config = loadConfig(overrides);

	const pid = await launchDetached(
		{
			runDir,
			config,
			boot: {
				projectDir: process.cwd(),
				config: overrides,
				environment: str(values.env),
				watch,
			},
		},
		io,
	);
	if (pid === null) return 1;

	io.out(
		`offbook up — pid ${pid} · mode ${config.mode} · seed ${config.seed}${ci ? " (--ci profile)" : ""}`,
	);
	io.out(
		`  control http://localhost:${config.controlPlanePort} · logs ${logPath(runDir)}`,
	);
	io.out(
		`point your MQTT client at ws://localhost:${config.brokerWsPort} (MQTT 3.1.1)`,
	);

	// EI2: fresh-project orientation — suppressed once a scenario or handler
	// loads (loadHandlers imports every handlers/**/*.ts, so file presence =
	// loaded; scenarios are counted as actually loaded via the API)
	const { scenarios } = (await api(config.controlPlanePort).get(
		"/v1/scenarios",
	)) as { scenarios: unknown[] };
	const handlersDir = join(process.cwd(), "handlers");
	const handlerFiles = existsSync(handlersDir)
		? [...new Bun.Glob("**/*.ts").scanSync({ cwd: handlersDir })]
		: [];
	if (scenarios.length === 0 && handlerFiles.length === 0)
		io.out(
			"L1 floor active: every toClient topic serves seeded, schema-valid examples — no scenarios or handlers loaded yet. Author scenarios/*.yaml (L2) or handlers/*.ts (L3) to script behavior; `offbook topics` shows what's flowing.",
		);
	return 0;
}

async function cmdDemoServe(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		serve: { type: "boolean" },
		"run-dir": { type: "string" },
		seed: { type: "string" },
		"ws-port": { type: "string" },
		"tcp-port": { type: "string" },
		"ctrl-port": { type: "string" },
	});
	const runDir = runDirOf(values);
	// interactive profile — the demo should feel alive (wall-clock, autonomous)
	const overrides: Partial<Config> = {
		runDir,
		mode: "autonomous",
		wallClock: true,
		strict: false,
	};
	if (values.seed !== undefined)
		overrides.seed = toInt(str(values.seed) ?? "", "--seed");
	if (values["ws-port"] !== undefined)
		overrides.brokerWsPort = toInt(str(values["ws-port"]) ?? "", "--ws-port");
	if (values["tcp-port"] !== undefined)
		overrides.brokerTcpPort = toInt(
			str(values["tcp-port"]) ?? "",
			"--tcp-port",
		);
	if (values["ctrl-port"] !== undefined)
		overrides.controlPlanePort = toInt(
			str(values["ctrl-port"]) ?? "",
			"--ctrl-port",
		);
	const config = loadConfig(overrides);
	const pid = await launchDetached(
		{
			runDir,
			config,
			boot: { projectDir: process.cwd(), config: overrides, demo: true },
		},
		io,
	);
	if (pid === null) return 1;
	io.out(
		`offbook demo --serve — pid ${pid} · bundled thermostat spec · mode ${config.mode} · seed ${config.seed}`,
	);
	io.out(
		`  control http://localhost:${config.controlPlanePort} · logs ${logPath(runDir)}`,
	);
	io.out(
		`point your MQTT client at ws://localhost:${config.brokerWsPort} (MQTT 3.1.1) — \`offbook down\` stops it`,
	);
	return 0;
}

async function cmdDown(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, { "run-dir": { type: "string" } });
	const runDir = runDirOf(values);
	const run = await readRunfile(runDir);
	// idempotent (P7): dead/absent pid cleans the runfile and exits 0
	if (!run || !pidAlive(run.pid)) {
		clearRunfile(runDir);
		io.out("offbook: not running");
		return 0;
	}
	process.kill(run.pid, "SIGTERM");
	const deadline = Date.now() + 5_000;
	while (pidAlive(run.pid) && Date.now() < deadline) await sleep(50);
	if (pidAlive(run.pid)) {
		process.kill(run.pid, "SIGKILL");
		await sleep(100);
	}
	clearRunfile(runDir);
	io.out(`offbook down — stopped (pid ${run.pid})`);
	return 0;
}

async function cmdStatus(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		"run-dir": { type: "string" },
		json: { type: "boolean" },
	});
	const runDir = runDirOf(values);
	const resolved = await resolveRunning(runDir);
	if (!resolved?.live) {
		io.err(
			`offbook: not running${resolved ? ` (stale runfile, pid ${resolved.run.pid})` : ` (no runfile in ${runDir})`}`,
		);
		return 1;
	}
	const run = resolved.run;
	const a = api(run.controlPlanePort);
	const [modeRes, specsRes, valRes, diagRes] = (await Promise.all([
		a.get("/v1/mode"),
		a.get("/v1/specs"),
		a.get("/v1/validation"),
		a.get("/v1/diagnostics"),
	])) as [
		{ mode: string; seed: number },
		{ specs: SpecInfo[]; warnings?: string[] },
		{ summary: ValidationSummary },
		{ summary: DiagnosticSummary },
	];
	if (values.json) {
		io.out(
			JSON.stringify(
				{
					run,
					mode: modeRes,
					specs: specsRes.specs,
					validation: valRes.summary,
					diagnostics: diagRes.summary,
				},
				null,
				2,
			),
		);
		return 0;
	}
	const v = valRes.summary;
	io.out(`offbook: running (pid ${run.pid}, since ${run.startedAt})`);
	io.out(`  mode ${modeRes.mode} · seed ${modeRes.seed}`);
	io.out(
		`  ports: ws ${run.brokerWsPort} · tcp ${run.brokerTcpPort} · http ${run.controlPlanePort}`,
	);
	io.out(
		`  point your MQTT client at ws://localhost:${run.brokerWsPort} (MQTT 3.1.1)`,
	);
	if (specsRes.specs.length === 0) io.out("  specs: (none)");
	for (const s of specsRes.specs) {
		const age = specAge(s.fetchedAt);
		io.out(
			`  spec ${s.service}: ${s.source} @ ${shortHash(s.contentHash)} · fetched ${s.fetchedAt}${age ? ` (${age})` : ""}`,
		);
	}
	io.out(
		`  violations: client ${v.byOrigin.client} / mock ${v.byOrigin.mock} — caught ${v.distinct.client} distinct client break(s)`,
	);
	io.out(
		`  diagnostics: ${diagRes.summary.errors} error(s) · ${diagRes.summary.warnings} warning(s)`,
	);
	return 0;
}

async function cmdLogs(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		"run-dir": { type: "string" },
		follow: { type: "boolean", short: "f" },
	});
	const path = logPath(runDirOf(values));
	if (!existsSync(path))
		throw new CliError(`no log at ${path} — has \`offbook up\` run here?`);
	const text = await Bun.file(path).text();
	if (text.trimEnd() !== "") io.out(text.trimEnd());
	if (!values.follow) return 0;
	let offset = Bun.file(path).size;
	while (true) {
		await sleep(300);
		const f = Bun.file(path);
		if (f.size > offset) {
			const appended = await f.slice(offset).text();
			offset = f.size;
			if (appended.trimEnd() !== "") io.out(appended.trimEnd());
		}
	}
}

// --- init scaffold (R-025 refines; local file work only) ---

const INIT_SERVICES = `# offbook — where each service's AsyncAPI spec lives (services.yaml).
# gitHost: https://git.example.com   # base URL for org/name repo slugs
services: {}
# services:
#   my-service:
#     repo: org/my-service     # slug (resolved against gitHost), full URL, or absolute path
#     specPath: asyncapi.yaml
#     branch: main
`;

const INIT_ENVIRONMENTS = `# offbook — requested spec versions per environment.
# v1 records these but fetches branch tips (resolution-mode: branch).
environments:
  default: {}
`;

const INIT_SCENARIO = `# offbook L2 scenarios — declarative reactive/triggered emissions.
# Example (uncomment and adapt to your spec's topics):
# - name: accept-set
#   when:
#     topic: command/{deviceId}/set
#   then:
#     - emit:
#         topic: state/{{deviceId}}
#         payload: { deviceId: "{{deviceId}}", status: accepted }
#         delay: 50-80ms
`;

async function cmdInit(rest: string[], io: Io): Promise<number> {
	const { positionals } = parseFlags(rest, {});
	const dir = positionals[0] ?? ".";
	if (existsSync(join(dir, "services.yaml"))) {
		io.err(
			"offbook init: services.yaml already exists — refusing to overwrite",
		);
		return 1;
	}
	mkdirSync(dir, { recursive: true });
	const created: string[] = [];
	const writeIfAbsent = async (rel: string, content: string) => {
		const path = join(dir, rel);
		if (existsSync(path)) return;
		await Bun.write(path, content);
		created.push(rel);
	};
	await writeIfAbsent("services.yaml", INIT_SERVICES);
	await writeIfAbsent("environments.yaml", INIT_ENVIRONMENTS);
	mkdirSync(join(dir, "scenarios"), { recursive: true });
	await writeIfAbsent("scenarios/00-example.yaml", INIT_SCENARIO);
	mkdirSync(join(dir, "handlers"), { recursive: true });
	// runDir is a run artifact — gitignored from day one (§1a); specs.lock is
	// NEVER scaffolded (it is written by `up`/`specs update`)
	await writeIfAbsent(".gitignore", ".offbook/\n");
	io.out(
		`offbook init — scaffolded ${created.join(", ")}, scenarios/, handlers/`,
	);
	io.out(
		"next: set gitHost + your services in services.yaml, then `offbook up`",
	);
	return 0;
}

// --- dispatch ---

const USAGE = `usage: offbook <command>

  init [dir]                 scaffold services.yaml, environments.yaml, scenarios/, handlers/
  demo [--serve]             bundled demo spec — one-shot catch, or --serve to keep serving
  up [--ci] [--strict] [--watch] [--seed n] [--ws-port n] [--tcp-port n] [--ctrl-port n] [--env e]
  down                       stop the running server (idempotent)
  status [--json]            running/ports/mode/specs/violations at a glance
  logs [-f]                  print (or follow) the server log
  topics [--compact] [--no-examples] [--schema] [--receives|--sends] [--json]
  state [--topic prefix]     retained state
  publish <topic> [--example | --payload <json|-> | --payload-file <path>]
                  [--qos n] [--retain] [--force] [--wait]
  scenario <name> [--param k=v ...] [--payload <json|-> | --payload-file <path>] [--wait]
  scenarios                  list loaded L2 scenarios
  reset [--seed n]           reset the deterministic baseline
  mode [autonomous|passive]  read or set the mode
  validation [-v] [--watch] [--since n] [--origin o] [--kind k] [--severity s] [--json]
  check [--since n]          exit nonzero iff client contract breaks
  diagnostics [--watch] [--json]  scenario/spec load issues
  specs [update]             spec provenance; update re-resolves + hot-swaps

client verbs accept --run-dir <dir> (default .offbook) and --ctrl-port <n>`;

const VERBS: Record<string, (rest: string[], io: Io) => Promise<number>> = {
	topics: cmdTopics,
	state: cmdState,
	publish: cmdPublish,
	scenario: cmdScenario,
	scenarios: cmdScenarios,
	reset: cmdReset,
	mode: cmdMode,
	validation: cmdValidation,
	check: cmdCheck,
	diagnostics: cmdDiagnostics,
	specs: cmdSpecs,
	up: cmdUp,
	down: cmdDown,
	status: cmdStatus,
	logs: cmdLogs,
	init: cmdInit,
};

export async function run(argv: string[], io: Io = consoleIo): Promise<number> {
	const [cmd, ...rest] = argv;
	try {
		if (cmd === "demo") {
			if (rest.includes("--serve")) return await cmdDemoServe(rest, io);
			const { output } = await runDemo();
			io.out(output);
			return 0;
		}
		const verb = cmd === undefined ? undefined : VERBS[cmd];
		if (!verb) {
			io.err(USAGE);
			return 1;
		}
		return await verb(rest, io);
	} catch (cause) {
		if (cause instanceof CliError) {
			io.err(`offbook: ${cause.message}`);
			return cause.exitCode;
		}
		io.err(`offbook: ${(cause as Error).message}`);
		return 1;
	}
}

if (import.meta.main)
	run(process.argv.slice(2)).then((code) => process.exit(code));
