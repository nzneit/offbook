// `bun demo-app/serve.ts [--port 9090] [--ctrl-port 9080] [--run-dir ./.offbook]`
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
const ctrlPort = Number(values["ctrl-port"] ?? 9080);
const server = createDemoAppServer({
	port: Number(values.port ?? 9090),
	ctrlPort,
	runDir: values["run-dir"] ?? "./.offbook",
});
console.log(
	`demo-app on http://localhost:${server.port} → offbook control :${ctrlPort} (run \`bun run demo-app:build\` after UI edits)`,
);
