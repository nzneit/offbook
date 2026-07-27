// R-016 — L2 scenario loading (l2 §3/§7): glob → sorted load (fixed code-unit
// collation) → two-tier author-time validation → the ordered dispatch table.
// Failure handling is lenient-but-loud: a broken scenario is SKIPPED and
// surfaced as a scenario-load Diagnostic (the /diagnostics surface, never the
// runtime /validation log); strict mode turns any error fatal at startup
// (runtime's job, index.ts).
import { parse as parseYaml } from "yaml";
import { parseDelay } from "#src/engine/resolve-emit.ts";
import type {
	Channel,
	Config,
	Diagnostic,
	Faker,
	Scenario,
	SpecRegistry,
} from "#src/model/index.ts";
import { fillRequired, schemaHasPath } from "./fill.ts";
import { comparePatterns, resolvePath } from "./matcher.ts";
import { TEMPLATE_RE, parseRef, scanValue } from "./template.ts";

export interface LoadedScenario {
	scenario: Scenario;
	source: string; // file path relative to the scenarios dir
	captures: string[]; // {param} names captured by when.topic, in order
	whenChannel?: Channel; // first intersecting fromClient channel (trigger-time inbound faking)
	stepUsesInbound: boolean[]; // per step: references {{payload.*}} (runtime pre-draw hint)
}

export interface LoadResult {
	table: LoadedScenario[]; // dispatch order: sorted file path → in-file declaration order
	diagnostics: Diagnostic[];
}

export interface LoaderDeps {
	registry: SpecRegistry;
	faker: Faker;
	config: Config;
}

const CAPTURE_RE = /\{([^{}/]+)\}/g;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

const PARAM_SOURCES =
	"a '{{param}}' is bound by a {param} capture in when.topic or by the trigger request 'params'";

export async function loadScenarios(
	dir: string,
	deps: LoaderDeps,
): Promise<LoadResult> {
	const glob = new Bun.Glob("**/*.yaml");
	const sources = (await Array.fromAsync(glob.scan({ cwd: dir }))).sort();
	const files: { source: string; text: string }[] = [];
	for (const source of sources)
		files.push({ source, text: await Bun.file(`${dir}/${source}`).text() });
	return buildTable(files, deps);
}

export async function buildTable(
	files: { source: string; text: string }[],
	deps: LoaderDeps,
): Promise<LoadResult> {
	const table: LoadedScenario[] = [];
	const diagnostics: Diagnostic[] = [];
	const nameOrigin = new Map<string, string>();

	const err = (detail: string, source: string, scenarioName?: string) =>
		diagnostics.push({
			kind: "scenario-load",
			severity: "error",
			detail,
			source,
			scenarioName,
		});

	for (const { source, text } of files) {
		let doc: unknown;
		try {
			doc = parseYaml(text);
		} catch (e) {
			err(`YAML parse failed — ${e instanceof Error ? e.message : e}`, source);
			continue;
		}
		if (doc === null || doc === undefined) continue; // comments-only file
		if (!Array.isArray(doc)) {
			err(
				"expected a YAML list of scenarios (a file is a list, l2 §3)",
				source,
			);
			continue;
		}
		for (let idx = 0; idx < doc.length; idx++) {
			const loaded = await validateScenario(doc[idx], idx, source, deps);
			if ("errors" in loaded) {
				for (const detail of loaded.errors) err(detail, source, loaded.name);
				continue;
			}
			const prior = nameOrigin.get(loaded.entry.scenario.name);
			if (prior !== undefined) {
				err(
					`duplicate scenario name '${loaded.entry.scenario.name}' (already defined in ${prior}) — names are globally unique (l2 §2)`,
					source,
					loaded.entry.scenario.name,
				);
				continue;
			}
			nameOrigin.set(loaded.entry.scenario.name, source);
			table.push(loaded.entry);
		}
	}

	diagnostics.push(...detectOverlaps(table));
	return { table, diagnostics };
}

