// R-041 — the template-parses gate (adoption.md §8): extract each scaffolded
// template's fenced example(s) (strip exactly one "# " per line), parse each
// STANDALONE (replace-not-join — never merged with the active lines, so
// duplicate-key collisions are impossible by construction), and assert the
// config parsers accept it; the as-scaffolded files must parse too; the
// scenario example is checked against doctor's OWN scenario-shape checker
// (F18: reused via the already-exported DOCTOR_CHECKS, not hand-rolled here)
// so this gate drifts WITH doctor rather than against it.
// [utest->R-041]
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkoutOrigin, repoRoot } from "#src/cli/checkout.ts";
import type { DoctorCtx } from "#src/cli/doctor.ts";
import { DOCTOR_CHECKS, runDoctor } from "#src/cli/doctor.ts";
import type { Io } from "#src/cli/index.ts";
import { run } from "#src/cli/index.ts";
import { parseEnvironments, parseServices } from "#src/config/index.ts";

const quietIo: Io = { out: () => {}, err: () => {} };

async function scaffold(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "offbook-init-"));
	expect(await run(["init", dir], quietIo)).toBe(0);
	return dir;
}

// F18 — loop the extraction: collect EVERY fenced example in document order
// (a template with a second fence used to go unparsed, since the old
// extraction took only the first marker pair via indexOf), and assert the
// fences are balanced (every open has a matching close, no stray marker).
function extractExamples(template: string): string[] {
	const lines = template.split("\n");
	const examples: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i] !== "# --- example ---") {
			i++;
			continue;
		}
		const end = lines.indexOf("# --- end example ---", i + 1);
		expect(
			end,
			`missing end fence for example starting at line ${i + 1}`,
		).toBeGreaterThan(i);
		examples.push(
			lines
				.slice(i + 1, end)
				.map((l) => l.replace(/^# ?/, ""))
				.join("\n"),
		);
		i = end + 1;
	}
	expect(examples.length, "missing example fence").toBeGreaterThan(0);
	const starts = lines.filter((l) => l === "# --- example ---").length;
	const ends = lines.filter((l) => l === "# --- end example ---").length;
	expect(ends, "unbalanced example fences (a stray marker)").toBe(starts);
	return examples;
}

test("extractExamples collects every fence pair, not just the first", () => {
	const template = [
		"# preamble",
		"# --- example ---",
		"# my-service:",
		"#   repo: org/x",
		"#   specPath: a.yaml",
		"# --- end example ---",
		"# more prose",
		"# --- example ---",
		"# second: block",
		"# --- end example ---",
	].join("\n");
	expect(extractExamples(template)).toEqual([
		"my-service:\n  repo: org/x\n  specPath: a.yaml",
		"second: block",
	]);
});

test("extractExamples rejects an unbalanced fence", () => {
	const missingEnd = [
		"# --- example ---",
		"# a: 1",
		"# --- end example ---",
		"# --- example ---",
		"# b: 2 (never closed)",
	].join("\n");
	expect(() => extractExamples(missingEnd)).toThrow();
});

test("services.yaml: fenced example(s) parse standalone; scaffold parses as-is", async () => {
	const dir = await scaffold();
	const raw = await Bun.file(join(dir, "services.yaml")).text();
	for (const example of extractExamples(raw)) {
		const services = parseServices(example);
		expect(Object.keys(services.services)).toEqual(["my-service"]);
		expect(services.services["my-service"].specPath).toBe("asyncapi.yaml");
	}
	expect(parseServices(raw).services).toEqual({}); // as-scaffolded: empty, parses
	expect(raw).not.toMatch(/^gitHost:/m); // commented example, never active (EI1 amendment)
});

test("environments.yaml: fenced example(s) parse standalone; scaffold parses as-is", async () => {
	const dir = await scaffold();
	const raw = await Bun.file(join(dir, "environments.yaml")).text();
	for (const example of extractExamples(raw)) {
		const envs = parseEnvironments(example);
		expect(Object.keys(envs.environments)).toEqual(["staging"]);
	}
	expect(parseEnvironments(raw).environments).toEqual({ default: {} });
});

test("scenario scaffold: fenced example(s) satisfy doctor's real scenario-shape check", async () => {
	const dir = await scaffold();
	const raw = await Bun.file(join(dir, "scenarios/00-example.yaml")).text();
	const examples = extractExamples(raw);

	// F18 — reuse doctor's OWN checker (DOCTOR_CHECKS is already exported;
	// no new export needed) rather than hand-rolling the same shape
	// assertions here. Lighter than a full runDoctor() pass (which would
	// also run network/ports/deps checks): write each extracted example into
	// its own scenarios/ file and run just the "scenarios" check against it.
	const scenariosCheck = DOCTOR_CHECKS.find((c) => c.name === "scenarios");
	if (scenariosCheck === undefined)
		throw new Error("doctor has no 'scenarios' check");
	const shapeDir = mkdtempSync(join(tmpdir(), "offbook-scenario-shape-"));
	for (const [i, example] of examples.entries())
		await Bun.write(join(shapeDir, "scenarios", `example-${i}.yaml`), example);
	const ctx: DoctorCtx = {
		repoRoot: shapeDir,
		projectDir: shapeDir,
		runDir: join(shapeDir, ".offbook"),
		offline: true,
		bunVersion: "1.0.0",
		ports: { ws: 0, tcp: 0, ctrl: 0 },
	};
	const report = await runDoctor(ctx, [scenariosCheck]);
	expect(report.checks[0].status).toBe("pass");

	expect(parseYaml(raw)).toBeNull(); // as-scaffolded: all comments, parses to null (doctor treats as fine)
});

test("init scaffolds README.md: doctor-first, install steps, no invented host", async () => {
	const dir = await scaffold();
	const readme = await Bun.file(join(dir, "README.md")).text();
	expect(readme).toContain("offbook doctor");
	expect(readme).toContain("bun link");
	// origin observed or ask-a-teammate — never a made-up host (the dev
	// checkout HAS an origin, so this asserts the observed form end-to-end)
	expect(readme).not.toContain("git.example.com");
	// the clone URL is the OBSERVED origin of this checkout, not an invented one
	const origin = await checkoutOrigin(repoRoot());
	if (origin !== undefined) {
		expect(readme).toMatch(/git clone \S+ offbook/);
		expect(readme).toContain(`git clone ${origin} offbook`);
	} else {
		expect(readme).toContain("ask a teammate");
	}
});
