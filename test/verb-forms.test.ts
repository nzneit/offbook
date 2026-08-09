// R-042 — VERB_FORMS ↔ dispatch ↔ USAGE coherence (adoption.md §9): one
// source of truth, pinned in both directions. USAGE-parse convention (fork
// e + follow-up pass): `<...>` and `[a|b]` bracket groups are arguments; a
// bare `[word]` names a subcommand iff the two-token form is in VERB_FORMS.
// [utest->R-042]
import { expect, test } from "bun:test";
import { DISPATCH_VERBS, USAGE } from "#src/cli/index.ts";
import { SUBCOMMAND_FIRST_TOKENS, VERB_FORMS } from "#src/cli/verbs.ts";

const firstTokens = [...new Set(VERB_FORMS.map((f) => f.split(" ")[0]))];
const usageVerbLines = USAGE.split("\n").filter((l) => /^ {2}\S/.test(l));

test("VERB_FORMS first tokens ≡ dispatch verbs", () => {
	expect(firstTokens.sort()).toEqual([...DISPATCH_VERBS].sort());
});

test("every VERB_FORM appears in USAGE", () => {
	for (const form of VERB_FORMS) {
		const [a, b] = form.split(" ");
		const line = usageVerbLines.find((l) => l.trimStart().split(/\s/)[0] === a);
		expect(line, `no USAGE line for '${a}'`).toBeDefined();
		if (b !== undefined)
			expect(
				line?.includes(`[${b}]`) || line?.includes(` ${b}`),
				`USAGE line for '${a}' does not name subcommand '${b}'`,
			).toBe(true);
	}
});

test("no USAGE verb line names a form outside VERB_FORMS", () => {
	for (const line of usageVerbLines) {
		const tokens = line.trimStart().split(/\s+/);
		const verb = tokens[0];
		expect(firstTokens, `USAGE names unknown verb '${verb}'`).toContain(verb);
		// bare [word] (no |, no <, no -) claims a subcommand only if the
		// two-token form exists; otherwise it is an argument by convention
		const m = tokens[1]?.match(/^\[([a-z-]+)\]$/);
		if (m && SUBCOMMAND_FIRST_TOKENS.has(verb))
			expect(VERB_FORMS).toContain(`${verb} ${m[1]}`);
	}
});

test("offbook --version prints version + commit and exits 0", async () => {
	const out: string[] = [];
	const code = await (await import("#src/cli/index.ts")).run(["--version"], {
		out: (l) => out.push(l),
		err: () => {},
	});
	expect(code).toBe(0);
	expect(out[0]).toMatch(/^offbook \d+\.\d+\.\d+ \(.+\)$/);
});