// One scenario through the l2 §7 load-time tiers: structural → topic/
// direction → reference resolvability (EQ7 included) → skeleton schema check.
async function validateScenario(
	raw: unknown,
	idx: number,
	source: string,
	deps: LoaderDeps,
): Promise<{ entry: LoadedScenario } | { errors: string[]; name?: string }> {
	const { registry, faker, config } = deps;

	if (!isPlainObject(raw)) return { errors: [`scenario #${idx}: not a map`] };
	const name = raw.name;
	if (typeof name !== "string" || name.length === 0)
		return { errors: [`scenario #${idx}: missing required 'name' (string)`] };

	const errors: string[] = [];
	for (const k of Object.keys(raw))
		if (k !== "name" && k !== "when" && k !== "then")
			// loud, not lenient: a typo'd 'when' would otherwise silently turn a
			// reactive scenario into an on-demand one
			errors.push(`unknown key '${k}' (a scenario is name/when?/then, l2 §9)`);

	// --- when ---
	let when: Scenario["when"];
	let captures: string[] = [];
	let whenChannel: Channel | undefined;
	if (raw.when !== undefined) {
		if (!isPlainObject(raw.when)) {
			errors.push(`'when' must be a map with a 'topic'`);
		} else {
			const w = raw.when;
			for (const k of Object.keys(w))
				if (k !== "topic" && k !== "payloadMatch")
					errors.push(`unknown 'when' key '${k}' (topic/payloadMatch only)`);
			if (typeof w.topic !== "string" || w.topic.length === 0) {
				errors.push(`'when' requires a 'topic' (string)`);
			} else {
				const topic = w.topic;
				const levels = topic.split("/");
				if (levels.includes("#") && levels.indexOf("#") !== levels.length - 1)
					errors.push(
						`'#' must be the terminal level in when.topic '${topic}' (MQTT 3.1.1, l2 §4)`,
					);
				let payloadMatch: Record<string, unknown> | undefined;
				if (w.payloadMatch !== undefined) {
					if (!isPlainObject(w.payloadMatch))
						errors.push(`'payloadMatch' must be a map of dotted-path: value`);
					else payloadMatch = w.payloadMatch;
				}
				captures = [...topic.matchAll(CAPTURE_RE)].flatMap((m) =>
					m[1] === undefined ? [] : [m[1]],
				);
				// direction check (l2 §7): 'when' fires on client publishes
				const intersecting = registry
					.channels()
					.filter((c) => comparePatterns(topic, c.topic).intersects);
				whenChannel = intersecting.find((c) => c.direction === "fromClient");
				if (!whenChannel)
					errors.push(
						intersecting.length > 0
							? `when.topic '${topic}' matches only toClient channels (${intersecting.map((c) => `'${c.topic}'`).join(", ")}) — 'when' fires on client (fromClient) publishes`
							: `when.topic '${topic}' matches no fromClient channel in any consumed spec`,
					);
				when = { topic, payloadMatch };
			}
		}
	}

	const finish = (errs: string[]) => ({
		errors: errs.map((e) => `'${name}': ${e}`),
		name,
	});

	// --- then ---
	if (!Array.isArray(raw.then) || raw.then.length === 0)
		return finish([
			...errors,
			`'then' must be a non-empty list of steps (l2 §2)`,
		]);

	const steps: Scenario["then"] = [];
	const stepUsesInbound: boolean[] = [];
	// the inbound base draw for {{payload.*}} stand-ins, drawn at most once
	let inboundBase: unknown;
	let inboundBaseDrawn = false;
	for (let i = 0; i < raw.then.length; i++) {
		const step = raw.then[i];
		const at = `step ${i}`;
		if (!isPlainObject(step) || !isPlainObject(step.emit)) {
			errors.push(`${at}: the only step kind in v1 is 'emit' (l2 §2)`);
			continue;
		}
		for (const k of Object.keys(step))
			if (k !== "emit")
				errors.push(`${at}: unknown step key '${k}' (v1 steps are emit-only)`);
		const emit = step.emit;
		for (const k of Object.keys(emit))
			if (k !== "topic" && k !== "payload" && k !== "delay")
				errors.push(`${at}: unknown emit key '${k}' (topic/payload/delay)`);
		if (typeof emit.topic !== "string" || emit.topic.length === 0) {
			errors.push(`${at}: emit.topic is required (string)`);
			continue;
		}
		let delay: string | undefined;
		if (emit.delay !== undefined) {
			if (typeof emit.delay !== "string") {
				errors.push(
					`${at}: delay must be a string ("<n>ms|s" or "<min>-<max>ms|s") — units are required, no bare numbers (l2 §6)`,
				);
			} else {
				delay = emit.delay;
				try {
					parseDelay(delay, config, { scenarioName: name, stepIndex: i });
				} catch (e) {
					errors.push(`${at}: ${e instanceof Error ? e.message : e}`);
				}
			}
		}

		const stepErrorsBefore = errors.length;

		// EQ7 — a single-brace segment on the emit side is a capture written
		// where a substitution was meant; teach, never a bare "unknown param"
		const scan = scanValue(emit.payload, scanValue(emit.topic));
		for (const s of scan.singleBrace)
			errors.push(
				`${at}: single-brace '{…}' in emit field '${s}' — single braces CAPTURE (when.topic only); double braces SUBSTITUTE on the emit side (write '{{param}}'); ${PARAM_SOURCES}`,
			);
		for (const o of scan.occurrences) {
			if (!o.ref) {
				errors.push(
					`${at}: unknown template reference '${o.raw}' — the closed vocabulary is {{param}}, {{payload.<path>}}, {{uuid}}, {{seq}}, {{now}} (l2 §5)`,
				);
				continue;
			}
			if (o.ref.kind === "param" && when && !captures.includes(o.ref.name))
				errors.push(
					`${at}: '${o.raw}' has no source — not captured by when.topic (captures here: ${captures.length ? captures.join(", ") : "none"}); ${PARAM_SOURCES} (when-less scenarios only)`,
				);
			if (
				o.ref.kind === "payload" &&
				whenChannel &&
				!schemaHasPath(whenChannel.schema, o.ref.path)
			)
				errors.push(
					`${at}: '${o.raw}' is not in the inbound channel schema for '${whenChannel.topic}'`,
				);
		}

		// topic/direction check: every {{…}} aligns with a channel-address
		// level, so a dummy segment finds the channel iff the shape fits
		const dummyTopic = emit.topic.replace(TEMPLATE_RE, "x0");
		const m = registry.match(dummyTopic);
		if (!m)
			errors.push(
				`${at}: emit.topic '${emit.topic}' resolves to no channel in any consumed spec`,
			);
		else if (m.channel.direction !== "toClient")
			errors.push(
				`${at}: emit.topic '${emit.topic}' resolves to fromClient channel '${m.channel.topic}' — emits are mock→client (toClient)`,
			);

		// skeleton schema check (l2 §7): substitute stand-ins, L1-autofill, Ajv.
		// Skipped when the step already failed — stand-ins would be meaningless.
		if (
			m &&
			m.channel.direction === "toClient" &&
			errors.length === stepErrorsBefore
		) {
			let emitBase: unknown;
			try {
				emitBase = await faker(m.channel);
			} catch {
				// a rejecting faker leaves the runtime F5 drop-and-surface to it
			}
			const needsInbound = scan.occurrences.some(
				(o) => o.ref?.kind === "payload",
			);
			if (needsInbound && whenChannel && !inboundBaseDrawn) {
				inboundBaseDrawn = true;
				try {
					inboundBase = await faker(whenChannel);
				} catch {}
			}
			const skeleton = skeletonize(emit.payload, emitBase, inboundBase, config);
			const filled = fillRequired(skeleton, m.channel.schema, emitBase);
			const schemaErrors = m.channel.validate(filled);
			const first = schemaErrors[0];
			if (first)
				errors.push(
					`${at}: skeleton payload fails the schema of '${m.channel.topic}' — ${first.instancePath || "/"}: ${first.keyword}${schemaErrors.length > 1 ? ` (+${schemaErrors.length - 1} more)` : ""}`,
				);
		}

		steps.push({ emit: { topic: emit.topic, payload: emit.payload, delay } });
		stepUsesInbound.push(
			scan.occurrences.some((o) => o.ref?.kind === "payload"),
		);
	}

	if (errors.length > 0) return finish(errors);
	return {
		entry: {
			// biome-ignore lint/suspicious/noThenProperty: `then` is the contracts §3a Scenario field (frozen interface), not a thenable
			scenario: { name, when, then: steps },
			source,
			captures,
			whenChannel,
			stepUsesInbound,
		},
	};
}

