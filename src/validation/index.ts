import type {
	Config,
	ValidationSummary,
	Violation,
	ViolationKind,
} from "../model/index.ts";

const KINDS: ViolationKind[] = [
	"schema",
	"direction",
	"unknown-topic",
	"decode",
];

export interface ValidationLog {
	record(v: Omit<Violation, "seq" | "observedAt">): Violation;
	query(opts?: {
		sinceSeq?: number;
		origin?: "client" | "mock";
		kind?: ViolationKind;
		severity?: "error" | "warning";
	}): Violation[];
	summary(): ValidationSummary;
	baseline(): number;
}

function distinctKey(v: Violation): string {
	const loc = v.errors?.[0]
		? `${v.errors[0].instancePath}:${v.errors[0].keyword}`
		: "";
	return `${v.origin}|${v.kind}|${v.channel ?? ""}|${loc}`;
}

export function createValidationLog(config: Config): ValidationLog {
	const buf: Violation[] = []; // FIFO; capacity config.maxViolations
	let nextSeq = 1;

	return {
		record(input) {
			const v: Violation = {
				...input,
				seq: nextSeq++,
				observedAt: new Date().toISOString(),
			};
			buf.push(v);
			if (buf.length > config.maxViolations) buf.shift();
			return v;
		},
		query(opts = {}) {
			return buf.filter(
				(v) =>
					(opts.sinceSeq === undefined || v.seq > opts.sinceSeq) &&
					(opts.origin === undefined || v.origin === opts.origin) &&
					(opts.kind === undefined || v.kind === opts.kind) &&
					(opts.severity === undefined || v.severity === opts.severity),
			);
		},
		summary() {
			const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<
				ViolationKind,
				number
			>;
			const byOrigin = { client: 0, mock: 0 };
			const distinct = new Set<string>();
			const distinctByOrigin = {
				client: new Set<string>(),
				mock: new Set<string>(),
			};
			let errors = 0;
			let warnings = 0;
			for (const v of buf) {
				byKind[v.kind]++;
				byOrigin[v.origin]++;
				v.severity === "error" ? errors++ : warnings++;
				distinct.add(distinctKey(v));
				distinctByOrigin[v.origin].add(distinctKey(v));
			}
			return {
				errors,
				warnings,
				byOrigin,
				byKind,
				oldestSeq: buf[0]?.seq ?? 0,
				distinct: {
					total: distinct.size,
					client: distinctByOrigin.client.size,
					mock: distinctByOrigin.mock.size,
				},
			};
		},
		baseline: () => nextSeq - 1,
	};
}
