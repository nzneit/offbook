// R-043 — probeOffbook direct: the "answers as offbook" probe that `up`
// preflight and doctor's ports check use to decide whether a busy control
// port may be attributed to another offbook instance. A regression here
// (e.g. accepting any 200 response) would make offbook falsely accuse an
// unrelated dev server of "owning" the port — the exact lie R-043 exists to
// prevent — so the shape check and the timeout bound are pinned directly.
// [utest->R-043]
import { expect, test } from "bun:test";
import { probeOffbook } from "./runfile.ts";

// ports for this file (repo convention: unique per file): 19960-19964

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
