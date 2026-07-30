// `bun demo-app/serve.ts [--port 9090] [--ctrl-port 9080] [--run-dir ./.offbook]`
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createDemoAppServer } from "./server.ts";

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		port: { type: "string" },
		"ctrl-port": { type: "string" },
		"run-dir": { type: "string" },
	},
});

// C1 — self-healing quickstart: dist/ is gitignored and `bun install` has no
// postinstall step, so a fresh clone has no bundle until someone runs
// `bun run demo-app:build`. Build it here on demand (mirrors that script's
// Bun.build call exactly) so the README quickstart never 500s on /main.js.
const entrypoint = new URL("./src/main.tsx", import.meta.url).pathname;
const outdir = new URL("./dist", import.meta.url).pathname;
if (!existsSync(new URL("./dist/main.js", import.meta.url).pathname)) {
	console.log("building demo-app bundle…");
	const result = await Bun.build({
		entrypoints: [entrypoint],
		outdir,
		target: "browser",
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		throw new Error("demo-app: bundle build failed — see logs above");
	}
}

const ctrlPort = Number(values["ctrl-port"] ?? 9080);
const server = createDemoAppServer({
	port: Number(values.port ?? 9090),
	ctrlPort,
	runDir: values["run-dir"] ?? "./.offbook",
});
console.log(
	`demo-app on http://localhost:${server.port} → offbook control :${ctrlPort} (run \`bun run demo-app:build\` after UI edits)`,
);
