// R-016 — loader/author-time validation (l2 §3/§7): dispatch-table order,
// structural + direction + reference-resolvability (EQ7 teaching diagnostics)
// + skeleton schema checks, lenient-but-loud skipping, overlap detection.
// [utest->R-016]
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "#src/config/index.ts";
import type { Channel, Faker, SpecRegistry } from "#src/model/index.ts";
import { buildTable, loadScenarios } from "./loader.ts";
import { matchTopic } from "./matcher.ts";

const stateSchema = {
	type: "object",
	additionalProperties: false,
	required: ["deviceId", "status", "units"],
	properties: {
		deviceId: { type: "string" },
		status: { type: "string" },
		units: { type: "string" },
		target: { type: "number" },
		updatedAt: { type: "number" },
	},
};

const commandSchema = {
	type: "object",
	additionalProperties: false,
	required: ["mode"],
	properties: {
		mode: { type: "string" },
		target: { type: "number" },
		status: { type: "object", properties: { code: { type: "number" } } },
	},
};

function makeChannel(
	topic: string,
	direction: Channel["direction"],
	schema: object,
): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
	return {
		topic,
		direction,
		service: "t",
		schema,
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
	};
}

const channels = [
	makeChannel("command/{deviceId}/set", "fromClient", commandSchema),
	makeChannel("state/{deviceId}", "toClient", stateSchema),
];

const registry: SpecRegistry = {
	diagnostics: () => [],
	match(topic) {
		for (const channel of channels) {
			const params = matchTopic(channel.topic, topic);
			if (params) return { channel, params };
		}
		return undefined;
	},
	matchesFilter: () => false,
	channels: () => channels,
};

const fakes: Record<string, unknown> = {
	"state/{deviceId}": {
		deviceId: "fake-dev",
		status: "fake-status",
		units: "celsius",
		target: 0,
		updatedAt: 1,
	},
	"command/{deviceId}/set": { mode: "heat", target: 21 },
};
const faker: Faker = async (c) => structuredClone(fakes[c.topic]);

const deps = { registry, faker, config: loadConfig({}) };

const load = (text: string, source = "50-test.yaml") =>
	buildTable([{ source, text }], deps);

const errorsOf = (r: Awaited<ReturnType<typeof buildTable>>) =>
	r.diagnostics.filter((d) => d.severity === "error").map((d) => d.detail);

// a minimal valid when-less scenario body (block style: braces are legal in
// plain scalars there, mirroring the l2 §0 canonical example)
const emitOnly = (name: string, topic = "state/{{deviceId}}") =>
	`- name: ${name}\n  then:\n    - emit:\n        topic: ${topic}\n        payload: { status: x }\n`;

describe("table building & order", () => {
	test("the canonical l2 §0 example loads clean", async () => {
		const r = await load(`
- name: set-temperature-heat
  when:
    topic: command/{deviceId}/set
    payloadMatch: { mode: heat }
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          target: "{{payload.target}}"
          status: accepted
          updatedAt: "{{now}}"
        delay: 150-300ms
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: heating }
        delay: 1-2s

- name: device-offline
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: offline }
`);
		expect(errorsOf(r)).toEqual([]);
		expect(r.table.map((e) => e.scenario.name)).toEqual([
			"set-temperature-heat",
			"device-offline",
		]);
		expect(r.table[0]?.captures).toEqual(["deviceId"]);
		expect(r.table[0]?.whenChannel?.topic).toBe("command/{deviceId}/set");
		expect(r.table[0]?.scenario.then).toHaveLength(2);
		expect(r.table[1]?.scenario.when).toBeUndefined();
	});

	test("dispatch order is sorted file path → in-file order (glob path)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "offbook-l2-"));
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "50-b.yaml"), emitOnly("b1") + emitOnly("b2"));
		writeFileSync(join(dir, "00-a.yaml"), emitOnly("a1"));
		writeFileSync(join(dir, "sub/10-c.yaml"), emitOnly("c1"));
		const r = await loadScenarios(dir, deps);
		expect(errorsOf(r)).toEqual([]);
		expect(r.table.map((e) => e.scenario.name)).toEqual([
			"a1",
			"b1",
			"b2",
			"c1",
		]);
		expect(r.table.map((e) => e.source)).toEqual([
			"00-a.yaml",
			"50-b.yaml",
			"50-b.yaml",
			"sub/10-c.yaml",
		]);
	});

	test("a comments-only file contributes nothing, loudly nothing", async () => {
		const r = await load("# just notes\n");
		expect(r.table).toHaveLength(0);
		expect(r.diagnostics).toHaveLength(0);
	});
});

