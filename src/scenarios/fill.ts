// R-016 — schema-guided payload shaping (l2 §5/§7): the author templates only
// the causal fields; omitted REQUIRED schema fields are backfilled from the
// seeded L1 base draw. The walk is deliberately conservative — allOf branches
// compose, oneOf/anyOf are never filled (the branch is statically unknowable)
// — because the emit-time Ajv recheck (engine.publish) backstops anything it
// can't decide, never silently.

interface EffectiveSchema {
	properties: Record<string, unknown>;
	required: string[];
	object: boolean;
}

function effective(schema: unknown, depth = 0): EffectiveSchema {
	const out: EffectiveSchema = { properties: {}, required: [], object: false };
	if (
		depth > 16 ||
		schema === null ||
		typeof schema !== "object" ||
		Array.isArray(schema)
	)
		return out;
	const s = schema as Record<string, unknown>;
	if (s.type === "object" || s.properties !== undefined) out.object = true;
	if (
		s.properties !== null &&
		typeof s.properties === "object" &&
		!Array.isArray(s.properties)
	)
		Object.assign(out.properties, s.properties);
	if (Array.isArray(s.required))
		out.required.push(
			...s.required.filter((r): r is string => typeof r === "string"),
		);
	if (Array.isArray(s.allOf)) {
		for (const branch of s.allOf) {
			const e = effective(branch, depth + 1);
			out.object ||= e.object;
			Object.assign(out.properties, e.properties);
			out.required.push(...e.required);
		}
	}
	return out;
}

// Fill omitted required properties of `authored` from `base` (the seeded L1
// draw), recursing into authored sub-objects that have a declared subschema.
// Arrays pass through untouched (Ajv backstops). An absent authored payload
// on an object schema fills from {}; on a scalar schema the base IS the
// payload.
export function fillRequired(
	authored: unknown,
	schema: unknown,
	base: unknown,
): unknown {
	const eff = effective(schema);
	let value = authored;
	if (value === undefined) {
		if (!eff.object) return base;
		value = {};
	}
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!eff.object
	)
		return value;
	const src = value as Record<string, unknown>;
	const baseObj =
		base !== null && typeof base === "object" && !Array.isArray(base)
			? (base as Record<string, unknown>)
			: undefined;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(src)) {
		const sub = eff.properties[k];
		out[k] =
			v !== null && typeof v === "object" && !Array.isArray(v) && sub
				? fillRequired(v, sub, baseObj?.[k])
				: v;
	}
	for (const req of eff.required) {
		if (out[req] === undefined && baseObj?.[req] !== undefined)
			out[req] = baseObj[req];
	}
	return out;
}

function branchProps(
	schema: unknown,
	seg: string,
	acc: { found: unknown[]; declared: boolean },
	depth = 0,
): void {
	if (
		depth > 16 ||
		schema === null ||
		typeof schema !== "object" ||
		Array.isArray(schema)
	)
		return;
	const s = schema as Record<string, unknown>;
	const props = s.properties;
	if (props !== null && typeof props === "object" && !Array.isArray(props)) {
		acc.declared = true;
		const sub = (props as Record<string, unknown>)[seg];
		if (sub !== undefined) acc.found.push(sub);
	}
	for (const key of ["allOf", "oneOf", "anyOf"]) {
		const branches = s[key];
		if (Array.isArray(branches))
			for (const b of branches) branchProps(b, seg, acc, depth + 1);
	}
}

// Static {{payload.<path>}} check against the inbound channel schema (l2 §7):
// the path must be reachable through declared properties (any oneOf/anyOf
// branch counts). A level that declares NO properties is free-form — the
// check stops there and passes (statically uncheckable, runtime backstops).
export function schemaHasPath(schema: unknown, path: string): boolean {
	let candidates: unknown[] = [schema];
	for (const seg of path.split(".")) {
		const acc = { found: [] as unknown[], declared: false };
		for (const c of candidates) branchProps(c, seg, acc);
		if (!acc.declared) return true;
		if (acc.found.length === 0) return false;
		candidates = acc.found;
	}
	return true;
}
