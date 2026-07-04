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
