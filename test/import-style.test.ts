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

// The `#test/*` alias (added with the port bands, D-033) is a src -> test edge,
// which the other three aliases are not. It exists for ONE reason: `src/**/
// *.test.ts` files allocate ports through `#test/ports.ts`. Importing it from
// anything that ships is a real hazard, not a style point — `test/ports.ts`
// binds a socket and writes to stderr as an import side effect, and the R-043
// log parsers are stderr-sensitive (D-030). Assembled from halves so this
// file's own source never contains the string it forbids.
const TEST_ALIAS = ["#test", "/"].join("");

test("only *.test.ts files reach into the #test/ alias", () => {
	const offenders = ["src", "scripts", "bin", "demo-app"]
		.flatMap(walk)
		.filter(
			(p) =>
				(p.endsWith(".ts") || p.startsWith("bin/")) && !p.endsWith(".test.ts"),
		)
		.filter((p) => readFileSync(p, "utf8").includes(TEST_ALIAS));
	expect(offenders).toEqual([]);
});
