// R-016 — schema-guided payload shaping: required-field autofill from the
// seeded L1 base draw (l2 §5) and the static {{payload.<path>}} schema check
// (l2 §7), incl. allOf composition and the free-form escape hatch.
// [utest->R-016]
import { describe, expect, test } from "bun:test";
import { fillRequired, schemaHasPath } from "./fill.ts";

const schema = {
	type: "object",
	required: ["deviceId", "status", "units"],
	properties: {
		deviceId: { type: "string" },
		status: { type: "string" },
		units: { type: "string" },
		optional: { type: "number" },
		nested: {
			type: "object",
			required: ["a", "b"],
			properties: { a: { type: "number" }, b: { type: "number" } },
		},
	},
};

const base = {
	deviceId: "base-dev",
	status: "base-status",
	units: "celsius",
	optional: 9,
	nested: { a: 1, b: 2 },
};

describe("fillRequired", () => {
	test("fills omitted required fields from base; keeps authored values", () => {
		expect(
			fillRequired({ deviceId: "t1", status: "heating" }, schema, base),
		).toEqual({ deviceId: "t1", status: "heating", units: "celsius" });
	});

	test("does NOT fill omitted optionals (required-only, l2 §5)", () => {
		const out = fillRequired({ deviceId: "t1", status: "s" }, schema, base) as {
			optional?: number;
		};
		expect(out.optional).toBeUndefined();
	});

	test("recurses into authored sub-objects", () => {
		expect(
			fillRequired(
				{ deviceId: "t1", status: "s", nested: { a: 5 } },
				schema,
				base,
			),
		).toEqual({
			deviceId: "t1",
			status: "s",
			units: "celsius",
			nested: { a: 5, b: 2 },
		});
	});

	test("absent payload on an object schema fills all required from base", () => {
		expect(fillRequired(undefined, schema, base)).toEqual({
			deviceId: "base-dev",
			status: "base-status",
			units: "celsius",
		});
	});

	test("absent payload on a scalar schema takes the base wholesale", () => {
		expect(fillRequired(undefined, { type: "number" }, 42)).toBe(42);
	});

	test("scalar/array authored payloads pass through untouched", () => {
		expect(fillRequired("lit", schema, base)).toBe("lit");
		expect(fillRequired([1, 2], schema, base)).toEqual([1, 2]);
	});

	test("allOf branches compose properties + required", () => {
		const composed = {
			allOf: [
				{
					type: "object",
					required: ["a"],
					properties: { a: { type: "number" } },
				},
				{
					type: "object",
					required: ["b"],
					properties: { b: { type: "number" } },
				},
			],
		};
		expect(fillRequired({ a: 1 }, composed, { a: 0, b: 7 })).toEqual({
			a: 1,
			b: 7,
		});
	});

	test("missing base leaves gaps for the Ajv recheck to surface", () => {
		expect(fillRequired({ deviceId: "t1" }, schema, undefined)).toEqual({
			deviceId: "t1",
		});
	});
});

describe("schemaHasPath", () => {
	test("finds declared paths, rejects undeclared ones", () => {
		expect(schemaHasPath(schema, "deviceId")).toBe(true);
		expect(schemaHasPath(schema, "nested.b")).toBe(true);
		expect(schemaHasPath(schema, "ghost")).toBe(false);
		expect(schemaHasPath(schema, "nested.ghost")).toBe(false);
	});

	test("any oneOf/anyOf branch counts", () => {
		const s = {
			oneOf: [
				{ type: "object", properties: { mode: { type: "string" } } },
				{ type: "object", properties: { level: { type: "number" } } },
			],
		};
		expect(schemaHasPath(s, "mode")).toBe(true);
		expect(schemaHasPath(s, "level")).toBe(true);
		expect(schemaHasPath(s, "ghost")).toBe(false);
	});

	test("a free-form level (no declared properties) is uncheckable → passes", () => {
		expect(schemaHasPath({ type: "object" }, "anything.goes")).toBe(true);
		expect(
			schemaHasPath(
				{
					type: "object",
					properties: { blob: { type: "object" } },
				},
				"blob.deep.field",
			),
		).toBe(true);
	});
});
