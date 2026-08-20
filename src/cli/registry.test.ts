// [utest->R-045] — the machine-local instance registry: pointers, not
// state (contracts §5, D-032). No ports are bound in this file.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalPath,
	pointerPath,
	removePointer,
	scanPointers,
	stateDirFromEnv,
	writePointer,
} from "./registry.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "offbook-registry-"));

// biome may flag the empty-env objects below; env params are deliberate
test("stateDirFromEnv: OFFBOOK_STATE_DIR wins, then XDG_STATE_HOME, then ~/.local/state", () => {
	expect(stateDirFromEnv({ OFFBOOK_STATE_DIR: "/x/state" })).toBe("/x/state");
	expect(stateDirFromEnv({ XDG_STATE_HOME: "/x/xdg" })).toBe(
		join("/x/xdg", "offbook"),
	);
	expect(stateDirFromEnv({})).toContain(join(".local", "state", "offbook"));
});

test("registry functions throw when no state dir was injected", async () => {
	expect(() => pointerPath("", "/tmp/x")).toThrow("no state dir");
	await expect(writePointer("", "/tmp/x")).rejects.toThrow("no state dir");
	expect(() => removePointer("", "/tmp/x")).toThrow("no state dir");
	await expect(scanPointers("")).rejects.toThrow("no state dir");
});

test("writePointer: atomic temp INSIDE instances/, sha256(realpath) name, scan round-trips", async () => {
	const state = scratch();
	const runDir = mkdtempSync(join(tmpdir(), "offbook-rundir-"));
	await writePointer(state, runDir);
	const canonical = canonicalPath(runDir);
	const expectedName = `${createHash("sha256").update(canonical).digest("hex")}.json`;
	const names = readdirSync(join(state, "instances"));
	expect(names).toEqual([expectedName]); // no leaked temp files
	const entries = await scanPointers(state);
	expect(entries).toHaveLength(1);
	expect(entries[0].pointer).toMatchObject({ v: 1, runDir: canonical });
	expect(typeof entries[0].pointer.host).toBe("string");
	rmSync(state, { recursive: true, force: true });
	rmSync(runDir, { recursive: true, force: true });
});

test("removePointer: idempotent, and resolves a NONEXISTENT runDir to the same name writePointer used for a live one", async () => {
	const state = scratch();
	const runDir = mkdtempSync(join(tmpdir(), "offbook-rundir-"));
	await writePointer(state, runDir);
	rmSync(runDir, { recursive: true, force: true }); // dir gone before remove
	removePointer(state, runDir); // must still hit the same hash (resolve fallback)
	expect(readdirSync(join(state, "instances"))).toEqual([]);
	removePointer(state, runDir); // idempotent
	rmSync(state, { recursive: true, force: true });
});

test("scanPointers: ignores non-hash names, reaps corrupt pointers, dedupes string-identical twins keeping the realpath-keyed one", async () => {
	const state = scratch();
	const runDir = mkdtempSync(join(tmpdir(), "offbook-rundir-"));
	await writePointer(state, runDir);
	const dir = join(state, "instances");
	// a crash-leaked temp and a foreign file are inert
	await Bun.write(join(dir, `${"a".repeat(64)}.json.tmp999`), "x");
	await Bun.write(join(dir, "README"), "x");
	// a corrupt pointer is reaped on sight (the deletion law's one exception)
	await Bun.write(join(dir, `${"b".repeat(64)}.json`), "{not json");
	// a string-identical twin under a WRONG hash loses to the realpath-keyed one
	const canonical = canonicalPath(runDir);
	await Bun.write(
		join(dir, `${"c".repeat(64)}.json`),
		JSON.stringify({ v: 1, runDir: canonical, host: "twin" }),
	);
	const entries = await scanPointers(state);
	expect(entries).toHaveLength(1);
	const goodName = `${createHash("sha256").update(canonical).digest("hex")}.json`;
	expect(entries[0].path.endsWith(goodName)).toBe(true);
	expect(existsSync(join(dir, `${"b".repeat(64)}.json`))).toBe(false);
	expect(existsSync(join(dir, `${"c".repeat(64)}.json`))).toBe(false);
	// ignored means INERT, not reaped: the name filter is what makes a
	// crash-leaked temp (and anything else a user drops here) survive a scan
	expect(existsSync(join(dir, `${"a".repeat(64)}.json.tmp999`))).toBe(true);
	expect(existsSync(join(dir, "README"))).toBe(true);
	rmSync(state, { recursive: true, force: true });
	rmSync(runDir, { recursive: true, force: true });
});

test("scanPointers: a state dir that has never registered anything scans empty, and the scan creates nothing", async () => {
	const state = scratch();
	expect(await scanPointers(state)).toEqual([]);
	// a read verb resolving on a fresh machine must not materialize state
	expect(existsSync(join(state, "instances"))).toBe(false);
	rmSync(state, { recursive: true, force: true });
});

