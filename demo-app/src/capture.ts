// The R-007 capture artifact (docs/specs/demo-app.md §6): server view wins,
// client options fill the gaps. qosUsed/retainUsed = the CLIENT's own
// publish/subscribe classes, never retained-receipt.
import type { FingerprintBundle } from "#demo-app/server.ts";

export interface CaptureInputs {
	clientOptions: {
		wsUrl: string;
		clientId: string;
		protocolVersion: number;
		keepalive: number;
		clean: boolean;
		username?: string;
		passwordPresent: boolean;
	};
	probe?: { subprotocolSelected?: string };
	fingerprint?: FingerprintBundle;
}

export function buildCapture(i: CaptureInputs): Record<string, unknown> {
	const c = i.fingerprint?.connect ?? {};
	const ws = (c.ws ?? {}) as Record<string, unknown>;
	const qosUsed = [
		...new Set(
			[
				...(i.fingerprint?.subscribes ?? []),
				...(i.fingerprint?.publishes ?? []),
			]
				.map((o) => o.qos)
				.filter((q): q is number => typeof q === "number"),
		),
	].sort();
	return {
		capturedAt: new Date().toISOString(),
		source: "demo-app",
		wsUrl: i.clientOptions.wsUrl,
		path: (ws.path as string | undefined) ?? "/",
		subprotocol:
			(ws.subprotocolSelected as string | undefined) ??
			i.probe?.subprotocolSelected ??
			null,
		protocolLevel:
			(c.protocolLevel as number | undefined) ??
			i.clientOptions.protocolVersion,
		clientIdPattern: `${i.clientOptions.clientId.replace(/[^-]*$/, "")}*`,
		auth: {
			username:
				(c.username as string | undefined) ?? i.clientOptions.username ?? null,
			passwordPresent:
				(c.passwordPresent as boolean | undefined) ??
				i.clientOptions.passwordPresent,
		},
		keepalive: (c.keepalive as number | undefined) ?? i.clientOptions.keepalive,
		clean: (c.clean as boolean | undefined) ?? i.clientOptions.clean,
		qosUsed,
		retainUsed: (i.fingerprint?.publishes ?? []).some((p) => p.retain === true),
	};
}
