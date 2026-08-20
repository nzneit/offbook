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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { port } from "#test/ports.ts";
import { pointerPath } from "./registry.ts";
import {
	clearRunfile,
	logSafeEnv,
	pidAlive,
	probeOffbook,
	probeServer,
	readRunfile,
	writeRunfile,
} from "./runfile.ts";

// Port bases for this file (repo convention: unique per file): 19960-19978.
// Those are BASE literals, not necessarily the bound ports — every one is
// band-mapped at runtime by port() (test/ports.ts). Band 0, the single-process
// local case, is the identity map, so a plain `bun test` still binds exactly
// the numbers written here; a concurrent process claims another band and its
// bases land in that band's compact window instead.

test("probeOffbook: a listener answering non-mode JSON is not attributed as offbook", async () => {
	const server = Bun.serve({
		port: port(19960),
		fetch: () => Response.json({ ok: true }),
	});
	try {
		expect(await probeOffbook(port(19960))).toBe(false);
	} finally {
		server.stop(true);
	}
});

test("probeOffbook: a listener that never responds fails within the timeout, not hung", async () => {
	// a raw TCP accept, never an HTTP response: fetch() must time out, not hang
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: port(19961),
		socket: { data() {} },
	});
	try {
		const start = Date.now();
		expect(await probeOffbook(port(19961), 60)).toBe(false);
		expect(Date.now() - start).toBeLessThan(500); // bounded by timeoutMs, not the default
	} finally {
		listener.stop(true);
	}
});

