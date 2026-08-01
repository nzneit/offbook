// R-016 — the closed {{…}} templating vocabulary (l2 §5): parse, scan (incl.
// EQ7 single-brace detection), substitution semantics (type-preserving
// whole-string vs string interpolation, OMIT on unresolved), seeded UUID.
// [utest->R-016]
import { describe, expect, test } from "bun:test";
import { hashToInt, mulberry32 } from "#src/engine/prng.ts";
import {
	OMIT,
	parseRef,
	scanValue,
	seededUuid,
	substitute,
	type TemplateRef,
} from "./template.ts";

describe("parseRef", () => {
	test("closed vocabulary parses; anything else is rejected", () => {
		expect(parseRef("deviceId")).toEqual({ kind: "param", name: "deviceId" });
		expect(parseRef("payload.target")).toEqual({
			kind: "payload",
			path: "target",
		});
		expect(parseRef("payload.status.code")).toEqual({
			kind: "payload",
			path: "status.code",
		});
		expect(parseRef("uuid")).toEqual({ kind: "uuid" });
		expect(parseRef("seq")).toEqual({ kind: "seq" });
		expect(parseRef("now")).toEqual({ kind: "now" });
		expect(parseRef("payload")).toBeUndefined(); // bare payload: no path
		expect(parseRef("payload.")).toBeUndefined();
		expect(parseRef("now.iso")).toBeUndefined(); // helpers take no paths
		expect(parseRef("")).toBeUndefined();
	});
});

describe("scanValue", () => {
	test("collects occurrences depth-first; keys are never templated", () => {
		const scan = scanValue({
			topic: "state/{{deviceId}}",
			nested: { at: "{{now}}", arr: ["{{seq}}", 42] },
			"{{notAKey}}": "literal",
		});
		expect(scan.occurrences.map((o) => o.raw)).toEqual([
			"{{deviceId}}",
			"{{now}}",
			"{{seq}}",
		]);
		expect(scan.singleBrace).toEqual([]);
	});

	test("flags single-brace residue (EQ7) and unknown refs", () => {
		const scan = scanValue({
			topic: "state/{deviceId}",
			bad: "{{what.ever}}",
		});
		expect(scan.singleBrace).toEqual(["state/{deviceId}"]);
		const unknown = scan.occurrences.filter((o) => !o.ref);
		expect(unknown.map((o) => o.raw)).toEqual(["{{what.ever}}"]);
	});

	test("a stray brace next to a well-formed template is still EQ7 residue", () => {
		expect(scanValue("x/{{{id}}}").singleBrace).toEqual(["x/{{{id}}}"]);
	});
});

describe("substitute", () => {
	const values: Record<string, unknown> = {
		"param:deviceId": "t1",
		"payload:target": 21.5,
		"payload:status.code": 2,
		seq: 7,
		now: 1_700_000_000_150,
	};
	function resolver(ref: TemplateRef): unknown {
		switch (ref.kind) {
			case "param":
				return values[`param:${ref.name}`];
			case "payload":
				return values[`payload:${ref.path}`];
			default:
				return values[ref.kind];
		}
	}

	test("whole-string template preserves the resolved type", () => {
		expect(substitute("{{payload.target}}", resolver)).toBe(21.5);
		expect(substitute("{{seq}}", resolver)).toBe(7);
		expect(substitute("{{ deviceId }}", resolver)).toBe("t1"); // inner whitespace tolerated
	});

	test("embedded templates interpolate as strings", () => {
		expect(substitute("dev-{{deviceId}}@{{now}}", resolver)).toBe(
			"dev-t1@1700000000150",
		);
	});

	test("unresolved whole-string templates OMIT the field for L1 autofill", () => {
		expect(substitute("{{ghost}}", resolver)).toBe(OMIT);
		expect(
			substitute({ keep: "{{deviceId}}", drop: "{{ghost}}" }, resolver),
		).toEqual({ keep: "t1" });
		expect(substitute(["{{ghost}}", "{{seq}}"], resolver)).toEqual([7]);
		expect(substitute("a-{{ghost}}-b", resolver)).toBe("a--b");
	});

	test("recurses through objects and arrays; non-strings pass through", () => {
		expect(
			substitute(
				{
					deviceId: "{{deviceId}}",
					data: [{ code: "{{payload.status.code}}" }, true],
				},
				resolver,
			),
		).toEqual({ deviceId: "t1", data: [{ code: 2 }, true] });
	});

	test("strings outside the vocabulary pass through untouched", () => {
		expect(substitute("{{not a ref}}", resolver)).toBe("{{not a ref}}");
		expect(substitute("plain", resolver)).toBe("plain");
	});
});

describe("seededUuid", () => {
	test("deterministic per key, v4-shaped, distinct across counter values", () => {
		const draw = (k: string) => mulberry32(hashToInt(k));
		const a = seededUuid(draw("1|uuid|s|0"));
		const b = seededUuid(draw("1|uuid|s|0"));
		const c = seededUuid(draw("1|uuid|s|1"));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});
