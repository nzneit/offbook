// R-028 — the §5 validation-correctness v1 gate, cross-cutting over the
// module bars (R-004 registry, R-015 validation): the three named fixtures
// drive the COMPOSED stack end to end. A false negative (off-contract
// payload passing green) or false positive (clean payload flagged) on any
// of them is a tool-killer; qos-overrides also proves the tier-2/tier-3
// config resolution reaches the wire (F14).
// [itest->R-028]
import { afterEach, expect, test } from "bun:test";
import { type Composed, compose } from "#src/compose/index.ts";
import { loadConfig, loadServices } from "#src/config/index.ts";
import type { StateEntry, Violation } from "#src/model/index.ts";
import { buildRegistry } from "#src/registry/index.ts";

const FIXTURES = `${import.meta.dir}/../fixtures/asyncapi`;

const servers: Composed[] = [];
afterEach(async () => {
	while (servers.length) await servers.pop()?.stop();
});

// 197xx/129xx ports: distinct from cli-dispatch (190xx) and the other suites
async function bootFixture(
	n: number,
	file: string,
	serviceConfig?: Awaited<ReturnType<typeof loadServices>>["services"][string],
) {
	const config = loadConfig({
		brokerWsPort: 19070 + n,
		brokerTcpPort: 12970 + n,
		controlPlanePort: 19870 + n,
	});
	const path = `${FIXTURES}/${file}`;
	const registry = await buildRegistry({
		specText: await Bun.file(path).text(),
		service: file.replace(".yaml", ""),
		config,
		serviceConfig,
		source: path,
	});
	const server = await compose({ config, registry });
	servers.push(server);
	await server.start();
	const req = (p: string) => server.app.request(p);
	const post = async (p: string, body: unknown) =>
		(await (
			await server.app.request(p, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			})
		).json()) as { matched: boolean; injected: boolean; sinceSeq: number };
	const violationsSince = async (seq: number) =>
		(
			(await (await req(`/v1/validation?sinceSeq=${seq}`)).json()) as {
				violations: Violation[];
			}
		).violations;
	const state = async () =>
		((await (await req("/v1/state")).json()) as { state: StateEntry[] }).state;
	return { post, violationsSince, state };
}

test("external-ref: the bundled cross-file pattern is enforced through the stack; a clean payload passes; the seeded example emits (D-008)", async () => {
	const fx = await bootFixture(1, "external-ref.yaml");
	const good = {
		nodeId: "node-1",
		recordedAt: "2020-01-01T00:00:00Z",
		value: 1,
	};

	// false-negative check: the EXTERNAL pattern (shared/common.yaml) rejects
	const bad = await fx.post("/v1/publish", {
		topic: "telemetry/node-1",
		payload: { ...good, nodeId: "BAD_ID" },
	});
	expect(bad).toMatchObject({ matched: true, injected: true }); // delivered
	const flagged = await fx.violationsSince(bad.sinceSeq);
	expect(flagged).toHaveLength(1);
	expect(flagged[0]?.kind).toBe("schema");
	expect(flagged[0]?.errors?.[0]?.keyword).toBe("pattern");

	// false-positive check: the clean payload raises nothing
	const ok = await fx.post("/v1/publish", {
		topic: "telemetry/node-1",
		payload: good,
	});
	expect(await fx.violationsSince(ok.sinceSeq)).toEqual([]);

	// the seeded example passes its own pre-emit recheck on the §5 bar —
	// F5 drop-and-surface stands with zero drops here (D-008)
	const ex = await fx.post("/v1/publish", {
		topic: "telemetry/node-1",
		example: true,
	});
	expect(ex).toMatchObject({ matched: true, injected: true });
});

test("qos-retain: the binding tier reaches the wire (qos 2 + retained); an off-type payload is surfaced, never blocked", async () => {
	const fx = await bootFixture(2, "qos-retain.yaml");
	const ok = await fx.post("/v1/publish", {
		topic: "presence/p-1",
		payload: { deviceId: "p-1", online: true },
	});
	expect(await fx.violationsSince(ok.sinceSeq)).toEqual([]);
	const entry = (await fx.state()).find((e) => e.topic === "presence/p-1");
	expect(entry?.qos).toBe(2); // spec MQTT binding, tier 1
	expect(entry?.retain).toBe(true);

	const bad = await fx.post("/v1/publish", {
		topic: "presence/p-1",
		payload: { deviceId: "p-1", online: "yes" },
	});
	expect(bad).toMatchObject({ matched: true, injected: true });
	const flagged = await fx.violationsSince(bad.sinceSeq);
	expect(flagged[0]?.kind).toBe("schema");
	expect(flagged[0]?.errors?.[0]?.keyword).toBe("type");
	// raw delivery even off-spec: the retained store now holds the bad payload
	const after = (await fx.state()).find((e) => e.topic === "presence/p-1");
	expect((after?.payload as { online: unknown }).online).toBe("yes");
});

test("qos-overrides: tier-2 topicOverrides beats the tier-3 per-service default on the wire (F14), schema bar intact", async () => {
	const serviceC = (
		await loadServices(
			`${import.meta.dir}/../src/config/fixtures/services.yaml`,
		)
	).services.serviceC;
	const fx = await bootFixture(3, "qos-overrides.yaml", serviceC);

	// alerts: no binding, no override → per-service default qos 2 + retain true
	const alert = await fx.post("/v1/publish", {
		topic: "alerts/a-1",
		payload: { deviceId: "a-1", level: "info", message: "m" },
	});
	expect(await fx.violationsSince(alert.sinceSeq)).toEqual([]);
	const alertEntry = (await fx.state()).find((e) => e.topic === "alerts/a-1");
	expect(alertEntry?.qos).toBe(2);

	// telemetry: topicOverrides pins qos 0 + retain FALSE → delivered but
	// never retained (absence from /state is the observable)
	const tele = await fx.post("/v1/publish", {
		topic: "telemetry/t-1",
		payload: { deviceId: "t-1", value: 1 },
	});
	expect(tele).toMatchObject({ matched: true, injected: true });
	expect(
		(await fx.state()).find((e) => e.topic === "telemetry/t-1"),
	).toBeUndefined();

	// the schema bar holds on the config-tier fixture too
	const bad = await fx.post("/v1/publish", {
		topic: "alerts/a-1",
		payload: { deviceId: "a-1", level: "fatal", message: "m" },
	});
	const flagged = await fx.violationsSince(bad.sinceSeq);
	expect(flagged[0]?.kind).toBe("schema");
	expect(flagged[0]?.errors?.[0]?.keyword).toBe("enum");
});