describe("lenient-but-loud skipping (l2 §7)", () => {
	test("malformed YAML skips the file, other files still load", async () => {
		const r = await buildTable(
			[
				{ source: "00-bad.yaml", text: "- name: x\n  then: [\n" },
				{ source: "50-good.yaml", text: emitOnly("ok") },
			],
			deps,
		);
		expect(r.table.map((e) => e.scenario.name)).toEqual(["ok"]);
		expect(errorsOf(r)[0]).toContain("YAML parse failed");
		expect(r.diagnostics[0]?.source).toBe("00-bad.yaml");
	});

	test("a non-list document is a file-level error", async () => {
		const r = await load("name: not-a-list\n");
		expect(errorsOf(r)[0]).toContain("expected a YAML list");
	});

	test("structural errors: name/then/step shape/unknown keys", async () => {
		const r = await load(`
- then:
    - emit:
        topic: state/lobby
        payload: { status: x }
- name: no-then
- name: empty-then
  then: []
- name: bad-step
  then:
    - emitt:
        topic: state/lobby
- name: typo-when
  whn:
    topic: command/{d}/set
  then:
    - emit:
        topic: state/{{d}}
        payload: { status: x }
`);
		expect(r.table).toHaveLength(0);
		const errs = errorsOf(r);
		expect(
			errs.find((e) => e.includes("missing required 'name'")),
		).toBeDefined();
		expect(errs.filter((e) => e.includes("non-empty list"))).toHaveLength(2);
		expect(
			errs.find((e) => e.includes("only step kind in v1 is 'emit'")),
		).toBeDefined();
		expect(errs.find((e) => e.includes("unknown key 'whn'"))).toBeDefined();
	});

	test("duplicate names: the later one is skipped and names the origin", async () => {
		const r = await buildTable(
			[
				{ source: "00-a.yaml", text: emitOnly("dup") },
				{ source: "50-b.yaml", text: emitOnly("dup") },
			],
			deps,
		);
		expect(r.table).toHaveLength(1);
		expect(errorsOf(r)[0]).toContain("already defined in 00-a.yaml");
	});

	test("non-terminal # and malformed delays are load errors", async () => {
		const r = await load(`
- name: bad-hash
  when:
    topic: command/#/set
  then:
    - emit:
        topic: state/lobby
        payload: { status: x }
- name: bad-delays
  then:
    - emit:
        topic: state/lobby
        payload: { status: x }
        delay: "150"
    - emit:
        topic: state/lobby
        payload: { status: x }
        delay: 300-150ms
    - emit:
        topic: state/lobby
        payload: { status: x }
        delay: 20
`);
		const errs = errorsOf(r);
		expect(
			errs.find((e) => e.includes("'#' must be the terminal level")),
		).toBeDefined();
		expect(errs.filter((e) => e.includes("malformed delay"))).toHaveLength(2);
		expect(
			errs.find((e) => e.includes("delay must be a string")),
		).toBeDefined();
	});
});

describe("references & directions (l2 §7)", () => {
	test("EQ7: single-brace on an emit field teaches the convention", async () => {
		const r = await load(`
- name: eq7
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{deviceId}
        payload: { status: x }
`);
		const err = errorsOf(r)[0] ?? "";
		expect(err).toContain("single-brace");
		expect(err).toContain("when.topic");
		expect(err).toContain("trigger request 'params'");
		expect(r.table).toHaveLength(0);
	});

	test("unknown template references are rejected (closed vocabulary)", async () => {
		const r = await load(`
- name: unknowns
  then:
    - emit:
        topic: state/lobby
        payload: { status: "{{payload}}", units: "{{now.iso}}" }
`);
		const errs = errorsOf(r);
		expect(
			errs.filter((e) => e.includes("unknown template reference")),
		).toHaveLength(2);
	});

	test("a reactive scenario's {{param}} must be captured; when-less is free", async () => {
		const r = await load(`
- name: reactive-bad
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{roomId}}
        payload: { status: x }
- name: ondemand-ok
  then:
    - emit:
        topic: state/{{roomId}}
        payload: { status: x }
`);
		expect(r.table.map((e) => e.scenario.name)).toEqual(["ondemand-ok"]);
		const err = errorsOf(r)[0] ?? "";
		expect(err).toContain("'{{roomId}}' has no source");
		expect(err).toContain("captures here: deviceId");
		expect(err).toContain("trigger request 'params'");
	});

	test("{{payload.<path>}} must exist in the inbound channel schema", async () => {
		const r = await load(`
- name: ghost-path
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: "{{payload.ghost}}" }
`);
		expect(errorsOf(r)[0]).toContain(
			"'{{payload.ghost}}' is not in the inbound channel schema",
		);
	});

	test("when.topic direction errors distinguish toClient-only from no-match", async () => {
		const r = await load(`
- name: wrong-direction
  when:
    topic: state/{deviceId}
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { status: x }
- name: no-channel
  when:
    topic: nothing/here
  then:
    - emit:
        topic: state/lobby
        payload: { status: x }
`);
		const errs = errorsOf(r);
		expect(
			errs.find((e) => e.includes("matches only toClient channels")),
		).toBeDefined();
		expect(
			errs.find((e) => e.includes("matches no fromClient channel")),
		).toBeDefined();
	});

	test("emit.topic must resolve to a toClient channel", async () => {
		const r = await load(`
- name: emit-nowhere
  then:
    - emit:
        topic: ghost/{{d}}
        payload: { status: x }
- name: emit-inbound
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: command/{{deviceId}}/set
        payload: { mode: heat }
`);
		const errs = errorsOf(r);
		expect(
			errs.find((e) => e.includes("resolves to no channel")),
		).toBeDefined();
		expect(
			errs.find((e) => e.includes("resolves to fromClient channel")),
		).toBeDefined();
	});
});

