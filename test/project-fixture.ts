// Shared local-git project fixture for process-level CLI/gate tests: a git
// repo holding the bundled demo spec, addressable by absolute path from a
// services.yaml (no gitHost needed).
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeSpecRepo(repoDir: string): Promise<void> {
	mkdirSync(repoDir, { recursive: true });
	const git = (...args: string[]) => {
		const r = Bun.spawnSync(["git", ...args], { cwd: repoDir });
		if (r.exitCode !== 0)
			throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	};
	git("init", "-q", "-b", "main");
	writeFileSync(
		join(repoDir, "asyncapi.yaml"),
		await Bun.file(`${import.meta.dir}/../src/demo/thermostat.yaml`).text(),
	);
	git("add", "-A");
	git(
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"-m",
		"spec",
	);
}

export const servicesYamlFor = (repoDir: string): string =>
	`services:\n  thermostat:\n    repo: ${repoDir}\n    specPath: asyncapi.yaml\n    branch: main\n`;

export async function gitSpecProject(): Promise<string> {
	const projectDir = await mkdtemp(join(tmpdir(), "offbook-proj-"));
	const repoDir = join(projectDir, "repo");
	await makeSpecRepo(repoDir);
	writeFileSync(join(projectDir, "services.yaml"), servicesYamlFor(repoDir));
	return projectDir;
}
