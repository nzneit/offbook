import { useCallback, useEffect, useRef, useState } from "react";
import type { FingerprintBundle } from "#demo-app/server.ts";
import type { ChecklistState } from "./checklist.ts";
import { checklistReduce, initialChecklist } from "./checklist.ts";
import { CommandBar } from "./components/CommandBar.tsx";
import type { TopicRow } from "./components/ContractStrip.tsx";
import { ContractStrip } from "./components/ContractStrip.tsx";
import type { DeviceState } from "./components/Devices.tsx";
import { Devices } from "./components/Devices.tsx";
import { SpikePanel } from "./components/SpikePanel.tsx";
import { ViolationsFeed } from "./components/ViolationsFeed.tsx";
import type { ViolationLite } from "./distinct.ts";
import { distinctRows } from "./distinct.ts";
import { connectClient, makeClientId, probeWs } from "./mqtt.ts";

const params = new URLSearchParams(location.search);
const WS_URL = `ws://${location.hostname}:${params.get("ws") ?? "9001"}`;
const CLIENT_ID = makeClientId();

export function App() {
	const [checklist, setChecklist] = useState<ChecklistState>(initialChecklist);
	const [probe, setProbe] = useState<{ subprotocolSelected?: string }>();
	const [devices, setDevices] = useState(new Map<string, DeviceState>());
	const [violations, setViolations] = useState<ViolationLite[]>([]);
	const [topics, setTopics] = useState<TopicRow[]>([]);
	const [fingerprint, setFingerprint] = useState<FingerprintBundle>();
	const [unreachable, setUnreachable] = useState(false);
	const clientRef = useRef<ReturnType<typeof connectClient>>(null);
	// stable identity (empty deps) so it can sit in the effects' dependency
	// arrays below without re-running them on every render
	const tick = useCallback(
		(e: Parameters<typeof checklistReduce>[1]) =>
			setChecklist((s) => checklistReduce(s, e)),
		[],
	);

	// probe first (upgrade + subprotocol), then the real mqtt client
	useEffect(() => {
		let disposed = false;
		void probeWs(WS_URL).then((p) => {
			if (disposed) return;
			if (p.ok) {
				tick({ type: "ws-upgrade" });
				setProbe({ subprotocolSelected: p.subprotocolSelected });
			}
			const client = connectClient({ wsUrl: WS_URL, clientId: CLIENT_ID });
			clientRef.current = client;
			client.on("connect", () => {
				tick({ type: "ws-upgrade" });
				tick({ type: "connack" });
				client.subscribe("state/#", { qos: 1 }, (err, granted) => {
					if (!err && granted?.[0])
						tick({ type: "suback", qos: granted[0].qos });
				});
			});
			client.on("reconnect", () => tick({ type: "reconnect" }));
			client.on("message", (topic, payload, packet) => {
				if (packet.retain) tick({ type: "retained" });
				if (!topic.startsWith("state/")) return;
				try {
					const body = JSON.parse(payload.toString()) as Omit<
						DeviceState,
						"receivedAt"
					> | null;
					if (typeof body !== "object" || body === null) return; // off-contract state — the feed surfaces it
					setDevices((prev) => {
						const next = new Map(prev);
						next.set(body.deviceId ?? topic.slice("state/".length), {
							...body,
							deviceId: body.deviceId ?? topic.slice("state/".length),
							receivedAt: Date.now(),
						});
						return next;
					});
				} catch {
					/* non-JSON state — the feed will show the decode violation */
				}
			});
		});
		return () => {
			disposed = true;
			clientRef.current?.end(true);
		};
	}, [tick]);

	// same-origin polls through the proxy
	useEffect(() => {
		const poll = setInterval(() => {
			void fetch("/v1/validation")
				.then((r) => {
					if (r.status === 502) throw new Error("unreachable");
					return r.json() as Promise<{ violations: ViolationLite[] }>;
				})
				.then((body) => {
					setUnreachable(false);
					setViolations(body.violations);
					if (body.violations.some((v) => v.origin === "client"))
						tick({ type: "violation" });
				})
				.catch(() => setUnreachable(true));
		}, 1000);
		const fpPoll = setInterval(() => {
			void fetch(`/spike/fingerprint?clientId=${CLIENT_ID}`)
				.then((r) =>
					r.ok ? (r.json() as Promise<FingerprintBundle>) : undefined,
				)
				.then((b) => b && setFingerprint(b))
				.catch(() => {});
		}, 2000);
		void fetch("/v1/topics")
			.then((r) => {
				if (!r.ok) throw new Error("offbook unreachable");
				return r.json() as Promise<{ topics: TopicRow[] }>;
			})
			.then((body) => setTopics(body.topics))
			.catch(() => {}); // strip stays empty until offbook is up
		return () => {
			clearInterval(poll);
			clearInterval(fpPoll);
		};
	}, [tick]);

	const publish = (topic: string, body: unknown) =>
		clientRef.current?.publish(
			topic,
			JSON.stringify(body),
			{ qos: 1 },
			(err) => {
				if (!err) tick({ type: "puback" });
			},
		);

	return (
		<>
			<header>
				<h1>offbook demo</h1>
				<span className="sub">
					{WS_URL} · client {CLIENT_ID}
				</span>
			</header>
			{unreachable && (
				<div className="banner">
					offbook not reachable through the proxy — is `offbook demo --serve`
					running?
				</div>
			)}
			<main>
				<div>
					<Devices devices={devices} />
					<CommandBar
						deviceIds={[...devices.keys()]}
						onCommand={(id, mode, target) =>
							publish(`command/${id}/set`, { mode, target })
						}
						onBreakSchema={(id) =>
							publish(`command/${id}/set`, { mode: "broil", target: 22 })
						}
						onWrongDirection={(id) =>
							publish(`state/${id}`, {
								deviceId: id,
								status: "idle",
								target: 0,
								units: "C",
							})
						}
					/>
					<ViolationsFeed rows={distinctRows(violations)} />
					<ContractStrip topics={topics} />
				</div>
				<SpikePanel
					checklist={checklist}
					inputs={{
						clientOptions: {
							wsUrl: WS_URL,
							clientId: CLIENT_ID,
							protocolVersion: 4,
							keepalive: 60,
							clean: true,
							passwordPresent: false,
						},
						probe,
						fingerprint,
					}}
				/>
			</main>
		</>
	);
}
