import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../model/index.ts";
import {
	loadConfig,
	loadEnvironments,
	loadServices,
	parseEnvironments,
	parseServices,
} from "./index.ts";

test("loadConfig with no args returns the defaults", () => {
	expect(loadConfig()).toEqual(DEFAULT_CONFIG);
});

test("loadConfig merges shallow overrides", () => {
	const c = loadConfig({ seed: 42, brokerWsPort: 9999 });
	expect(c.seed).toBe(42);
	expect(c.brokerWsPort).toBe(9999);
	expect(c.brokerTcpPort).toBe(DEFAULT_CONFIG.brokerTcpPort);
});

// --- services.yaml ---

const SERVICES_YAML = `
gitHost: https://git.example.com
services:
  serviceA: { repo: org/service-a, specPath: asyncapi.yaml }
  serviceB: { repo: org/service-b, specPath: asyncapi.yaml, branch: dev }
  serviceC:
    repo: org/service-c
    specPath: asyncapi.yaml
    qosDefault: 2
    retainDefault: true
    topicOverrides:
      telemetry/{deviceId}: { qos: 0, retain: false }
  serviceD: { repo: https://other.example.com/org/service-d.git, specPath: asyncapi.yaml }
`;

test("parseServices reads gitHost and injects each service's name from its map key", () => {
	const cfg = parseServices(SERVICES_YAML);
	expect(cfg.gitHost).toBe("https://git.example.com");
	expect(cfg.services.serviceA.name).toBe("serviceA");
	expect(cfg.services.serviceA.repo).toBe("org/service-a");
	expect(cfg.services.serviceA.specPath).toBe("asyncapi.yaml");
	expect(cfg.services.serviceB.branch).toBe("dev");
});

test("parseServices leaves absent optional fields undefined", () => {
	const cfg = parseServices(SERVICES_YAML);
	const a = cfg.services.serviceA;
	expect(a.branch).toBeUndefined();
	expect(a.qosDefault).toBeUndefined();
	expect(a.retainDefault).toBeUndefined();
	expect(a.topicOverrides).toBeUndefined();
});

// [utest->R-002]
test("parseServices carries a topicOverrides entry through as typed qos/retain (R-002)", () => {
	const cfg = parseServices(SERVICES_YAML);
	expect(cfg.services.serviceC.topicOverrides).toEqual({
		"telemetry/{deviceId}": { qos: 0, retain: false },
	});
});

test("parseServices carries the tier-3 per-service qos/retain defaults", () => {
	const cfg = parseServices(SERVICES_YAML);
	expect(cfg.services.serviceC.qosDefault).toBe(2);
	expect(cfg.services.serviceC.retainDefault).toBe(true);
});

test("parseServices passes both a slug repo and a full-URL repo through verbatim (URL resolution is ingestion's job)", () => {
	const cfg = parseServices(SERVICES_YAML);
	expect(cfg.services.serviceA.repo).toBe("org/service-a");
	expect(cfg.services.serviceD.repo).toBe(
		"https://other.example.com/org/service-d.git",
	);
});

test("parseServices throws when the 'services' map is missing", () => {
	expect(() => parseServices("gitHost: https://x\n")).toThrow(/services/);
});

test("parseServices names the offending service when 'repo' is missing", () => {
	const bad = "services:\n  serviceA: { specPath: asyncapi.yaml }\n";
	expect(() => parseServices(bad)).toThrow(/serviceA.*repo/);
});

test("parseServices names the offending service when 'specPath' is missing", () => {
	const bad = "services:\n  serviceA: { repo: org/a }\n";
	expect(() => parseServices(bad)).toThrow(/serviceA.*specPath/);
});

test("parseServices rejects a qosDefault outside 0|1|2", () => {
	const bad =
		"services:\n  serviceA: { repo: org/a, specPath: x.yaml, qosDefault: 5 }\n";
	expect(() => parseServices(bad)).toThrow(/serviceA.*qos/);
});

// --- environments.yaml ---

test("parseEnvironments reads the env → service → version maps", () => {
	const cfg = parseEnvironments(
		'environments:\n  default:\n    serviceA: "1.4.7"\n    serviceB: "2.0.1"\n',
	);
	expect(cfg.environments.default).toEqual({
		serviceA: "1.4.7",
		serviceB: "2.0.1",
	});
});

test("parseEnvironments coerces an unquoted numeric-looking version to a string", () => {
	const cfg = parseEnvironments("environments:\n  default:\n    serviceA: 3\n");
	expect(cfg.environments.default.serviceA).toBe("3");
});

test("parseEnvironments throws when the 'environments' map is missing", () => {
	expect(() => parseEnvironments("services: {}\n")).toThrow(/environments/);
});

// --- file loaders (file → config) ---

test("loadServices reads a services.yaml file into typed objects", async () => {
	const cfg = await loadServices(`${import.meta.dir}/fixtures/services.yaml`);
	expect(cfg.gitHost).toBe("https://git.example.com");
	expect(
		cfg.services.serviceC.topicOverrides?.["telemetry/{deviceId}"],
	).toEqual({ qos: 0, retain: false });
});

test("loadEnvironments reads an environments.yaml file into typed objects", async () => {
	const cfg = await loadEnvironments(
		`${import.meta.dir}/fixtures/environments.yaml`,
	);
	expect(cfg.environments.default).toEqual({
		serviceA: "1.4.7",
		serviceB: "2.0.1",
	});
});
