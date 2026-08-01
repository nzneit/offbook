import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

// Upward-reaching imports must use the #src/ or #scripts/ aliases from
// package.json "imports"; same-directory and downward ./ stay relative.
// Covers static/re-export, bare side-effect, and literal dynamic forms;
// a dynamic import of a variable is invisible to a grep gate by nature.
// No self-match: this file's own source never puts a quote directly
// after "from ", "import ", or "import(".
const PARENT_RELATIVE = /(from |import |import\()["']\.\.\//;

test("no parent-relative imports outside the subpath aliases", () => {
	const offenders = ["src", "test", "scripts", "bin"]
		.flatMap(walk)
		.filter((p) => p.endsWith(".ts") || p.startsWith("bin/"))
		.filter((p) => PARENT_RELATIVE.test(readFileSync(p, "utf8")));
	expect(offenders).toEqual([]);
});