// Type-appropriate stand-ins (l2 §7): a templated field is vouched by a value
// of its RUNTIME type — payload refs by the faked inbound draw, {{seq}}/
// {{now}} by numbers, {{uuid}}/{{param}} by strings (base draw preferred, so
// enums/patterns don't false-positive) — while literals are checked as-is.
export const SKELETON_UUID = "00000000-0000-4000-8000-000000000000";

function skeletonize(
	value: unknown,
	base: unknown,
	inboundBase: unknown,
	config: Config,
): unknown {
	if (typeof value === "string") {
		const matches = [...value.matchAll(TEMPLATE_RE)];
		if (matches.length === 0) return value;
		const first = matches[0];
		if (matches.length === 1 && first && first[0] === value) {
			const ref = parseRef(first[1] ?? "");
			switch (ref?.kind) {
				case "payload":
					return resolvePath(inboundBase, ref.path);
				case "seq":
					return 0;
				case "now":
					return config.fixedEpoch;
				case "uuid":
					return SKELETON_UUID;
				default:
					// {{param}} binds a topic segment — always a string
					return typeof base === "string" ? base : "x";
			}
		}
		// embedded templates interpolate to strings at runtime
		return typeof base === "string" ? base : value.replace(TEMPLATE_RE, "x");
	}
	if (Array.isArray(value)) {
		const baseArr = Array.isArray(base) ? base : [];
		return value
			.map((v, i) => skeletonize(v, baseArr[i], inboundBase, config))
			.filter((v) => v !== undefined);
	}
	if (isPlainObject(value)) {
		const baseObj = isPlainObject(base) ? base : {};
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			const sv = skeletonize(v, baseObj[k], inboundBase, config);
			if (sv !== undefined) out[k] = sv;
		}
		return out;
	}
	return value;
}

// l2 §3 — loud overlap warnings over the final table order: an EARLIER
// unconditional scenario steals the intersection from a later one (warning);
// scenarios disambiguated only by payloadMatch both stay reachable (info).
function detectOverlaps(table: LoadedScenario[]): Diagnostic[] {
	const out: Diagnostic[] = [];
	for (let i = 0; i < table.length; i++) {
		const a = table[i];
		if (!a?.scenario.when) continue;
		for (let j = i + 1; j < table.length; j++) {
			const b = table[j];
			if (!b?.scenario.when) continue;
			const rel = comparePatterns(a.scenario.when.topic, b.scenario.when.topic);
			if (!rel.intersects) continue;
			if (a.scenario.when.payloadMatch)
				out.push({
					kind: "overlap",
					severity: "info",
					detail: `'${a.scenario.name}' and '${b.scenario.name}' overlap on ${rel.witness}, disambiguated by payload`,
					source: b.source,
					scenarioName: b.scenario.name,
				});
			else
				out.push({
					kind: "overlap",
					severity: "warning",
					detail: `'${a.scenario.name}' shadows '${b.scenario.name}' for ${rel.witness}`,
					source: b.source,
					scenarioName: b.scenario.name,
				});
		}
	}
	return out;
}
