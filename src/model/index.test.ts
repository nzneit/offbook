import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "./index.ts";

test("DEFAULT_CONFIG has the frozen port + seed defaults", () => {
	expect(DEFAULT_CONFIG.seed).toBe(1);
	expect(DEFAULT_CONFIG.brokerWsPort).toBe(9001);
	expect(DEFAULT_CONFIG.brokerTcpPort).toBe(1883);
	expect(DEFAULT_CONFIG.controlPlanePort).toBe(9080);
	expect(DEFAULT_CONFIG.mode).toBe("autonomous");
	expect(DEFAULT_CONFIG.wallClock).toBe(false);
	expect(DEFAULT_CONFIG.maxViolations).toBe(10_000);
});
