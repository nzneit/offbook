// R-018 — the moment-4 synchronous-CI primitive (contracts §5, EC1/D-003):
// reset → publish → GET /pending?wait → GET /validation?sinceSeq= with NO
// poll loop. ?wait returns only once /state reflects every emit of a
// multi-step reactive scenario (scheduled: 0, settled: true — the D-003 span
// counts in-flight faker promises), and wall-paced mode reports nonzero
// scheduled mid-chain.
// [itest->R-018]
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Composed, compose } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import type { StateEntry, Violation } from "#src/model/index.ts";
import { buildRegistry } from "#src/registry/index.ts";

const servers: Composed[] = [];
afterEach(async () => {
	while (servers.length) await servers.pop()?.stop();
});

// two-step reactive chain with seeded ranged delays: step 2 overwrites the
// same retained topic, so /state proves BOTH emits drained in order
const CHAIN = `
- name: set-chain
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: accepted, target: "{{payload.target}}" }
        delay: 50-80ms
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: heating }
        delay: 100-200ms
`;

// 176xx ports: distinct from control-plane (188xx), m0 (177xx-179xx), broker
async function boot(n: number, overrides: Record<string, unknown> = {}) {
	const config = loadConfig({
		brokerWsPort: 16000 + n,
		brokerTcpPort: 12600 + n,
		controlPlanePort: 16800 + n,
		...overrides,
	});
	const dir = mkdtempSync(join(tmpdir(), "offbook-ci-"));
	writeFileSync(join(dir, "50-chain.yaml"), CHAIN);
	const registry = await buildRegistry({
		specText: await Bun.file("src/demo/thermostat.yaml").text(),
		service: "demo",
		config,
	});
	const server = await compose({ config, registry, scenariosDir: dir });
	servers.push(server);
	await server.start();
	const req = (path: string, init?: RequestInit) =>
		server.app.request(path, init);
	const post = (path: string, body: unknown) =>
		req(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	return { server, config, req, post };
}

test("CI flow (passive/fast-virtual): reset → publish → pending?wait → validation slice, no poll loop", async () => {
	// the CI boot profile: passive + fast-virtual (up --ci co-sets these)
	const { req, post } = await boot(1, { mode: "passive", wallClock: false });

	// 1. reset — the checkpoint
	const reset = (await (await post("/v1/reset", {})).json()) as {
		reset: boolean;
		sinceSeq: number;
	};
	expect(reset.reset).toBe(true);

	// drain the reset republish, then take the assertion window
	await req("/v1/pending?wait");
	const checkpoint = (await (await post("/v1/reset", {})).json()) as {
		sinceSeq: number;
	};

	// 2. inject the client command (valid — the reactive chain fires)
	await post("/v1/publish", {
		topic: "command/thermostat-1/set",
		payload: { mode: "heat", target: 22 },
	});

	// 3. ONE blocking settle call — no poll loop, and fast-virtual pays no
	// wall time for the ~130-280ms of seeded delays
	const settled = (await (await req("/v1/pending?wait")).json()) as {
		scheduled: number;
		settled: boolean;
	};
	expect(settled).toEqual({ scheduled: 0, settled: true });

	// /state already reflects EVERY emit — the second step overwrote the
	// retained topic, so its payload is the chain's final word
	const { state } = (await (await req("/v1/state")).json()) as {
		state: StateEntry[];
	};
	const final = state.find((e) => e.topic === "state/thermostat-1");
	expect((final?.payload as { status: string }).status).toBe("heating");

	// 4. the violation slice since the checkpoint: a clean publish produced
	// no client violations (the offbook check gate would pass)
	const slice = (await (
		await req(`/v1/validation?sinceSeq=${checkpoint.sinceSeq}`)
	).json()) as {
		violations: Violation[];
		summary: { byOrigin: { client: number } };
	};
	expect(slice.violations.filter((v) => v.origin === "client")).toEqual([]);

	// 5. an off-contract publish lands exactly one client violation in the
	// next window — the expected slice, still no poll loop
	const window2 = (await (await post("/v1/reset", {})).json()) as {
		sinceSeq: number;
	};
	await req("/v1/pending?wait");
	await post("/v1/publish", {
		topic: "command/thermostat-1/set",
		payload: { mode: "broil", target: 22 },
	});
	await req("/v1/pending?wait");
	const slice2 = (await (
		await req(`/v1/validation?sinceSeq=${window2.sinceSeq}`)
	).json()) as { violations: Violation[] };
	const clientViolations = slice2.violations.filter(
		(v) => v.origin === "client",
	);
	expect(clientViolations).toHaveLength(1);
	expect(clientViolations[0]?.kind).toBe("schema");
}, 10_000);

test("wall-paced mode: nonzero scheduled mid-chain, then ?wait waits the real delays out", async () => {
	const { req, post } = await boot(2, { mode: "passive", wallClock: true });

	await post("/v1/publish", {
		topic: "command/thermostat-1/set",
		payload: { mode: "heat", target: 22 },
	});

	// mid-chain: the seeded delays are real wall timers now, so pending work
	// is visible immediately after the prompt 202
	const mid = (await (await req("/v1/pending")).json()) as {
		scheduled: number;
		settled: boolean;
	};
	expect(mid.scheduled).toBeGreaterThan(0);
	expect(mid.settled).toBe(false);

	// a capped wait shorter than the chain returns settled: false at the cap
	const capped = (await (await req("/v1/pending?wait=20")).json()) as {
		settled: boolean;
	};
	expect(capped.settled).toBe(false);

	// the uncapped wait pays the real ~150-280ms and settles
	const settled = (await (await req("/v1/pending?wait")).json()) as {
		scheduled: number;
		settled: boolean;
	};
	expect(settled).toEqual({ scheduled: 0, settled: true });
	const { state } = (await (await req("/v1/state")).json()) as {
		state: StateEntry[];
	};
	expect(
		(
			state.find((e) => e.topic === "state/thermostat-1")?.payload as {
				status: string;
			}
		)?.status,
	).toBe("heating");
}, 10_000);
