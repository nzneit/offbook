import type { DistinctRow } from "../distinct.ts";

export function ViolationsFeed({ rows }: { rows: DistinctRow[] }) {
	return (
		<section>
			<h2>Violations (distinct)</h2>
			{rows.length === 0 ? (
				<p className="ok">none — everything on contract</p>
			) : (
				<table>
					<tbody>
						{rows.map((r) => (
							<tr key={r.key} className="viol">
								<td className="mono">×{r.count}</td>
								<td className="mono">{r.latest.origin}</td>
								<td className="mono">{r.latest.kind}</td>
								<td className="mono">{r.latest.topic}</td>
								<td>{r.latest.detail}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}
