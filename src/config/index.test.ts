import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../model/index.ts";
import { loadConfig } from "./index.ts";

test("loadConfig with no args returns the defaults", () => {
	expect(loadConfig()).toEqual(DEFAULT_CONFIG);
});

test("loadConfig merges shallow overrides", () => {
	const c = loadConfig({ seed: 42, brokerWsPort: 9999 });
	expect(c.seed).toBe(42);
	expect(c.brokerWsPort).toBe(9999);
	expect(c.brokerTcpPort).toBe(DEFAULT_CONFIG.brokerTcpPort);
});
