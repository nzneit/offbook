import { expect, test } from "bun:test";
import { renderTopics, runDemo } from "./index.ts";

test("renderTopics lists every topic with client-facing direction phrasing and fields (M0 gate ii)", async () => {
	const out = await renderTopics(["--json"]);
	const topics = JSON.parse(out) as Array<{ topic: string; direction: string }>;
	expect(topics.map((t) => t.topic).sort()).toEqual([
		"command/{deviceId}/set",
		"state/{deviceId}",
	]);

	const human = await renderTopics([]);
	expect(human).toContain("state/{deviceId}");
	expect(human).toContain("command/{deviceId}/set");
	expect(human).toMatch(/client receives|client sends/); // direction phrasing, not raw toClient/fromClient
	expect(human).not.toContain("fromClient"); // literal enum only under --json
	expect(human).not.toMatch(/"type":/); // no raw JSON-Schema fragment in default output
});

test("runDemo boots, publishes off-contract, catches a schema/client violation, and reports it", async () => {
	const result = await runDemo(17); // port offset for isolation
	expect(result.caught.kind).toBe("schema");
	expect(result.caught.origin).toBe("client");
	expect(result.output).toContain("command/thermostat-1/set");
});