test("scanPointers: valid JSON of the wrong SHAPE is reaped like a corrupt pointer, per field", async () => {
	const state = scratch();
	const runDir = mkdtempSync(join(tmpdir(), "offbook-rundir-"));
	await writePointer(state, runDir);
	const dir = join(state, "instances");
	// one file per field of the shape check: a future v, a non-string runDir
	// (which would be joined into a filesystem path), a non-string host (which
	// would be compared against hostname() and pass nothing)
	const malformed = {
		[`${"1".repeat(64)}.json`]: { v: 2, runDir: "/x/.offbook", host: "h" },
		[`${"2".repeat(64)}.json`]: { v: 1, runDir: 42, host: "h" },
		[`${"3".repeat(64)}.json`]: { v: 1, runDir: "/y/.offbook", host: 42 },
	};
	for (const [name, body] of Object.entries(malformed))
		await Bun.write(join(dir, name), JSON.stringify(body));
	const entries = await scanPointers(state);
	expect(entries.map((e) => e.pointer.runDir)).toEqual([canonicalPath(runDir)]);
	for (const name of Object.keys(malformed))
		expect(existsSync(join(dir, name))).toBe(false);
	rmSync(state, { recursive: true, force: true });
	rmSync(runDir, { recursive: true, force: true });
});

test("scanPointers: the realpath-keyed pointer wins even when the twin is scanned after it", async () => {
	const state = scratch();
	const runDir = mkdtempSync(join(tmpdir(), "offbook-rundir-"));
	await writePointer(state, runDir);
	const dir = join(state, "instances");
	const canonical = canonicalPath(runDir);
	const goodName = `${createHash("sha256").update(canonical).digest("hex")}.json`;
	const twinRaw = `${JSON.stringify({ v: 1, runDir: canonical, host: "twin" })}\n`;
	// scanPointers sorts its listing, so scan position is a NAME choice, not
	// the filesystem's: a twin named above the canonical hash is scanned
	// after it. The twin is deliberately CREATED first — sorted scan order
	// must beat creation order.
	const arrange = async (): Promise<string> => {
		for (let i = 0; i < 16; i++) {
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true });
			const candidate = `${"f".repeat(63)}${i.toString(16)}.json`;
			await Bun.write(join(dir, candidate), twinRaw);
			await writePointer(state, runDir);
			const names = readdirSync(dir).sort();
			if (names.indexOf(candidate) > names.indexOf(goodName)) return candidate;
		}
		return "";
	};
	const twinName = await arrange();
	expect(twinName).not.toBe("");
	const entries = await scanPointers(state);
	expect(entries).toHaveLength(1);
	expect(entries[0].path).toBe(join(dir, goodName));
	expect(entries[0].pointer.host).not.toBe("twin");
	expect(existsSync(join(dir, goodName))).toBe(true); // the kept entry is the surviving FILE
	expect(existsSync(join(dir, twinName))).toBe(false);
	rmSync(state, { recursive: true, force: true });
	rmSync(runDir, { recursive: true, force: true });
});

test("scanPointers: the realpath-keyed pointer wins when the twin is scanned before it", async () => {
	const state = scratch();
	const runDir = mkdtempSync(join(tmpdir(), "offbook-rundir-"));
	const dir = join(state, "instances");
	const canonical = canonicalPath(runDir);
	const goodName = `${createHash("sha256").update(canonical).digest("hex")}.json`;
	const twinRaw = `${JSON.stringify({ v: 1, runDir: canonical, host: "twin" })}\n`;
	// a twin named below the canonical hash is scanned first, so the dedupe
	// meets it as the incumbent — the arm where "keep the first seen" and
	// "keep the realpath-keyed one" disagree
	const arrange = async (): Promise<string> => {
		for (let i = 0; i < 16; i++) {
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true });
			const candidate = `${"0".repeat(63)}${i.toString(16)}.json`;
			await writePointer(state, runDir);
			await Bun.write(join(dir, candidate), twinRaw);
			const names = readdirSync(dir).sort();
			if (names.indexOf(candidate) < names.indexOf(goodName)) return candidate;
		}
		return "";
	};
	const twinName = await arrange();
	expect(twinName).not.toBe("");
	const entries = await scanPointers(state);
	expect(entries).toHaveLength(1);
	expect(entries[0].path).toBe(join(dir, goodName));
	expect(entries[0].pointer.host).not.toBe("twin");
	expect(existsSync(join(dir, goodName))).toBe(true);
	expect(existsSync(join(dir, twinName))).toBe(false);
	rmSync(state, { recursive: true, force: true });
	rmSync(runDir, { recursive: true, force: true });
});

test("scanPointers: returns entries in sorted name order regardless of creation order", async () => {
	const state = scratch();
	const dir = join(state, "instances");
	mkdirSync(dir, { recursive: true });
	// creation order [b, a, d, c] disagrees with sorted order under ext4
	// (creation order), tmpfs (reverse creation order), and almost every
	// name-hash order — the return order below is the sort's doing, not
	// the filesystem's
	const mk = (ch: string) => `${ch.repeat(64)}.json`;
	for (const ch of ["b", "a", "d", "c"])
		await Bun.write(
			join(dir, mk(ch)),
			JSON.stringify({ v: 1, runDir: `/x/${ch}`, host: "h" }),
		);
	const entries = await scanPointers(state);
	expect(entries.map((e) => e.path)).toEqual(
		["a", "b", "c", "d"].map((ch) => join(dir, mk(ch))),
	);
	rmSync(state, { recursive: true, force: true });
});

test("canonicalPath: resolves symlinks so a symlinked runDir hashes to its real subtree", () => {
	const real = mkdtempSync(join(tmpdir(), "offbook-real-"));
	const linkParent = mkdtempSync(join(tmpdir(), "offbook-link-"));
	const link = join(linkParent, "alias");
	symlinkSync(real, link);
	expect(canonicalPath(link)).toBe(canonicalPath(real));
	rmSync(linkParent, { recursive: true, force: true });
	rmSync(real, { recursive: true, force: true });
});