describe("skeleton schema check (l2 §7)", () => {
	test("wrong-typed literals and unknown fields fail at load", async () => {
		const r = await load(`
- name: bad-literal
  then:
    - emit:
        topic: state/lobby
        payload: { status: x, target: twenty }
- name: unknown-field
  then:
    - emit:
        topic: state/lobby
        payload: { status: x, extra: 1 }
`);
		const errs = errorsOf(r);
		expect(
			errs.filter((e) => e.includes("skeleton payload fails")),
		).toHaveLength(2);
	});

	test("a cross-schema type mismatch through {{payload.*}} is caught", async () => {
		// inbound target is a number; units wants a string
		const r = await load(`
- name: cross-type
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: x, units: "{{payload.target}}" }
`);
		expect(errorsOf(r)[0]).toContain("skeleton payload fails");
	});

	test("templated causal fields + autofilled required fields pass", async () => {
		const r = await load(`
- name: minimal
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", target: "{{payload.target}}", updatedAt: "{{now}}" }
`);
		expect(errorsOf(r)).toEqual([]);
		expect(r.table).toHaveLength(1);
	});
});

describe("overlap detection (l2 §3)", () => {
	test("an earlier unconditional scenario shadows a later one (warning)", async () => {
		const r = await buildTable(
			[
				{
					source: "00-first.yaml",
					text: "- name: thermostat-1-rejects\n  when:\n    topic: command/thermostat-1/set\n  then:\n    - emit:\n        topic: state/thermostat-1\n        payload: { status: x }\n",
				},
				{
					source: "50-general.yaml",
					text: "- name: set-temp-ack\n  when:\n    topic: command/{deviceId}/set\n  then:\n    - emit:\n        topic: state/{{deviceId}}\n        payload: { status: x }\n",
				},
			],
			deps,
		);
		expect(errorsOf(r)).toEqual([]);
		const warn = r.diagnostics.find(
			(d) => d.kind === "overlap" && d.severity === "warning",
		);
		expect(warn?.detail).toBe(
			"'thermostat-1-rejects' shadows 'set-temp-ack' for command/thermostat-1/set",
		);
		expect(warn?.scenarioName).toBe("set-temp-ack");
		expect(warn?.source).toBe("50-general.yaml");
	});

	test("payload-disambiguated overlap is informational", async () => {
		const r = await load(`
- name: set-heat
  when:
    topic: command/{deviceId}/set
    payloadMatch: { mode: heat }
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { status: heating }
- name: set-generic-ack
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { status: accepted }
`);
		expect(errorsOf(r)).toEqual([]);
		const info = r.diagnostics.find((d) => d.kind === "overlap");
		expect(info?.severity).toBe("info");
		expect(info?.detail).toContain("disambiguated by payload");
		// the later topic-only fallback is NOT warned against — this is the
		// documented specific-above-general layout
		expect(r.diagnostics.find((d) => d.severity === "warning")).toBeUndefined();
	});

	test("disjoint topics produce no overlap diagnostics", async () => {
		const r = await load(`
- name: a
  when:
    topic: command/a/set
  then:
    - emit:
        topic: state/room-a
        payload: { status: x }
- name: b
  when:
    topic: command/b/set
  then:
    - emit:
        topic: state/room-b
        payload: { status: x }
`);
		expect(errorsOf(r)).toEqual([]);
		expect(r.diagnostics.filter((d) => d.kind === "overlap")).toHaveLength(0);
	});
});
