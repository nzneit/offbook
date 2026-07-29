// The CLI's distinct-violation collapse (design §5), client-side: key =
// origin·kind·channel·errors[0].instancePath+keyword.
export interface ViolationLite {
	seq: number;
	origin: string;
	kind: string;
	topic: string;
	channel?: string;
	detail: string;
	clientId?: string;
	errors?: { instancePath?: string; keyword?: string; message?: string }[];
}

export interface DistinctRow {
	key: string;
	count: number;
	latest: ViolationLite;
}

export function distinctRows(violations: ViolationLite[]): DistinctRow[] {
	const rows = new Map<string, DistinctRow>();
	for (const v of violations) {
		const key = `${v.origin}·${v.kind}·${v.channel ?? v.topic}·${v.errors?.[0]?.instancePath ?? ""}·${v.errors?.[0]?.keyword ?? ""}`;
		const row = rows.get(key);
		if (row) {
			row.count += 1;
			if (v.seq > row.latest.seq) row.latest = v;
		} else rows.set(key, { key, count: 1, latest: v });
	}
	return [...rows.values()].sort((a, b) => b.latest.seq - a.latest.seq);
}
