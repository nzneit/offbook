// R-028 — the §5 validation-correctness v1 gate, cross-cutting over the
// module bars (R-004 registry, R-015 validation): the named fixtures
// drive the COMPOSED stack end to end. A false negative (off-contract
// payload passing green) or false positive (clean payload flagged) on any
// of them is a tool-killer; qos-overrides also proves the tier-2/tier-3
// config resolution reaches the wire (F14).
//
// multi-format and v2-oldest extend the gate across the SUPPORTED-VERSION
// range (D-018): the newest major's explicit Multi Format Schema Object
// payload and the oldest major's publish/subscribe form. Both shipped a
// real false negative (a wrapper schema with no keywords accepted
// everything; a 2.x binding validated by nothing reached a typed field),
// so the composed-stack rejection of a known-bad payload on each is the
// point of their entries here, not a unit-level detail.
// [itest->R-028]
import { afterEach, expect, test } from "bun:test";
import { type Composed, compose } from "#src/compose/index.ts";
import { loadConfig, loadServices } from "#src/config/index.ts";
import type { Direction, StateEntry, Violation } from "#src/model/index.ts";
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
		).json()) as {
			direction: Direction | null;
			matched: boolean;
			injected: boolean;
			sinceSeq: number;
		};
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
	expect((after?.payload as { online: unknown } | undefined)?.online).toBe(
		"yes",
	);
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

// [itest->R-038]
test("multi-format (3.1.0): the Multi Format Schema Object payload is enforced through the stack in BOTH directions, never accepted wholesale", async () => {
	const fx = await bootFixture(4, "multi-format.yaml");

	// false-negative check, toClient: the wrapper's INNER schema is what
	// validates. Spread verbatim it carries no validation keywords, so this
	// payload passed green through the whole stack before D-018.
	const bad = await fx.post("/v1/publish", {
		topic: "reading/s-1",
		payload: { sensorId: "s-1", celsius: "hot" },
	});
	expect(bad).toMatchObject({
		direction: "toClient",
		matched: true,
		injected: true,
	}); // delivered
	const flagged = await fx.violationsSince(bad.sinceSeq);
	expect(flagged).toHaveLength(1);
	expect(flagged[0]?.kind).toBe("schema");
	expect(flagged[0]?.errors?.[0]?.keyword).toBe("type");

	// false-positive check: the clean payload raises nothing
	const ok = await fx.post("/v1/publish", {
		topic: "reading/s-1",
		payload: { sensorId: "s-1", celsius: 21.5 },
	});
	expect(await fx.violationsSince(ok.sinceSeq)).toEqual([]);

	// the client-publish path carries the wrapper too: a fromClient channel
	// (action: receive) rejects an off-contract publish on the same terms
	const badIn = await fx.post("/v1/publish", {
		topic: "calibrate/s-1",
		payload: { offset: "way-off" },
	});
	expect(badIn).toMatchObject({
		direction: "fromClient",
		matched: true,
		injected: true,
	});
	const flaggedIn = await fx.violationsSince(badIn.sinceSeq);
	expect(flaggedIn).toHaveLength(1);
	expect(flaggedIn[0]?.kind).toBe("schema");
	expect(flaggedIn[0]?.errors?.[0]?.keyword).toBe("type");

	const okIn = await fx.post("/v1/publish", {
		topic: "calibrate/s-1",
		payload: { offset: 0.5 },
	});
	expect(await fx.violationsSince(okIn.sinceSeq)).toEqual([]);
});

// [itest->R-037]
// [itest->R-039]
test("v2-oldest (2.0.0): the floor of the range loads, its subscribe/publish inversion validates the right way round, and its mqtt binding reaches the wire", async () => {
	const fx = await bootFixture(5, "v2-oldest.yaml");

	// the 2.x `subscribe` operation binding (qos 2 + retain) reaches the wire,
	// which nothing upstream validates: 2.x maps `mqtt` to an empty schema
	const ok = await fx.post("/v1/publish", {
		topic: "legacy/d-1/telemetry",
		payload: { deviceId: "d-1", celsius: 21 },
	});
	expect(ok.direction).toBe("toClient"); // 2.x `subscribe` = the SERVICE publishes
	expect(await fx.violationsSince(ok.sinceSeq)).toEqual([]);
	const entry = (await fx.state()).find(
		(e) => e.topic === "legacy/d-1/telemetry",
	);
	expect(entry?.qos).toBe(2);
	expect(entry?.retain).toBe(true);

	// false-negative check on the oldest major: an off-type payload is flagged
	const bad = await fx.post("/v1/publish", {
		topic: "legacy/d-1/telemetry",
		payload: { deviceId: "d-1", celsius: "warm" },
	});
	expect(bad).toMatchObject({ matched: true, injected: true }); // delivered
	const flagged = await fx.violationsSince(bad.sinceSeq);
	expect(flagged).toHaveLength(1);
	expect(flagged[0]?.kind).toBe("schema");
	expect(flagged[0]?.errors?.[0]?.keyword).toBe("type");

	// the `publish` operation normalized to fromClient (the inversion the 2.x
	// spec mandates), and its message schema is enforced on that path too
	const badIn = await fx.post("/v1/publish", {
		topic: "legacy/d-1/command",
		payload: { mode: "broil" },
	});
	expect(badIn).toMatchObject({
		direction: "fromClient",
		matched: true,
		injected: true,
	});
	const flaggedIn = await fx.violationsSince(badIn.sinceSeq);
	expect(flaggedIn).toHaveLength(1);
	expect(flaggedIn[0]?.kind).toBe("schema");
	expect(flaggedIn[0]?.errors?.[0]?.keyword).toBe("enum");

	const okIn = await fx.post("/v1/publish", {
		topic: "legacy/d-1/command",
		payload: { mode: "heat" },
	});
	expect(await fx.violationsSince(okIn.sinceSeq)).toEqual([]);
});
