import { expect, test } from "bun:test";
import { loadConfig } from "../config/index.ts";
import { createValidationLog } from "./index.ts";

function base(
	origin: "client" | "mock",
	kind: "schema" | "direction" | "unknown-topic" | "decode",
	topic: string,
) {
	return {
		origin,
		kind,
		severity: "error" as const,
		topic,
		detail: `${topic}:${kind}`,
	};
}

// Minimal SchemaError-shaped object: only instancePath/keyword feed
// distinctKey, so the rest are placeholders.
function schemaError(instancePath: string, keyword: string) {
	return {
		instancePath,
		keyword,
		schemaPath: `#/properties${instancePath}/${keyword}`,
		params: {},
	};
}

test("seq is monotonic and unique; sinceSeq is strictly-greater", () => {
	const log = createValidationLog(loadConfig());
	const a = log.record(base("client", "schema", "t/1"));
	const b = log.record(base("mock", "decode", "t/2"));
	expect(b.seq).toBe(a.seq + 1);
	expect(log.query({ sinceSeq: a.seq }).map((v) => v.seq)).toEqual([b.seq]);
});

test("past the cap the oldest evicts while seq keeps climbing and oldestSeq advances", () => {
	const log = createValidationLog(loadConfig({ maxViolations: 3 }));
	const seqs = Array.from(
		{ length: 5 },
		(_, i) => log.record(base("client", "schema", `t/${i}`)).seq,
	);
	expect(seqs).toEqual([1, 2, 3, 4, 5]);
	const kept = log.query();
	expect(kept.length).toBe(3);
	expect(kept.map((v) => v.seq)).toEqual([seqs[2], seqs[3], seqs[4]]);
	expect(log.summary().oldestSeq).toBe(seqs[2]);
});

test("summary counts by origin and zero-fills every kind", () => {
	const log = createValidationLog(loadConfig());
	log.record(base("client", "schema", "t/1"));
	log.record(base("mock", "schema", "t/2"));
	const s = log.summary();
	expect(s.byOrigin).toEqual({ client: 1, mock: 1 });
	expect(s.byKind).toEqual({
		schema: 2,
		direction: 0,
		"unknown-topic": 0,
		decode: 0,
	});
	expect(s.warnings).toBe(0);
});

test("distinct collapses violations sharing origin+kind+channel+error-location, differing only in payload", () => {
	const log = createValidationLog(loadConfig());
	log.record({
		...base("client", "schema", "t/1"),
		channel: "ch/a",
		errors: [schemaError("/mode", "enum")],
		payload: { mode: "x" },
	});
	log.record({
		...base("client", "schema", "t/1"),
		channel: "ch/a",
		errors: [schemaError("/mode", "enum")],
		payload: { mode: "y" },
	});
	let s = log.summary();
	// Two violations, same origin/kind/channel/error-location, different
	// payload only: they collapse to a single distinct entry...
	expect(s.distinct.total).toBe(1);
	// ...while raw counts still see both.
	expect(s.byKind.schema).toBe(2);
	expect(s.byOrigin.client).toBe(2);

	log.record({
		...base("mock", "schema", "t/2"),
		channel: "ch/b",
		errors: [schemaError("/mode", "enum")],
		payload: { mode: "z" },
	});
	s = log.summary();
	// A third violation differing in channel (and origin) is a new
	// distinct entry.
	expect(s.distinct.total).toBe(2);
	expect(s.distinct.client).toBe(1);
	expect(s.distinct.mock).toBe(1);
});

test("baseline is 0 on an empty log and tracks the last minted seq", () => {
	const log = createValidationLog(loadConfig());
	expect(log.baseline()).toBe(0);
	log.record(base("client", "schema", "t/1"));
	const last = log.record(base("mock", "decode", "t/2"));
	expect(log.baseline()).toBe(last.seq);
});
