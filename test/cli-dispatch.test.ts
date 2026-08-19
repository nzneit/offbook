// R-019 — the CLI dispatch backbone: every verb hits its endpoint (or does
// its local file/process work) and renders the response, resolving the G14
// runfile where needed. Suite A drives the HTTP verbs against an in-process
// composed server; suite B runs the real `up → status → … → down` process
// cycle against a local-git project fixture.
// [itest->R-019]
// [itest->R-036]
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "#src/cli/index.ts";
import {
	clientsFromLog,
	renderTopicList,
	run,
	specsStalenessWarning,
} from "#src/cli/index.ts";
import { readRunfile, writeRunfile } from "#src/cli/runfile.ts";
import type { Composed } from "#src/compose/index.ts";
import { compose } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import type { Channel, SpecRegistry, TopicInfo } from "#src/model/index.ts";
import { buildRegistry, mergeRegistries } from "#src/registry/index.ts";
import {
	gitSpecProject,
	makeSpecRepo,
	servicesYamlFor,
} from "./project-fixture.ts";

// 19xxx/129xx: distinct from control-plane (18xxx), ci-settlement (16xxx), m0
// (this file's other literal ports: 19010-19040/12910-12940, 19045/12945/19845
// — see each test; kept out of named consts since they're single-use)
// 19450-19479 + tcp 12496-12499: instance-discovery verb policy
const WS = 19001;
const TCP = 12901;
const CTRL = 19801;
const CTRL_FLAG = ["--ctrl-port", String(CTRL)];
const STATE = process.env.OFFBOOK_STATE_DIR ?? "";

const SCENARIO = `
- name: accept-set
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: accepted
          target: "{{payload.target}}"
`;

let base: string;
let server: Composed;

function io(): { out: string[]; err: string[]; io: Io } {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

// a fake discovered instance: an identity server + a matching runfile,
// registered by writeRunfile's pointer write into the CURRENT
// OFFBOOK_STATE_DIR (set per-test)
async function fakeInstance(opts: {
	port: number;
	projectDir: string;
	demo?: boolean;
	routes?: Record<string, unknown>;
}): Promise<{ runDir: string; token: string; stop(): void }> {
	const token = crypto.randomUUID().replaceAll("-", "");
	const runDir = join(opts.projectDir, ".offbook");
	await writeRunfile(
		runDir,
		{
			pid: process.pid,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: opts.port,
			startedAt: "t",
			token,
			host: hostname(),
		},
		{ stateDir: process.env.OFFBOOK_STATE_DIR ?? "" },
	);
	const identity = {
		pid: process.pid,
		token,
		host: hostname(),
		projectDir: opts.projectDir,
		runDir,
		startedAt: "t",
		demo: opts.demo === true,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: opts.port },
	};
	const server = Bun.serve({
		port: opts.port,
		fetch: (req) => {
			const p = new URL(req.url).pathname;
			if (p === "/v1/server") return Response.json(identity);
			const body = opts.routes?.[p];
			if (body !== undefined) return Response.json(body);
			return new Response("nope", { status: 404 });
		},
	});
	return { runDir, token, stop: () => server.stop(true) };
}

// pin the state dir + cwd for one discovery test; restores both
async function inDiscoveryWorld<T>(
	cwd: string,
	fn: () => Promise<T>,
): Promise<T> {
	const prevState = process.env.OFFBOOK_STATE_DIR;
	const prevCwd = process.cwd();
	process.env.OFFBOOK_STATE_DIR = mkdtempSync(
		join(tmpdir(), "offbook-vp-state-"),
	);
	process.chdir(cwd);
	try {
		return await fn();
	} finally {
		process.chdir(prevCwd);
		rmSync(process.env.OFFBOOK_STATE_DIR ?? "", {
			recursive: true,
			force: true,
		});
		// assigning undefined would store the STRING "undefined" — delete instead
		if (prevState === undefined) delete process.env.OFFBOOK_STATE_DIR;
		else process.env.OFFBOOK_STATE_DIR = prevState;
	}
}

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "offbook-cli-"));
	const scenariosDir = join(base, "scenarios");
	mkdirSync(scenariosDir);
	writeFileSync(join(scenariosDir, "50-accept.yaml"), SCENARIO);
	const config = loadConfig({
		brokerWsPort: WS,
		brokerTcpPort: TCP,
		controlPlanePort: CTRL,
	});
	const registry = await buildRegistry({
		specText: await Bun.file("src/demo/thermostat.yaml").text(),
		service: "demo",
		config,
	});
	server = await compose({ config, registry, scenariosDir });
	await server.start();
});

afterAll(async () => {
	await server.stop();
	await rm(base, { recursive: true, force: true });
});

// --- suite A: HTTP verbs over --ctrl-port ---

test("topics hits GET /v1/topics on the running server (no demo-fallback note) and --json round-trips", async () => {
	const human = io();
	expect(await run(["topics", ...CTRL_FLAG], human.io)).toBe(0);
	const text = human.out.join("\n");
	expect(text).toContain("state/{deviceId}");
	expect(text).toContain("command/{deviceId}/set");
	expect(text).toMatch(/client receives|client sends/);
	expect(text).not.toContain("bundled demo spec"); // server-backed, not fallback

	const json = io();
	expect(await run(["topics", ...CTRL_FLAG, "--json"], json.io)).toBe(0);
	const topics = JSON.parse(json.out.join("\n")) as Array<{ topic: string }>;
	expect(topics.map((t) => t.topic).sort()).toEqual([
		"command/{deviceId}/set",
		"state/{deviceId}",
	]);
});

test("publish --payload injects and state renders the retained entry", async () => {
	const pub = io();
	expect(
		await run(
			[
				"publish",
				"state/thermostat-9",
				"--payload",
				'{"deviceId":"thermostat-9","status":"idle"}',
				...CTRL_FLAG,
				"--wait",
			],
			pub.io,
		),
	).toBe(0);
	expect(pub.out.join("\n")).toContain("injected → state/thermostat-9");
	expect(pub.out.join("\n")).toContain("settled: true");

	const st = io();
	expect(
		await run(["state", "--topic", "state/thermostat-9", ...CTRL_FLAG], st.io),
	).toBe(0);
	expect(st.out.join("\n")).toContain('"deviceId":"thermostat-9"');
});

test("publish on an unmatched topic exits nonzero unless --force (EQ1)", async () => {
	const bare = io();
	expect(
		await run(
			["publish", "nope/unknown", "--payload", "{}", ...CTRL_FLAG],
			bare.io,
		),
	).toBe(1);
	expect(bare.out.join("\n")).toContain("unknown topic");
	expect(bare.err.join("\n")).toContain("--force");

	const forced = io();
	expect(
		await run(
			["publish", "nope/unknown", "--payload", "{}", "--force", ...CTRL_FLAG],
			forced.io,
		),
	).toBe(0);
});

test("publish rejects --payload with --example, and bad --payload JSON, client-side", async () => {
	const both = io();
	expect(
		await run(
			["publish", "state/x", "--payload", "{}", "--example", ...CTRL_FLAG],
			both.io,
		),
	).toBe(1);
	expect(both.err.join("\n")).toContain("mutually exclusive");

	const bad = io();
	expect(
		await run(
			["publish", "state/x", "--payload", "{nope", ...CTRL_FLAG],
			bad.io,
		),
	).toBe(1);
	expect(bad.err.join("\n")).toContain("invalid JSON");
});

// --- R-020: the --payload* input family on publish + scenario (EQ1/EQ4) ---
// [itest->R-020]

test("publish --payload-file injects the file's JSON; a missing file errors client-side", async () => {
	const file = join(base, "payload.json");
	writeFileSync(file, '{"deviceId":"from-file","status":"idle"}');
	const ok = io();
	expect(
		await run(
			["publish", "state/from-file", "--payload-file", file, ...CTRL_FLAG],
			ok.io,
		),
	).toBe(0);
	const st = io();
	await run(["state", "--topic", "state/from-file", ...CTRL_FLAG], st.io);
	expect(st.out.join("\n")).toContain('"deviceId":"from-file"');

	const missing = io();
	expect(
		await run(
			[
				"publish",
				"state/x",
				"--payload-file",
				join(base, "nope.json"),
				...CTRL_FLAG,
			],
			missing.io,
		),
	).toBe(1);
	expect(missing.err.join("\n")).toContain("cannot read");
});

