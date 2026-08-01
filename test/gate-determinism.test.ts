// R-029 — the determinism v1 gate (F9/F10): same seed ⇒ identical emission
// stream + violation ordering across two SEPARATE `offbook up --ci` boots of
// the same project, driving the same inbound script. The comparison is over
// the F9 canonical projection (Violation minus wall-clock `observedAt` and
// `clientId`) plus the final retained state; the gate asserts GET /mode ==
// passive first (F10) so no autonomous tick perturbs the window.
// [itest->R-029]
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "#src/cli/index.ts";
import { readRunfile } from "#src/cli/runfile.ts";
import type { StateEntry, Violation } from "#src/model/index.ts";
import { gitSpecProject } from "./project-fixture.ts";

const CTRL = 19850;
const BASE = `http://localhost:${CTRL}`;

// seeded ranged delays + a param capture: the scheduler draws and the keyed
// param fakes are all in play, so drift anywhere in the seeded path shows
const CHAIN = `
- name: chain
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: accepted
          target: "{{payload.target}}"
        delay: 50-80ms
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: heating
        delay: 100-200ms
`;

const quiet = { out: () => {}, err: () => {} };

async function post(
	path: string,
	body: unknown,
): Promise<Record<string, unknown>> {
	return (await (
		await fetch(`${BASE}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})
	).json()) as Record<string, unknown>;
}

const get = async (path: string) =>
	(await (await fetch(`${BASE}${path}`)).json()) as Record<string, unknown>;

// one full boot → scripted window → collect → down
async function runOnce(flags: string[]): Promise<{
	violations: unknown[];
	state: StateEntry[];
}> {
	const errs: string[] = [];
	const code = await run(["up", "--ci", "--seed", "7", ...flags], {
		out: () => {},
		err: (l) => errs.push(l),
	});
	if (code !== 0) throw new Error(`up --ci failed:\n${errs.join("\n")}`);

	// F10: the window is passive — the --ci co-set held
	expect(((await get("/v1/mode")) as { mode: string }).mode).toBe("passive");

	// checkpoint, then the fixed inbound script
	const checkpoint = (await post("/v1/reset", {})) as { sinceSeq: number };
	await get("/v1/pending?wait");
	await post("/v1/publish", {
		topic: "command/thermostat-1/set",
		payload: { mode: "broil", target: 22 }, // schema violation + chain
	});
	await post("/v1/publish", {
		topic: "command/thermostat-1/set",
		payload: { mode: "heat", target: 21 }, // clean + chain
	});
	await post("/v1/trigger/chain", { params: { deviceId: "det-1" } });
	await get("/v1/pending?wait");

	const violations = (
		(await get(`/v1/validation?sinceSeq=${checkpoint.sinceSeq}`)) as {
			violations: Violation[];
		}
	).violations.map(({ observedAt: _o, clientId: _c, ...keep }) => keep); // the F9 mask
	const state = ((await get("/v1/state")) as { state: StateEntry[] }).state;

	expect(await run(["down", "--run-dir", flags[1] ?? ""], quiet)).toBe(0);
	return { violations, state };
}

test("same seed ⇒ byte-identical F9 violation stream + final retained state across two separate up --ci boots", async () => {
	const projectDir = await gitSpecProject();
	const scenariosDir = join(projectDir, "scenarios");
	mkdirSync(scenariosDir);
	writeFileSync(join(scenariosDir, "50-chain.yaml"), CHAIN);
	const runDir = join(projectDir, ".offbook");
	const flags = [
		"--run-dir",
		runDir,
		"--ws-port",
		"19051",
		"--tcp-port",
		"12951",
		"--ctrl-port",
		String(CTRL),
	];
	const prevCwd = process.cwd();
	process.chdir(projectDir);
	try {
		const first = await runOnce(flags);
		const second = await runOnce(flags); // fresh process, same seed

		expect(first.violations.length).toBeGreaterThan(0); // non-vacuous
		expect(second.violations).toEqual(first.violations);
		expect(second.state).toEqual(first.state);
		// the chain's final word won both runs (ordering, not just membership)
		const final = first.state.find((e) => e.topic === "state/thermostat-1");
		expect((final?.payload as { status: string } | undefined)?.status).toBe(
			"heating",
		);
	} finally {
		process.chdir(prevCwd);
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		await rm(projectDir, { recursive: true, force: true });
	}
}, 90_000);
