import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	expect(human).not.toContain("toClient"); // literal enum only under --json
	expect(human).not.toMatch(/"type":/); // no raw JSON-Schema fragment in default output
});

test("runDemo boots, publishes off-contract, catches a schema/client violation, and reports it", async () => {
	const result = await runDemo(17); // port offset for isolation
	expect(result.caught.kind).toBe("schema");
	expect(result.caught.origin).toBe("client");
	expect(result.output).toContain("command/thermostat-1/set");
});

test("CLI works from a non-repo cwd (DEMO_SPEC must be module-relative, not cwd-relative)", async () => {
	const bin = `${import.meta.dir}/../../bin/offbook`;
	// a SCRATCH non-repo cwd, not literal /tmp: a stray /tmp/.offbook runfile
	// (shared machine state) would otherwise feed the D-032 resolver a
	// reclaim note on stderr and flake the empty-stderr assertion
	const proc = Bun.spawn([bin, "topics"], {
		cwd: mkdtempSync(join(tmpdir(), "offbook-nonrepo-")),
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	const err = await new Response(proc.stderr).text();
	await proc.exited;
	expect(proc.exitCode).toBe(0);
	expect(err).toBe("");
	expect(out).toContain("state/{deviceId}");
	expect(out).toContain("command/{deviceId}/set");
});
