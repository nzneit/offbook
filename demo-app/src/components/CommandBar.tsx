import { useState } from "react";

export function CommandBar({
	deviceIds,
	onCommand,
	onBreakSchema,
	onWrongDirection,
}: {
	deviceIds: string[];
	onCommand(deviceId: string, mode: string, target: number): void;
	onBreakSchema(deviceId: string): void;
	onWrongDirection(deviceId: string): void;
}) {
	const [mode, setMode] = useState("heat");
	const [target, setTarget] = useState(21);
	const device = deviceIds[0] ?? "thermostat-1";
	return (
		<section>
			<h2>Command — {device}</h2>
			<label>
				mode{" "}
				<select value={mode} onChange={(e) => setMode(e.target.value)}>
					<option>heat</option>
					<option>cool</option>
					<option>off</option>
				</select>
			</label>{" "}
			<label>
				target {target}°{" "}
				<input
					type="range"
					min={5}
					max={35}
					value={target}
					onChange={(e) => setTarget(Number(e.target.value))}
				/>
			</label>{" "}
			<button type="button" onClick={() => onCommand(device, mode, target)}>
				send command
			</button>{" "}
			<button
				type="button"
				className="danger"
				onClick={() => onBreakSchema(device)}
			>
				break the schema
			</button>{" "}
			<button
				type="button"
				className="danger"
				onClick={() => onWrongDirection(device)}
			>
				wrong direction
			</button>
		</section>
	);
}
