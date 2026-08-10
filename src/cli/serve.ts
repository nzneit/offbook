// R-019/R-024 — the detached server entry `offbook up` spawns (contracts
// §5/G14). argv[2] = the boot file `up` wrote (<runDir>/offbook.boot.json);
// stdout and stderr are redirected to <runDir>/offbook.log by the parent, so
// every line printed here lands in the log `offbook logs`/`status` read
// (EO1). A fatal boot (spec fetch/parse failure, strict scenario error, port
// bind) exits nonzero — `up`'s readiness probe sees the death and surfaces
// the log tail in the foreground.
//
// EH1 (`up --watch`, autonomous-only): a handlers/**/*.ts change restarts
// the WHOLE PROCESS — L3 handlers are loaded via `import()`, which caches by
// path, so only a fresh module graph picks up edited handler code. The old
// process frees the three ports, spawns its replacement on the same boot
// file with the log APPENDED (the G14 continuity guarantee), points the
// runfile at the new pid, and exits.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, watch as fsWatch, openSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "#src/config/index.ts";
import type { Config } from "#src/model/index.ts";
import { bootDemo, bootProject } from "./boot.ts";
import { logPath, logSafeEnv, writeRunfile } from "./runfile.ts";

interface BootFile {
	projectDir: string;
	config: Partial<Config>;
	environment?: string;
	watch?: boolean;
	demo?: boolean; // demo --serve: bundled spec, no project files (D-015)
}

const bootPath = process.argv[2];
if (!bootPath) {
	console.error("[offbook] serve: missing boot-file argument");
	process.exit(2);
}

const log = (line: string) =>
	console.error(`[offbook] ${new Date().toISOString()} ${line}`);

try {
	const boot = JSON.parse(await Bun.file(bootPath).text()) as BootFile;
	const config = loadConfig(boot.config);
	// F8 — read once, BEFORE boot: the hash below must reflect exactly what
	// bootProject loaded, not a second read of a file a slow (git-fetching)
	// boot had time to edit or delete out from under it. `existsSync` mirrors
	// bootProject's own missing-file check, so a genuinely-absent services.yaml
	// still surfaces bootProject's friendly "run `offbook init`" fatal error
	// instead of a raw read failure here.
	const servicesPath = join(boot.projectDir, "services.yaml");
	const servicesText =
		boot.demo === true
			? undefined
			: existsSync(servicesPath)
				? await Bun.file(servicesPath).text()
				: undefined;
	const composed =
		boot.demo === true
			? await bootDemo({ config, log })
			: await bootProject({
					projectDir: boot.projectDir,
					config,
					environment: boot.environment,
					log,
				});
	await composed.start();
	// R-043 — the boot line (adoption.md §10): every startup logs what it
	// loaded. Double duty: `status` scopes connect counts to lines after the
	// LAST boot line; `specs update` compares this hash against the current
	// services.yaml to warn on silent staleness. F8 — logged synchronously
	// right after `start()` resolves (no await between) so a client that
	// reconnects the instant ports open can never land in the log before this
	// line and be excluded from "this run" (adoption.md §10).
	if (boot.demo === true) log("boot: bundled demo spec");
	else
		log(
			`boot: services.yaml sha256:${createHash("sha256")
				.update(servicesText ?? "")
				.digest("hex")}`,
		);
	const ports = {
		brokerWsPort: config.brokerWsPort,
		brokerTcpPort: config.brokerTcpPort,
		controlPlanePort: config.controlPlanePort,
	};
	// the runfile follows the SERVING pid across --watch respawns (G14)
	await writeRunfile(config.runDir, {
		pid: process.pid,
		...ports,
		startedAt: new Date().toISOString(),
	});
	log(
		`listening — http :${config.controlPlanePort} · ws :${config.brokerWsPort} · tcp :${config.brokerTcpPort} · mode ${config.mode} · seed ${config.seed}`,
	);
	const shutdown = async (signal: string) => {
		log(`${signal} — shutting down`);
		await composed.stop();
		process.exit(0);
	};
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));

	const handlersDir = join(boot.projectDir, "handlers");
	if (boot.watch === true && existsSync(handlersDir)) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const watcher = fsWatch(handlersDir, { recursive: true }, (_ev, file) => {
			if (file !== null && !file.endsWith(".ts")) return;
			// a runtime flip to passive freezes the window (EH1) — no restarts
			if (config.mode !== "autonomous") return;
			clearTimeout(timer);
			timer = setTimeout(async () => {
				log("handlers/ changed — restarting (up --watch)");
				watcher.close();
				await composed.stop(); // release the three ports first
				const fd = openSync(logPath(config.runDir), "a");
				const child = spawn(process.execPath, [process.argv[1], bootPath], {
					detached: true,
					stdio: ["ignore", fd, fd],
					// D-030 — belt-and-braces: launchDetached already sanitized this
					// process's env, but the respawn must not depend on that
					env: logSafeEnv(),
				});
				child.unref();
				if (child.pid !== undefined)
					await writeRunfile(config.runDir, {
						pid: child.pid,
						...ports,
						startedAt: new Date().toISOString(),
					});
				process.exit(0);
			}, 200);
		});
	}
} catch (cause) {
	log(`fatal: ${(cause as Error).message}`);
	process.exit(1);
}
