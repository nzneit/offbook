import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

// Upward-reaching imports must use the #src/ or #scripts/ aliases from
// package.json "imports"; same-directory and downward ./ stay relative.
const PARENT_RELATIVE = /from ["']\.\.\//;

test("no parent-relative imports outside the subpath aliases", () => {
	const offenders = ["src", "test", "scripts", "bin"]
		.flatMap(walk)
		.filter((p) => p.endsWith(".ts") || p.startsWith("bin/"))
		.filter((p) => PARENT_RELATIVE.test(readFileSync(p, "utf8")));
	expect(offenders).toEqual([]);
});
