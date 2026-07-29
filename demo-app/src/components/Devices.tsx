export interface DeviceState {
	deviceId: string;
	status: string;
	target?: number;
	units?: string;
	updatedAt?: number; // logical-clock stamp ({{now}} is numeric — contracts §3)
	receivedAt: number;
}

export function Devices({ devices }: { devices: Map<string, DeviceState> }) {
	if (devices.size === 0)
		return (
			<section>
				<h2>Devices</h2>
				<p className="sub">waiting for retained state on state/#…</p>
			</section>
		);
	return (
		<section>
			<h2>Devices</h2>
			{[...devices.values()].map((d) => (
				<div className="card" key={d.deviceId}>
					<div className="meta">{d.deviceId}</div>
					<div className="status">{d.status}</div>
					<div className="meta">
						target {d.target ?? "—"} {d.units ?? ""} ·{" "}
						{new Date(d.receivedAt).toLocaleTimeString()}
					</div>
				</div>
			))}
		</section>
	);
}
