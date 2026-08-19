// R-019 — the CLI dispatch backbone (build-plan tier 4): a thin client over
// the /v1 HTTP API. Read/action verbs resolve the control-plane port
// (--ctrl-port, else the runfile of a live offbook) and render the response;
// up/down/logs/status are process management over the G14 runfile
// (contracts §5) — never HTTP. `demo` and the no-server `topics` fallback
// boot/read the bundled demo spec locally (M0's zero-config discovery floor).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { checkoutCommit, checkoutOrigin, repoRoot } from "./checkout.ts";
import type { Api } from "./client.ts";
import { api, CliError } from "./client.ts";
import type { CheckStatus, DoctorCtx } from "./doctor.ts";
import { runDoctor } from "./doctor.ts";
import { guarded } from "./guard.ts";
import type { InstanceRow } from "./messages.ts";
import {
	instanceTable,
	M3,
	M5,
	M6,
	M8,
	M9,
	M10,
	M11,
	M11s,
	M12,
	M13,
	M13wrongToken,
	M15,
	M16,
	M17,
	M18,
	M19,
	M20,
	M22,
	refusalEnvelope,
} from "./messages.ts";
import { canonicalPath, stateDirFromEnv } from "./registry.ts";
import type {
	Resolution,
	ResolvedInstance,
	SkippedInstance,
} from "./resolve.ts";
import {
	attributeCtrlPort,
	containsOrEqual,
	resolveInstance,
	WrongHostError,
} from "./resolve.ts";
import type { Runfile, ServerProbe } from "./runfile.ts";
import {
	clearRunfile,
	logPath,
	logSafeEnv,
	pidAlive,
	probeOffbook,
	probeServer,
	readRunfile,
	resolveRunning,
	writeRunfile,
} from "./runfile.ts";
import { cmdSkill } from "./skill.ts";

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
		throw new CliError(
			`${(cause as Error).message} — run \`offbook\` with no arguments for usage`,
		);
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

// --- D-032: the verb-policy front door over the shared resolver ---

type VerbKind = "read" | "mutate";
interface Target {
	api: Api;
	inst?: ResolvedInstance;
	res?: Resolution;
}

function rowsOf(candidates: ResolvedInstance[]): InstanceRow[] {
	return candidates.map((c) => ({
		projectDir: c.projectDir ?? dirname(c.runDir),
		demo: c.demo,
		ws: c.run.brokerWsPort,
		tcp: c.run.brokerTcpPort,
		http: c.run.controlPlanePort,
		pid: c.run.pid,
		runDir: c.runDir,
	}));
}

// row 4's skip note names BOTH sides (the port answered — as a different
// offbook); every other skip gets the plain not-answering M13
function skippedNote(s: SkippedInstance): string {
	return s.reason === "wrong-token" && s.answeringProjectDir !== undefined
		? M13wrongToken(s.projectDir, s.pid, s.ctrlPort, s.answeringProjectDir)
		: M13(s.projectDir, s.pid, s.ctrlPort);
}

// the one place the wrong-host refusal (M10) is rendered: verbatim catalog
// wording on stderr (never re-prefixed by run()'s renderer), or the
// wrong-host envelope under --json; exit 2 either way
async function resolveOrRefuse(
	opts: Parameters<typeof resolveInstance>[0],
	io: Io,
	json: boolean,
): Promise<Resolution | number> {
	try {
		return await resolveInstance(opts);
	} catch (cause) {
		if (cause instanceof WrongHostError) {
			if (json) io.out(refusalEnvelope("wrong-host", cause.message));
			else io.err(cause.message);
			return 2;
		}
		throw cause;
	}
}

// registry-resolved object-shaped --json documents carry identity in-band
// (the spec's "other shapes gain the same fields where their envelope
// allows"); cwd-resolved output stays byte-identical, so the pinned
// round-trip shapes only grow the block when discovery actually engaged.
// Array-shaped documents (topics/state/scenarios --json) are exempt — their
// envelope does not allow it; scripts pin those with --run-dir.
function withServer(
	doc: Record<string, unknown>,
	t: Target,
): Record<string, unknown> {
	if (t.inst === undefined || t.inst.source !== "registry") return doc;
	return {
		...doc,
		server: {
			projectDir: t.inst.projectDir,
			runDir: t.inst.runDir,
			source: t.inst.source,
			demo: t.inst.demo,
		},
	};
}