test("the payload sources are mutually exclusive in every pairing", async () => {
	const pairs = [
		["--payload", "{}", "--example"],
		["--payload", "{}", "--payload-file", "x.json"],
		["--example", "--payload-file", "x.json"],
	];
	for (const extra of pairs) {
		const r = io();
		expect(
			await run(["publish", "state/x", ...extra, ...CTRL_FLAG], r.io),
		).toBe(1);
		expect(r.err.join("\n")).toContain("mutually exclusive");
	}
});

test("publish --payload - reads the payload from stdin", async () => {
	const bin = `${import.meta.dir}/../bin/offbook`;
	const proc = Bun.spawn(
		[bin, "publish", "state/stdin-1", "--payload", "-", ...CTRL_FLAG],
		{
			stdin: new TextEncoder().encode('{"deviceId":"stdin-1","status":"idle"}'),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	await proc.exited;
	expect({ code: proc.exitCode, err }).toEqual({ code: 0, err: "" });
	expect(out).toContain("injected → state/stdin-1");

	const st = io();
	await run(["state", "--topic", "state/stdin-1", ...CTRL_FLAG], st.io);
	expect(st.out.join("\n")).toContain('"deviceId":"stdin-1"');
});

test("scenario accepts the same --payload* family: --payload-file feeds {{payload.*}} refs (EQ4)", async () => {
	const file = join(base, "trigger-payload.json");
	writeFileSync(file, '{"mode":"heat","target":33}');
	const fired = io();
	expect(
		await run(
			[
				"scenario",
				"accept-set",
				"--param",
				"deviceId=t8",
				"--payload-file",
				file,
				"--wait",
				...CTRL_FLAG,
			],
			fired.io,
		),
	).toBe(0);
	const st = io();
	await run(["state", "--topic", "state/t8", ...CTRL_FLAG], st.io);
	expect(st.out.join("\n")).toContain('"target":33');

	const both = io();
	expect(
		await run(
			[
				"scenario",
				"accept-set",
				"--payload",
				"{}",
				"--payload-file",
				file,
				...CTRL_FLAG,
			],
			both.io,
		),
	).toBe(1);
	expect(both.err.join("\n")).toContain("mutually exclusive");
});

test("scenario fires POST /v1/trigger/:name with --param; unknown name renders the envelope and exits nonzero", async () => {
	const fired = io();
	expect(
		await run(
			[
				"scenario",
				"accept-set",
				"--param",
				"deviceId=t7",
				"--wait",
				...CTRL_FLAG,
			],
			fired.io,
		),
	).toBe(0);
	expect(fired.out.join("\n")).toContain("fired → scenario 'accept-set'");

	const st = io();
	await run(["state", "--topic", "state/t7", ...CTRL_FLAG], st.io);
	expect(st.out.join("\n")).toContain('"status":"accepted"');

	const missing = io();
	expect(await run(["scenario", "ghost", ...CTRL_FLAG], missing.io)).toBe(1);
	expect(missing.err.join("\n")).toContain("unknown-scenario");
	// R-036: the failure names a next step, same as the missing-<name> case
	expect(missing.err.join("\n")).toContain("offbook scenarios");
});

test("scenarios lists the loaded L2 table", async () => {
	const s = io();
	expect(await run(["scenarios", ...CTRL_FLAG], s.io)).toBe(0);
	expect(s.out.join("\n")).toContain(
		"accept-set — on command/{deviceId}/set · 1 step(s)",
	);
});

test("reset --seed echoes the seed; mode reads and sets", async () => {
	const r = io();
	expect(await run(["reset", "--seed", "42", ...CTRL_FLAG], r.io)).toBe(0);
	expect(r.out.join("\n")).toMatch(/reset — seed 42 · violation baseline #\d+/);

	const m1 = io();
	expect(await run(["mode", ...CTRL_FLAG], m1.io)).toBe(0);
	expect(m1.out.join("\n")).toContain("mode: autonomous · seed 42");

	const m2 = io();
	expect(await run(["mode", "passive", ...CTRL_FLAG], m2.io)).toBe(0);
	expect(m2.out.join("\n")).toContain("mode: passive");

	const bad = io();
	expect(await run(["mode", "sideways", ...CTRL_FLAG], bad.io)).toBe(1);
	expect(bad.err.join("\n")).toContain("bad-request");

	await run(["mode", "autonomous", ...CTRL_FLAG], io().io);
});

test("validation renders violation lines + summary footer; check gates on client breaks since a baseline (P8)", async () => {
	// checkpoint via the CLI reset, then a CLEAN window
	const r = io();
	await run(["reset", ...CTRL_FLAG], r.io);
	const baseline = Number(/#(\d+)/.exec(r.out.join("\n"))?.[1]);
	expect(Number.isInteger(baseline)).toBe(true);
	await run(
		["publish", "state/thermostat-1", "--example", "--wait", ...CTRL_FLAG],
		io().io,
	);

	const clean = io();
	expect(
		await run(["check", "--since", String(baseline), ...CTRL_FLAG], clean.io),
	).toBe(0);
	expect(clean.out.join("\n")).toContain("clean");

	// off-contract client publish → check exits nonzero
	await run(
		[
			"publish",
			"command/thermostat-1/set",
			"--payload",
			'{"mode":"broil","target":22}',
			"--wait",
			...CTRL_FLAG,
		],
		io().io,
	);
	const broken = io();
	expect(
		await run(["check", "--since", String(baseline), ...CTRL_FLAG], broken.io),
	).toBe(1);
	expect(broken.out.join("\n")).toMatch(/1 client violation\(s\).*1 distinct/);

	const v = io();
	expect(
		await run(
			[
				"validation",
				"--since",
				String(baseline),
				"--origin",
				"client",
				...CTRL_FLAG,
			],
			v.io,
		),
	).toBe(0);
	const text = v.out.join("\n");
	expect(text).toMatch(/×1 ✗ client schema command\/thermostat-1\/set — /);
	expect(text).toMatch(/— 1 distinct shown \(1 total\)/);
});

// --- R-021: topics + validation human rendering (ER1/ER2/EQ3/EQ6) ---
// [itest->R-021]

test("topics default output has fields + example but NO raw JSON-Schema; --schema opts it in; --compact/--no-examples trim (ER1)", async () => {
	const def = io();
	await run(["topics", ...CTRL_FLAG], def.io);
	const text = def.out.join("\n");
	expect(text).not.toMatch(/"type":/); // the acceptance grep
	expect(text).toMatch(/- deviceId \(required\): string/);
	expect(text).toContain("example: ");

	const raw = io();
	await run(["topics", "--schema", ...CTRL_FLAG], raw.io);
	expect(raw.out.join("\n")).toMatch(/"type":/); // opt-in only

	const compact = io();
	await run(["topics", "--compact", ...CTRL_FLAG], compact.io);
	const compactText = compact.out.join("\n");
	expect(compactText).not.toContain("example:");
	expect(compactText).not.toContain("- deviceId");
	expect(compactText).toContain("state/{deviceId}  [client receives]");

	const noEx = io();
	await run(["topics", "--no-examples", ...CTRL_FLAG], noEx.io);
	expect(noEx.out.join("\n")).not.toContain("example:");
	expect(noEx.out.join("\n")).toMatch(/- deviceId/);
});

test("topics --receives/--sends filter by direction and are mutually exclusive (EQ3)", async () => {
	const recv = io();
	await run(["topics", "--receives", "--compact", ...CTRL_FLAG], recv.io);
	expect(recv.out.join("\n")).toContain("state/{deviceId}");
	expect(recv.out.join("\n")).not.toContain("command/{deviceId}/set");

	const sends = io();
	await run(["topics", "--sends", "--compact", ...CTRL_FLAG], sends.io);
	expect(sends.out.join("\n")).toContain("command/{deviceId}/set");
	expect(sends.out.join("\n")).not.toContain("state/{deviceId}");

	const both = io();
	expect(
		await run(["topics", "--receives", "--sends", ...CTRL_FLAG], both.io),
	).toBe(1);
	expect(both.err.join("\n")).toContain("mutually exclusive");
});

test("renderTopicList flattens allOf into one field list and marks oneOf variants (ER1)", async () => {
	const t = (schema: object): TopicInfo =>
		({
			topic: "x/y",
			direction: "toClient",
			service: "s",
			schema,
			example: { a: "v" },
		}) as TopicInfo;
	const flattened = renderTopicList([
		t({
			allOf: [
				{ properties: { a: { type: "string" } }, required: ["a"] },
				{ properties: { b: { type: "number" } } },
			],
		}),
	]);
	expect(flattened).toContain("- a (required): string");
	expect(flattened).toContain("- b: number");
	expect(flattened).not.toMatch(/"type":/);

	const marked = renderTopicList([
		t({
			oneOf: [
				{ properties: { on: { type: "boolean" } }, required: ["on"] },
				{ properties: { level: { enum: ["low", "high"] } } },
			],
		}),
	]);
	expect(marked).toContain("one of 2 variant(s):");
	expect(marked).toContain("variant 1:");
	expect(marked).toContain("- on (required): boolean");
	expect(marked).toContain("- level: enum(low|high)");
});

// [utest->R-040]
test("renderTopicList marks initialState:false channels in both views", () => {
	const t: TopicInfo = {
		topic: "alerts/x",
		direction: "toClient",
		service: "s",
		schema: {},
		initialState: false,
	};
	expect(renderTopicList([t])).toContain("[no initial state]");
	expect(renderTopicList([t], { compact: true })).toContain(
		"[no initial state]",
	);
	const plain: TopicInfo = {
		topic: "state/x",
		direction: "toClient",
		service: "s",
		schema: {},
	};
	expect(renderTopicList([plain])).not.toContain("[no initial state]");
});

test("validation collapses repeats to ×N with the EQ6 composed headline; -v expands; --json round-trips (ER2)", async () => {
	const r = io();
	await run(["reset", ...CTRL_FLAG], r.io);
	const baseline = Number(/#(\d+)/.exec(r.out.join("\n"))?.[1]);
	// the same off-contract publish twice → ONE distinct violation, ×2
	for (let i = 0; i < 2; i++)
		await run(
			[
				"publish",
				"command/thermostat-1/set",
				"--payload",
				'{"mode":"broil","target":22}',
				"--wait",
				...CTRL_FLAG,
			],
			io().io,
		);

	const v = io();
	expect(
		await run(
			[
				"validation",
				"--since",
				String(baseline),
				"--origin",
				"client",
				...CTRL_FLAG,
			],
			v.io,
		),
	).toBe(0);
	const text = v.out.join("\n");
	expect(text).toMatch(
		/×2 ✗ client schema command\/thermostat-1\/set — \/mode /,
	);
	expect(text).toMatch(/\(got "broil"\) · #\d+…#\d+/);
	expect(text).toMatch(/— 1 distinct shown \(2 total\) · log distinct \d+/);
	expect(text).not.toMatch(/"keyword":/); // no raw Ajv object in human output

	const verbose = io();
	await run(
		[
			"validation",
			"--since",
			String(baseline),
			"--origin",
			"client",
			"-v",
			...CTRL_FLAG,
		],
		verbose.io,
	);
	const vText = verbose.out.join("\n");
	expect(vText).toContain("client: control-plane");
	expect(vText).toContain('payload: {"mode":"broil","target":22}');
	expect(vText).toMatch(/error: \/mode enum — /);

	const json = io();
	await run(
		["validation", "--since", String(baseline), "--json", ...CTRL_FLAG],
		json.io,
	);
	const parsed = JSON.parse(json.out.join("\n")) as {
		violations: Array<{ errors?: unknown[] }>;
		summary: { distinct: { total: number } };
	};
	expect(parsed.violations.length).toBeGreaterThanOrEqual(2);
	expect(parsed.violations.some((x) => (x.errors?.length ?? 0) > 0)).toBe(true);
	expect(parsed.summary.distinct.total).toBeGreaterThanOrEqual(1);
});

test("diagnostics and specs render; demo-composed server has no specs but shows branch mode", async () => {
	const d = io();
	expect(await run(["diagnostics", ...CTRL_FLAG], d.io)).toBe(0);
	expect(d.out.join("\n")).toMatch(/— \d+ error\(s\) · \d+ warning\(s\)/);

	const s = io();
	expect(await run(["specs", ...CTRL_FLAG], s.io)).toBe(0);
	expect(s.out.join("\n")).toContain("(no specs");
	expect(s.out.join("\n")).toContain("resolution-mode: branch");
});

// --- R-023: status scoreboard + check's server-retained baseline (P8/D-014) ---
// [itest->R-023]

test("check with no --since gates on the window since the LAST RESET (server-retained baseline)", async () => {
	// break the contract → check (no --since) is dirty
	await run(["reset", ...CTRL_FLAG], io().io);
	await run(
		[
			"publish",
			"command/thermostat-1/set",
			"--payload",
			'{"mode":"broil","target":22}',
			"--wait",
			...CTRL_FLAG,
		],
		io().io,
	);
	const dirty = io();
	expect(await run(["check", ...CTRL_FLAG], dirty.io)).toBe(1);
	expect(dirty.out.join("\n")).toMatch(/since #\d+/);

	// a fresh reset advances the retained baseline past the break → clean
	await run(["reset", ...CTRL_FLAG], io().io);
	const clean = io();
	expect(await run(["check", ...CTRL_FLAG], clean.io)).toBe(0);
	expect(clean.out.join("\n")).toContain("clean");

	// mode --json surfaces the baseline itself (D-014)
	const mj = io();
	await run(["mode", "--json", ...CTRL_FLAG], mj.io);
	const parsed = JSON.parse(mj.out.join("\n")) as { lastResetSeq: number };
	expect(parsed.lastResetSeq).toBeGreaterThan(0);
});

test("status prints the caught-N-distinct-breaks scoreboard, diagnostics counts, and the connect target", async () => {
	const dir = join(base, "run-live-status");
	await writeRunfile(
		dir,
		{
			pid: process.pid,
			brokerWsPort: WS,
			brokerTcpPort: TCP,
			controlPlanePort: CTRL,
			startedAt: "t",
		},
		{ stateDir: STATE },
	);
	const st = io();
	expect(await run(["status", "--run-dir", dir], st.io)).toBe(0);
	const text = st.out.join("\n");
	expect(text).toMatch(/caught \d+ distinct client break\(s\)/);
	expect(text).toMatch(/diagnostics: \d+ error\(s\) · \d+ warning\(s\)/);
	expect(text).toContain(`point your MQTT client at ws://localhost:${WS}`);
});

// --- runfile resolution (G14) ---

test("client verbs resolve the runfile: live pid+port works, stale pid errors, no runfile errors", async () => {
	const liveDir = join(base, "run-live");
	await writeRunfile(
		liveDir,
		{
			pid: process.pid, // alive, and CTRL answers as offbook
			brokerWsPort: WS,
			brokerTcpPort: TCP,
			controlPlanePort: CTRL,
			startedAt: "t",
		},
		{ stateDir: STATE },
	);
	const live = io();
	expect(await run(["mode", "--run-dir", liveDir], live.io)).toBe(0);
	expect(live.out.join("\n")).toContain("mode:");

	// a pid that is definitely dead: a spawned-and-exited child
	const dead = Bun.spawnSync(["true"]);
	const staleDir = join(base, "run-stale");
	await writeRunfile(
		staleDir,
		{
			pid: dead.pid ?? 4_193_999,
			brokerWsPort: WS,
			brokerTcpPort: TCP,
			controlPlanePort: CTRL,
			startedAt: "t",
		},
		{ stateDir: STATE },
	);
	const stale = io();
	expect(await run(["state", "--run-dir", staleDir], stale.io)).toBe(1);
	expect(stale.err.join("\n")).toContain("stale runfile");

	const none = io();
	expect(
		await run(["state", "--run-dir", join(base, "run-none")], none.io),
	).toBe(1);
	expect(none.err.join("\n")).toContain("not running");
});

test("topics falls back to the bundled demo spec when nothing is running (M0 discovery floor)", async () => {
	const t = io();
	expect(await run(["topics", "--run-dir", join(base, "run-none")], t.io)).toBe(
		0,
	);
	const text = t.out.join("\n");
	expect(text).toContain("bundled demo spec");
	expect(text).toContain("state/{deviceId}");
	expect(t.err).toEqual([]);
});

// [itest->R-043]
test("topics --json with no live server refuses (exit 1, run-dir-qualified); human fallback stays", async () => {
	const empty = mkdtempSync(join(tmpdir(), "no-server-"));
	const refused = io();
	expect(await run(["topics", "--json", "--run-dir", empty], refused.io)).toBe(
		1,
	);
	expect(refused.err.join("\n")).toContain(
		"bundled-demo fallback is human-only",
	);
	const human = io();
	expect(await run(["topics", "--run-dir", empty], human.io)).toBe(0);
	expect(human.out[0]).toContain("showing the bundled demo spec"); // pinned note survives
});

test("down is idempotent on a dead/absent runfile; status exits nonzero when down; logs reads the log file", async () => {
	const deadPid = Bun.spawnSync(["true"]).pid ?? 4_193_998;
	const dir = join(base, "run-down");
	await writeRunfile(
		dir,
		{
			pid: deadPid,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 3,
			startedAt: "t",
		},
		{ stateDir: STATE },
	);
	const d1 = io();
	expect(await run(["down", "--run-dir", dir], d1.io)).toBe(0);
	expect(d1.out.join("\n")).toContain("not running");
	expect(await readRunfile(dir)).toBeUndefined();

	const d2 = io();
	expect(await run(["down", "--run-dir", dir], d2.io)).toBe(0); // idempotent

	const st = io();
	expect(await run(["status", "--run-dir", dir], st.io)).toBe(1);
	expect(st.err.join("\n")).toContain("not running");

	writeFileSync(join(dir, "offbook.log"), "[offbook] hello from the log\n");
	const lg = io();
	expect(await run(["logs", "--run-dir", dir], lg.io)).toBe(0);
	expect(lg.out.join("\n")).toContain("hello from the log");

	const noLog = io();
	expect(
		await run(["logs", "--run-dir", join(base, "run-none")], noLog.io),
	).toBe(1);
});

test("init scaffolds only-when-absent and refuses a re-run", async () => {
	const dir = join(base, "proj-init");
	const first = io();
	expect(await run(["init", dir], first.io)).toBe(0);
	for (const f of [
		"services.yaml",
		"environments.yaml",
		"scenarios/00-example.yaml",
		".gitignore",
	])
		expect(existsSync(join(dir, f))).toBe(true);
	expect(existsSync(join(dir, "handlers"))).toBe(true);
	expect(existsSync(join(dir, "specs.lock"))).toBe(false); // never scaffolded

	const again = io();
	expect(await run(["init", dir], again.io)).toBe(1);
	expect(again.err.join("\n")).toContain("already exists");
});

test("unknown verb prints usage and exits nonzero", async () => {
	const u = io();
	expect(await run(["frobnicate"], u.io)).toBe(1);
	expect(u.err.join("\n")).toContain("usage: offbook");
});

// --- mergeRegistries (the multi-service boot path) ---

test("mergeRegistries: one registry over all services — most-specific wins across services, declaration order breaks ties", () => {
	const ch = (topic: string, service: string): Channel =>
		({
			topic,
			direction: "toClient",
			service,
			schema: {},
			validate: () => [],
		}) as unknown as Channel;
	const regOf = (...channels: Channel[]): SpecRegistry => ({
		diagnostics: () => [],
		channels: () => channels,
		match: () => undefined,
		matchesFilter: () => false,
	});
	const a = regOf(ch("state/{deviceId}", "svc-a"));
	const b = regOf(ch("state/main", "svc-b"), ch("alerts/{level}", "svc-b"));
	const merged = mergeRegistries([a, b]);

	expect(merged.channels().map((c) => c.service)).toEqual([
		"svc-a",
		"svc-b",
		"svc-b",
	]);
	// literal beats {param} even though it was declared in the LATER registry
	expect(merged.match("state/main")?.channel.service).toBe("svc-b");
	expect(merged.match("state/other")?.channel.topic).toBe("state/{deviceId}");
	expect(merged.match("alerts/red")?.params).toEqual({ level: "red" });
	expect(merged.matchesFilter("state/+", "state/main")).toBe(true);
});

// [itest->R-043]
test("clientsFromLog: counts only post-last-boot-line connects, skips malformed", () => {
	const iso = "2026-08-08T10:00:00.000Z";
	const lines = [
		`[offbook] ${iso} boot: services.yaml sha256:${"a".repeat(64)}`,
		`[offbook] ${iso} ws-connect {"clientId":"stale-run"}`,
		`[offbook] ${iso} boot: services.yaml sha256:${"b".repeat(64)}`,
		`[offbook] ${iso} ws-connect {"clientId":"web-1","protocolLevel":4}`,
		`[offbook] ${iso} ws-connect not-json`,
		`[offbook] ${iso} mqtt-subscribe {"clientId":"web-1","topic":"state/x"}`,
		`[offbook] ${iso} tcp-connect {"clientId":"cli-2"}`,
	].join("\n");
	const r = clientsFromLog(lines);
	expect(r.connects).toBe(2); // stale-run excluded (before the last boot line)
	expect(r.last).toEqual({ clientId: "cli-2", at: iso });
	expect(clientsFromLog("")).toEqual({ connects: 0 });

	// boot line is the last line (no connects after)
	expect(
		clientsFromLog(
			`[offbook] ${iso} boot: services.yaml sha256:${"c".repeat(64)}`,
		),
	).toEqual({ connects: 0 });

	// torn JSON case: matches regex but fails JSON.parse, mixed with valid connects
	const withTorn = [
		`[offbook] ${iso} boot: services.yaml sha256:${"d".repeat(64)}`,
		`[offbook] ${iso} ws-connect {"clientId":"valid-1"}`,
		`[offbook] ${iso} ws-connect {bad: json}`,
		`[offbook] ${iso} tcp-connect {"clientId":"valid-2"}`,
	].join("\n");
	const rTorn = clientsFromLog(withTorn);
	expect(rTorn.connects).toBe(2); // torn line skipped
	expect(rTorn.last).toEqual({ clientId: "valid-2", at: iso });
});

// [itest->R-043]
test("clientsFromLog: sanitizes control characters restored by JSON.parse (F4)", () => {
	const iso = "2026-08-08T10:00:00.000Z";
	const esc = String.fromCharCode(27);
	const raw = JSON.stringify({ clientId: `web-${esc}[31mhostile` });
	const lines = [
		`[offbook] ${iso} boot: services.yaml sha256:${"e".repeat(64)}`,
		`[offbook] ${iso} ws-connect ${raw}`,
	].join("\n");
	const r = clientsFromLog(lines);
	expect(r.connects).toBe(1);
	const clientId = r.last?.clientId ?? "";
	expect(clientId.includes(esc)).toBe(false);
	for (let i = 0; i < clientId.length; i++) {
		const code = clientId.charCodeAt(i);
		expect(code < 32 || code === 127).toBe(false);
	}
});

// --- suite B: the real up → status → specs → check → down process cycle ---

test("up spawns the detached server from a local-git project, status/specs/logs read it, down stops it", async () => {
	const projectDir = await gitSpecProject();
	const runDir = join(projectDir, ".offbook");
	const flags = [
		"--run-dir",
		runDir,
		"--ws-port",
		"19010",
		"--tcp-port",
		"12910",
		"--ctrl-port",
		"19810",
	];
	const prevCwd = process.cwd();
	process.chdir(projectDir);
	try {
		const up = io();
		const upCode = await run(["up", "--ci", "--seed", "7", ...flags], up.io);
		if (upCode !== 0) throw new Error(`up failed:\n${up.err.join("\n")}`);
		const upText = up.out.join("\n");
		expect(upText).toContain(
			"point your MQTT client at ws://localhost:19010 (MQTT 3.1.1)",
		);
		expect(upText).toContain("mode passive · seed 7 (--ci profile)"); // --ci co-sets
		expect(existsSync(join(projectDir, "specs.lock"))).toBe(true);

		// [itest->R-043]
		const logText = await Bun.file(
			join(projectDir, ".offbook", "offbook.log"),
		).text();
		expect(logText).toMatch(/\] .*boot: services\.yaml sha256:[0-9a-f]{64}$/m);

		// a second up refuses the live double-start (P7)
		const dup = io();
		expect(await run(["up", ...flags], dup.io)).toBe(1);
		expect(dup.err.join("\n")).toContain("already running");

		const st = io();
		expect(await run(["status", "--run-dir", runDir], st.io)).toBe(0);
		const stText = st.out.join("\n");
		expect(stText).toContain("offbook: running");
		expect(stText).toContain("mode passive · seed 7");
		expect(stText).toMatch(
			/spec thermostat: main@.*asyncapi\.yaml @ [0-9a-f]{8}/,
		);
		expect(stText).toMatch(/fetched .* \(\d+[smhd] ago\)/); // neutral spec age (P2)
		expect(stText).toContain("no connects observed this run"); // zero-connects branch

		const sp = io();
		expect(await run(["specs", "--run-dir", runDir], sp.io)).toBe(0);
		expect(sp.out.join("\n")).toContain("thermostat:");
		expect(sp.out.join("\n")).toContain("branch tip");

		const upd = io();
		expect(await run(["specs", "update", "--run-dir", runDir], upd.io)).toBe(0);
		expect(upd.out.join("\n")).toContain("specs refreshed (1 service(s))");

		// [itest->R-043] edit services.yaml after `up` to test staleness warning
		const servicesPath = join(projectDir, "services.yaml");
		const currentServices = await Bun.file(servicesPath).text();
		writeFileSync(servicesPath, `${currentServices}# edited\n`);

		// specs update with --ctrl-port should skip the warning (it's a server-aware refresh)
		const updCtrl = io();
		expect(
			await run(
				["specs", "update", "--run-dir", runDir, "--ctrl-port", "19810"],
				updCtrl.io,
			),
		).toBe(0);
		expect(updCtrl.out.join("\n")).toContain("specs refreshed (1 service(s))");
		expect(updCtrl.out.join("\n")).not.toContain("changed since");

		// specs update without --ctrl-port should warn (the running server is stale)
		const updWarn = io();
		expect(
			await run(["specs", "update", "--run-dir", runDir], updWarn.io),
		).toBe(0);
		expect(updWarn.out.join("\n")).toContain("specs refreshed (1 service(s))");
		expect(updWarn.out.join("\n")).toContain("changed since");

		// the CI gate over the wire: clean → 0, off-contract publish → 1
		expect(await run(["check", "--run-dir", runDir], io().io)).toBe(0);
		await run(
			[
				"publish",
				"command/thermostat-1/set",
				"--payload",
				'{"mode":"broil","target":22}',
				"--wait",
				"--run-dir",
				runDir,
			],
			io().io,
		);
		expect(await run(["check", "--run-dir", runDir], io().io)).toBe(1);

		const lg = io();
		expect(await run(["logs", "--run-dir", runDir], lg.io)).toBe(0);
		expect(lg.out.join("\n")).toContain("listening");

		const down = io();
		expect(await run(["down", "--run-dir", runDir], down.io)).toBe(0);
		expect(down.out.join("\n")).toContain("stopped");
		expect(await readRunfile(runDir)).toBeUndefined();
		expect(await run(["down", "--run-dir", runDir], io().io)).toBe(0); // idempotent
	} finally {
		process.chdir(prevCwd);
		// safety net: if down never ran, kill via the runfile
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		await rm(projectDir, { recursive: true, force: true });
	}
}, 60_000);

// --- R-022: up boot profiles + port lifecycle (P7/EH1) ---
// [itest->R-022]

test("up preflights the ports in the foreground (named fix, no detached EADDRINUSE) and auto-reclaims a stale runfile", async () => {
	const dir = join(base, "run-preflight");
	const dead = Bun.spawnSync(["true"]).pid ?? 4_193_997;
	await writeRunfile(
		dir,
		{
			pid: dead,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 3,
			startedAt: "t",
		},
		{ stateDir: STATE },
	);
	// CTRL is held by the suite-A server, so preflight must fail fast — after
	// reclaiming the stale runfile, before anything spawns
	const up = io();
	expect(
		await run(
			[
				"up",
				"--run-dir",
				dir,
				"--ws-port",
				"19021",
				"--tcp-port",
				"12921",
				"--ctrl-port",
				String(CTRL),
			],
			up.io,
		),
	).toBe(1);
	expect(up.out.join("\n")).toContain("reclaiming stale runfile");
	expect(up.err.join("\n")).toContain("another offbook owns the control port");
	expect(up.err.join("\n")).toContain(String(CTRL));
	expect(up.err.join("\n")).not.toContain("owns these ports");
	expect(up.err.join("\n")).not.toContain("likely the demo");
	expect(await readRunfile(dir)).toBeUndefined(); // reclaimed; nothing spawned
});

// [itest->R-043]
test("up against ports owned by another offbook attributes it instead of 'another broker?'", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "attr-"));
	const a = io();
	expect(
		await run(
			[
				"up",
				"--run-dir",
				scratch,
				"--ws-port",
				String(WS),
				"--tcp-port",
				String(TCP),
				"--ctrl-port",
				String(CTRL),
			],
			a.io,
		),
	).toBe(1);
	expect(a.err.join("\n")).toContain("another offbook owns the control port");
	expect(a.err.join("\n")).toContain(String(CTRL));
	expect(a.err.join("\n")).not.toContain("owns these ports");
	expect(a.err.join("\n")).not.toContain("likely the demo");
});

// F5 — the branch that must NOT attribute: a foreign (non-offbook) listener
// on the ctrl port fails probeOffbook's mode-shape check, so `up` preflight
// must fall back to the generic busy message, not claim another offbook.
// [itest->R-043]
test("up against a ctrl port held by a foreign listener falls back to the generic busy message", async () => {
	const FOREIGN_WS = 19045;
	const FOREIGN_TCP = 12945;
	const FOREIGN_CTRL = 19845; // not offbook: no `mode` field in the response
	const foreign = Bun.serve({
		port: FOREIGN_CTRL,
		fetch: () => Response.json({ ok: true }),
	});
	try {
		const scratch = mkdtempSync(join(tmpdir(), "attr-neg-"));
		const b = io();
		expect(
			await run(
				[
					"up",
					"--run-dir",
					scratch,
					"--ws-port",
					String(FOREIGN_WS),
					"--tcp-port",
					String(FOREIGN_TCP),
					"--ctrl-port",
					String(FOREIGN_CTRL),
				],
				b.io,
			),
		).toBe(1);
		expect(b.err.join("\n")).toContain("port(s) in use");
		expect(b.err.join("\n")).toContain(`ctrl ${FOREIGN_CTRL}`);
		expect(b.err.join("\n")).not.toContain("another offbook owns");
		expect(b.err.join("\n")).not.toContain("another directory");
	} finally {
		foreign.stop(true);
	}
});

test("interactive default boots lenient-loud past a bad scenario (autonomous, strict=false); up --strict makes it fatal", async () => {
	const projectDir = await gitSpecProject();
	const scenariosDir = join(projectDir, "scenarios");
	mkdirSync(scenariosDir);
	// structurally broken: no `then` steps — a scenario-load error (l2 §7)
	writeFileSync(join(scenariosDir, "10-broken.yaml"), "- name: broken\n");
	const runDir = join(projectDir, ".offbook");
	const flags = [
		"--run-dir",
		runDir,
		"--ws-port",
		"19022",
		"--tcp-port",
		"12922",
		"--ctrl-port",
		"19822",
	];
	const prevCwd = process.cwd();
	process.chdir(projectDir);
	try {
		// interactive default: lenient-loud — boots, surfaces the load error
		const up1 = io();
		const code1 = await run(["up", ...flags], up1.io);
		if (code1 !== 0) throw new Error(`up failed:\n${up1.err.join("\n")}`);
		expect(up1.out.join("\n")).toContain("mode autonomous"); // interactive profile
		expect(up1.out.join("\n")).not.toContain("--ci profile");

		const m = io();
		await run(["mode", "--run-dir", runDir], m.io);
		expect(m.out.join("\n")).toContain("mode: autonomous");

		const d = io();
		expect(await run(["diagnostics", "--run-dir", runDir], d.io)).toBe(0);
		expect(d.out.join("\n")).toMatch(/✗ scenario-load .*10-broken/);

		expect(await run(["down", "--run-dir", runDir], io().io)).toBe(0);

		// --strict (independent of --ci): the same bad scenario is now fatal —
		// up surfaces the foreground failure and cleans the runfile
		const up2 = io();
		expect(await run(["up", "--strict", ...flags], up2.io)).toBe(1);
		expect(up2.err.join("\n")).toContain("failed to start");
		expect(up2.err.join("\n")).toMatch(/fatal|strict/);
		expect(await readRunfile(runDir)).toBeUndefined();
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
}, 60_000);

// --- R-024: watch modes (EH1/EO1–EO4) ---
// [itest->R-024]

const BIN = `${import.meta.dir}/../bin/offbook`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("logs -f follows appended lines (EO1)", async () => {
	const dir = join(base, "run-logs-f");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "offbook.log"), "first line\n");
	const proc = Bun.spawn([BIN, "logs", "-f", "--run-dir", dir], {
		stdout: "pipe",
		stderr: "pipe",
	});
	await pause(800);
	appendFileSync(join(dir, "offbook.log"), "appended line\n");
	await pause(1200);
	proc.kill();
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	expect(out).toContain("first line");
	expect(out).toContain("appended line");
}, 15_000);

test("validation --watch renders a new violation within one interval (EO2)", async () => {
	const r = io();
	await run(["reset", ...CTRL_FLAG], r.io);
	const baseline = Number(/#(\d+)/.exec(r.out.join("\n"))?.[1]);
	const proc = Bun.spawn(
		[
			BIN,
			"validation",
			"--watch",
			"--interval",
			"100",
			"--since",
			String(baseline),
			...CTRL_FLAG,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	await pause(1000); // CLI cold start + first poll
	await run(
		[
			"publish",
			"command/thermostat-1/set",
			"--payload",
			'{"mode":"broil","target":22}',
			"--wait",
			...CTRL_FLAG,
		],
		io().io,
	);
	await pause(2000); // > one interval
	proc.kill();
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	expect(out).toMatch(
		/×1 ✗ client schema command\/thermostat-1\/set — \/mode /,
	);
}, 20_000);

test("diagnostics --watch diff-renders a hot-reloaded scenario-load error (EO3 + l2 §8 hot-reload)", async () => {
	const proc = Bun.spawn(
		[BIN, "diagnostics", "--watch", "--interval", "100", ...CTRL_FLAG],
		{ stdout: "pipe", stderr: "pipe" },
	);
	await pause(1000);
	// dropping a broken file into the WATCHED scenarios dir hot-reloads the
	// table (compose wires runtime.watch() in autonomous) → a new diagnostic
	const brokenPath = join(base, "scenarios", "90-broken.yaml");
	writeFileSync(brokenPath, "- name: broken-watch\n");
	await pause(2000);
	proc.kill();
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	expect(out).toMatch(/✗ scenario-load .*90-broken/);
	// clean up and let the watcher swap the good table back in
	rmSync(brokenPath);
	await pause(300);
}, 20_000);

test("up --ci ignores --watch (EH1 co-set)", async () => {
	const dir = join(base, "run-ci-watch");
	const up = io();
	expect(
		await run(
			[
				"up",
				"--ci",
				"--watch",
				"--run-dir",
				dir,
				"--ws-port",
				"19031",
				"--tcp-port",
				"12931",
				"--ctrl-port",
				String(CTRL), // occupied → preflight fails after the note (cheap)
			],
			up.io,
		),
	).toBe(1);
	expect(up.out.join("\n")).toContain("--watch is ignored under --ci");
});

test("up --watch restarts the detached server on a handlers/**/*.ts change; the log stays continuous (EH1/G14)", async () => {
	const projectDir = await gitSpecProject();
	const handlersDir = join(projectDir, "handlers");
	mkdirSync(handlersDir);
	writeFileSync(join(handlersDir, "noop.ts"), "// no handlers yet\n");
	const runDir = join(projectDir, ".offbook");
	const flags = [
		"--run-dir",
		runDir,
		"--ws-port",
		"19030",
		"--tcp-port",
		"12930",
		"--ctrl-port",
		"19830",
	];
	const prevCwd = process.cwd();
	process.chdir(projectDir);
	try {
		const up = io();
		const code = await run(["up", "--watch", ...flags], up.io);
		if (code !== 0) throw new Error(`up failed:\n${up.err.join("\n")}`);
		const first = await readRunfile(runDir);
		expect(first).toBeDefined();

		// edit a handler → the serving process replaces itself (fresh module
		// graph) and points the runfile at the new pid
		writeFileSync(join(handlersDir, "noop.ts"), "// edited\n");
		const deadline = Date.now() + 25_000;
		let second = await readRunfile(runDir);
		while ((!second || second.pid === first?.pid) && Date.now() < deadline) {
			await pause(200);
			second = await readRunfile(runDir);
		}
		expect(second?.pid).not.toBe(first?.pid);

		// the replacement serves — wait for readiness, then status is green
		const ready = Date.now() + 25_000;
		while (
			(await run(["status", "--run-dir", runDir], io().io)) !== 0 &&
			Date.now() < ready
		)
			await pause(200);
		expect(await run(["status", "--run-dir", runDir], io().io)).toBe(0);

		// appended, never truncated: both boots' lines are in ONE log (G14)
		const lg = io();
		await run(["logs", "--run-dir", runDir], lg.io);
		const logText = lg.out.join("\n");
		expect(logText).toContain("restarting (up --watch)");
		expect(logText.match(/listening —/g)?.length ?? 0).toBeGreaterThanOrEqual(
			2,
		);

		expect(await run(["down", "--run-dir", runDir], io().io)).toBe(0);
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

// --- R-025: the init → up path + the L1-floor orientation banner (EI1/EI2) ---
// [itest->R-025]

test("EI1/EI2: init && <set services> && up reaches a running server; the fresh project shows the L1-floor banner, authored scenarios suppress it", async () => {
	const projectDir = await mkdtemp(join(tmpdir(), "offbook-init-e2e-"));
	const runDir = join(projectDir, ".offbook");
	const flags = [
		"--run-dir",
		runDir,
		"--ws-port",
		"19040",
		"--tcp-port",
		"12940",
		"--ctrl-port",
		"19840",
	];
	const prevCwd = process.cwd();
	try {
		// 1. scaffold — the ONLY hand edit afterwards is services.yaml (EI1)
		expect(await run(["init", projectDir], io().io)).toBe(0);
		const repoDir = join(projectDir, "repo");
		await makeSpecRepo(repoDir);
		writeFileSync(join(projectDir, "services.yaml"), servicesYamlFor(repoDir));

		process.chdir(projectDir);

		// 2. up reaches a running server; the scaffold loads ZERO scenarios
		// (00-example.yaml is comments-only) and handlers/ is empty → banner
		const up1 = io();
		const code1 = await run(["up", ...flags], up1.io);
		if (code1 !== 0) throw new Error(`up failed:\n${up1.err.join("\n")}`);
		expect(up1.out.join("\n")).toContain("L1 floor active");

		const t = io();
		expect(await run(["topics", "--run-dir", runDir], t.io)).toBe(0);
		expect(t.out.join("\n")).toContain("state/{deviceId}"); // served, not fallback
		expect(t.out.join("\n")).not.toContain("bundled demo spec");
		expect(await run(["down", "--run-dir", runDir], io().io)).toBe(0);

		// 3. author a real scenario → the banner is suppressed (EI2)
		writeFileSync(join(projectDir, "scenarios", "10-real.yaml"), SCENARIO);
		const up2 = io();
		const code2 = await run(["up", ...flags], up2.io);
		if (code2 !== 0) throw new Error(`up failed:\n${up2.err.join("\n")}`);
		expect(up2.out.join("\n")).not.toContain("L1 floor active");
		expect(await run(["down", "--run-dir", runDir], io().io)).toBe(0);
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

// --- R-036 first-run error audit: every error names a next step ---
// ports for these pins: 19140/19141, 12996/12997, 19896/19897

test("unknown flag points at usage", async () => {
	const err: string[] = [];
	await run(["topics", "--bogus"], { out: () => {}, err: (l) => err.push(l) });
	expect(err.join("\n")).toContain("for usage");
});

test("bare publish/scenario point at their listing verbs", async () => {
	const pubErr: string[] = [];
	await run(["publish"], { out: () => {}, err: (l) => pubErr.push(l) });
	expect(pubErr.join("\n")).toContain("offbook topics");
	const scnErr: string[] = [];
	await run(["scenario"], { out: () => {}, err: (l) => scnErr.push(l) });
	expect(scnErr.join("\n")).toContain("offbook scenarios");
});

// bind-probe: a leaked detached server holds its ports, and a listening
// socket releases on process exit (no TIME_WAIT), so binding is the
// truthful "is it free" check
function portFree(port: number): boolean {
	try {
		const probe = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: { data() {} },
		});
		probe.stop(true);
		return true;
	} catch {
		return false;
	}
}

test("up: busy port and failed boot both point at doctor", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "offbook-audit-"));
	// the failed-boot premise is "no services.yaml in cwd", so pin cwd to an
	// empty dir — inheriting the checkout root breaks the moment a stray
	// `offbook init` lands there: the boot then SUCCEEDS, the test fails, and
	// the detached server leaks onto the pinned ports, failing every later
	// run with the port-conflict attribution instead of the doctor hint
	const prevCwd = process.cwd();
	const emptyCwd = join(tmp, "cwd");
	mkdirSync(emptyCwd);
	process.chdir(emptyCwd);
	try {
		// busy ws port → preflight fails before any spawn
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: 19140,
			socket: { data() {} },
		});
		try {
			const busyErr: string[] = [];
			expect(
				await run(
					[
						"up",
						"--run-dir",
						join(tmp, "a"),
						"--ws-port",
						"19140",
						"--tcp-port",
						"12996",
						"--ctrl-port",
						"19896",
					],
					{ out: () => {}, err: (l) => busyErr.push(l) },
				),
			).not.toBe(0);
			expect(busyErr.join("\n")).toContain("offbook doctor");
		} finally {
			listener.stop(true);
		}

		// no services.yaml in cwd → the spawned server dies at boot → doctor hint
		const bootErr: string[] = [];
		expect(
			await run(
				[
					"up",
					"--run-dir",
					join(tmp, "b"),
					"--ws-port",
					"19141",
					"--tcp-port",
					"12997",
					"--ctrl-port",
					"19897",
				],
				{ out: () => {}, err: (l) => bootErr.push(l) },
			),
		).not.toBe(0);
		const bootText = bootErr.join("\n");
		expect(bootText).toContain("offbook doctor");
		// discriminate from the preflight-busy path (its generic message also
		// names doctor): only a spawned-then-dead server prints this header,
		// so a stray squatter on 19141/12997 can't green this case without
		// the boot path ever running
		expect(bootText).toContain("server failed to start");

		// leak guard: a regression that leaves the server alive (boot
		// succeeded, or bound-but-never-ready — `up` clears the runfile after
		// the deadline, so the finally's down can't reach that one) must fail
		// HERE, not squat silently on the pinned fixture ports
		for (const port of [19141, 12997, 19897])
			expect({ port, free: portFree(port) }).toEqual({ port, free: true });
	} finally {
		process.chdir(prevCwd);
		// belt-and-braces: if a regression ever lets the boot succeed, tear
		// the server down before dropping tmp instead of leaking it
		await run(["down", "--run-dir", join(tmp, "b")], {
			out: () => {},
			err: () => {},
		});
		rmSync(tmp, { recursive: true, force: true });
	}
}, 60_000); // the failed-boot case rides out `up`'s full readiness deadline

// [itest->R-043]
test("specsStalenessWarning: warns on hash mismatch, skips demo/absent/ctrl-only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "staleness-"));
	const iso = "2026-08-08T10:00:00.000Z";
	// no boot file → skip
	expect(await specsStalenessWarning(dir)).toBeUndefined();
	// demo boot → skip
	writeFileSync(
		join(dir, "offbook.boot.json"),
		JSON.stringify({ projectDir: dir, demo: true }),
	);
	writeFileSync(
		join(dir, "offbook.log"),
		`[offbook] ${iso} boot: bundled demo spec\n`,
	);
	expect(await specsStalenessWarning(dir)).toBeUndefined();
	// project boot, matching hash → no warn
	const services = "services: {}\n";
	writeFileSync(join(dir, "services.yaml"), services);
	writeFileSync(
		join(dir, "offbook.boot.json"),
		JSON.stringify({ projectDir: dir }),
	);
	const hash = createHash("sha256").update(services).digest("hex");
	writeFileSync(
		join(dir, "offbook.log"),
		`[offbook] ${iso} boot: services.yaml sha256:${hash}\n`,
	);
	expect(await specsStalenessWarning(dir)).toBeUndefined();
	// edited file → warn
	writeFileSync(join(dir, "services.yaml"), "services: {}\n# edited\n");
	expect(await specsStalenessWarning(dir)).toContain("restart to apply");
	rmSync(dir, { recursive: true, force: true });
});

test("specsStalenessWarning: skips gracefully on no boot line, malformed JSON, or unreadable services", async () => {
	// case 1: valid project boot, but log has no boot line (only ws-connect) → skip
	const dir1 = mkdtempSync(join(tmpdir(), "staleness-no-boot-line-"));
	const iso = "2026-08-08T10:00:00.000Z";
	writeFileSync(
		join(dir1, "offbook.boot.json"),
		JSON.stringify({ projectDir: dir1 }),
	);
	writeFileSync(
		join(dir1, "offbook.log"),
		`[offbook] ${iso} ws-connect {"clientId":"browser-1"}\n`,
	);
	expect(await specsStalenessWarning(dir1)).toBeUndefined();
	rmSync(dir1, { recursive: true, force: true });

	// case 2: malformed JSON in boot file → skip
	const dir2 = mkdtempSync(join(tmpdir(), "staleness-bad-json-"));
	writeFileSync(join(dir2, "offbook.boot.json"), "{bad json");
	expect(await specsStalenessWarning(dir2)).toBeUndefined();
	rmSync(dir2, { recursive: true, force: true });

	// case 3: services.yaml missing (deleted) since boot → warns (no skip; missing counts as changed)
	const dir3 = mkdtempSync(join(tmpdir(), "staleness-missing-services-"));
	const realContent = "services: {}\n";
	const realHash = createHash("sha256").update(realContent).digest("hex");
	writeFileSync(
		join(dir3, "offbook.boot.json"),
		JSON.stringify({ projectDir: dir3 }),
	);
	writeFileSync(
		join(dir3, "offbook.log"),
		`[offbook] ${iso} boot: services.yaml sha256:${realHash}\n`,
	);
	expect(await specsStalenessWarning(dir3)).toContain("restart to apply");
	rmSync(dir3, { recursive: true, force: true });
});

// --- D-032: verb policy over the resolver (instance discovery) ---

// [itest->R-045]
test("read verb, registry-resolved: the M16 header names the instance; cwd-resolved output is byte-identical (no header)", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-proj-"));
	const elsewhere = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(elsewhere, async () => {
		const inst = await fakeInstance({
			port: 19450,
			projectDir: proj,
			routes: { "/v1/state": { state: [] } },
		});
		try {
			const away = io();
			expect(await run(["state"], away.io)).toBe(0);
			expect(away.out[0]).toBe(`offbook @ ${proj} (ws 1 · http 19450)`);
			expect(away.out[1]).toBe("(no retained state)");
			// same verb from the project dir itself: no header, byte-identical
			process.chdir(proj);
			const home = io();
			expect(await run(["state"], home.io)).toBe(0);
			expect(home.out).toEqual(["(no retained state)"]);
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(elsewhere, { recursive: true, force: true });
});

// [itest->R-045]
test("object-shaped --json carries the server block on registry resolution only", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-jsonid-"));
	const elsewhere = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	const diagnostics = {
		diagnostics: [],
		summary: { errors: 0, warnings: 0, info: 0, byKind: {} },
	};
	await inDiscoveryWorld(elsewhere, async () => {
		const inst = await fakeInstance({
			port: 19465,
			projectDir: proj,
			routes: { "/v1/diagnostics": diagnostics },
		});
		try {
			const away = io();
			expect(await run(["diagnostics", "--json"], away.io)).toBe(0);
			expect(away.out).toHaveLength(1);
			const doc = JSON.parse(away.out[0]) as {
				server?: { projectDir: string };
			};
			expect(doc.server?.projectDir).toBe(proj);
			// cwd-resolved: byte-identical round-trip, no server block
			process.chdir(proj);
			const home = io();
			expect(await run(["diagnostics", "--json"], home.io)).toBe(0);
			expect(JSON.parse(home.out[0])).toEqual(diagnostics);
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(elsewhere, { recursive: true, force: true });
});

// [itest->R-045]
test("ambiguity: two live instances refuse with the M8 table (exit 2); --json emits exactly one envelope on stdout", async () => {
	const projA = mkdtempSync(join(tmpdir(), "offbook-vp-a-"));
	const projB = mkdtempSync(join(tmpdir(), "offbook-vp-b-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const a = await fakeInstance({ port: 19451, projectDir: projA });
		const b = await fakeInstance({ port: 19452, projectDir: projB });
		try {
			const human = io();
			expect(await run(["scenarios"], human.io)).toBe(2);
			const err = human.err.join("\n");
			expect(err).toContain(
				"offbook: several instances are running — pick one:",
			);
			expect(err).toContain(
				`offbook scenarios --run-dir ${join(projA, ".offbook")}`,
			);
			expect(human.out).toEqual([]);

			const json = io();
			expect(await run(["scenarios", "--json"], json.io)).toBe(2);
			expect(json.out).toHaveLength(1); // exactly one stdout document
			const envelope = JSON.parse(json.out[0]) as {
				error: { code: string };
				candidates: unknown[];
			};
			expect(envelope.error.code).toBe("ambiguous");
			expect(envelope.candidates).toHaveLength(2);
			expect(json.err.join("\n")).not.toContain("--run-dir");
		} finally {
			a.stop();
			b.stop();
		}
	});
	for (const d of [projA, projB, cwd])
		rmSync(d, { recursive: true, force: true });
});

// [itest->R-045]
test("M12 replaces M11 and M13 when the only skipped instance is cwd's own wedged one", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-wedged-"));
	await inDiscoveryWorld(cwd, async () => {
		// live pid, silent port: row 3
		await writeRunfile(
			join(cwd, ".offbook"),
			{
				pid: process.pid,
				brokerWsPort: 1,
				brokerTcpPort: 2,
				controlPlanePort: 19453, // nothing listens here
				startedAt: "t",
				token: "ab".repeat(16),
				host: hostname(),
			},
			{ stateDir: process.env.OFFBOOK_STATE_DIR ?? "" },
		);
		const x = io();
		expect(await run(["scenarios"], x.io)).toBe(1);
		const err = x.err.join("\n");
		expect(err).toContain("offbook is not answering here");
		expect(err).not.toContain("offbook is not running"); // M11 replaced
		expect(err).not.toContain("(offbook: an instance in"); // M13 replaced
	});
	rmSync(cwd, { recursive: true, force: true });
}, 15_000);

// [itest->R-045]
test("zero live, nothing skipped: M11 with its automation anchor, exit 1", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-empty-"));
	await inDiscoveryWorld(cwd, async () => {
		const x = io();
		expect(await run(["scenarios"], x.io)).toBe(1);
		expect(
			x.err.some((l) =>
				l.includes(
					"offbook is not running (no runfile in .offbook, and nothing else is running on this machine)",
				),
			),
		).toBe(true);
	});
	rmSync(cwd, { recursive: true, force: true });
});

// [itest->R-045]
test("mutating verb, registry-resolved: M15 stderr note, never an M16 header", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-mut-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({
			port: 19454,
			projectDir: proj,
			routes: { "/v1/reset": { reset: true, seed: 7, sinceSeq: 3 } },
		});
		try {
			const x = io();
			expect(await run(["reset"], x.io)).toBe(0);
			expect(x.err).toContain(
				`(offbook: using the offbook started in ${proj})`,
			);
			expect(x.out.some((l) => l.startsWith("offbook @"))).toBe(false);
			expect(x.out).toContain("reset — seed 7 · violation baseline #3");
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

// [itest->R-045]
test("specs update reads the RESOLVED instance's boot record for the staleness warning", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-stale-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await Bun.write(join(proj, "services.yaml"), "services: {}\n"); // current content
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({
			port: 19455,
			projectDir: proj,
			routes: { "/v1/specs/refresh": { specs: [] } },
		});
		// the instance's boot record + a boot line hashing DIFFERENT content
		await Bun.write(
			join(inst.runDir, "offbook.boot.json"),
			JSON.stringify({ projectDir: proj, config: {}, token: inst.token }),
		);
		const staleHash = new Bun.CryptoHasher("sha256")
			.update("older content")
			.digest("hex");
		await Bun.write(
			join(inst.runDir, "offbook.log"),
			`[offbook] 2026-08-19T00:00:00.000Z boot: services.yaml sha256:${staleHash}\n`,
		);
		try {
			const x = io();
			expect(await run(["specs", "update"], x.io)).toBe(0);
			expect(
				x.out.some((l) =>
					l.includes(
						"services.yaml changed since `offbook up` — restart to apply",
					),
				),
			).toBe(true);
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

// [itest->R-045]
test("status, registry-resolved: first line names the instance; --json carries the server block + skipped array", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-status-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({
			port: 19456,
			projectDir: proj,
			routes: {
				"/v1/mode": { mode: "autonomous", seed: 1, lastResetSeq: 0 },
				"/v1/specs": { specs: [], resolutionMode: "branch" },
				"/v1/validation": {
					violations: [],
					summary: {
						byOrigin: { client: 0, mock: 0 },
						distinct: { total: 0, client: 0, mock: 0 },
					},
				},
				"/v1/diagnostics": {
					diagnostics: [],
					summary: { errors: 0, warnings: 0, info: 0, byKind: {} },
				},
			},
		});
		try {
			const human = io();
			expect(await run(["status"], human.io)).toBe(0);
			expect(human.out[0]).toBe(`offbook @ ${proj} (ws 1 · http 19456)`);

			const json = io();
			expect(await run(["status", "--json"], json.io)).toBe(0);
			expect(json.out).toHaveLength(1);
			const doc = JSON.parse(json.out[0]) as {
				server: { projectDir: string; source: string; demo: boolean };
				skipped: unknown[];
			};
			expect(doc.server).toMatchObject({
				projectDir: proj,
				source: "registry",
				demo: false,
			});
			expect(doc.skipped).toEqual([]);
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

// [itest->R-045]
test("status --ctrl-port against a pre-upgrade (legacy) server refuses with the older-build message, exit 2", async () => {
	const legacy = Bun.serve({
		port: 19457,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/mode"
				? Response.json({ mode: "passive" })
				: new Response("nope", { status: 404 }),
	});
	try {
		const x = io();
		expect(await run(["status", "--ctrl-port", "19457"], x.io)).toBe(2);
		expect(x.err.join("\n")).toContain("started by an older offbook build");
	} finally {
		legacy.stop(true);
	}
});

// [itest->R-045]
test("status with nothing anywhere: the not-running clause covers the whole machine, exit 1", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const x = io();
		expect(await run(["status"], x.io)).toBe(1);
		expect(x.err.join("\n")).toContain(
			"offbook: not running (no runfile in .offbook, and nothing else is running on this machine)",
		);
	});
	rmSync(cwd, { recursive: true, force: true });
});
