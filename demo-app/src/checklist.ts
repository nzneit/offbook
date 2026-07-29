// The live R-006 checklist (docs/specs/demo-app.md §6) as a pure reducer so
// bun test can drive it without a browser.
export type ChecklistId =
	| "ws-upgrade"
	| "connack"
	| "suback"
	| "retained"
	| "puback"
	| "violation";

export const CHECKLIST_LABELS: Record<ChecklistId, string> = {
	"ws-upgrade": "WebSocket upgrade (subprotocol negotiated)",
	connack: "MQTT CONNACK received",
	suback: "SUBACK received",
	retained: "retained state received on subscribe",
	puback: "QoS-1 publish round-trip (PUBACK)",
	violation: "contract break surfaced in /v1/validation",
};

export interface ChecklistState {
	done: Record<ChecklistId, boolean>;
	grantedQos?: number;
	reconnects: number;
}

export type ChecklistEvent =
	| { type: "ws-upgrade" }
	| { type: "connack" }
	| { type: "suback"; qos: number }
	| { type: "retained" }
	| { type: "puback" }
	| { type: "violation" }
	| { type: "reconnect" };

export const initialChecklist: ChecklistState = {
	done: {
		"ws-upgrade": false,
		connack: false,
		suback: false,
		retained: false,
		puback: false,
		violation: false,
	},
	reconnects: 0,
};

export function checklistReduce(
	s: ChecklistState,
	e: ChecklistEvent,
): ChecklistState {
	if (e.type === "reconnect") return { ...s, reconnects: s.reconnects + 1 };
	if (e.type === "suback")
		return { ...s, grantedQos: e.qos, done: { ...s.done, suback: true } };
	if (s.done[e.type]) return s;
	return { ...s, done: { ...s.done, [e.type]: true } };
}
