// R-030 — the transport-isolation v1 gate: only src/broker/ may import
// aedes or ANY MQTT/transport package; everything else operates on the
// normalized message model (AGENTS.md hard constraint). NB `mqtt-pattern`
// is a pure string matcher, sanctioned for registry/ by F6/R2 — the quoted
// exact-name alternation below deliberately does not match it.
// [stest->R-030]
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

const TRANSPORT =
	/from ["'](aedes|aedes-server-factory|mqtt|mqtt-packet|mqtt-connection|ws|websocket-stream)["']|require\(["'](aedes|aedes-server-factory|mqtt|mqtt-packet|mqtt-connection|ws|websocket-stream)["']\)/;

test("only src/broker/ imports a transport package (aedes/mqtt/ws family) — repo-wide", () => {
	const offenders = walk("src")
		.filter((p) => p.endsWith(".ts") && !p.startsWith("src/broker/"))
		.filter((p) => TRANSPORT.test(readFileSync(p, "utf8")));
	expect(offenders).toEqual([]);
});
