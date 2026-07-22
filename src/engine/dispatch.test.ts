import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Handler, SpecRegistry } from "../model/index.ts";
import { createDispatchRegistry, defaultDispatch } from "./dispatch.ts";

// A minimal SpecRegistry stub: two channels, one literal and one {param}, the
// literal winning the shared concrete topic — the matcher's most-specific rule
// (the real matcher behavior is R-004-tested in registry/; dispatch only
// delegates to it, so a stub keeps this test transport- and parser-free).
const stubRegistry: SpecRegistry = {
	match(topic: string) {
		const mk = (address: string, params: Record<string, string>) => ({
			channel: {
				topic: address,
				direction: "fromClient" as const,
				service: "t",
				schema: {},
				validate: () => [],
			},
			params,
		});
		if (topic === "command/special/set") return mk("command/special/set", {});
		const m = topic.match(/^command\/([^/]+)\/set$/);
		if (m?.[1]) return mk("command/{deviceId}/set", { deviceId: m[1] });
		return undefined;
	},
	matchesFilter: () => false,
	channels: () => [],
};

function handlerTagged(tag: string, log: string[]): () => Handler {
	return () => ({
		onInbound() {
			log.push(tag);
		},
	});
}

test("select routes through registry.match: literal channel beats {param} for the same topic", () => {
	const d = createDispatchRegistry();
	const log: string[] = [];
	d.register("command/{deviceId}/set", handlerTagged("param", log), "a.ts");
	d.register("command/special/set", handlerTagged("literal", log), "b.ts");
	d.instantiate();
	expect(d.select("command/special/set", stubRegistry)?.registration.pattern).toBe(
		"command/special/set",
	);
	const generic = d.select("command/thermostat-1/set", stubRegistry);
	expect(generic?.registration.pattern).toBe("command/{deviceId}/set");
	expect(generic?.params).toEqual({ deviceId: "thermostat-1" });
});

test("same-channel overlap resolves by sorted module path, independent of registration order", () => {
	const winners: string[] = [];
	for (const reversed of [false, true]) {
		const d = createDispatchRegistry();
		const log: string[] = [];
		const regs: [string, string][] = [
			["z-module.ts", "Z"],
			["a-module.ts", "A"],
		];
		if (reversed) regs.reverse();
		for (const [path, tag] of regs)
			d.register("command/{deviceId}/set", handlerTagged(tag, log), path);
		d.instantiate();
		const sel = d.select("command/x/set", stubRegistry);
		expect(sel).toBeDefined();
		winners.push(sel?.registration.modulePath ?? "?");
	}
	// same winner both times: sorted module path, not import/registration order
	expect(winners).toEqual(["a-module.ts", "a-module.ts"]);
});

test("same module path falls back to registration order", () => {
	const d = createDispatchRegistry();
	const log: string[] = [];
	d.register("command/{deviceId}/set", handlerTagged("first", log), "m.ts");
	d.register("command/{deviceId}/set", handlerTagged("second", log), "m.ts");
	d.instantiate();
	const sel = d.select("command/x/set", stubRegistry);
	sel?.handler.onInbound?.(
		{ message: { topic: "command/x/set", payload: {} }, meta: { clientId: "c", seq: 1, receivedAt: 0 } },
		{ publish: () => {}, random: () => 0, now: () => 0 },
	);
	expect(log).toEqual(["first"]);
});

test("instantiate() re-creates handler instances from factories (fresh state each call)", () => {
	const d = createDispatchRegistry();
	let built = 0;
	d.register("command/{deviceId}/set", () => {
		built++;
		return {};
	});
	d.instantiate();
	d.instantiate();
	expect(built).toBe(2);
	expect(d.all().length).toBe(1);
});

test("select returns undefined for a topic no current channel matches (lazy F19: unresolvable pattern simply never fires)", () => {
	const d = createDispatchRegistry();
	d.register("no/such/{channel}", () => ({}));
	d.instantiate();
	expect(d.select("unrelated/topic", stubRegistry)).toBeUndefined();
});

test("loadHandlers globs, imports in sorted-path order, and stamps module paths", async () => {
	const dir = mkdtempSync(join(tmpdir(), "offbook-handlers-"));
	const dispatchPath = join(import.meta.dir, "dispatch.ts");
	// two handler modules registering on the same pattern; sorted path ⇒ 10-a wins
	writeFileSync(
		join(dir, "10-a.ts"),
		`import { register } from ${JSON.stringify(dispatchPath)};
register("command/{deviceId}/set", () => ({}));`,
	);
	writeFileSync(
		join(dir, "20-b.ts"),
		`import { register } from ${JSON.stringify(dispatchPath)};
register("command/{deviceId}/set", () => ({}));`,
	);
	const paths = await defaultDispatch.loadHandlers(dir);
	expect(paths.map((p) => p.split("/").pop())).toEqual(["10-a.ts", "20-b.ts"]);
	defaultDispatch.instantiate();
	const sel = defaultDispatch.select("command/d1/set", stubRegistry);
	expect(sel?.registration.modulePath.endsWith("10-a.ts")).toBe(true);
});
