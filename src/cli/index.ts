import { compose } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import type { ExampleFn } from "#src/control-plane/index.ts";
import { buildTopicInfo } from "#src/control-plane/index.ts";
import { createFaker, l1Floor } from "#src/engine/faker.ts";
import type { TopicInfo, Violation } from "#src/model/index.ts";
import { buildRegistry } from "#src/registry/index.ts";

const DEMO_SPEC = `${import.meta.dir}/../demo/thermostat.yaml`;

async function demoTopicInfo(): Promise<TopicInfo[]> {
	const config = loadConfig();
	const specText = await Bun.file(DEMO_SPEC).text();
	const registry = await buildRegistry({ specText, service: "demo", config });
	// the CLI composes its own example capability (F11 constrains the
	// control-plane module, not the CLI)
	const faker = createFaker(config);
	const example: ExampleFn = async (channel) => {
		const floor = await l1Floor(channel, faker);
		return "payload" in floor ? { payload: floor.payload } : { dropped: true };
	};
	return buildTopicInfo(registry, example);
}

function phraseDirection(d: TopicInfo["direction"]): string {
	return d === "toClient" ? "client receives" : "client sends";
}

function fieldLines(schema: object): string {
	const s = schema as {
		properties?: Record<string, { type?: string }>;
		required?: string[];
	};
	if (!s.properties) return "";
	return Object.entries(s.properties)
		.map(
			([name, def]) =>
				`      - ${name}${s.required?.includes(name) ? " (required)" : ""}: ${def.type ?? "any"}`,
		)
		.join("\n");
}

export async function renderTopics(argv: string[]): Promise<string> {
	const topics = await demoTopicInfo();
	if (argv.includes("--json")) return JSON.stringify(topics, null, 2);
	return topics
		.map(
			(t) =>
				`${t.topic}  [${phraseDirection(t.direction)}]\n${fieldLines(t.schema)}\n    example: ${JSON.stringify(t.example)}`,
		)
		.join("\n\n");
}

export async function runDemo(
	portOffset = 0,
): Promise<{ caught: Violation; output: string }> {
	const config = loadConfig({
		brokerWsPort: 9001 + portOffset,
		brokerTcpPort: 1883 + portOffset,
		controlPlanePort: 9080 + portOffset,
	});
	const specText = await Bun.file(DEMO_SPEC).text();
	const registry = await buildRegistry({ specText, service: "demo", config });
	const server = await compose({ config, registry });
	await server.start();
	try {
		// seed populated (retained, per the state channel binding) state
		await server.app.request("/v1/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ topic: "state/thermostat-1", example: true }),
		});
		// scripted off-contract publish
		const pub = await (
			await server.app.request("/v1/publish", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					topic: "command/thermostat-1/set",
					payload: { mode: "broil", target: 20 },
				}),
			})
		).json();
		const after = await (
			await server.app.request(`/v1/validation?sinceSeq=${pub.sinceSeq}`)
		).json();
		const caught = (after.violations as Violation[]).find(
			(v) => v.kind === "schema",
		);
		if (!caught)
			throw new Error("demo: expected a schema violation to be caught");
		const output = `offbook demo: published off-contract to command/thermostat-1/set → caught ${caught.kind}/${caught.origin}: ${caught.detail}`;
		return { caught, output };
	} finally {
		await server.stop();
	}
}

export async function run(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	if (cmd === "topics") {
		console.log(await renderTopics(rest));
		return 0;
	}
	if (cmd === "demo") {
		const { output } = await runDemo();
		console.log(output);
		return 0;
	}
	console.error("usage: offbook <topics|demo>");
	return 1;
}

if (import.meta.main)
	run(process.argv.slice(2)).then((code) => process.exit(code));
