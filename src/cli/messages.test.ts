// [utest->R-045] — the catalog IS the fixture: wording, stream, and exit
// code assertions in cli-dispatch build on these exact strings, and the
// D-032 docs sweep greps them. Two automation anchors are contract.
import { expect, test } from "bun:test";
import { port } from "#test/ports.ts";
import {
	instanceTable,
	M3,
	M5,
	M6,
	M11,
	M12,
	M13,
	M16,
	M22,
	M23,
	refusalEnvelope,
} from "./messages.ts";

test("the two automation anchors: M11 leads with 'offbook is not running'; notes lead with '(offbook:'", () => {
	expect(M11().startsWith("offbook is not running")).toBe(true);
	expect(M12(7).startsWith("offbook is not running")).toBe(false); // M12 is the wedged variant
	expect(M12(7).startsWith("offbook is not answering here")).toBe(true);
	expect(M13("/p", 7, port(19801)).startsWith("(offbook:")).toBe(true);
});

test("M23 (`up` on a wedged instance): M12's clause + a paste-ready selector, no machine-wide claim", () => {
	expect(M23(41, "/app/mock/.offbook")).toBe(
		"offbook: not answering here (pid 41, runfile in /app/mock/.offbook) — it may still be starting; `offbook down --run-dir /app/mock/.offbook` stops it if it is wedged",
	);
	expect(
		M23(41, "/app/mock/.offbook").startsWith("offbook is not running"),
	).toBe(false);
});

test("instance table rows: identity line + one complete paste-ready command per instance", () => {
	const rows = instanceTable(
		[
			{
				projectDir: "/app/mock",
				demo: false,
				ws: 9001,
				tcp: 1883,
				http: 9080,
				pid: 41,
				runDir: "/app/mock/.offbook",
			},
			{
				projectDir: "/tmp/demo",
				demo: true,
				ws: 9101,
				tcp: 1983,
				http: 9180,
				pid: 42,
				runDir: "/tmp/demo/.offbook",
			},
		],
		"down",
	);
	expect(rows).toEqual([
		"  /app/mock — ws 9001 · tcp 1883 · http 9080 · pid 41",
		"    offbook down --run-dir /app/mock/.offbook",
		"  /tmp/demo [demo] — ws 9101 · tcp 1983 · http 9180 · pid 42",
		"    offbook down --run-dir /tmp/demo/.offbook",
	]);
});

test("no registry/pointer/token/endpoint vocabulary in human-facing text", () => {
	const all = [
		M3({ port: 9080, projectDir: "/p", runDir: "/p/.offbook", demo: false }),
		M5(1, "/p", false),
		M6(),
		M11(),
		M12(1),
		M13("/p", 1, 2),
		M16("/p", 1, 2, true),
		M22(),
	].join("\n");
	for (const word of ["registry", "pointer", "token", "endpoint", "/v1/"])
		expect(all.includes(word)).toBe(false);
});

test("every catalog template renders non-empty (and keeps the per-file coverage floor honest)", async () => {
	const catalog = await import("./messages.ts");
	const rendered = [
		catalog.M2("/p"),
		catalog.M3({
			port: 1,
			projectDir: "/p",
			runDir: "/p/.offbook",
			demo: true,
			alsoBusy: "; also busy: ws 9001",
		}),
		catalog.M5(1, "/p", true),
		catalog.M6(),
		catalog.M8(),
		catalog.M9(),
		catalog.M10("h", "/p/.offbook"),
		catalog.M11(),
		catalog.M11s(),
		catalog.M12(1),
		catalog.M13("/p", 1, 2),
		catalog.M13wrongToken("/p", 1, 2, "/q"),
		catalog.M14("/p", 1),
		catalog.M14missing("/p"),
		catalog.M15("/p", true),
		catalog.M15d("/p", "/p/.offbook"),
		catalog.M16("/p", 1, 2, false),
		catalog.M17("/p", "/p/.offbook"),
		catalog.M18(),
		catalog.M19("/l", "/p", "/p/.offbook"),
		catalog.M20("/p"),
		catalog.M21(),
		catalog.M22(),
		catalog.M23(1, "/p/.offbook"),
	];
	for (const m of rendered) expect(m.length).toBeGreaterThan(0);
});

test("refusalEnvelope is exactly one JSON document", () => {
	const doc = refusalEnvelope("ambiguous", "pick one", [
		{
			projectDir: "/p",
			demo: false,
			ws: 1,
			tcp: 2,
			http: 3,
			pid: 4,
			runDir: "/p/.offbook",
		},
	]);
	const parsed = JSON.parse(doc);
	expect(parsed.error.code).toBe("ambiguous");
	expect(parsed.candidates).toHaveLength(1);
	expect(
		JSON.parse(refusalEnvelope("not-running", "m")).candidates,
	).toBeUndefined();
});
