// R-043 — probeOffbook direct: the "answers as offbook" probe that `up`
// preflight and doctor's ports check use to decide whether a busy control
// port may be attributed to another offbook instance. A regression here
// (e.g. accepting any 200 response) would make offbook falsely accuse an
// unrelated dev server of "owning" the port — the exact lie R-043 exists to
// prevent — so the shape check and the timeout bound are pinned directly.
// Also logSafeEnv (D-030): the env guard both server spawn sites use to keep
// offbook.log free of ANSI, which the R-043 parsers read as raw bytes.
// [utest->R-043]
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	logSafeEnv,
	pidAlive,
	probeOffbook,
	probeServer,
	readRunfile,
} from "./runfile.ts";

// ports for this file (repo convention: unique per file): 19960-19968

test("probeOffbook: a listener answering non-mode JSON is not attributed as offbook", async () => {
	const server = Bun.serve({
		port: 19960,
		fetch: () => Response.json({ ok: true }),
	});
	try {
		expect(await probeOffbook(19960)).toBe(false);
	} finally {
		server.stop(true);
	}
});

test("probeOffbook: a listener that never responds fails within the timeout, not hung", async () => {
	// a raw TCP accept, never an HTTP response: fetch() must time out, not hang
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 19961,
		socket: { data() {} },
	});
	try {
		const start = Date.now();
		expect(await probeOffbook(19961, 60)).toBe(false);
		expect(Date.now() - start).toBeLessThan(500); // bounded by timeoutMs, not the default
	} finally {
		listener.stop(true);
	}
});

test("probeOffbook: a {mode: passive} responder is attributed as a live offbook", async () => {
	const server = Bun.serve({
		port: 19962,
		fetch: () => Response.json({ mode: "passive" }),
	});
	try {
		expect(await probeOffbook(19962)).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("probeOffbook: a {mode: autonomous} responder is also attributed as live", async () => {
	const server = Bun.serve({
		port: 19963,
		fetch: () => Response.json({ mode: "autonomous" }),
	});
	try {
		expect(await probeOffbook(19963)).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("probeOffbook: nothing listening (connection refused) is not attributed as offbook", async () => {
	expect(await probeOffbook(19964)).toBe(false);
});

test("logSafeEnv: strips the color-forcing vars, asserts NO_COLOR, passes the rest through", () => {
	const parent = {
		FORCE_COLOR: "3",
		CLICOLOR_FORCE: "1",
		DEBUG_COLORS: "1",
		DEBUG: "*",
		PATH: "/usr/bin",
		TERM: "xterm-256color",
	};
	const env = logSafeEnv(parent);
	// deleting FORCE_COLOR is the load-bearing half: Bun gives it precedence
	// over NO_COLOR, so NO_COLOR=1 alone would not stop the ANSI wrapping
	expect("FORCE_COLOR" in env).toBe(false);
	expect("CLICOLOR_FORCE" in env).toBe(false);
	expect("DEBUG_COLORS" in env).toBe(false);
	expect(env.NO_COLOR).toBe("1");
	expect(env.PATH).toBe("/usr/bin");
	expect(env.TERM).toBe("xterm-256color");
	// DEBUG itself is functional (which lines get logged), not a color
	// switch — it must pass through so a debug-logging run keeps working
	expect(env.DEBUG).toBe("*");
});

test("logSafeEnv: never mutates the parent env it copies from", () => {
	const parent = { FORCE_COLOR: "3", HOME: "/home/x" };
	logSafeEnv(parent);
	expect(parent).toEqual({ FORCE_COLOR: "3", HOME: "/home/x" });
});

test("logSafeEnv: a clean parent gains only NO_COLOR", () => {
	expect(logSafeEnv({ PATH: "/usr/bin" })).toEqual({
		PATH: "/usr/bin",
		NO_COLOR: "1",
	});
});

test("both server spawn sites pass logSafeEnv — inheritance masks a dropped guard, so pin the source (D-030)", async () => {
	for (const file of ["index.ts", "serve.ts"]) {
		// comment lines dropped first, so a commented-out guard reads as absent
		const src = (await Bun.file(new URL(file, import.meta.url)).text())
			.split("\n")
			.filter((l) => !l.trim().startsWith("//"))
			.join("\n");
		const spawns = src.split("spawn(process.execPath").length - 1;
		expect(spawns).toBeGreaterThan(0);
		expect(src.split("env: logSafeEnv()").length - 1).toBe(spawns);
	}
});

// [utest->R-044]
test("probeServer: classifies an identity answer, a legacy /v1/mode answer, and silence", async () => {
	const identity = {
		pid: 4242,
		token: "aa".repeat(16),
		host: "devbox",
		projectDir: "/tmp/p",
		runDir: "/tmp/p/.offbook",
		startedAt: "2026-08-19T00:00:00.000Z",
		demo: false,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 19965 },
	};
	const server = Bun.serve({
		port: 19965,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/server"
				? Response.json(identity)
				: new Response("nope", { status: 404 }),
	});
	try {
		const probe = await probeServer(19965);
		expect(probe.kind).toBe("server");
		if (probe.kind === "server")
			expect(probe.identity.token).toBe(identity.token);
	} finally {
		server.stop(true);
	}

	// legacy: /v1/server 404s but /v1/mode answers offbook-shaped
	const legacy = Bun.serve({
		port: 19966,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/mode"
				? Response.json({ mode: "passive" })
				: new Response("nope", { status: 404 }),
	});
	try {
		expect((await probeServer(19966)).kind).toBe("legacy");
	} finally {
		legacy.stop(true);
	}

	// silence: nothing listens (the internal one-retry-with-longer-timeout
	// path still concludes silent)
	expect((await probeServer(19967, 60)).kind).toBe("silent");

	// a foreign HTTP server that 404s both paths is silent, not legacy
	const foreign = Bun.serve({
		port: 19968,
		fetch: () => new Response("hello", { status: 200 }),
	});
	try {
		expect((await probeServer(19968, 60)).kind).toBe("silent");
	} finally {
		foreign.stop(true);
	}
});

// [utest->R-044]
test("pidAlive: EPERM counts as alive-but-unsignalable, ESRCH as dead", () => {
	// pid 1 is init: alive, and signaling it as non-root raises EPERM
	expect(pidAlive(1)).toBe(true);
	const dead = Bun.spawnSync(["true"]);
	expect(pidAlive(dead.pid ?? 4_193_998)).toBe(false);
});

// [utest->R-044]
test("readRunfile tolerates and returns token/host fields", async () => {
	const dir = mkdtempSync(join(tmpdir(), "offbook-runfile-token-"));
	await Bun.write(
		join(dir, "offbook.run"),
		JSON.stringify({
			pid: 1,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 3,
			startedAt: "t",
			token: "ff".repeat(16),
			host: "devbox",
		}),
	);
	const run = await readRunfile(dir);
	expect(run?.token).toBe("ff".repeat(16));
	expect(run?.host).toBe("devbox");
	rmSync(dir, { recursive: true, force: true });
});
