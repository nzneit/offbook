// R-034/R-036 — the README quickstart is executable (adoption.md §4): the
// canonical sequence runs end-to-end, and the README's tagged fences must
// match it token-for-token (execution appends ONLY --run-dir + port flags).
// [itest->R-034]
// [itest->R-036]
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "#src/cli/index.ts";
import { readRunfile } from "#src/cli/runfile.ts";

// ports for this file: ws 19120 / tcp 12994 / ctrl 19894 / demo-app 19994
const WS = "19120";
const TCP = "12994";
const CTRL = "19894";
const APP = "19994";
const REPO_ROOT = join(import.meta.dir, "..");

function quickstartFences(text: string): string[] {
	const lines: string[] = [];
	for (const m of text.matchAll(/```sh quickstart\n([\s\S]*?)```/g))
		for (const raw of m[1].split("\n")) {
			const line = raw.trim();
			if (line !== "" && !line.startsWith("#")) lines.push(line);
		}
	return lines;
}

test("README quickstart: fences match the canonical sequence, and it executes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "offbook-quickstart-"));
	const runDir = join(dir, ".offbook");
	const io = { out: () => {}, err: () => {} };
	let app: ReturnType<typeof Bun.spawn> | undefined;
	try {
		// the canonical sequence — execution may append ONLY --run-dir and ports
		const canonical = [
			{
				line: "offbook demo --serve",
				exec: async () => {
					expect(
						await run(
							[
								"demo",
								"--serve",
								"--run-dir",
								runDir,
								"--ws-port",
								WS,
								"--tcp-port",
								TCP,
								"--ctrl-port",
								CTRL,
							],
							io,
						),
					).toBe(0);
				},
			},
			{
				line: "bun run demo-app",
				exec: async () => {
					// `bun run demo-app` = `bun demo-app/serve.ts` (package.json script)
					app = Bun.spawn(
						[
							process.execPath,
							"demo-app/serve.ts",
							"--port",
							APP,
							"--ctrl-port",
							CTRL,
							"--run-dir",
							runDir,
						],
						{ cwd: REPO_ROOT, stdout: "ignore", stderr: "ignore" },
					);
				},
			},
		];

		const readme = await Bun.file(join(REPO_ROOT, "README.md")).text();
		expect(quickstartFences(readme)).toEqual(canonical.map((c) => c.line));

		for (const step of canonical) await step.exec();

		// the quickstart's promise: the page serves and /v1 proxies through
		const deadline = Date.now() + 10_000;
		let ready = false;
		while (Date.now() < deadline && !ready) {
			ready = await fetch(`http://localhost:${APP}/`)
				.then((r) => r.ok)
				.catch(() => false);
			if (!ready) await new Promise((r) => setTimeout(r, 100));
		}
		expect(ready).toBe(true);
		expect((await fetch(`http://localhost:${APP}/v1/topics`)).ok).toBe(true);
		// C1: a fresh clone has no demo-app/dist/ (gitignored, no postinstall
		// build step) — serve.ts must self-build the bundle before serving.
		expect((await fetch(`http://localhost:${APP}/main.js`)).status).toBe(200);

		// teardown is part of the documented sequence
		expect(await run(["down", "--run-dir", runDir], io)).toBe(0);
	} finally {
		app?.kill();
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);
