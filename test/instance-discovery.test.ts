// [itest->R-044] [itest->R-045]
// Instance discovery integration: serve.ts boot-contract fatals here;
// the state-table row suite lands in this file in a later task.
// Ports for this file (repo convention: unique per file): 19430-19449,
// tcp 12490-12495 (bound by the real `up` runs below).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVE = join(import.meta.dir, "../src/cli/serve.ts");

async function spawnServe(
	boot: object,
): Promise<{ code: number; err: string }> {
	const dir = mkdtempSync(join(tmpdir(), "offbook-serve-fatal-"));
	const bootPath = join(dir, "offbook.boot.json");
	await Bun.write(bootPath, JSON.stringify(boot));
	const proc = Bun.spawn([process.execPath, SERVE, bootPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	const err = await new Response(proc.stderr).text();
	rmSync(dir, { recursive: true, force: true });
	return { code, err };
}

// [itest->R-044]
test("serve: a relative runDir in the boot file is a fatal boot error (no ports bound)", async () => {
	const { code, err } = await spawnServe({
		projectDir: "/tmp/nowhere",
		config: { runDir: ".offbook" },
		demo: true,
		token: "aa".repeat(16),
	});
	expect(code).toBe(1);
	expect(err).toContain("relative runDir");
	expect(err).toContain("offbook up");
}, 20_000);

// [itest->R-044]
test("serve: a missing launch token is a fatal boot error", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "offbook-serve-notoken-"));
	const { code, err } = await spawnServe({
		projectDir: "/tmp/nowhere",
		config: { runDir },
		demo: true,
	});
	expect(code).toBe(1);
	expect(err).toContain("no launch token");
	rmSync(runDir, { recursive: true, force: true });
}, 20_000);