// Resolves for one verb invocation and applies the naming/refusal policy
// (spec "Verb policy" + "Naming and notes"): prints resolver notes, M13
// skips, and the registry-resolution naming duty (M16 header for reads on
// stdout, M15 note for mutations on stderr — human mode only; a quiet
// cwd day stays byte-identical). Returns the exit code when it refused:
// 2 = refused-with-selector (M8), 1 = not running (M11/M12).
async function targetFor(
	values: FlagValues,
	io: Io,
	kind: VerbKind,
	verb: string,
): Promise<Target | number> {
	if (values["ctrl-port"] !== undefined)
		return { api: api(toInt(str(values["ctrl-port"]) ?? "", "--ctrl-port")) };
	const json = values.json === true;
	const res = await resolveOrRefuse(
		{
			cwd: process.cwd(),
			runDirFlag: str(values["run-dir"]),
			stateDir: stateDirFromEnv(),
		},
		io,
		json,
	);
	if (typeof res === "number") return res;
	for (const n of res.notes) io.err(n);
	if (res.resolved !== undefined) {
		const inst = res.resolved;
		for (const s of res.skipped) io.err(skippedNote(s));
		if (inst.source === "registry" && !json) {
			const projectDir = inst.projectDir ?? dirname(inst.runDir);
			if (kind === "read")
				io.out(
					M16(
						projectDir,
						inst.run.brokerWsPort,
						inst.run.controlPlanePort,
						inst.demo,
					),
				);
			else io.err(M15(projectDir, inst.demo));
		}
		return { api: api(inst.run.controlPlanePort), inst, res };
	}
	if (res.candidates.length > 1) {
		if (json)
			io.out(refusalEnvelope("ambiguous", M8(), rowsOf(res.candidates)));
		else {
			io.err(M8());
			for (const line of instanceTable(rowsOf(res.candidates), verb))
				io.err(line);
		}
		return 2;
	}
	// zero live. Explicit --run-dir keeps the pre-D-032 wordings byte for
	// byte (the scripting escape hatch) — note a dead-pid runfile was
	// already reclaimed above (row 5), surfacing as no-runfile plus the M14 note.
	const runDirFlag = str(values["run-dir"]);
	if (runDirFlag !== undefined) {
		const s = res.skipped[0];
		const message =
			s === undefined
				? `offbook is not running (no runfile in ${runDirFlag}) — run \`offbook up\`, or pass --ctrl-port`
				: `offbook is not running (stale runfile in ${runDirFlag}, pid ${s.pid}) — run \`offbook up\``;
		if (json) io.out(refusalEnvelope("not-running", message));
		else io.err(message);
		return 1;
	}
	const own =
		res.skipped.length === 1 &&
		res.skipped[0].runDir === resolve(process.cwd(), DEFAULT_CONFIG.runDir)
			? res.skipped[0]
			: undefined;
	if (own !== undefined) {
		// M12 REPLACES M11 and M13 — never printed alongside them
		if (json) io.out(refusalEnvelope("not-running", M12(own.pid)));
		else io.err(M12(own.pid));
		return 1;
	}
	for (const s of res.skipped) io.err(skippedNote(s));
	if (json) io.out(refusalEnvelope("not-running", M11()));
	else io.err(M11());
	return 1;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const glyph = (severity: string): string =>
	severity === "error" ? "✗" : severity === "warning" ? "⚠" : "ℹ";

const shortHash = (h: string): string => h.replace(/^sha256:/, "").slice(0, 8);

// shared by clientsFromLog (finds the last boot line) and
// specsStalenessWarning (reads what it recorded) — one offbook.log boot-line
// shape, matched once.
const BOOT_LINE = /^\[offbook\] \S+ boot: (.*)$/;

// R-043 — connects observed THIS RUN (adoption.md §10): the log appends
// across runs, so "this run" = fingerprint lines after the LAST boot line
// (under --watch each respawn writes a new boot line — the count restarts
// per respawn, which is the acceptance-test semantics). Connects observed,
// never a live count: that is what the log truthfully knows.
export function clientsFromLog(logText: string): {
	connects: number;
	last?: { clientId: string; at: string };
} {
	const lines = logText.split("\n");
	let start = 0;
	for (let i = lines.length - 1; i >= 0; i--)
		if (BOOT_LINE.test(lines[i])) {
			start = i + 1;
			break;
		}
	let connects = 0;
	let last: { clientId: string; at: string } | undefined;
	for (const line of lines.slice(start)) {
		const m = line.match(/^\[offbook\] (\S+) (?:ws|tcp)-connect (\{.*\})$/);
		if (!m) continue;
		try {
			const fields = JSON.parse(m[2]) as { clientId?: unknown };
			if (typeof fields.clientId !== "string") continue;
			connects++;
			const clientId = fields.clientId.replace(/\p{Cc}/gu, "?");
			last = { clientId, at: m[1] };
		} catch {
			// malformed fingerprint line: skip, never crash status (R-043)
		}
	}
	return { connects, last };
}

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
	// R-040: the human views carry the reactive-only marker; --json shows the
	// TopicInfo field itself
	const quietMark = (t: TopicInfo) =>
		t.initialState === false ? "  [no initial state]" : "";
	if (opts.compact)
		return topics
			.map(
				(t) =>
					`${t.topic}  [${phraseDirection(t.direction)}]  ${t.service}${quietMark(t)}`,
			)
			.join("\n");
	return topics
		.map((t) => {
			const lines = [
				`${t.topic}  [${phraseDirection(t.direction)}]${quietMark(t)}`,
			];
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
		const a = api(toInt(str(values["ctrl-port"]) ?? "", "--ctrl-port"));
		topics = ((await a.get(`/v1/topics${query}`)) as { topics: TopicInfo[] })
			.topics;
	} else {
		const res = await resolveOrRefuse(
			{
				cwd: process.cwd(),
				runDirFlag: str(values["run-dir"]),
				stateDir: stateDirFromEnv(),
			},
			io,
			values.json === true,
		);
		if (typeof res === "number") return res;
		for (const n of res.notes) io.err(n);
		if (res.resolved !== undefined) {
			const inst = res.resolved;
			for (const s of res.skipped) io.err(skippedNote(s));
			const projectDir = inst.projectDir ?? dirname(inst.runDir);
			if (values.json === true && inst.source === "registry" && inst.demo) {
				// the agent path must never mistake demo topics for ingestion
				// (a cwd-resolved demo is deliberate; a discovered one is not)
				io.out(refusalEnvelope("demo-only", M20(projectDir)));
				return 1;
			}
			if (inst.source === "registry" && values.json !== true)
				io.out(
					M16(
						projectDir,
						inst.run.brokerWsPort,
						inst.run.controlPlanePort,
						inst.demo,
					),
				);
			const a = api(inst.run.controlPlanePort);
			topics = ((await a.get(`/v1/topics${query}`)) as { topics: TopicInfo[] })
				.topics;
		} else if (res.candidates.length > 1) {
			if (values.json === true)
				io.out(refusalEnvelope("ambiguous", M8(), rowsOf(res.candidates)));
			else {
				io.err(M8());
				for (const line of instanceTable(rowsOf(res.candidates), "topics"))
					io.err(line);
			}
			return 2;
		} else {
			// zero live anywhere
			const own =
				res.skipped.length === 1 &&
				res.skipped[0].runDir === resolve(process.cwd(), DEFAULT_CONFIG.runDir)
					? res.skipped[0]
					: undefined;
			if (values.json === true) {
				io.out(
					refusalEnvelope(
						"not-running",
						own !== undefined ? M12(own.pid) : M11(),
					),
				);
				return 1;
			}
			// the M0 human fallback survives — with the skips disclosed
			for (const s of res.skipped) io.err(skippedNote(s));
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
	const t = await targetFor(values, io, "read", "state");
	if (typeof t === "number") return t;
	const a = t.api;
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
	const t = await targetFor(values, io, "read", "scenarios");
	if (typeof t === "number") return t;
	const a = t.api;
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
	const t = await targetFor(values, io, "read", "validation");
	if (typeof t === "number") return t;
	const a = t.api;
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
		io.out(
			JSON.stringify(
				withServer(res as unknown as Record<string, unknown>, t),
				null,
				2,
			),
		);
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
	const t = await targetFor(values, io, "read", "diagnostics");
	if (typeof t === "number") return t;
	const a = t.api;
	const res = (await a.get("/v1/diagnostics")) as {
		diagnostics: Diagnostic[];
		summary: DiagnosticSummary;
	};
	if (values.json) {
		io.out(
			JSON.stringify(
				withServer(res as unknown as Record<string, unknown>, t),
				null,
				2,
			),
		);
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

// R-043 — services.yaml edited after `up` (adoption.md §10): compare the
// current file's hash against the LAST boot line. Skips silently (no warn
// possible, none owed) when: --ctrl-port is passed (the target server's run
// dir correspondence is unverified), the last boot was the bundled demo, or
// no boot line exists (pre-R-043 log). Today the edit silently never applies
// while "specs refreshed" prints success.
export async function specsStalenessWarning(
	runDir: string,
): Promise<string | undefined> {
	const bootFile = Bun.file(join(runDir, "offbook.boot.json"));
	if (!(await bootFile.exists())) return undefined;
	let projectDir: string;
	try {
		const boot = JSON.parse(await bootFile.text()) as {
			projectDir?: string;
			demo?: boolean;
		};
		if (boot.demo === true || boot.projectDir === undefined) return undefined;
		projectDir = boot.projectDir;
	} catch {
		return undefined;
	}
	const logText = await Bun.file(logPath(runDir))
		.text()
		.catch(() => "");
	let bootHash: string | undefined;
	for (const line of logText.split("\n").reverse()) {
		const m = line.match(BOOT_LINE);
		if (!m) continue;
		bootHash = m[1].match(/^services\.yaml sha256:([0-9a-f]{64})$/)?.[1];
		break; // last boot line wins, whatever it recorded
	}
	if (bootHash === undefined) return undefined;
	const current = createHash("sha256")
		.update(
			await Bun.file(join(projectDir, "services.yaml"))
				.text()
				.catch(() => ""),
		)
		.digest("hex");
	return current === bootHash
		? undefined
		: "⚠ services.yaml changed since `offbook up` — restart to apply";
}

// F17 — see src/cli/skill.ts's SKILL_SUBCOMMANDS: the real subcommand this
// verb dispatches (rest[0] === "update" below), exported for the same
// reason — pin two-token VERB_FORMS entries against the dispatch, not USAGE.
export const SPECS_SUBCOMMANDS: readonly string[] = ["update"];

async function cmdSpecs(rest: string[], io: Io): Promise<number> {
	const update = rest[0] === "update";
	const { values } = parseFlags(update ? rest.slice(1) : rest, {
		...COMMON,
		json: { type: "boolean" },
	});
	// the selector must reproduce the refused invocation — "specs" alone would read, not refresh
	const t = await targetFor(
		values,
		io,
		update ? "mutate" : "read",
		update ? "specs update" : "specs",
	);
	if (typeof t === "number") return t;
	const a = t.api;
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
		// R-043 semantics under D-032: the staleness warning reads the
		// RESOLVED instance's boot record (skipped under --ctrl-port, where
		// run-dir correspondence stays unverified)
		if (str(values["ctrl-port"]) === undefined && t.inst !== undefined) {
			const warn = await specsStalenessWarning(t.inst.runDir);
			if (warn !== undefined) io.out(warn);
		}
		return 0;
	}
	const res = (await a.get("/v1/specs")) as {
		specs: SpecInfo[];
		resolutionMode: string;
		warnings?: string[];
	};
	if (values.json) {
		io.out(
			JSON.stringify(
				withServer(res as unknown as Record<string, unknown>, t),
				null,
				2,
			),
		);
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
	const t = await targetFor(
		values,
		io,
		positionals.length > 0 ? "mutate" : "read",
		"mode",
	);
	if (typeof t === "number") return t;
	const a = t.api;
	const res = (
		positionals.length > 0
			? await a.post("/v1/mode", { mode: positionals[0] })
			: await a.get("/v1/mode")
	) as { mode: string; seed: number };
	if (values.json)
		io.out(
			JSON.stringify(
				withServer(res as unknown as Record<string, unknown>, t),
				null,
				2,
			),
		);
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
	if (!topic)
		throw new CliError(
			"publish: missing <topic> — `offbook topics` lists every topic and its direction",
		);
	const body: Record<string, unknown> = {
		topic,
		...(await payloadBody(values, { bareIsExample: true })), // bare = --example (EQ1)
	};
	if (values.qos !== undefined)
		body.qos = toInt(str(values.qos) ?? "", "--qos");
	if (values.retain) body.retain = true;

	const t = await targetFor(values, io, "mutate", "publish");
	if (typeof t === "number") return t;
	const a = t.api;
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
	if (!name)
		throw new CliError(
			"scenario: missing <name> — `offbook scenarios` lists what's loaded",
		);
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
	const t = await targetFor(values, io, "mutate", "scenario");
	if (typeof t === "number") return t;
	const a = t.api;
	let res: { scenario: string; fired: boolean; sinceSeq: number };
	try {
		res = (await a.post(`/v1/trigger/${encodeURIComponent(name)}`, body)) as {
			scenario: string;
			fired: boolean;
			sinceSeq: number;
		};
	} catch (cause) {
		// R-036: the server's unknown-scenario envelope names no next step —
		// add one here, same as the missing-<name> case above.
		if (
			cause instanceof CliError &&
			cause.message.startsWith("unknown-scenario")
		)
			throw new CliError(
				`${cause.message} — \`offbook scenarios\` lists what's loaded`,
			);
		throw cause;
	}
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
	const t = await targetFor(values, io, "mutate", "reset");
	if (typeof t === "number") return t;
	const a = t.api;
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
	const t = await targetFor(values, io, "read", "check");
	if (typeof t === "number") return t;
	const a = t.api;
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

function portListenable(port: number): boolean {
	try {
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: { data() {} },
		});
		listener.stop(true);
		return true;
	} catch {
		return false;
	}
}

// R-043 — evaluate ALL THREE ports before composing the error, and probe a
// busy ctrl port: "another broker/server?" was a misattribution when the
// owner is offbook's own demo from another directory (adoption.md §10).
async function preflightPorts(config: Config): Promise<void> {
	const candidates = [
		{ label: "ws", port: config.brokerWsPort, flag: "--ws-port" },
		{ label: "tcp", port: config.brokerTcpPort, flag: "--tcp-port" },
		{ label: "ctrl", port: config.controlPlanePort, flag: "--ctrl-port" },
	];
	const busy = candidates.filter((c) => !portListenable(c.port));
	if (busy.length === 0) return;
	if (busy.some((b) => b.label === "ctrl")) {
		const others = busy.filter((b) => b.label !== "ctrl");
		const alsoBusy =
			others.length > 0
				? `; also busy: ${others.map((b) => `${b.label} ${b.port}`).join(", ")}`
				: "";
		// D-032: name the owner when the port's claim is PROVEN (the served
		// identity matches the claimed runfile's token); a bare offbook-shaped
		// answer keeps the pre-D-032 generic attribution — never a guess
		const owner = await attributeCtrlPort(config.controlPlanePort);
		if (owner !== undefined)
			throw new CliError(
				M3({
					port: config.controlPlanePort,
					projectDir: owner.projectDir,
					runDir: owner.runDir,
					demo: owner.demo,
					alsoBusy,
				}),
			);
		if (await probeOffbook(config.controlPlanePort))
			throw new CliError(
				`another offbook owns the control port ${config.controlPlanePort}${alsoBusy} — \`offbook down\` in that project's directory frees the control port; check the others separately if they persist`,
			);
	}
	throw new CliError(
		`port(s) in use: ${busy.map((b) => `${b.label} ${b.port}`).join(", ")} — another broker/server? set ${busy.map((b) => b.flag).join("/")} (P7); \`offbook doctor\` checks all three ports`,
	);
}

// guarded site #4's precondition, extracted pure so its race semantics are
// testable without racing a real boot: the failed-boot clear fires only
// when the runfile still names OUR spawn AND no other launch answers the
// port — a concurrent up's winner (repointed runfile, or a different token
// on the port) must survive the clear
export function shouldClearFailedBoot(
	spawned: { pid: number; token: string },
	seen: { run: Runfile | undefined; probe: ServerProbe },
): boolean {
	return (
		seen.run !== undefined &&
		seen.run.pid === spawned.pid &&
		seen.run.token === spawned.token &&
		!(
			seen.probe.kind === "server" &&
			seen.probe.identity.token !== spawned.token
		)
	);
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
	const stateDir = stateDirFromEnv();
	const existing = await resolveRunning(runDir);
	if (existing?.live) {
		io.err(
			`offbook: already running (pid ${existing.run.pid}, ports ws ${existing.run.brokerWsPort} / tcp ${existing.run.brokerTcpPort} / http ${existing.run.controlPlanePort}) — run \`offbook down\` first`,
		);
		return null;
	}
	if (existing) {
		io.out(`(reclaiming stale runfile — pid ${existing.run.pid} is gone)`);
		clearRunfile(runDir, { stateDir });
	}
	await preflightPorts(config);
	const token = randomBytes(16).toString("hex"); // the launch lineage id (R-044)
	mkdirSync(runDir, { recursive: true });
	const bootFile = join(runDir, "offbook.boot.json");
	await Bun.write(bootFile, JSON.stringify({ ...spec.boot, token }, null, 2));
	const logFd = openSync(logPath(runDir), "a");
	const serveEntry = fileURLToPath(new URL("./serve.ts", import.meta.url));
	const child = spawn(process.execPath, [serveEntry, bootFile], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: logSafeEnv(), // D-030 — the log must stay ANSI-clean
	});
	closeSync(logFd);
	child.unref();
	const pid = child.pid;
	if (pid === undefined) throw new CliError("up: failed to spawn the server");
	const reg = await writeRunfile(
		runDir,
		{
			pid,
			brokerWsPort: config.brokerWsPort,
			brokerTcpPort: config.brokerTcpPort,
			controlPlanePort: config.controlPlanePort,
			startedAt: new Date().toISOString(),
			token,
			host: hostname(),
		},
		{ stateDir },
	);
	if (!reg.registered) io.err(M17(spec.boot.projectDir, runDir));
	const deadline = Date.now() + 30_000;
	let ready = false;
	while (Date.now() < deadline) {
		// readiness IS identity (R-044): only THIS launch's token counts —
		// an old instance still draining the port must not green a new up
		const probe = await probeServer(config.controlPlanePort, 300);
		if (probe.kind === "server" && probe.identity.token === token) {
			ready = true;
			break;
		}
		if (!pidAlive(pid)) break;
		await sleep(100);
	}
	if (!ready) {
		// guarded site #4: clear only if the runfile still names OUR spawn
		// and no OTHER launch answers the port (a concurrent up's winner —
		// or a late riser of ours — must survive this clear)
		await guarded({
			read: async () => ({
				run: await readRunfile(runDir),
				probe: await probeServer(config.controlPlanePort, 300),
			}),
			expect: (seen) => shouldClearFailedBoot({ pid, token }, seen),
			act: () => clearRunfile(runDir, { stateDir }),
		});
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
		io.err(
			"(try `offbook doctor` — it checks config, spec reachability, and ports)",
		);
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
	const runDir = resolve(process.cwd(), runDirOf(values));

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
	const runDir = resolve(process.cwd(), runDirOf(values));
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
	const stateDir = stateDirFromEnv();
	const explicit = str(values["run-dir"]);
	// the foreign-host refusal (M10) renders verbatim on stderr, exit 2
	const res = await resolveOrRefuse(
		{ cwd: process.cwd(), runDirFlag: explicit, stateDir },
		io,
		false,
	);
	if (typeof res === "number") return res;
	for (const n of res.notes) io.err(n);
	if (res.resolved !== undefined) {
		const inst = res.resolved;
		if (explicit === undefined && inst.source === "registry") {
			// however it was resolved — the demo stage included — an instance
			// unrelated to cwd is never auto-signaled (FM-025)
			const projectDir = canonicalPath(inst.projectDir ?? dirname(inst.runDir));
			const cwdReal = canonicalPath(process.cwd());
			const related =
				containsOrEqual(projectDir, cwdReal) ||
				containsOrEqual(cwdReal, projectDir);
			if (!related) {
				if (res.skipped.length > 0) {
					// one verified + others not answering: the skipped may be
					// the intended target — refuse with the table (M9, exit 2)
					for (const s of res.skipped) io.err(skippedNote(s));
					io.err(M9());
					for (const line of instanceTable(rowsOf(res.candidates), "down"))
						io.err(line);
					return 2;
				}
				// nothing of yours: deterministic no-op — the table makes
				// choosing one paste (M6, exit 0)
				io.out(M6());
				for (const line of instanceTable(rowsOf(res.candidates), "down"))
					io.out(line);
				return 0;
			}
		}
		return signalInstance(inst, stateDir, io);
	}
	if (res.candidates.length > 1) {
		io.err(M8());
		for (const line of instanceTable(rowsOf(res.candidates), "down"))
			io.err(line);
		return 2;
	}
	// row 3, the wedged-server path: cwd's own SILENT instance is still
	// signalable pid-only (M12 promises `offbook down` stops it); a
	// wrong-token skip is never signaled — the pid may be reused (row 4)
	const ownRunDir =
		explicit !== undefined
			? res.skipped[0]?.runDir
			: resolve(process.cwd(), DEFAULT_CONFIG.runDir);
	const own = res.skipped.find(
		(s) => s.runDir === ownRunDir && s.reason === "silent",
	);
	if (own !== undefined) {
		const run = await readRunfile(own.runDir);
		if (run !== undefined)
			return signalInstance(
				{
					runDir: own.runDir,
					run,
					projectDir: own.projectDir,
					demo: false,
					source: "cwd",
				},
				stateDir,
				io,
			);
	}
	// explicit-path dead runfile: down has ALWAYS cleaned these up (P7
	// idempotence) — the resolver's reclaimDead:false left it for us so
	// read verbs could keep reporting it as stale
	const deadOwn = res.skipped.find(
		(s) => s.runDir === ownRunDir && s.reason === "dead",
	);
	if (deadOwn !== undefined) {
		await guarded({
			read: () => readRunfile(deadOwn.runDir),
			expect: (cur) => cur !== undefined && cur.pid === deadOwn.pid,
			act: () => clearRunfile(deadOwn.runDir, { stateDir }),
		});
		io.out("offbook: not running");
		return 0;
	}
	if (res.foreignSeen && explicit === undefined) {
		// row 10 on the pid-only path: never signal into a foreign pid table
		const cwdRunDir = resolve(process.cwd(), DEFAULT_CONFIG.runDir);
		const run = await readRunfile(cwdRunDir);
		if (run?.host !== undefined && run.host !== hostname()) {
			io.err(M10(run.host, cwdRunDir));
			return 2;
		}
	}
	for (const s of res.skipped) io.err(skippedNote(s));
	io.out("offbook: not running");
	return 0;
}

// The signal path (guarded sites #3 and #2), exported so the site pins can
// drive it directly. The TOKEN identifies the lineage; the PID identifies
// the incarnation — compare-and-signal checks the pid, because signaling
// the wrong incarnation is exactly the race being guarded.
export async function signalInstance(
	inst: ResolvedInstance,
	stateDir: string,
	io: Io,
): Promise<number> {
	const { runDir, run } = inst;
	const lineage = run.token;
	// site #3: the runfile must still name the verified pid at signal time
	const signaled = await guarded({
		read: () => readRunfile(runDir),
		expect: (cur) => cur !== undefined && cur.pid === run.pid,
		act: () => {
			try {
				process.kill(run.pid, "SIGTERM");
			} catch (cause) {
				// ESRCH inside the guard's race window = already dead — that IS success
				if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
			}
		},
	});
	if (!signaled) {
		io.err(M22());
		return 1;
	}
	const deadline = Date.now() + 5_000;
	while (pidAlive(run.pid) && Date.now() < deadline) await sleep(50);
	if (pidAlive(run.pid)) {
		// the SIGKILL escalation re-verifies BOTH granularities: the runfile
		// must still name this pid, and the port must not answer as a
		// DIFFERENT offbook. NB the port check only excludes other offbooks —
		// a non-offbook squatter reads as "silent" — so the runfile pid
		// re-read is the real gate on this escalation.
		const cur = await readRunfile(runDir);
		const probe = await probeServer(run.controlPlanePort, 300);
		const portIsOurs =
			probe.kind === "silent" ||
			(probe.kind === "server" &&
				lineage !== undefined &&
				probe.identity.token === lineage) ||
			(probe.kind === "server" &&
				lineage === undefined &&
				canonicalPath(probe.identity.runDir) === canonicalPath(runDir)) ||
			(probe.kind === "legacy" && lineage === undefined);
		if (cur === undefined || cur.pid !== run.pid || !portIsOurs) {
			io.err(M22());
			return 1;
		}
		try {
			process.kill(run.pid, "SIGKILL");
		} catch (cause) {
			// ESRCH inside the guard's race window = already dead — that IS success
			if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
		}
		await sleep(100);
	}
	// site #2: clear only while the runfile still names the signaled pid —
	// a --watch successor's registration survives this clear
	await guarded({
		read: () => readRunfile(runDir),
		expect: (cur) => cur !== undefined && cur.pid === run.pid,
		act: () => clearRunfile(runDir, { stateDir }),
	});
	if (inst.identity !== undefined)
		io.out(M5(run.pid, inst.projectDir ?? dirname(runDir), inst.demo));
	else io.out(`offbook down — stopped (pid ${run.pid})`); // unverified: claim only what was proven
	return 0;
}

async function cmdStatus(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		"run-dir": { type: "string" },
		"ctrl-port": { type: "string" },
		json: { type: "boolean" },
	});
	if (values["ctrl-port"] !== undefined) return statusByCtrlPort(values, io);
	const json = values.json === true;
	const res = await resolveOrRefuse(
		{
			cwd: process.cwd(),
			runDirFlag: str(values["run-dir"]),
			stateDir: stateDirFromEnv(),
		},
		io,
		json,
	);
	if (typeof res === "number") return res;
	for (const n of res.notes) io.err(n);
	if (res.resolved === undefined) {
		if (res.candidates.length > 1) {
			if (json)
				io.out(refusalEnvelope("ambiguous", M8(), rowsOf(res.candidates)));
			else {
				io.err(M8());
				for (const line of instanceTable(rowsOf(res.candidates), "status"))
					io.err(line);
			}
			return 2;
		}
		const runDirFlag = str(values["run-dir"]);
		if (runDirFlag !== undefined) {
			// explicit addressing keeps status's pre-D-032 wordings
			const s = res.skipped[0];
			io.err(
				`offbook: not running${s !== undefined ? ` (stale runfile, pid ${s.pid})` : ` (no runfile in ${runDirFlag})`}`,
			);
			return 1;
		}
		const own =
			res.skipped.length === 1 &&
			res.skipped[0].runDir === resolve(process.cwd(), DEFAULT_CONFIG.runDir)
				? res.skipped[0]
				: undefined;
		if (own !== undefined) {
			if (json) io.out(refusalEnvelope("not-running", M12(own.pid)));
			else io.err(M12(own.pid));
			return 1;
		}
		for (const s of res.skipped) io.err(skippedNote(s));
		if (json) io.out(refusalEnvelope("not-running", M11s()));
		else io.err(M11s());
		return 1;
	}
	const inst = res.resolved;
	for (const s of res.skipped) io.err(skippedNote(s));
	const run = inst.run;
	const a = api(run.controlPlanePort);
	const clients = clientsFromLog(
		await Bun.file(logPath(inst.runDir))
			.text()
			.catch(() => ""),
	);
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
	if (json) {
		io.out(
			JSON.stringify(
				{
					server: {
						projectDir: inst.projectDir,
						runDir: inst.runDir,
						source: inst.source,
						demo: inst.demo,
					},
					skipped: res.skipped,
					run,
					mode: modeRes,
					specs: specsRes.specs,
					validation: valRes.summary,
					diagnostics: diagRes.summary,
					clients,
				},
				null,
				2,
			),
		);
		return 0;
	}
	const v = valRes.summary;
	if (inst.source === "registry")
		io.out(
			M16(
				inst.projectDir ?? dirname(inst.runDir),
				run.brokerWsPort,
				run.controlPlanePort,
				inst.demo,
			),
		);
	io.out(`offbook: running (pid ${run.pid}, since ${run.startedAt})`);
	io.out(`  mode ${modeRes.mode} · seed ${modeRes.seed}`);
	io.out(
		`  ports: ws ${run.brokerWsPort} · tcp ${run.brokerTcpPort} · http ${run.controlPlanePort}`,
	);
	io.out(
		`  point your MQTT client at ws://localhost:${run.brokerWsPort} (MQTT 3.1.1)`,
	);
	io.out(
		clients.connects === 0
			? `  clients: no connects observed this run — is your app pointed at ws://localhost:${run.brokerWsPort}?`
			: `  clients: ${clients.connects} connect(s) this run · last ${clients.last?.clientId} at ${clients.last?.at}`,
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

// status --ctrl-port (D-032): identity-only reporting — the server's own
// claim, no log- or boot-file-derived extras (their run-dir correspondence
// is what --ctrl-port cannot verify; the identity CAN, so it is shown).
// Pre-upgrade servers refuse with M18 (no degraded partial-output mode).
async function statusByCtrlPort(values: FlagValues, io: Io): Promise<number> {
	const port = toInt(str(values["ctrl-port"]) ?? "", "--ctrl-port");
	const json = values.json === true;
	const probe = await probeServer(port);
	if (probe.kind === "legacy") {
		if (json) io.out(refusalEnvelope("version-skew", M18()));
		else io.err(M18());
		return 2;
	}
	if (probe.kind === "silent")
		throw new CliError(
			`could not reach offbook at http://localhost:${port} — is it running?`,
		);
	const id = probe.identity;
	const a = api(port);
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
	if (json) {
		io.out(
			JSON.stringify(
				{
					server: {
						projectDir: id.projectDir,
						runDir: id.runDir,
						source: "ctrl-port",
						demo: id.demo,
					},
					skipped: [],
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
	io.out(
		M16(
			id.projectDir,
			id.ports.brokerWsPort,
			id.ports.controlPlanePort,
			id.demo,
		),
	);
	io.out(`offbook: running (pid ${id.pid}, since ${id.startedAt})`);
	io.out(`  mode ${modeRes.mode} · seed ${modeRes.seed}`);
	io.out(
		`  ports: ws ${id.ports.brokerWsPort} · tcp ${id.ports.brokerTcpPort} · http ${id.ports.controlPlanePort}`,
	);
	io.out(
		`  violations: client ${valRes.summary.byOrigin.client} / mock ${valRes.summary.byOrigin.mock} — caught ${valRes.summary.distinct.client} distinct client break(s)`,
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
	const explicit = str(values["run-dir"]);
	// logs always runs the resolver — the banner needs its outcome; the
	// local log merely wins for OUTPUT (post-mortem logs keep working in
	// the project directory, a stated non-goal boundary)
	const res = await resolveOrRefuse(
		{ cwd: process.cwd(), runDirFlag: explicit, stateDir: stateDirFromEnv() },
		io,
		false,
	);
	if (typeof res === "number") return res;
	for (const n of res.notes) io.err(n);
	const localRunDir = resolve(process.cwd(), explicit ?? DEFAULT_CONFIG.runDir);
	const localPath = logPath(localRunDir);
	let path = localPath;
	if (existsSync(localPath)) {
		if (
			res.resolved !== undefined &&
			canonicalPath(res.resolved.runDir) !== canonicalPath(localRunDir)
		)
			io.err(
				M19(
					localPath,
					res.resolved.projectDir ?? dirname(res.resolved.runDir),
					res.resolved.runDir,
				),
			);
	} else if (res.resolved !== undefined) {
		if (res.resolved.source === "registry")
			io.out(
				M16(
					res.resolved.projectDir ?? dirname(res.resolved.runDir),
					res.resolved.run.brokerWsPort,
					res.resolved.run.controlPlanePort,
					res.resolved.demo,
				),
			);
		path = logPath(res.resolved.runDir);
	} else if (res.candidates.length > 1) {
		io.err(M8());
		for (const line of instanceTable(rowsOf(res.candidates), "logs"))
			io.err(line);
		return 2;
	} else {
		for (const s of res.skipped) io.err(skippedNote(s));
		throw new CliError(`no log at ${localPath} — has \`offbook up\` run here?`);
	}
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

// R-041 — reference-quality scaffolds (adoption.md §8). Fence convention:
// exactly ONE canonical worked example per template between the marker
// lines, commented at code depth ("# "); alternatives and prose sit at
// prose depth ("## ") outside the fence, so test/init-templates.test.ts's
// extraction (strip one "# " per line, parse STANDALONE) is mechanical.
// gitHost stays a COMMENTED example, never an active placeholder (contracts
// §6, the EI1 amendment): unset must remain the true config state so a
// slug-form repo hits the clean G20 error, not a fetch against garbage.
const INIT_SERVICES = `# offbook — where each service's AsyncAPI spec lives (services.yaml).
# Validate as you edit: \`offbook doctor\` checks this file locally (no
# network) and confirms each repo resolves (the specs-reachable check).
#
# gitHost: https://git.example.com
##  ^ uncomment and set: the base URL slug-form repos resolve against.
##  NO built-in default — a slug-form repo with no gitHost is a config
##  error. Full-URL and absolute-path repos need no gitHost.
services: {}
# --- example ---
# services:
#   my-service:
#     repo: org/my-service
#     specPath: asyncapi.yaml
#     branch: main
# --- end example ---
## repo (required) — three accepted forms:
##   slug:           org/my-service        (resolved against gitHost)
##   full URL:       https://git.example.com/org/my-service.git
##   absolute path:  /home/you/checkouts/my-service
## specPath (required) — path to the AsyncAPI doc inside the repo.
## branch (optional) — defaults to main.
## Per-service extras: gitHost (overrides the global), qosDefault (0|1|2),
## retainDefault, topicOverrides — docs/guides/wiring-your-service.md.
`;

const INIT_ENVIRONMENTS = `# offbook — requested spec versions per environment (environments.yaml).
# What it is for: records WHICH spec version each environment wants, so
# provenance lands in specs.lock. v1 always fetches branch tips regardless
# (resolution-mode: branch) — you rarely touch this file until pinned
# resolution ships. Validate with \`offbook doctor\`.
environments:
  default: {}
# --- example ---
# environments:
#   staging:
#     my-service: "1.4.2"
# --- end example ---
`;

const INIT_SCENARIO = `# offbook L2 scenarios — declarative reactive/triggered emissions.
# \`offbook doctor\` shape-checks scenarios/*.yaml; a running server reports
# full binding diagnostics (\`offbook diagnostics\`).
# --- example ---
# - name: accept-set
#   when:
#     topic: command/{deviceId}/set
#   then:
#     - emit:
#         topic: state/{{deviceId}}
#         payload: { deviceId: "{{deviceId}}", status: accepted }
#         delay: 50-80ms
# --- end example ---
## Adapt the topics to your spec (\`offbook topics\` lists them); recipes:
## docs/guides/scenario-cookbook.md
`;

// R-041 — the one committed artifact that names the next step for a
// teammate WITHOUT an agent (fresh app-repo clone: mock/, scripts, and
// skill present, `offbook: command not found`). The clone URL is OBSERVED
// from the running tool's own checkout — never the app repo's remote, and
// never invented (the <internal-git> rule).
function initReadme(originUrl: string | undefined): string {
	const cloneLine =
		originUrl !== undefined
			? `git clone ${originUrl} offbook`
			: "git clone <ask a teammate for the offbook clone URL> offbook";
	return `# offbook mock project

This directory mocks this app's MQTT-over-WebSockets backend from its
AsyncAPI specs (services.yaml points at them). The app connects to
\`ws://localhost:9001\` exactly as it would to the real backend.

## Install offbook (once per machine)

\`\`\`sh
${cloneLine}
cd offbook && bun install && bun link
\`\`\`

## Use

\`\`\`sh
offbook doctor   # start here — validates this project + your environment
offbook up       # serve the mock
offbook down
\`\`\`

Guides live in the offbook checkout under docs/guides/ (getting-started,
wiring-your-service, scenario-cookbook, daily-loop).
`;
}

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
	await writeIfAbsent(
		"README.md",
		initReadme(await checkoutOrigin(repoRoot())),
	);
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
		"next: set gitHost + your services in services.yaml (validate with `offbook doctor` as you edit), then `offbook up`",
	);
	return 0;
}

// --- doctor (R-035 — preflight; adoption.md §3; CLI-local, no /v1) ---

const DOCTOR_GLYPH: Record<CheckStatus, string> = {
	pass: "✓",
	warn: "!",
	fail: "✗",
};

async function cmdDoctor(rest: string[], io: Io): Promise<number> {
	const { values, positionals } = parseFlags(rest, {
		offline: { type: "boolean" },
		json: { type: "boolean" },
		"run-dir": { type: "string" },
	});
	const runDir = runDirOf(values);
	const run = await readRunfile(runDir); // live or stale: its ports are the ones that matter
	const ctx: DoctorCtx = {
		repoRoot: join(import.meta.dir, "../.."),
		projectDir: positionals[0] ?? ".",
		runDir,
		offline: values.offline === true,
		bunVersion: Bun.version,
		stateDir: stateDirFromEnv(),
		ports: run
			? {
					ws: run.brokerWsPort,
					tcp: run.brokerTcpPort,
					ctrl: run.controlPlanePort,
				}
			: { ws: 9001, tcp: 1883, ctrl: 9080 },
	};
	const report = await runDoctor(ctx);
	if (values.json === true) {
		io.out(JSON.stringify(report));
	} else {
		for (const c of report.checks) {
			io.out(`${DOCTOR_GLYPH[c.status]} ${c.name} — ${c.detail}`);
			if (c.hint !== undefined) io.out(`    ↳ ${c.hint}`);
		}
		const fails = report.checks.filter((c) => c.status === "fail").length;
		io.out(fails === 0 ? "doctor: ok" : `doctor: ${fails} problem(s)`);
	}
	return report.ok ? 0 : 1;
}

// --- dispatch ---

export const USAGE = `usage: offbook <command>

  init [dir]                 scaffold services.yaml, environments.yaml, scenarios/, handlers/
  doctor [dir] [--offline] [--json] [--run-dir <dir>]  preflight: runtime, deps, config, spec reachability, ports
  skill install [--dest <dir>] [--force]  install the onboarding skill into this repo's .claude/skills/
  demo [--serve]             bundled demo spec — one-shot catch, or --serve to keep serving
  up [--ci] [--strict] [--watch] [--seed n] [--ws-port n] [--tcp-port n] [--ctrl-port n] [--env e]
  down                       stop the running server (idempotent)
  status [--json] [--ctrl-port n]    running/ports/mode/specs/violations at a glance
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

client verbs accept --run-dir <dir> (default .offbook) and --ctrl-port <n>; \`offbook --version\` prints the tool's version + source commit`;

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
	doctor: cmdDoctor,
	skill: cmdSkill,
};

// R-042 — the dispatch truth the VERB_FORMS coherence test pins (`demo` is
// dispatched outside the table, in run()).
export const DISPATCH_VERBS: readonly string[] = [
	...Object.keys(VERBS),
	"demo",
];

export async function run(argv: string[], io: Io = consoleIo): Promise<number> {
	const [cmd, ...rest] = argv;
	try {
		if (cmd === "--version" || cmd === "-v") {
			const root = repoRoot();
			const pkg = JSON.parse(
				await Bun.file(join(root, "package.json")).text(),
			) as { version?: string };
			io.out(
				`offbook ${pkg.version ?? "0.0.0"} (${await checkoutCommit(root)})`,
			);
			return 0;
		}
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
