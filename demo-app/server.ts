// The demo-app's little server (docs/specs/demo-app.md §5): static shell,
// same-origin /v1 proxy (so the control plane needs no CORS), and the
// fingerprint read over <runDir>/offbook.log's D-015 structured lines.
import { join } from "node:path";

export interface DemoAppServerOptions {
	port: number;
	ctrlPort: number;
	runDir: string;
	root?: string; // demo-app/ itself; overridable for tests
}

export interface FingerprintBundle {
	connect?: Record<string, unknown>;
	subscribes: Record<string, unknown>[];
	publishes: Record<string, unknown>[];
}

const LINE =
	/(ws-connect|tcp-connect|mqtt-subscribe|mqtt-publish) (\{.*\})\s*$/;

export function parseFingerprintLines(
	logText: string,
	clientId: string,
): FingerprintBundle | undefined {
	let connect: Record<string, unknown> | undefined;
	const subscribes: Record<string, unknown>[] = [];
	const publishes: Record<string, unknown>[] = [];
	for (const line of logText.split("\n")) {
		const m = LINE.exec(line);
		if (!m) continue;
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(m[2] ?? "") as Record<string, unknown>;
		} catch {
			continue; // torn/rotated line — skip, never crash
		}
		if (parsed.clientId !== clientId) continue;
		if (m[1] === "ws-connect" || m[1] === "tcp-connect")
			connect = parsed; // last wins (reconnects)
		else if (m[1] === "mqtt-subscribe") subscribes.push(parsed);
		else publishes.push(parsed);
	}
	if (
		connect === undefined &&
		subscribes.length === 0 &&
		publishes.length === 0
	)
		return undefined;
	return { connect, subscribes, publishes };
}

export function createDemoAppServer(opts: DemoAppServerOptions) {
	const root = opts.root ?? import.meta.dir;
	return Bun.serve({
		port: opts.port,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.startsWith("/v1/")) {
				try {
					return await fetch(
						`http://localhost:${opts.ctrlPort}${url.pathname}${url.search}`,
						{ method: req.method, headers: req.headers, body: req.body },
					);
				} catch {
					return Response.json(
						{ error: "offbook-unreachable" },
						{ status: 502 },
					);
				}
			}
			if (url.pathname === "/spike/fingerprint") {
				const clientId = url.searchParams.get("clientId") ?? "";
				const text = await Bun.file(join(opts.runDir, "offbook.log"))
					.text()
					.catch(() => "");
				const bundle = parseFingerprintLines(text, clientId);
				if (bundle === undefined)
					return Response.json({ error: "no-fingerprint" }, { status: 404 });
				return Response.json(bundle);
			}
			if (url.pathname === "/")
				return new Response(Bun.file(join(root, "index.html")));
			if (url.pathname === "/main.js")
				return new Response(Bun.file(join(root, "dist/main.js")));
			return new Response("not found", { status: 404 });
		},
	});
}
