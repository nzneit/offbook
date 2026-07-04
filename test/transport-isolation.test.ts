import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

test("only src/broker/ imports aedes", () => {
	const offenders = walk("src")
		.filter((p) => p.endsWith(".ts") && !p.startsWith("src/broker/"))
		.filter((p) =>
			/from ["']aedes(-server-factory)?["']|require\(["']aedes/.test(
				readFileSync(p, "utf8"),
			),
		);
	expect(offenders).toEqual([]);
});
