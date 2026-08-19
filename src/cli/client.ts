// R-019 — the HTTP thin client every read/action verb shares: call /v1/* at
// a caller-resolved control-plane port and turn the §5 error envelope into a
// CliError the dispatcher renders (closed ErrorCode union — no ad-hoc
// strings). Port resolution itself is R-045/D-032's resolver (./resolve.ts)
// plus each verb's own --ctrl-port branch — this file no longer resolves.
import type { ErrorCode } from "#src/model/index.ts";

export class CliError extends Error {
	constructor(
		message: string,
		public readonly exitCode = 1,
	) {
		super(message);
	}
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
