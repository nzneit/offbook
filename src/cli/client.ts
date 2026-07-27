// R-019 — the HTTP thin client every read/action verb shares: resolve the
// control-plane port (explicit --ctrl-port wins, else the runfile of a LIVE
// offbook), call /v1/*, and turn the §5 error envelope into a CliError the
// dispatcher renders (closed ErrorCode union — no ad-hoc strings).
import type { ErrorCode } from "#src/model/index.ts";
import { resolveRunning } from "./runfile.ts";

export class CliError extends Error {
	constructor(
		message: string,
		public readonly exitCode = 1,
	) {
		super(message);
	}
}

export async function resolveCtrlPort(
	runDir: string,
	ctrlPortFlag?: string,
): Promise<number> {
	if (ctrlPortFlag !== undefined) {
		const port = Number(ctrlPortFlag);
		if (!Number.isInteger(port) || port <= 0)
			throw new CliError(`--ctrl-port: not a port: '${ctrlPortFlag}'`);
		return port;
	}
	const resolved = await resolveRunning(runDir);
	if (!resolved)
		throw new CliError(
			`offbook is not running (no runfile in ${runDir}) — run \`offbook up\`, or pass --ctrl-port`,
		);
	if (!resolved.live)
		throw new CliError(
			`offbook is not running (stale runfile in ${runDir}, pid ${resolved.run.pid}) — run \`offbook up\``,
		);
	return resolved.run.controlPlanePort;
}

interface Envelope {
	error?: { code?: ErrorCode; message?: string };
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch (cause) {
		throw new CliError(
			`could not reach offbook at ${url} — is it running? (${(cause as Error).message})`,
		);
	}
	const body = (await res.json().catch(() => ({}))) as Envelope;
	if (!res.ok) {
		const code = body.error?.code ?? `http-${res.status}`;
		const message = body.error?.message ?? "request failed";
		throw new CliError(`${code}: ${message}`);
	}
	return body;
}

export interface Api {
	get(path: string): Promise<unknown>;
	post(path: string, body?: unknown): Promise<unknown>;
}

export function api(port: number): Api {
	const base = `http://localhost:${port}`;
	return {
		get: (path) => request(`${base}${path}`),
		post: (path, body) =>
			request(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {}),
			}),
	};
}
