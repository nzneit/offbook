import { expect, test } from "bun:test";
import { loadConfig } from "../config/index.ts";
import { buildRegistry } from "./index.ts";

async function demoRegistry() {
	const specText = await Bun.file("src/demo/thermostat.yaml").text();
	return buildRegistry({ specText, service: "demo", config: loadConfig() });
}

test("normalizes v3 directions onto channels", async () => {
	const reg = await demoRegistry();
	const byTopic = Object.fromEntries(reg.channels().map((c) => [c.topic, c]));
	expect(byTopic["command/{deviceId}/set"].direction).toBe("fromClient");
	expect(byTopic["state/{deviceId}"].direction).toBe("toClient");
});

test("match() resolves a concrete topic to its channel and captures params", async () => {
	const reg = await demoRegistry();
	const m = reg.match("command/thermostat-1/set");
	expect(m?.channel.topic).toBe("command/{deviceId}/set");
	expect(m?.params).toEqual({ deviceId: "thermostat-1" });
});

test("matchesFilter implements MQTT + / #", async () => {
	const reg = await demoRegistry();
	expect(reg.matchesFilter("state/#", "state/thermostat-1")).toBe(true);
	expect(reg.matchesFilter("state/+", "state/a/b")).toBe(false);
});

test("validate() rejects an off-contract payload and accepts a valid one", async () => {
	const reg = await demoRegistry();
	const cmd = reg.match("command/thermostat-1/set")?.channel;
	expect(cmd?.validate({ mode: "broil", target: 20 }).length).toBeGreaterThan(
		0,
	);
	expect(cmd?.validate({ mode: "heat", target: 20 })).toEqual([]);
});

test("resolves retain:true on the state channel from its spec binding", async () => {
	const reg = await demoRegistry();
	const state = reg.match("state/thermostat-1")?.channel;
	expect(state?.retain).toBe(true);
	expect(state?.qos).toBe(1);
});
