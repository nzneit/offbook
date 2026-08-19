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
	rmSync(state, { recursive: true, force: true });
	rmSync(runDir, { recursive: true, force: true });
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
