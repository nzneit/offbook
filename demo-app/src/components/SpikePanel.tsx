import type { FingerprintBundle } from "#demo-app/server.ts";
import type { CaptureInputs } from "../capture.ts";
import { buildCapture } from "../capture.ts";
import type { ChecklistState } from "../checklist.ts";
import { CHECKLIST_LABELS } from "../checklist.ts";

interface RowSpec {
	label: string;
	client: string;
	server: string;
}

function rows(i: CaptureInputs): RowSpec[] {
	const c = i.fingerprint?.connect ?? {};
	const ws = (c.ws ?? {}) as Record<string, unknown>;
	const s = (v: unknown) => (v === undefined ? "—" : String(v));
	return [
		{
			label: "clientId",
			client: i.clientOptions.clientId,
			server: s(c.clientId),
		},
		{
			label: "protocol level",
			client: String(i.clientOptions.protocolVersion),
			server: s(c.protocolLevel),
		},
		{
			label: "subprotocol",
			client: i.probe?.subprotocolSelected ?? "—",
			server: s(ws.subprotocolSelected),
		},
		{ label: "ws path", client: "/", server: s(ws.path) },
		{
			label: "keepalive",
			client: String(i.clientOptions.keepalive),
			server: s(c.keepalive),
		},
		{
			label: "clean",
			client: String(i.clientOptions.clean),
			server: s(c.clean),
		},
		{
			label: "password present",
			client: String(i.clientOptions.passwordPresent),
			server: s(c.passwordPresent),
		},
	];
}

export function SpikePanel({
	inputs,
	checklist,
}: {
	inputs: CaptureInputs;
	checklist: ChecklistState;
}) {
	const download = () => {
		const blob = new Blob([JSON.stringify(buildCapture(inputs), null, 2)], {
			type: "application/json",
		});
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = "offbook-connect-capture.json";
		document.body.append(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(a.href);
	};
	const fp: FingerprintBundle | undefined = inputs.fingerprint;
	return (
		<section>
			<h2>Spike panel (R-006 / R-007)</h2>
			<ul className="check">
				{(
					Object.keys(CHECKLIST_LABELS) as (keyof typeof CHECKLIST_LABELS)[]
				).map((id) => (
					<li key={id} className={checklist.done[id] ? "ok" : ""}>
						{checklist.done[id] ? "✓" : "○"} {CHECKLIST_LABELS[id]}
						{id === "suback" && checklist.grantedQos !== undefined
							? ` (granted qos ${checklist.grantedQos})`
							: ""}
					</li>
				))}
			</ul>
			<p className="sub">reconnects: {checklist.reconnects}</p>
			<table>
				<thead>
					<tr>
						<th />
						<th>client sent</th>
						<th>server saw</th>
					</tr>
				</thead>
				<tbody>
					{rows(inputs).map((r) => (
						<tr key={r.label}>
							<td>{r.label}</td>
							<td className="mono">{r.client}</td>
							<td
								className={
									r.server !== "—" && r.server !== r.client
										? "mono flag"
										: "mono"
								}
							>
								{r.server}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{fp === undefined && (
				<p className="sub">
					no fingerprint found — is offbook logging to this run dir?
				</p>
			)}
			<p>
				<button type="button" onClick={download}>
					Download capture (R-007 fixture)
				</button>
			</p>
		</section>
	);
}
