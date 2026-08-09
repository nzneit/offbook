// R-041 — the template-parses gate (adoption.md §8): extract each scaffolded
// template's fenced example (strip exactly one "# " per line), parse it
// STANDALONE (replace-not-join — never merged with the active lines, so
// duplicate-key collisions are impossible by construction), and assert the
// config parsers accept it; the as-scaffolded files must parse too; the
// scenario example satisfies the doctor check-5 shape (shape-only: its
// topics exist in no spec, the same line doctor draws).
// [utest->R-041]
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkoutOrigin, repoRoot } from "#src/cli/checkout.ts";
import type { Io } from "#src/cli/index.ts";
import { run } from "#src/cli/index.ts";
import { parseEnvironments, parseServices } from "#src/config/index.ts";

const quietIo: Io = { out: () => {}, err: () => {} };

async function scaffold(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "offbook-init-"));
	expect(await run(["init", dir], quietIo)).toBe(0);
	return dir;
}

function extractExample(template: string): string {
	const lines = template.split("\n");
	const start = lines.indexOf("# --- example ---");
	const end = lines.indexOf("# --- end example ---");
	expect(start, "missing example fence").toBeGreaterThanOrEqual(0);
	expect(end, "missing end fence").toBeGreaterThan(start);
	return lines
		.slice(start + 1, end)
		.map((l) => l.replace(/^# ?/, ""))
		.join("\n");
}

test("services.yaml: fenced example parses standalone; scaffold parses as-is", async () => {
	const dir = await scaffold();
	const raw = await Bun.file(join(dir, "services.yaml")).text();
	const services = parseServices(extractExample(raw));
	expect(Object.keys(services.services)).toEqual(["my-service"]);
	expect(services.services["my-service"].specPath).toBe("asyncapi.yaml");
	expect(parseServices(raw).services).toEqual({}); // as-scaffolded: empty, parses
	expect(raw).not.toMatch(/^gitHost:/m); // commented example, never active (EI1 amendment)
});

test("environments.yaml: fenced example parses standalone; scaffold parses as-is", async () => {
	const dir = await scaffold();
	const raw = await Bun.file(join(dir, "environments.yaml")).text();
	const envs = parseEnvironments(extractExample(raw));
	expect(Object.keys(envs.environments)).toEqual(["staging"]);
	expect(parseEnvironments(raw).environments).toEqual({ default: {} });
});

test("scenario scaffold: fenced example satisfies the doctor check-5 shape", async () => {
	const dir = await scaffold();
	const raw = await Bun.file(join(dir, "scenarios/00-example.yaml")).text();
	const doc = parseYaml(extractExample(raw)) as Array<{
		name?: unknown;
		then?: unknown;
	}>;
	expect(Array.isArray(doc)).toBe(true);
	for (const s of doc) {
		expect(typeof s.name).toBe("string");
		expect(Array.isArray(s.then)).toBe(true);
	}
	expect(parseYaml(raw)).toBeNull(); // as-scaffolded: all comments, parses to null (doctor treats as fine)
});

test("init scaffolds README.md: doctor-first, install steps, no invented host", async () => {
	const dir = await scaffold();
	const readme = await Bun.file(join(dir, "README.md")).text();
	expect(readme).toContain("offbook doctor");
	expect(readme).toContain("bun link");
	expect(readme).toMatch(/git clone \S+ offbook/);
	// origin observed or ask-a-teammate — never a made-up host (the dev
	// checkout HAS an origin, so this asserts the observed form end-to-end)
	expect(readme).not.toContain("git.example.com");
	// the clone URL is the OBSERVED origin of this checkout, not an invented one
	const origin = await checkoutOrigin(repoRoot());
	if (origin !== undefined) {
		expect(readme).toContain(`git clone ${origin} offbook`);
	} else {
		expect(readme).toContain("ask a teammate");
	}
});
