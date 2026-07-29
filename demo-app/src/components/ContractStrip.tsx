export interface TopicRow {
	topic: string;
	direction: "toClient" | "fromClient";
	example?: unknown;
}

export function ContractStrip({ topics }: { topics: TopicRow[] }) {
	return (
		<section>
			<h2>Contract</h2>
			<table>
				<tbody>
					{topics.map((t) => (
						<tr key={t.topic}>
							<td className="mono">{t.topic}</td>
							<td>{t.direction === "toClient" ? "you receive" : "you send"}</td>
							<td className="mono">
								{t.example === undefined ? "" : JSON.stringify(t.example)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}