test("probeOffbook: a {mode: passive} responder is attributed as a live offbook", async () => {
	const server = Bun.serve({
		port: port(19962),
		fetch: () => Response.json({ mode: "passive" }),
	});
	try {
		expect(await probeOffbook(port(19962))).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("probeOffbook: a {mode: autonomous} responder is also attributed as live", async () => {
	const server = Bun.serve({
		port: port(19963),
		fetch: () => Response.json({ mode: "autonomous" }),
	});
	try {
		expect(await probeOffbook(port(19963))).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("probeOffbook: nothing listening (connection refused) is not attributed as offbook", async () => {
	expect(await probeOffbook(port(19964))).toBe(false);
});

test("probeOffbook: a non-2xx answer is not attributed, even when its body is offbook-shaped", async () => {
	// a server erroring out (or a proxy answering 503 for a dead upstream) may
	// still echo an offbook-shaped body; only a 2xx proves someone is serving
	const server = Bun.serve({
		port: port(19969),
		fetch: () => Response.json({ mode: "passive" }, { status: 503 }),
	});
	try {
		expect(await probeOffbook(port(19969))).toBe(false);
	} finally {
		server.stop(true);
	}
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
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: port(19965) },
	};
	const server = Bun.serve({
		port: port(19965),
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/server"
				? Response.json(identity)
				: new Response("nope", { status: 404 }),
	});
	try {
		const probe = await probeServer(port(19965));
		expect(probe.kind).toBe("server");
		if (probe.kind === "server")
			expect(probe.identity.token).toBe(identity.token);
	} finally {
		server.stop(true);
	}

	// legacy: /v1/server 404s but /v1/mode answers offbook-shaped
	const legacy = Bun.serve({
		port: port(19966),
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/mode"
				? Response.json({ mode: "passive" })
				: new Response("nope", { status: 404 }),
	});
	try {
		expect((await probeServer(port(19966))).kind).toBe("legacy");
	} finally {
		legacy.stop(true);
	}

	// silence: nothing listens (the internal one-retry-with-longer-timeout
	// path still concludes silent)
	expect((await probeServer(port(19967), 60)).kind).toBe("silent");

	// a foreign HTTP server that 404s both paths is silent, not legacy
	const foreign = Bun.serve({
		port: port(19968),
		fetch: () => new Response("hello", { status: 200 }),
	});
	try {
		expect((await probeServer(port(19968), 60)).kind).toBe("silent");
	} finally {
		foreign.stop(true);
	}
});

// [utest->R-044]
test("probeServer: a 200 /v1/server body that is not identity-shaped is silent, and so is a server that 404s both paths", async () => {
	// a 200 from something that is not offbook must never be read as an
	// identity — trusting the answer would let a stray dev server claim an
	// instance's runDir and drive the resolver's heal/skip decisions
	const shapeless = Bun.serve({
		port: port(19970),
		fetch: () => Response.json({ hello: "world" }),
	});
	try {
		expect((await probeServer(port(19970))).kind).toBe("silent");
	} finally {
		shapeless.stop(true);
	}
	// 404 on /v1/server AND on /v1/mode: an unrelated HTTP server on the port,
	// not a pre-D-032 offbook (which is what "legacy" is reserved for)
	const notOffbook = Bun.serve({
		port: port(19971),
		fetch: () => new Response("nope", { status: 404 }),
	});
	try {
		expect((await probeServer(port(19971))).kind).toBe("silent");
	} finally {
		notOffbook.stop(true);
	}
});

// [utest->R-044]
test("probeServer: a listener that accepts but never answers is silent within the retry bound, not hung", async () => {
	// a wedged instance holds the connection open: the identity probe must give
	// up on its own timeout (and its one doubled retry), or every verb that
	// resolves an instance hangs with it
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: port(19972),
		socket: { data() {} },
	});
	try {
		const start = Date.now();
		expect((await probeServer(port(19972), 60)).kind).toBe("silent");
		// 60ms + a 120ms retry: bounded by timeoutMs, not by the 500ms default
		expect(Date.now() - start).toBeLessThan(1000);
	} finally {
		listener.stop(true);
	}
});

// [utest->R-044]
test("probeServer: an identity is trusted only when EVERY field is the right type", async () => {
	// one field wrong per body, the other two right: a shape check that ANDs
	// its clauses rejects all three, one that ORs them accepts all three. A
	// stray dev server answering /v1/server must never be read as an offbook
	// identity — the resolver drives heal/skip decisions off exactly this.
	const cases = [
		{ at: port(19973), body: { token: 42, runDir: "/x/.offbook", pid: 7 } },
		{ at: port(19974), body: { token: "t".repeat(32), runDir: 42, pid: 7 } },
		{
			at: port(19975),
			body: { token: "t".repeat(32), runDir: "/x/.offbook", pid: "7" },
		},
	];
	for (const { at, body } of cases) {
		const server = Bun.serve({ port: at, fetch: () => Response.json(body) });
		try {
			expect((await probeServer(at, 60)).kind).toBe("silent");
		} finally {
			server.stop(true);
		}
	}
});

// [utest->R-044]
test("probeServer: a silent first answer is retried exactly once, and a good first answer is not", async () => {
	// the retry is D-032's slow-machine allowance: a first answer that times
	// out must not read as wedged. Pin both halves — that the retry HAPPENS
	// (or a loaded server is misjudged) and that it does NOT happen after a
	// good answer (or every probe pays a second round trip).
	const identity = {
		token: "a".repeat(32),
		runDir: "/x/.offbook",
		pid: 7,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 3 },
	};
	let calls = 0;
	const slowFirst = Bun.serve({
		port: port(19976),
		fetch: async () => {
			calls += 1;
			if (calls === 1) await Bun.sleep(400); // aborted by the 60ms budget
			return Response.json(identity);
		},
	});
	try {
		const probe = await probeServer(port(19976), 60);
		expect(probe.kind).toBe("server"); // the retry rescued it
		expect(calls).toBe(2);
	} finally {
		slowFirst.stop(true);
	}

	let answered = 0;
	const promptly = Bun.serve({
		port: port(19977),
		fetch: () => {
			answered += 1;
			return Response.json(identity);
		},
	});
	try {
		expect((await probeServer(port(19977), 60)).kind).toBe("server");
		expect(answered).toBe(1); // no retry after a good answer
	} finally {
		promptly.stop(true);
	}
});

// [utest->R-044]
test("probeServer: the retry gets a DOUBLED budget, not the first one over again", async () => {
	// the second attempt waits 2t: an answer that lands between t and 2t must
	// be caught. Halving or reusing t would abort it, so the delay below sits
	// deliberately outside the first budget and inside the doubled one.
	const t = 400;
	let calls = 0;
	const server = Bun.serve({
		port: port(19978),
		fetch: async () => {
			calls += 1;
			// 1.4t: past the first budget, comfortably inside the doubled one
			await Bun.sleep(calls === 1 ? t * 3 : Math.round(t * 1.4));
			return Response.json({
				token: "b".repeat(32),
				runDir: "/x/.offbook",
				pid: 7,
			});
		},
	});
	try {
		expect((await probeServer(port(19978), t)).kind).toBe("server");
		expect(calls).toBe(2);
	} finally {
		server.stop(true);
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

// [utest->R-044]
test("readRunfile: a corrupt or wrong-shaped runfile reads as absent (the caller reclaims it)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "offbook-runfile-shape-"));
	const path = join(dir, "offbook.run");
	const base = { brokerWsPort: 1, brokerTcpPort: 2, startedAt: "t" };
	await Bun.write(path, "{not json");
	expect(await readRunfile(dir)).toBeUndefined();
	// a non-number pid would be signalled (or compared) as garbage — the
	// liveness read must reject it, not hand it to pidAlive
	await Bun.write(
		path,
		JSON.stringify({ ...base, pid: "4242", controlPlanePort: 3 }),
	);
	expect(await readRunfile(dir)).toBeUndefined();
	// same for the control port: the identity probe would fetch a garbage URL
	await Bun.write(
		path,
		JSON.stringify({ ...base, pid: 4242, controlPlanePort: "3" }),
	);
	expect(await readRunfile(dir)).toBeUndefined();
	// both numbers: accepted
	await Bun.write(
		path,
		JSON.stringify({ ...base, pid: 4242, controlPlanePort: 3 }),
	);
	expect((await readRunfile(dir))?.pid).toBe(4242);
	rmSync(dir, { recursive: true, force: true });
});

// [utest->R-045]
test("clearRunfile is idempotent when there is nothing to clear (down's idempotence)", async () => {
	const state = mkdtempSync(join(tmpdir(), "offbook-state-"));
	const dir = mkdtempSync(join(tmpdir(), "offbook-runfile-clear-"));
	clearRunfile(dir, { stateDir: state }); // no runfile, no pointer: not an error
	expect(existsSync(join(dir, "offbook.run"))).toBe(false);
	await writeRunfile(
		dir,
		{
			pid: 1,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 3,
			startedAt: "t",
		},
		{ stateDir: state },
	);
	clearRunfile(dir, { stateDir: state });
	clearRunfile(dir, { stateDir: state }); // and again, on the now-empty dir
	expect(existsSync(join(dir, "offbook.run"))).toBe(false);
	expect(existsSync(pointerPath(state, dir))).toBe(false);
	rmSync(state, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});

// [utest->R-045]
test("writeRunfile registers a pointer; clearRunfile removes it; registry failure never blocks", async () => {
	const state = mkdtempSync(join(tmpdir(), "offbook-state-"));
	const dir = mkdtempSync(join(tmpdir(), "offbook-runfile-ptr-"));
	const run = {
		pid: 1,
		brokerWsPort: 1,
		brokerTcpPort: 2,
		controlPlanePort: 3,
		startedAt: "t",
	};
	const { registered } = await writeRunfile(dir, run, { stateDir: state });
	expect(registered).toBe(true);
	expect(existsSync(pointerPath(state, dir))).toBe(true);
	clearRunfile(dir, { stateDir: state });
	expect(existsSync(pointerPath(state, dir))).toBe(false);
	expect(existsSync(join(dir, "offbook.run"))).toBe(false);

	// an unwritable state dir degrades: runfile still written, registered false
	const blocked = join(state, "blocked");
	await Bun.write(blocked, "a FILE where the state dir should be");
	const second = await writeRunfile(dir, run, { stateDir: blocked });
	expect(second.registered).toBe(false);
	expect(existsSync(join(dir, "offbook.run"))).toBe(true);
	rmSync(state, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});
