# Embedding Onboarding Implementation Plan (R-041, R-042, R-043)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the embedding-onboarding design — reference `init` templates + gates (R-041), the bundled onboarding skill with `offbook skill install`, `offbook --version`, doctor check 8, and the check-docs skill gates (R-042), and the first-light integrity hardening (R-043) — per `docs/specs/adoption.md` §8–§10.

**Architecture:** All CLI-local: no `/v1` endpoint or response-shape changes anywhere in this plan. New leaf modules (`src/cli/verbs.ts`, `src/cli/checkout.ts`) feed the CLI, the doc gate, and the skill-install verb from single sources of truth. R-043 rides existing surfaces only: structured `offbook.log` lines and the runfile/`probeOffbook` machinery.

**Tech Stack:** Bun + TypeScript (no build step), `bun:test`, Biome (tabs, double quotes), the `yaml` package, git via `Bun.spawn`.

## Global Constraints

- **Branch:** all work lands on `embedding-onboarding` (already checked out). Commit after every task; message style `feat:`/`test:`/`docs:` as the repo uses. **Never add a Co-Authored-By or any AI-attribution trailer.** Never run `git config`.
- **Gates are judged by exit code, never printed summaries** (`bun scripts/check-docs.ts`, `bun run lint`, `bun run typecheck`, full `bun test`). `bun test <single-file>` may exit 1 with zero failures (per-file coverage floor) — gate on full `bun test` runs; single-file runs are for red/green inspection of *your* test only.
- **Imports:** upward reaches use `#src/…`/`#scripts/…`; same-directory stays relative with explicit `.ts` (enforced by `test/import-style.test.ts`).
- **Transport isolation:** nothing in this plan may import `aedes` or any MQTT package outside `src/broker/` (nothing here needs to).
- **Frozen contracts:** do not touch `/v1` handlers or `docs/specs/contracts.md`. The one contract edit this cycle needed is already committed.
- **Test tags:** every test file (or added block) carries the arrow-tag comment for its requirement (`// [utest->R-041]`, `// [itest->R-043]`, …) — `check-docs` verifies tags in both directions once statuses flip to `tested` (Task 15).
- **Test ports:** per-file unique. New integration assertions reuse `test/cli-dispatch.test.ts`'s existing server/ports (19001/12901/19801); new unit test files need no ports.
- **Code style:** tabs, double quotes, match surrounding comment density. Run `bun run lint` before each commit.

---

### Task 1: `VERB_FORMS` single source of truth + coherence test

**Files:**
- Create: `src/cli/verbs.ts`
- Modify: `src/cli/index.ts` (export `USAGE` and `DISPATCH_VERBS`; both currently module-local/absent)
- Test: `test/verb-forms.test.ts`

**Interfaces:**
- Consumes: the existing `USAGE` string (`src/cli/index.ts:1322`) and `VERBS` table (`src/cli/index.ts:1346`).
- Produces: `VERB_FORMS: readonly string[]` (every valid invocation form, one- and two-token) and `SUBCOMMAND_FIRST_TOKENS: ReadonlySet<string>` from `src/cli/verbs.ts`; `USAGE: string` and `DISPATCH_VERBS: readonly string[]` exported from `src/cli/index.ts`. Task 6 (check-docs gate) and Task 7 (skill verb) build on these. **This task ships the current verb set — no `skill`, no `--version` yet; those arrive in Tasks 2/7 and must extend `VERB_FORMS` + `USAGE` together (this test enforces it).**

- [ ] **Step 1: Write `src/cli/verbs.ts`**

```ts
// R-042 — the CLI's invocation forms, one source of truth (adoption.md §9,
// review-round fork e): USAGE, the dispatch table, and check-docs' skill
// verb-existence gate all derive from this list. A LEAF module: imports
// nothing, so scripts/check-docs.ts can import it without dragging the CLI's
// transport stack into the doc gate. Argument VALUES are not forms
// (`mode autonomous` is `mode` + argument); subcommands are (`specs update`).
export const VERB_FORMS: readonly string[] = [
	"init",
	"doctor",
	"demo",
	"up",
	"down",
	"status",
	"logs",
	"topics",
	"state",
	"publish",
	"scenario",
	"scenarios",
	"reset",
	"mode",
	"validation",
	"check",
	"diagnostics",
	"specs",
	"specs update",
];

// first tokens that take a subcommand (any verb with a two-token form)
export const SUBCOMMAND_FIRST_TOKENS: ReadonlySet<string> = new Set(
	VERB_FORMS.filter((f) => f.includes(" ")).map((f) => f.split(" ")[0]),
);
```

- [ ] **Step 2: Export `USAGE` and `DISPATCH_VERBS` from `src/cli/index.ts`**

At `src/cli/index.ts:1322` change `const USAGE = ...` to `export const USAGE = ...`. Directly after the `VERBS` table (after line 1364's closing `};`) add:

```ts
// R-042 — the dispatch truth the VERB_FORMS coherence test pins (`demo` is
// dispatched outside the table, in run()).
export const DISPATCH_VERBS: readonly string[] = [
	...Object.keys(VERBS),
	"demo",
];
```

- [ ] **Step 3: Write the failing coherence test `test/verb-forms.test.ts`**

```ts
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
```

- [ ] **Step 4: Run the test**

Run: `bun test test/verb-forms.test.ts`
Expected: PASS (3 tests). If "every VERB_FORM appears in USAGE" fails, fix the `VERB_FORMS` list against the actual USAGE — the list above was transcribed from `src/cli/index.ts:1322-1344`; USAGE is the source for this task. (Single-file exit 1 with 0 fails = coverage floor; check the fail count.)

- [ ] **Step 5: Full gates + commit**

Run: `bun run lint && bun run typecheck && bun test` — all exit 0.

```bash
git add src/cli/verbs.ts src/cli/index.ts test/verb-forms.test.ts
git commit -m "feat: VERB_FORMS single source of truth + coherence test (R-042)"
```

---

### Task 2: `src/cli/checkout.ts` + `offbook --version`

**Files:**
- Create: `src/cli/checkout.ts`
- Modify: `src/cli/index.ts` (`run()` at line 1366: handle `--version`/`-v` before verb lookup)
- Test: `src/cli/checkout.test.ts`, plus a `--version` dispatch test appended to `test/verb-forms.test.ts`

**Interfaces:**
- Produces: `repoRoot(): string`, `checkoutCommit(root?): Promise<string>` (short sha, `-dirty` suffix, `"unknown"` fallback), `checkoutOrigin(root?): Promise<string | undefined>`, `gitToplevel(dir): Promise<string | undefined>`, `gitIgnored(path, cwd): Promise<boolean>`. Tasks 4 (init README), 7 (stamp), 8 (destination), 9 (doctor check 8) consume these exact signatures.

- [ ] **Step 1: Write `src/cli/checkout.ts`**

```ts
// R-042 — identity of the running tool's checkout (adoption.md §9): under
// `bun link` every install is a live symlink to a personal checkout, so
// version identity = the checkout's git state. Also the shared git helpers
// for skill install's destination/propagation checks. CLI-local; git runs
// via Bun.spawn with stderr ignored — a missing git or non-repo degrades to
// undefined/"unknown", never a crash.
import { join } from "node:path";

export function repoRoot(): string {
	return join(import.meta.dir, "../..");
}

async function git(args: string[], cwd: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
		if ((await proc.exited) !== 0) return undefined;
		const out = (await new Response(proc.stdout).text()).trim();
		return out === "" ? undefined : out;
	} catch {
		return undefined; // git itself missing
	}
}

export async function checkoutCommit(root = repoRoot()): Promise<string> {
	const sha = await git(["rev-parse", "--short", "HEAD"], root);
	if (sha === undefined) return "unknown";
	const dirty = await git(["status", "--porcelain"], root);
	return dirty === undefined ? sha : `${sha}-dirty`;
}

export async function checkoutOrigin(
	root = repoRoot(),
): Promise<string | undefined> {
	return git(["remote", "get-url", "origin"], root);
}

export async function gitToplevel(dir: string): Promise<string | undefined> {
	return git(["rev-parse", "--show-toplevel"], dir);
}

export async function gitIgnored(path: string, cwd: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(["git", "check-ignore", "-q", path], {
			cwd,
			stdout: "ignore",
			stderr: "ignore",
		});
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}
```

- [ ] **Step 2: Write the failing tests `src/cli/checkout.test.ts`**

```ts
// R-042 — checkout identity: sha/dirty/unknown, origin, toplevel, ignore.
// Runs against throwaway git repos in temp dirs — never the real checkout
// (its dirty state would flake the assertions).
// [utest->R-042]
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkoutCommit,
	checkoutOrigin,
	gitIgnored,
	gitToplevel,
} from "./checkout.ts";

async function sh(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "ignore" });
	if ((await proc.exited) !== 0) throw new Error(`failed: ${args.join(" ")}`);
}

async function tempRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "offbook-checkout-"));
	await sh(dir, "git", "init", "-q", "-b", "main");
	await sh(dir, "git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "x");
	return dir;
}

test("checkoutCommit: clean sha, -dirty suffix, unknown outside a repo", async () => {
	const repo = await tempRepo();
	const clean = await checkoutCommit(repo);
	expect(clean).toMatch(/^[0-9a-f]{4,}$/);
	writeFileSync(join(repo, "x.txt"), "x");
	expect(await checkoutCommit(repo)).toBe(`${clean}-dirty`);
	expect(await checkoutCommit(mkdtempSync(join(tmpdir(), "norepo-")))).toBe("unknown");
});

test("checkoutOrigin: undefined without a remote, the URL with one", async () => {
	const repo = await tempRepo();
	expect(await checkoutOrigin(repo)).toBeUndefined();
	await sh(repo, "git", "remote", "add", "origin", "https://git.example.com/org/offbook.git");
	expect(await checkoutOrigin(repo)).toBe("https://git.example.com/org/offbook.git");
});

test("gitToplevel resolves from a subdir; gitIgnored honors .gitignore", async () => {
	const repo = await tempRepo();
	const sub = join(repo, "mock");
	await sh(repo, "mkdir", "-p", sub);
	expect(await gitToplevel(sub)).toBe(await gitToplevel(repo));
	expect(await gitToplevel(mkdtempSync(join(tmpdir(), "norepo-")))).toBeUndefined();
	writeFileSync(join(repo, ".gitignore"), ".claude/\n");
	expect(await gitIgnored(join(repo, ".claude/skills"), repo)).toBe(true);
	expect(await gitIgnored(join(repo, "src"), repo)).toBe(false);
});
```

Run: `bun test src/cli/checkout.test.ts` — expected FAIL (module not found) before Step 1 is saved; PASS after (0 fails; ignore a coverage-floor exit 1).

- [ ] **Step 3: Wire `--version` into `run()`**

In `src/cli/index.ts` `run()` (line 1366), after `const [cmd, ...rest] = argv;` and **before** the `demo` special case, insert:

```ts
		if (cmd === "--version" || cmd === "-v") {
			const root = repoRoot();
			const pkg = JSON.parse(
				await Bun.file(join(root, "package.json")).text(),
			) as { version?: string };
			io.out(`offbook ${pkg.version ?? "0.0.0"} (${await checkoutCommit(root)})`);
			return 0;
		}
```

Add to the imports block: `import { checkoutCommit, repoRoot } from "./checkout.ts";`. Append to the USAGE footer line (line 1344), making it:

```
client verbs accept --run-dir <dir> (default .offbook) and --ctrl-port <n>; \`offbook --version\` prints the tool's version + source commit
```

- [ ] **Step 4: Append the dispatch test to `test/verb-forms.test.ts`**

```ts
test("offbook --version prints version + commit and exits 0", async () => {
	const out: string[] = [];
	const code = await (await import("#src/cli/index.ts")).run(["--version"], {
		out: (l) => out.push(l),
		err: () => {},
	});
	expect(code).toBe(0);
	expect(out[0]).toMatch(/^offbook \d+\.\d+\.\d+ \(.+\)$/);
});
```

- [ ] **Step 5: Full gates + commit**

Run: `bun run lint && bun run typecheck && bun test` — all exit 0.

```bash
git add src/cli/checkout.ts src/cli/checkout.test.ts src/cli/index.ts test/verb-forms.test.ts
git commit -m "feat: offbook --version + checkout identity helpers (R-042)"
```

---

### Task 3: Reference init templates + the template-parses gate

**Files:**
- Modify: `src/cli/index.ts:1212-1274` (`INIT_SERVICES`, `INIT_ENVIRONMENTS`, `INIT_SCENARIO`, `cmdInit`'s next-steps output)
- Test: `test/init-templates.test.ts`
- Check: `test/cli-dispatch.test.ts:711-723` pins init's output — update the expected next-steps string there.

**Interfaces:**
- Produces: the fence convention (`# --- example ---` / `# --- end example ---`, code depth `# `, prose depth `## `) that Task 4's README does NOT use (prose file), and template constants Task 4 extends. The extraction helper lives in the test file (the gate is its only consumer).

- [ ] **Step 1: Replace the three template constants in `src/cli/index.ts`**

```ts
// R-041 — reference-quality scaffolds (adoption.md §8). Fence convention:
// exactly ONE canonical worked example per template between the marker
// lines, commented at code depth ("# "); alternatives and prose sit at
// prose depth ("## ") outside the fence, so test/init-templates.test.ts's
// extraction (strip one "# " per line, parse STANDALONE) is mechanical.
// gitHost stays a COMMENTED example, never an active placeholder (contracts
// §6, the EI1 amendment): unset must remain the true config state so a
// slug-form repo hits the clean G20 error, not a fetch against garbage.
const INIT_SERVICES = `# offbook — where each service's AsyncAPI spec lives (services.yaml).
# Validate as you edit: \`offbook doctor\` checks this file locally (no
# network) and confirms each repo resolves (the specs-reachable check).
#
# gitHost: https://git.example.com
##  ^ uncomment and set: the base URL slug-form repos resolve against.
##  NO built-in default — a slug-form repo with no gitHost is a config
##  error. Full-URL and absolute-path repos need no gitHost.
services: {}
# --- example ---
# services:
#   my-service:
#     repo: org/my-service
#     specPath: asyncapi.yaml
#     branch: main
# --- end example ---
## repo (required) — three accepted forms:
##   slug:           org/my-service        (resolved against gitHost)
##   full URL:       https://git.example.com/org/my-service.git
##   absolute path:  /home/you/checkouts/my-service
## specPath (required) — path to the AsyncAPI doc inside the repo.
## branch (optional) — defaults to main.
## Per-service extras: gitHost (overrides the global), qosDefault (0|1|2),
## retainDefault, topicOverrides — docs/guides/wiring-your-service.md.
`;

const INIT_ENVIRONMENTS = `# offbook — requested spec versions per environment (environments.yaml).
# What it is for: records WHICH spec version each environment wants, so
# provenance lands in specs.lock. v1 always fetches branch tips regardless
# (resolution-mode: branch) — you rarely touch this file until pinned
# resolution ships. Validate with \`offbook doctor\`.
environments:
  default: {}
# --- example ---
# environments:
#   staging:
#     my-service: "1.4.2"
# --- end example ---
`;

const INIT_SCENARIO = `# offbook L2 scenarios — declarative reactive/triggered emissions.
# \`offbook doctor\` shape-checks scenarios/*.yaml; a running server reports
# full binding diagnostics (\`offbook diagnostics\`).
# --- example ---
# - name: accept-set
#   when:
#     topic: command/{deviceId}/set
#   then:
#     - emit:
#         topic: state/{{deviceId}}
#         payload: { deviceId: "{{deviceId}}", status: accepted }
#         delay: 50-80ms
# --- end example ---
## Adapt the topics to your spec (\`offbook topics\` lists them); recipes:
## docs/guides/scenario-cookbook.md
`;
```

- [ ] **Step 2: Update `cmdInit`'s next-steps line (`src/cli/index.ts:1270-1272`)**

```ts
	io.out(
		"next: set gitHost + your services in services.yaml (validate with `offbook doctor` as you edit), then `offbook up`",
	);
```

- [ ] **Step 3: Write the failing gate `test/init-templates.test.ts`**

```ts
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
```

- [ ] **Step 4: Run red → green**

Run: `bun test test/init-templates.test.ts` — expected FAIL before Step 1 lands (`missing example fence`), PASS after (0 fails). Then run the full `bun test`: **`test/cli-dispatch.test.ts` will fail on the pinned init next-steps string** (~line 711-723 block) — update the expectation there to the new string from Step 2, and update any pinned template-content assertions the run surfaces.

- [ ] **Step 5: Full gates + commit**

Run: `bun run lint && bun run typecheck && bun test && bun scripts/check-docs.ts` — all exit 0.

```bash
git add src/cli/index.ts test/init-templates.test.ts test/cli-dispatch.test.ts
git commit -m "feat: reference init templates + fenced template-parses gate (R-041)"
```

---

### Task 4: `init` scaffolds the project README (observed-origin clone URL)

**Files:**
- Modify: `src/cli/index.ts` (`cmdInit`, line 1242; add an `INIT_README` builder)
- Test: append to `test/init-templates.test.ts`

**Interfaces:**
- Consumes: `checkoutOrigin`, `repoRoot` from `src/cli/checkout.ts` (Task 2).
- Produces: `README.md` in the scaffolded project dir. **The origin is observed from the running tool's checkout — never the app repo's remote** (adoption.md §8; the wrong reading tells teammates to clone the wrong repo).

- [ ] **Step 1: Add the builder above `cmdInit` and wire it in**

```ts
// R-041 — the one committed artifact that names the next step for a
// teammate WITHOUT an agent (fresh app-repo clone: mock/, scripts, and
// skill present, `offbook: command not found`). The clone URL is OBSERVED
// from the running tool's own checkout — never the app repo's remote, and
// never invented (the <internal-git> rule).
function initReadme(originUrl: string | undefined): string {
	const cloneLine =
		originUrl !== undefined
			? `git clone ${originUrl} offbook`
			: "git clone <ask a teammate for the offbook clone URL> offbook";
	return `# offbook mock project

This directory mocks this app's MQTT-over-WebSockets backend from its
AsyncAPI specs (services.yaml points at them). The app connects to
\`ws://localhost:9001\` exactly as it would to the real backend.

## Install offbook (once per machine)

\`\`\`sh
${cloneLine}
cd offbook && bun install && bun link
\`\`\`

## Use

\`\`\`sh
offbook doctor   # start here — validates this project + your environment
offbook up       # serve the mock
offbook down
\`\`\`

Guides live in the offbook checkout under docs/guides/ (getting-started,
wiring-your-service, scenario-cookbook, daily-loop).
`;
}
```

In `cmdInit`, after the `environments.yaml` write (line 1260), add:

```ts
	await writeIfAbsent("README.md", initReadme(await checkoutOrigin(repoRoot())));
```

(`checkoutOrigin`/`repoRoot` are already imported by Task 2's edit; extend that import line.)

- [ ] **Step 2: Append the failing test to `test/init-templates.test.ts`**

```ts
test("init scaffolds README.md: doctor-first, install steps, no invented host", async () => {
	const dir = await scaffold();
	const readme = await Bun.file(join(dir, "README.md")).text();
	expect(readme).toContain("offbook doctor");
	expect(readme).toContain("bun link");
	expect(readme).toMatch(/git clone \S+ offbook/);
	// origin observed or ask-a-teammate — never a made-up host (the dev
	// checkout HAS an origin, so this asserts the observed form end-to-end)
	expect(readme).not.toContain("git.example.com");
});
```

- [ ] **Step 3: Run red → green, check init's summary line**

Run: `bun test test/init-templates.test.ts` — FAIL (no README.md) → implement Step 1 → PASS. Also extend `cmdInit`'s `created` summary output (line 1267-1269) naturally covers it via `created.join(", ")` — verify `offbook init` output now lists `README.md`; update the cli-dispatch pin if it asserts the exact scaffold list.

- [ ] **Step 4: Full gates + commit**

Run: `bun run lint && bun run typecheck && bun test` — all exit 0.

```bash
git add src/cli/index.ts test/init-templates.test.ts test/cli-dispatch.test.ts
git commit -m "feat: init scaffolds a project README with the observed-origin clone URL (R-041)"
```

---

### Task 5: Guide amendments — app-connection recipe + first-light acceptance test

**Files:**
- Modify: `docs/guides/wiring-your-service.md` (append §8; amend §4)

**Interfaces:** none (prose; the link gate covers it). Derived docs: on any conflict `contracts.md` wins.

- [ ] **Step 1: Append §8 to `docs/guides/wiring-your-service.md`**

```markdown
## 8. Point your app at offbook

Your app should reach the broker through one build-time env var, with the
real backend as the default and the mock as a dev-only override:

```ts
// src/mqtt.ts — the one place the broker URL lives
const MQTT_URL = import.meta.env.VITE_MQTT_URL ?? "wss://mqtt.your-backend.example";
```

```sh
# .env.development (committed): dev builds hit the mock
VITE_MQTT_URL=ws://localhost:9001
```

Two rules keep this safe:

- **The default is the real backend.** A build with no env file must reach
  production, never localhost.
- **On localhost use plain `ws://`, not `wss://`.**

Adjust the prefix to your bundler (`VITE_`, `REACT_APP_`, …) — build-time
env vars are only exposed to client code when prefixed. Zero-rebuild
variant: a runtime query-param override, as the bundled demo app does
(`?ws=<port>` — see `demo-app/src/App.tsx`); your app needs that one-time
code change before the URL is switchable without a rebuild.
```

- [ ] **Step 2: Amend §4 ("First `offbook up`") with the acceptance test**

Append to the §4 section body:

```markdown
**First light is not done until your app's connect lands.** Start the app,
then `offbook status`: the `clients:` line counts connects observed this
run. Zero connects while the app "works" means it is talking to the real
backend, not the mock — check §8's env wiring. (`offbook logs` shows the
full connect fingerprint.)
```

- [ ] **Step 3: Gate + commit**

Run: `bun scripts/check-docs.ts && bun test` — exit 0 (the readme-quickstart/cookbook gates don't touch this guide; the link gate does).

```bash
git add docs/guides/wiring-your-service.md
git commit -m "docs: app-connection recipe + first-light acceptance test in the wiring guide (R-041, R-043)"
```

---

### Task 6: The bundled skill + check-docs skill gates

**Files:**
- Create: `skills/offbook-onboard/SKILL.md`
- Modify: `scripts/check-docs.ts` (three new checks wired into `main()`)
- Test: `scripts/check-docs.test.ts` (new cases)

**Interfaces:**
- Consumes: `VERB_FORMS`, `SUBCOMMAND_FIRST_TOKENS` from `#src/cli/verbs.ts` (Task 1).
- Produces: `checkSkillLinks(files): string[]`, `checkSkillVerbs(files, forms, subFirst): string[]`, `checkSkillFrontmatter(text): string[]` exported from `scripts/check-docs.ts`; the skill directory Task 7 installs and Task 9 compares against.

- [ ] **Step 1: Write `skills/offbook-onboard/SKILL.md`**

````markdown
---
name: offbook-onboard
description: Embed offbook (the MQTT-over-WebSockets mock) into this app repo — scaffold the mock project, wire the AsyncAPI spec repos, point the app at the mock, and verify first light.
---

# Onboarding offbook into this app repo

You are embedding offbook — a local dev tool that mocks this app's
MQTT-over-WebSockets backend from AsyncAPI specs — into the current repo.

**Authority chain: contracts > guides > this skill.** The offbook checkout's
`docs/specs/contracts.md` and `docs/guides/` are canonical; if this skill
disagrees with them, this skill is wrong — follow the guide and say so.

**Locating the offbook docs:** read `.installed-from` in this skill's
directory. If its `sourcePath` exists on this machine, the guides are at
`<sourcePath>/docs/guides/`. Otherwise its `originUrl` is the clone URL
(clone it, or hand the URL to the human). If neither helps, ask a teammate
for the offbook clone URL — never guess a host.

Work conversationally: one question at a time, show diffs before applying
them, and run the named verification after every step.

## The journey

1. **Preflight.** Run `offbook doctor`. If `offbook` is not on PATH, follow
   the install steps in the offbook checkout's README (clone, `bun install`,
   `bun link`), then re-run. Fix anything doctor flags before continuing.
2. **Interview.** For each backend service to mock, ask where its AsyncAPI
   spec lives: git host base URL, repo (slug, full URL, or absolute path),
   path to the spec file inside the repo, branch. One service at a time.
3. **Scaffold + wire.** Run `offbook init mock/`. Fill `mock/services.yaml`
   from the interview answers — the file's own comments document every
   field. After each edit run `offbook doctor mock/` until it reports ok
   (shape is checked locally; specs-reachable confirms each repo resolves).
4. **Point the app at the mock.** Find the hardcoded broker URL in the app
   source. Extract it behind a build-time env var per the wiring guide's
   "Point your app at offbook" section (real backend stays the default;
   `ws://localhost:9001` goes in `.env.development`). Show the human the
   full diff and get approval BEFORE applying it.
5. **Package scripts.** Add to the app's package.json, mirroring the
   daily-loop guide:
   `"mock:up": "cd mock && offbook up"`, `"mock:down": "cd mock && offbook down"`.
6. **First light.** `cd mock && offbook up`. Confirm ingestion with
   `offbook topics --json` (it refuses if no server is running here — that
   refusal means `up` failed; read its output). Start the app. **The
   acceptance test: the app's connect fingerprint appears** — `offbook
   status` shows a nonzero `clients:` count. Zero connects while the app
   works means the app is still on the real backend: revisit step 4. Then
   run `offbook validation --watch` and show the human a violation landing
   (e.g. `offbook publish <a-toClient-topic> --example` then break a field).
7. **CI (offer, optional).** The daily-loop guide's CI recipe: `offbook up
   --ci`, run the app's integration tests, `offbook check`, `offbook down`.

## Refusals you may hit

- `offbook doctor` warns the installed skill differs from the bundled one:
  run `offbook skill install --force` from the repo root to refresh it.
- `offbook up` reports ports owned by an offbook in another directory:
  run `offbook down` in that directory (likely the demo), or pass
  `--ws-port`/`--ctrl-port`.
````

- [ ] **Step 2: Add the three checks to `scripts/check-docs.ts`**

Add the import at the top (`#src` import is fine here — the module is a leaf, this is exactly why it is one):

```ts
import { SUBCOMMAND_FIRST_TOKENS, VERB_FORMS } from "#src/cli/verbs.ts";
```

Add the three exported functions (beside `checkLinks`):

```ts
// R-042 — the skill's relative links must be INTRA-SKILL (adoption.md §9):
// the consumed copy lives in the app repo, so a link out of the skill dir
// resolves on the wrong filesystem by construction.
export function checkSkillLinks(
  files: { path: string; text: string }[],
): string[] {
  const errs: string[] = [];
  for (const f of files)
    for (const m of f.text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z+.-]*:/.test(target) || target.startsWith("#")) continue;
      const rel = target.split("#")[0];
      if (rel === "") continue;
      const resolved = join(dirname(f.path), rel);
      if (!resolved.startsWith("skills/offbook-onboard/"))
        errs.push(`${f.path}: link escapes the skill dir → ${target}`);
      else if (!existsSync(join(ROOT, resolved)))
        errs.push(`${f.path}: broken link → ${target}`);
    }
  return errs;
}

// R-042 — no dead verbs in the skill: every `offbook <form>` it names must
// be a VERB_FORMS member (set membership; `<...>` placeholders exempt,
// flags ignored; a second token participates only when the first token has
// any two-token form — `mode autonomous` is `mode` + argument). Residual
// (stated in adoption.md §9): verb FORMS only — flag names unchecked.
export function checkSkillVerbs(
  files: { path: string; text: string }[],
  forms: readonly string[] = VERB_FORMS,
  subFirst: ReadonlySet<string> = SUBCOMMAND_FIRST_TOKENS,
): string[] {
  const errs: string[] = [];
  const members = new Set(forms);
  for (const f of files)
    for (const m of f.text.matchAll(/`offbook ([^`]+)`|^\s*(?:\$ )?offbook (.+)$/gm)) {
      const rest = (m[1] ?? m[2] ?? "").trim();
      if (rest.startsWith("-")) continue; // `offbook --version` etc: flags, not verbs
      const tokens = rest.split(/\s+/).filter((t) => !t.startsWith("-"));
      if (tokens.length === 0 || tokens[0].startsWith("<")) continue;
      const first = tokens[0];
      const second =
        tokens[1] !== undefined && !tokens[1].startsWith("<")
          ? tokens[1]
          : undefined;
      const form =
        subFirst.has(first) && second !== undefined ? `${first} ${second}` : first;
      if (!members.has(form) && !members.has(first))
        errs.push(`${f.path}: names unknown verb form 'offbook ${form}'`);
      else if (subFirst.has(first) && second === undefined && !members.has(first))
        errs.push(`${f.path}: bare 'offbook ${first}' has no bare form`);
    }
  return errs;
}

// R-042 — SKILL.md frontmatter: discovery depends on it (adoption.md §9).
export function checkSkillFrontmatter(text: string): string[] {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return ["skills/offbook-onboard/SKILL.md: missing frontmatter"];
  const name = m[1].match(/^name:\s*(\S+)\s*$/m)?.[1];
  const desc = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const errs: string[] = [];
  if (name !== "offbook-onboard")
    errs.push(`SKILL.md frontmatter name '${name}' ≠ 'offbook-onboard' (must match the install dir)`);
  if (desc === undefined || desc === "")
    errs.push("SKILL.md frontmatter needs a non-empty description");
  return errs;
}
```

Wire into `main()` (beside the `checkLinks` call): read every `.md` under `skills/offbook-onboard/` into `skillDocs` (path-prefixed `skills/offbook-onboard/…`, skip if the dir is absent), then add to the `errors` array:

```ts
    ...checkSkillLinks(skillDocs),
    ...checkSkillVerbs(skillDocs),
    ...(skillDocs.length > 0
      ? checkSkillFrontmatter(
          skillDocs.find((f) => f.path.endsWith("SKILL.md"))?.text ?? "",
        )
      : []),
```

- [ ] **Step 3: Add failing-then-passing cases to `scripts/check-docs.test.ts`**

Append (match the file's existing import/test style; it already imports from `#scripts/check-docs.ts`):

```ts
// [utest->R-042]
import {
	checkSkillFrontmatter,
	checkSkillLinks,
	checkSkillVerbs,
} from "#scripts/check-docs.ts";

test("checkSkillVerbs: membership semantics (fork e, corrected)", () => {
	const doc = (text: string) => [{ path: "skills/offbook-onboard/SKILL.md", text }];
	expect(checkSkillVerbs(doc("run `offbook doctor` then `offbook specs`"))).toEqual([]);
	expect(checkSkillVerbs(doc("`offbook specs update` refreshes"))).toEqual([]);
	expect(checkSkillVerbs(doc("`offbook mode autonomous` flips it"))).toEqual([]);
	expect(checkSkillVerbs(doc("`offbook publish <topic> --example`"))).toEqual([]);
	expect(checkSkillVerbs(doc("try `offbook skil install`"))).toHaveLength(1);
	expect(checkSkillVerbs(doc("`offbook specs prune` cleans"))).toHaveLength(1);
});

test("checkSkillLinks: intra-skill only", () => {
	const at = (text: string) => [{ path: "skills/offbook-onboard/SKILL.md", text }];
	expect(checkSkillLinks(at("[guide](../../docs/guides/daily-loop.md)"))).toHaveLength(1);
	expect(checkSkillLinks(at("[here](#the-journey)"))).toEqual([]);
	expect(checkSkillLinks(at("[web](https://example.com)"))).toEqual([]);
});

test("checkSkillFrontmatter: name must match the install dir", () => {
	expect(checkSkillFrontmatter("---\nname: offbook-onboard\ndescription: x\n---\nbody")).toEqual([]);
	expect(checkSkillFrontmatter("---\nname: onboard\ndescription: x\n---\n")).toHaveLength(1);
	expect(checkSkillFrontmatter("no frontmatter")).toHaveLength(1);
});
```

Note for the implementer: `checkSkillVerbs`'s two-token guard means `skill` (added to VERB_FORMS in Task 7) makes bare `offbook skill` fail — but until Task 7, `skill` is not in VERB_FORMS, so **the SKILL.md written in Step 1 (which says `offbook skill install --force`) will fail the gate as an unknown form**. That is the gate working; Task 7 adds the form. Until then `bun scripts/check-docs.ts` reports exactly that one error — run it, confirm the error text names `skill install`, and defer the green run to Task 7. Keep this task's commit gated on `bun test` (the unit tests above), not on check-docs.

- [ ] **Step 4: Run + commit**

Run: `bun test scripts/check-docs.test.ts` (0 fails), `bun run lint && bun run typecheck && bun test` (exit 0), `bun scripts/check-docs.ts` — **expected: exactly one error, the known `skill install` form (resolved in Task 7)**.

```bash
git add skills/offbook-onboard/SKILL.md scripts/check-docs.ts scripts/check-docs.test.ts
git commit -m "feat: bundled onboarding skill + check-docs skill gates (R-042)"
```

---

### Task 7: `offbook skill install` — the verb

**Files:**
- Create: `src/cli/skill.ts`
- Modify: `src/cli/index.ts` (VERBS + USAGE), `src/cli/verbs.ts` (add `"skill install"`)
- Test: `src/cli/skill.test.ts`

**Interfaces:**
- Consumes: `repoRoot`, `checkoutCommit`, `checkoutOrigin`, `gitToplevel`, `gitIgnored` (Task 2); `CliError` from `./client.ts`; `Io` from `./index.ts` (import the type only).
- Produces: `cmdSkill(rest: string[], io: Io): Promise<number>`; the `.installed-from` stamp shape `{ version, commit, installedAt, sourcePath, originUrl? }`; `compareSkillTrees(srcDir, destDir): Promise<{ identical: boolean; changed: string[]; added: string[]; removed: string[] }>` (exported — Task 9's doctor check reuses it).

- [ ] **Step 1: Write `src/cli/skill.ts`**

```ts
// R-042 — `offbook skill install` (adoption.md §9): copy the bundled skill
// into the app repo's .claude/skills/offbook-onboard/. No positional — the
// destination is the git toplevel from cwd (fork f: a [dir] positional
// means "project dir" on init/doctor, and `skill install mock/` by analogy
// would install where no session looks); --dest is the explicit escape
// hatch. "Different" = byte-level tree equality, stamp excluded; --force =
// clean-replace (overlay would orphan old files and jam every compare).
import { existsSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CliError } from "./client.ts";
import {
	checkoutCommit,
	checkoutOrigin,
	gitIgnored,
	gitToplevel,
	repoRoot,
} from "./checkout.ts";
import type { Io } from "./index.ts";

const SKILL_NAME = "offbook-onboard";
const STAMP = ".installed-from";

export function bundledSkillDir(): string {
	return join(repoRoot(), "skills", SKILL_NAME);
}

async function listFiles(dir: string): Promise<string[]> {
	return (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir, dot: true })))
		.filter((f) => basename(f) !== STAMP)
		.sort();
}

export async function compareSkillTrees(
	srcDir: string,
	destDir: string,
): Promise<{ identical: boolean; changed: string[]; added: string[]; removed: string[] }> {
	const src = await listFiles(srcDir);
	const dest = await listFiles(destDir);
	const srcSet = new Set(src);
	const destSet = new Set(dest);
	const added = dest.filter((f) => !srcSet.has(f)); // present only in the install
	const removed = src.filter((f) => !destSet.has(f));
	const changed: string[] = [];
	for (const f of src.filter((x) => destSet.has(x))) {
		const [a, b] = await Promise.all([
			Bun.file(join(srcDir, f)).arrayBuffer(),
			Bun.file(join(destDir, f)).arrayBuffer(),
		]);
		if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) changed.push(f);
	}
	return { identical: added.length + removed.length + changed.length === 0, changed, added, removed };
}

async function copySkill(srcDir: string, destDir: string): Promise<void> {
	for (const f of await listFiles(srcDir))
		await Bun.write(join(destDir, f), Bun.file(join(srcDir, f)));
	await Bun.write(
		join(destDir, STAMP),
		`${JSON.stringify(
			{
				version: (
					JSON.parse(await Bun.file(join(repoRoot(), "package.json")).text()) as {
						version?: string;
					}
				).version ?? "0.0.0",
				commit: await checkoutCommit(),
				installedAt: new Date().toISOString(),
				sourcePath: repoRoot(),
				// observed at install time, never authored (adoption.md §9); omitted
				// when the checkout has no remote — the skill's locator wording then
				// falls back to "ask a teammate"
				...(await checkoutOrigin().then((o) => (o === undefined ? {} : { originUrl: o }))),
			},
			null,
			2,
		)}\n`,
	);
}

export async function cmdSkill(rest: string[], io: Io): Promise<number> {
	const [sub, ...flags] = rest;
	if (sub !== "install") {
		io.err(
			"usage: offbook skill install [--dest <dir>] [--force] — install the onboarding skill into this repo's .claude/skills/",
		);
		return 1;
	}
	let dest: string | undefined;
	let force = false;
	for (let i = 0; i < flags.length; i++) {
		if (flags[i] === "--force") force = true;
		else if (flags[i] === "--dest") dest = flags[++i];
		else throw new CliError(`skill install: unknown flag '${flags[i]}'`);
	}
	if (dest === undefined && flags.includes("--dest"))
		throw new CliError("skill install: --dest needs a directory");

	let targetRoot: string;
	if (dest !== undefined) {
		targetRoot = resolve(dest);
		const top = await gitToplevel(targetRoot);
		if (top !== undefined && resolve(top) !== targetRoot)
			io.err(
				"⚠ --dest is below the repo toplevel — a Claude Code session at the repo root won't discover a skill installed here",
			);
		if (top === undefined)
			io.err(
				"⚠ --dest is not inside a git repo — the skill cannot propagate to teammates from here",
			);
	} else {
		const top = await gitToplevel(process.cwd());
		if (top === undefined)
			throw new CliError(
				"skill install: not inside a git repository — cd into your app repo (or pass --dest <dir>)",
			);
		targetRoot = top;
	}

	const destDir = join(targetRoot, ".claude", "skills", SKILL_NAME);
	const srcDir = bundledSkillDir();
	if (!existsSync(srcDir))
		throw new CliError(`skill install: bundled skill missing at ${srcDir} — the offbook checkout looks incomplete`);

	if (existsSync(destDir)) {
		const diff = await compareSkillTrees(srcDir, destDir);
		if (diff.identical) {
			io.out(`offbook skill install: already up to date (${destDir})`);
			return 0;
		}
		if (!force) {
			io.err(`offbook skill install: ${destDir} differs from the bundled skill:`);
			for (const f of diff.changed) io.err(`  changed: ${f}`);
			for (const f of diff.added) io.err(`  only in install: ${f}`);
			for (const f of diff.removed) io.err(`  missing from install: ${f}`);
			io.err("local edits are drift — upstream them, or `--force` to clean-replace");
			return 1;
		}
		rmSync(destDir, { recursive: true, force: true }); // clean-replace, never overlay
	}
	await copySkill(srcDir, destDir);
	if (await gitIgnored(destDir, targetRoot))
		io.err(
			"⚠ .claude/ is gitignored here — the skill won't propagate; un-ignore it or teammates never see it",
		);
	io.out(`offbook skill install: installed to ${destDir} — commit it so teammates get the skill`);
	return 0;
}
```

- [ ] **Step 2: Wire the verb + forms + USAGE**

In `src/cli/index.ts`: add `skill: cmdSkill,` to the `VERBS` table (import `cmdSkill` from `./skill.ts`). Add the USAGE line after the `doctor` line (keep the two-space indent):

```
  skill install [--dest <dir>] [--force]  install the onboarding skill into this repo's .claude/skills/
```

In `src/cli/verbs.ts`: add `"skill install"` to `VERB_FORMS` (no bare `"skill"` — deliberate: bare invocation is a usage error).

- [ ] **Step 3: Write the failing tests `src/cli/skill.test.ts`**

```ts
// R-042 — skill install semantics (adoption.md §9, forks c/f): fresh copy
// (stamp written), identical no-op, present-different refusal (exit 1,
// divergence listed), --force clean-replace, stamp excluded from compare,
// bare/unknown subcommand usage, toplevel resolution, outside-a-repo
// error, --dest override + warnings.
// [utest->R-042]
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "./index.ts";
import { run } from "./index.ts";
import { bundledSkillDir, compareSkillTrees } from "./skill.ts";

function io(): { out: string[]; err: string[]; io: Io } {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

async function sh(cwd: string, ...args: string[]): Promise<void> {
	const p = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "ignore" });
	if ((await p.exited) !== 0) throw new Error(`failed: ${args.join(" ")}`);
}

async function tempAppRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "offbook-skill-"));
	await sh(dir, "git", "init", "-q", "-b", "main");
	return dir;
}

const DEST = (repo: string) => join(repo, ".claude", "skills", "offbook-onboard");

test("bare `offbook skill` and unknown subcommands are usage errors (exit 1)", async () => {
	const a = io();
	expect(await run(["skill"], a.io)).toBe(1);
	expect(a.err[0]).toContain("usage: offbook skill install");
	expect(await run(["skill", "uninstall"], io().io)).toBe(1);
});

test("fresh install into --dest: copies SKILL.md, writes the stamp", async () => {
	const repo = await tempAppRepo();
	const a = io();
	expect(await run(["skill", "install", "--dest", repo], a.io)).toBe(0);
	expect(existsSync(join(DEST(repo), "SKILL.md"))).toBe(true);
	const stamp = JSON.parse(await Bun.file(join(DEST(repo), ".installed-from")).text());
	expect(typeof stamp.commit).toBe("string");
	expect(typeof stamp.sourcePath).toBe("string");
	expect(typeof stamp.installedAt).toBe("string");
});

test("identical re-install is a no-op; stamp is excluded from the compare", async () => {
	const repo = await tempAppRepo();
	expect(await run(["skill", "install", "--dest", repo], io().io)).toBe(0);
	const again = io();
	expect(await run(["skill", "install", "--dest", repo], again.io)).toBe(0);
	expect(again.out[0]).toContain("already up to date");
	expect((await compareSkillTrees(bundledSkillDir(), DEST(repo))).identical).toBe(true);
});

test("present-different refuses with the divergence (exit 1); --force clean-replaces", async () => {
	const repo = await tempAppRepo();
	expect(await run(["skill", "install", "--dest", repo], io().io)).toBe(0);
	writeFileSync(join(DEST(repo), "SKILL.md"), "edited\n");
	writeFileSync(join(DEST(repo), "orphan.md"), "old\n");
	const refused = io();
	expect(await run(["skill", "install", "--dest", repo], refused.io)).toBe(1);
	expect(refused.err.join("\n")).toContain("changed: SKILL.md");
	expect(refused.err.join("\n")).toContain("only in install: orphan.md");
	expect(await run(["skill", "install", "--dest", repo, "--force"], io().io)).toBe(0);
	expect(existsSync(join(DEST(repo), "orphan.md"))).toBe(false); // clean-replace, not overlay
});

test("no positional: outside a git repo errors with a next step; --dest below toplevel and gitignored targets warn", async () => {
	const noRepo = mkdtempSync(join(tmpdir(), "offbook-norepo-"));
	const prev = process.cwd();
	try {
		process.chdir(noRepo);
		const a = io();
		expect(await run(["skill", "install"], a.io)).toBe(1);
		expect(a.err.join("\n")).toContain("not inside a git repository");
	} finally {
		process.chdir(prev);
	}
	const repo = await tempAppRepo();
	const sub = join(repo, "mock");
	mkdirSync(sub, { recursive: true });
	const below = io();
	expect(await run(["skill", "install", "--dest", sub], below.io)).toBe(0);
	expect(below.err.join("\n")).toContain("below the repo toplevel");
	const ignored = await tempAppRepo();
	writeFileSync(join(ignored, ".gitignore"), ".claude/\n");
	const warned = io();
	expect(await run(["skill", "install", "--dest", ignored], warned.io)).toBe(0);
	expect(warned.err.join("\n")).toContain("won't propagate");
});
```

- [ ] **Step 4: Run red → green, then the doc gate goes green too**

Run: `bun test src/cli/skill.test.ts` — FAIL before Step 1, PASS after (0 fails). Run `bun scripts/check-docs.ts` — **now exits 0**: Task 6's known `skill install` error is resolved by the VERB_FORMS addition. Run `bun test test/verb-forms.test.ts` — the coherence test forces the USAGE line and VERB_FORMS to agree (it fails if Step 2 missed either half).

- [ ] **Step 5: Full gates + commit**

Run: `bun run lint && bun run typecheck && bun test && bun scripts/check-docs.ts` — all exit 0.

```bash
git add src/cli/skill.ts src/cli/skill.test.ts src/cli/index.ts src/cli/verbs.ts
git commit -m "feat: offbook skill install — toplevel dest, clean-replace, provenance stamp (R-042)"
```

---

### Task 8: Doctor check 8 — installed-skill staleness

**Files:**
- Modify: `src/cli/doctor.ts` (new check appended to `DOCTOR_CHECKS`)
- Test: `src/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `compareSkillTrees`, `bundledSkillDir` from `./skill.ts` (Task 7); `gitToplevel` from `./checkout.ts` (Task 2).
- Produces: check name `"skill"`, appended after `runfile` — pass/warn only, never fail (doctor's exit-0-iff-no-fail rule is untouched).

- [ ] **Step 1: Append the check to `src/cli/doctor.ts`**

```ts
// R-042 — check 8 (adoption.md §3): the installed skill copy vs the running
// tool's bundled skill. Warn-never-fail: a stale skill doesn't break the
// tool. Resolved from the EXAMINED dir's toplevel; the hint names the path
// because `skill install --force` resolves from CWD, which can differ when
// `doctor <elsewhere>` examines another repo.
const skillCheck: DoctorCheck = {
	name: "skill",
	async run(ctx) {
		const top = await gitToplevel(ctx.projectDir);
		if (top === undefined)
			return { status: "pass", detail: "not in a git repo (no skill to check)" };
		const installed = join(top, ".claude", "skills", "offbook-onboard");
		if (!existsSync(installed))
			return {
				status: "pass",
				detail: "onboarding skill not installed (optional — `offbook skill install` adds it)",
			};
		const diff = await compareSkillTrees(bundledSkillDir(), installed);
		return diff.identical
			? { status: "pass", detail: `installed skill matches the bundled one (${installed})` }
			: {
					status: "warn",
					detail: `installed skill at ${installed} differs from the bundled one (${[...diff.changed, ...diff.added, ...diff.removed].length} file(s))`,
					hint: "stale/edited skill — `offbook skill install --force` refreshes it",
				};
	},
};
```

Add imports: `import { gitToplevel } from "./checkout.ts";` and `import { bundledSkillDir, compareSkillTrees } from "./skill.ts";`. Append `skillCheck` to `DOCTOR_CHECKS` (after `runfileCheck`, `src/cli/doctor.ts:357-365`).

- [ ] **Step 2: Add the failing tests to `src/cli/doctor.test.ts`**

Append (the file already has temp-dir helpers and a `ctx` builder — follow its local style; `// [utest->R-042]` above the block):

```ts
// [utest->R-042]
test("doctor skill check: non-repo pass, absent pass, identical pass, edited warn", async () => {
	const noRepo = mkdtempSync(join(tmpdir(), "doctor-skill-"));
	const r1 = await runDoctor({ ...baseCtx, projectDir: noRepo }, [skillOnly]);
	expect(r1.checks[0]).toMatchObject({ status: "pass" });

	const repo = mkdtempSync(join(tmpdir(), "doctor-skill-repo-"));
	await git(repo, "init", "-q", "-b", "main");
	const r2 = await runDoctor({ ...baseCtx, projectDir: repo }, [skillOnly]);
	expect(r2.checks[0].detail).toContain("not installed");

	const iox: Io = { out: () => {}, err: () => {} };
	expect(await run(["skill", "install", "--dest", repo], iox)).toBe(0);
	const r3 = await runDoctor({ ...baseCtx, projectDir: repo }, [skillOnly]);
	expect(r3.checks[0]).toMatchObject({ status: "pass" });

	writeFileSync(join(repo, ".claude/skills/offbook-onboard/SKILL.md"), "edited\n");
	const r4 = await runDoctor({ ...baseCtx, projectDir: repo }, [skillOnly]);
	expect(r4.checks[0].status).toBe("warn");
	expect(r4.checks[0].hint).toContain("offbook skill install --force");
	expect(r4.ok).toBe(true); // warn never fails doctor
});
```

Implementer notes: `skillOnly` = the check object — export `DOCTOR_CHECKS` is already exported; grab it via `DOCTOR_CHECKS.find((c) => c.name === "skill")!` (name it `skillOnly` locally, pass `[skillOnly]` to `runDoctor` exactly as the existing per-check tests do). Reuse the file's existing `git()` helper and ctx construction — read the top of `src/cli/doctor.test.ts` and mirror it; the snippet's `baseCtx` stands for the file's existing ctx fixture.

- [ ] **Step 3: Run red → green**

Run: `bun test src/cli/doctor.test.ts` — FAIL (check absent) → Step 1 → PASS (0 fails).

- [ ] **Step 4: Full gates + commit**

Run: `bun run lint && bun run typecheck && bun test && bun scripts/check-docs.ts` — all exit 0.

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts
git commit -m "feat: doctor check 8 — installed-skill staleness, warn-never-fail (R-042)"
```

---

### Task 9: Boot line in the server log

**Files:**
- Modify: `src/cli/serve.ts` (log a boot line every startup)
- Test: assertion added to the `up → status → down` cycle in `test/cli-dispatch.test.ts` (suite B) and to `test/demo-serve.test.ts`

**Interfaces:**
- Produces: the boot-line format Tasks 10 and 11 parse — a log line whose message part is `boot: services.yaml sha256:<64-hex>` (project boot) or `boot: bundled demo spec` (demo boot), emitted through the existing `log()` (so the full line is `[offbook] <iso> boot: …`). Every startup logs it, including `--watch` respawns (the respawn re-executes serve.ts).

- [ ] **Step 1: Add the boot line to `src/cli/serve.ts`**

Add `import { createHash } from "node:crypto";` to the imports. After `await composed.start();` (line 52) and before the `ports` const, insert:

```ts
	// R-043 — the boot line (adoption.md §10): every startup logs what it
	// loaded. Double duty: `status` scopes connect counts to lines after the
	// LAST boot line; `specs update` compares this hash against the current
	// services.yaml to warn on silent staleness.
	if (boot.demo === true) log("boot: bundled demo spec");
	else
		log(
			`boot: services.yaml sha256:${createHash("sha256")
				.update(await Bun.file(join(boot.projectDir, "services.yaml")).text())
				.digest("hex")}`,
		);
```

- [ ] **Step 2: Pin it in the process-cycle tests**

In `test/cli-dispatch.test.ts` suite B (the `up → status → … → down` test around line 1142 that runs `init` + `up` against the project fixture), after `up` succeeds, add (tag the block `// [itest->R-043]`):

```ts
	const logText = await Bun.file(join(projectDir, ".offbook", "offbook.log")).text();
	expect(logText).toMatch(/\] boot: services\.yaml sha256:[0-9a-f]{64}$/m);
```

(Adjust the log path to the fixture's actual `--run-dir` if the test passes one — read the surrounding test body first.) In `test/demo-serve.test.ts`, add the matching assertion after its server is up: `expect(logText).toContain("] boot: bundled demo spec")`.

- [ ] **Step 3: Run red → green**

Run: `bun test` (full — suite B needs the whole file's fixtures). Expected: the two new assertions FAIL before Step 1, PASS after; zero other fails.

- [ ] **Step 4: Commit**

```bash
git add src/cli/serve.ts test/cli-dispatch.test.ts test/demo-serve.test.ts
git commit -m "feat: boot line in the server log — run boundary + services.yaml hash (R-043)"
```

---

### Task 10: `offbook status` clients line

**Files:**
- Modify: `src/cli/index.ts` (`cmdStatus`, line 1122; new exported helper `clientsFromLog`)
- Test: `test/verb-forms.test.ts` is the wrong home — put the pure-helper tests in a new block in `test/cli-dispatch.test.ts` beside the other CLI unit blocks, tagged `// [itest->R-043]`.

**Interfaces:**
- Consumes: the boot-line format (Task 9); the fingerprint-line format `[offbook] <iso> ws-connect {"clientId":…}` / `tcp-connect …` (existing, `src/broker/index.ts:43-54`, emitted via `src/compose/index.ts:106`).
- Produces: `clientsFromLog(logText: string): { connects: number; last?: { clientId: string; at: string } }` exported from `src/cli/index.ts`; a `clients` key in `status --json`; a human `clients:` line.

- [ ] **Step 1: Add the helper to `src/cli/index.ts`** (near `specAge`, line 121)

```ts
// R-043 — connects observed THIS RUN (adoption.md §10): the log appends
// across runs, so "this run" = fingerprint lines after the LAST boot line
// (under --watch each respawn writes a new boot line — the count restarts
// per respawn, which is the acceptance-test semantics). Connects observed,
// never a live count: that is what the log truthfully knows.
export function clientsFromLog(logText: string): {
	connects: number;
	last?: { clientId: string; at: string };
} {
	const lines = logText.split("\n");
	let start = 0;
	for (let i = lines.length - 1; i >= 0; i--)
		if (/^\[offbook\] \S+ boot: /.test(lines[i])) {
			start = i + 1;
			break;
		}
	let connects = 0;
	let last: { clientId: string; at: string } | undefined;
	for (const line of lines.slice(start)) {
		const m = line.match(/^\[offbook\] (\S+) (?:ws|tcp)-connect (\{.*\})$/);
		if (!m) continue;
		try {
			const fields = JSON.parse(m[2]) as { clientId?: unknown };
			if (typeof fields.clientId !== "string") continue;
			connects++;
			last = { clientId: fields.clientId, at: m[1] };
		} catch {
			// malformed fingerprint line: skip, never crash status (R-043)
		}
	}
	return { connects, last };
}
```

- [ ] **Step 2: Wire it into `cmdStatus`**

In `cmdStatus` (line 1122), after resolving `run`, read the log once:

```ts
	const clients = clientsFromLog(
		await Bun.file(logPath(runDir))
			.text()
			.catch(() => ""),
	);
```

Add `clients` to the `--json` object (line 1149-1161, beside `validation`). In the human output, after the "point your MQTT client at" line (line 1170-1172), add:

```ts
	io.out(
		clients.connects === 0
			? `  clients: no connects observed this run — is your app pointed at ws://localhost:${run.brokerWsPort}?`
			: `  clients: ${clients.connects} connect(s) this run · last ${clients.last?.clientId} at ${clients.last?.at}`,
	);
```

- [ ] **Step 3: Write the failing tests** (in `test/cli-dispatch.test.ts`, a standalone block — pure function, no server needed)

```ts
// [itest->R-043]
test("clientsFromLog: counts only post-last-boot-line connects, skips malformed", () => {
	const iso = "2026-08-08T10:00:00.000Z";
	const lines = [
		`[offbook] ${iso} boot: services.yaml sha256:${"a".repeat(64)}`,
		`[offbook] ${iso} ws-connect {"clientId":"stale-run"}`,
		`[offbook] ${iso} boot: services.yaml sha256:${"b".repeat(64)}`,
		`[offbook] ${iso} ws-connect {"clientId":"web-1","protocolLevel":4}`,
		`[offbook] ${iso} ws-connect not-json`,
		`[offbook] ${iso} mqtt-subscribe {"clientId":"web-1","topic":"state/x"}`,
		`[offbook] ${iso} tcp-connect {"clientId":"cli-2"}`,
	].join("\n");
	const r = clientsFromLog(lines);
	expect(r.connects).toBe(2); // stale-run excluded (before the last boot line)
	expect(r.last).toEqual({ clientId: "cli-2", at: iso });
	expect(clientsFromLog("")).toEqual({ connects: 0 });
});
```

Also extend suite B's status assertion: after the existing `status` invocation in the cycle test, assert the human output contains `clients:` (zero-connects form — nothing connects in that fixture).

- [ ] **Step 4: Run red → green, full gates, commit**

Run: `bun test` — new assertions FAIL → implement → PASS, zero other fails. `bun run lint && bun run typecheck`.

```bash
git add src/cli/index.ts test/cli-dispatch.test.ts
git commit -m "feat: status clients line — connects observed this run, boot-line scoped (R-043)"
```

---

### Task 11: `specs update` staleness warning

**Files:**
- Modify: `src/cli/index.ts` (`cmdSpecs`, line 608)
- Test: `test/cli-dispatch.test.ts` (suite B cycle + a pure-helper block)

**Interfaces:**
- Consumes: the boot-line hash (Task 9); the boot file `<runDir>/offbook.boot.json` (`{ projectDir, demo? }` — written by `launchDetached`, `src/cli/index.ts:914-915`).
- Produces: `specsStalenessWarning(runDir: string): Promise<string | undefined>` exported from `src/cli/index.ts` (exported for the pure test); the warn line on `offbook specs update`.

- [ ] **Step 1: Add the helper** (near `cmdSpecs`)

```ts
// R-043 — services.yaml edited after `up` (adoption.md §10): compare the
// current file's hash against the LAST boot line. Skips silently (no warn
// possible, none owed) when: no run dir was involved (bare --ctrl-port),
// the last boot was the bundled demo, or no boot line exists (pre-R-043
// log). Today the edit silently never applies while "specs refreshed"
// prints success.
export async function specsStalenessWarning(
	runDir: string,
): Promise<string | undefined> {
	const bootFile = Bun.file(join(runDir, "offbook.boot.json"));
	if (!(await bootFile.exists())) return undefined;
	let projectDir: string;
	try {
		const boot = JSON.parse(await bootFile.text()) as {
			projectDir?: string;
			demo?: boolean;
		};
		if (boot.demo === true || boot.projectDir === undefined) return undefined;
		projectDir = boot.projectDir;
	} catch {
		return undefined;
	}
	const logText = await Bun.file(logPath(runDir))
		.text()
		.catch(() => "");
	let bootHash: string | undefined;
	for (const line of logText.split("\n").reverse()) {
		const m = line.match(/^\[offbook\] \S+ boot: (.*)$/);
		if (!m) continue;
		bootHash = m[1].match(/^services\.yaml sha256:([0-9a-f]{64})$/)?.[1];
		break; // last boot line wins, whatever it recorded
	}
	if (bootHash === undefined) return undefined;
	const current = createHash("sha256")
		.update(
			await Bun.file(join(projectDir, "services.yaml"))
				.text()
				.catch(() => ""),
		)
		.digest("hex");
	return current === bootHash
		? undefined
		: "⚠ services.yaml changed since `offbook up` — restart to apply";
}
```

Add `import { createHash } from "node:crypto";` to `src/cli/index.ts`'s imports.

- [ ] **Step 2: Wire into `cmdSpecs`'s update branch**

In the `update` branch (after `renderSpecs(io, specs)` at line 624), add:

```ts
		if (str(values["ctrl-port"]) === undefined) {
			const warn = await specsStalenessWarning(runDirOf(values));
			if (warn !== undefined) io.out(warn);
		}
```

- [ ] **Step 3: Failing tests** (pure-helper block in `test/cli-dispatch.test.ts`, tagged `// [itest->R-043]`)

```ts
test("specsStalenessWarning: warns on hash mismatch, skips demo/absent/ctrl-only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "staleness-"));
	const iso = "2026-08-08T10:00:00.000Z";
	// no boot file → skip
	expect(await specsStalenessWarning(dir)).toBeUndefined();
	// demo boot → skip
	writeFileSync(join(dir, "offbook.boot.json"), JSON.stringify({ projectDir: dir, demo: true }));
	writeFileSync(join(dir, "offbook.log"), `[offbook] ${iso} boot: bundled demo spec\n`);
	expect(await specsStalenessWarning(dir)).toBeUndefined();
	// project boot, matching hash → no warn
	const services = "services: {}\n";
	writeFileSync(join(dir, "services.yaml"), services);
	writeFileSync(join(dir, "offbook.boot.json"), JSON.stringify({ projectDir: dir }));
	const hash = createHash("sha256").update(services).digest("hex");
	writeFileSync(join(dir, "offbook.log"), `[offbook] ${iso} boot: services.yaml sha256:${hash}\n`);
	expect(await specsStalenessWarning(dir)).toBeUndefined();
	// edited file → warn
	writeFileSync(join(dir, "services.yaml"), "services: {}\n# edited\n");
	expect(await specsStalenessWarning(dir)).toContain("restart to apply");
});
```

(`createHash` import already exists in the test file or add `import { createHash } from "node:crypto";`.) In suite B's cycle: after `up`, edit the fixture's `services.yaml` (append a comment), run `specs update` via `run(["specs", "update", ...CTRL_FLAG])` — **note**: with `--ctrl-port` it must NOT warn (skip case); run it again without `--ctrl-port` but with the fixture's `--run-dir` and assert the warn line appears in `out`.

- [ ] **Step 4: Run red → green, full gates, commit**

Run: `bun test` (0 fails), `bun run lint && bun run typecheck`.

```bash
git add src/cli/index.ts test/cli-dispatch.test.ts
git commit -m "feat: specs update warns when services.yaml changed since up (R-043)"
```

---

### Task 12: `topics --json` refuses without a live server

**Files:**
- Modify: `src/cli/index.ts` (`cmdTopics`, the fallback branch at line 289-295)
- Test: `test/cli-dispatch.test.ts`

**Interfaces:**
- Consumes: `CliError` (exit 1 via the dispatcher). **The M0 `renderTopics` helper (line 253) is pinned by `src/cli/index.test.ts` and stays untouched — the refusal lives in the verb.** The human-path fallback and its printed note stay exactly as they are.

- [ ] **Step 1: Add the refusal**

In `cmdTopics`'s no-server fallback branch (the `else` at line 289), before assigning the demo topics:

```ts
			if (values.json === true)
				throw new CliError(
					"no running offbook in this run-dir — run `offbook up` here, or pass --ctrl-port; the bundled-demo fallback is human-only",
				);
```

- [ ] **Step 2: Failing test** (in `test/cli-dispatch.test.ts`, tagged `// [itest->R-043]` — use a fresh temp `--run-dir` so no runfile resolves)

```ts
test("topics --json with no live server refuses (exit 1, run-dir-qualified); human fallback stays", async () => {
	const empty = mkdtempSync(join(tmpdir(), "no-server-"));
	const refused = io();
	expect(await run(["topics", "--json", "--run-dir", empty], refused.io)).toBe(1);
	expect(refused.err.join("\n")).toContain("bundled-demo fallback is human-only");
	const human = io();
	expect(await run(["topics", "--run-dir", empty], human.io)).toBe(0);
	expect(human.out[0]).toContain("showing the bundled demo spec"); // pinned note survives
});
```

- [ ] **Step 3: Run red → green, full gates, commit**

Run: `bun test` — the new test FAILs (json path returns 0 with demo topics) → Step 1 → PASS; confirm `src/cli/index.test.ts`'s `renderTopics` pin still passes. `bun run lint && bun run typecheck`.

```bash
git add src/cli/index.ts test/cli-dispatch.test.ts
git commit -m "feat: topics --json refuses without a live server — demo fallback is human-only (R-043)"
```

---

### Task 13: Port-conflict attribution (up preflight + doctor ports)

**Files:**
- Modify: `src/cli/index.ts` (`preflightPort`/`launchDetached`, lines 866-912), `src/cli/doctor.ts` (`ports` check, lines 309-339)
- Test: `test/cli-dispatch.test.ts`, `src/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `probeOffbook` (existing, `src/cli/runfile.ts:56`).
- Produces: preflight that evaluates **all three ports before composing the error** and probes ctrl whenever it is among the busy set (today's first-busy-throws structure would never reach the probe in the all-three-busy demo scenario — the motivating case).

- [ ] **Step 1: Rework the preflight in `src/cli/index.ts`**

Replace `preflightPort` (lines 866-879) and the three call sites (910-912) with:

```ts
function portListenable(port: number): boolean {
	try {
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port,
			socket: { data() {} },
		});
		listener.stop(true);
		return true;
	} catch {
		return false;
	}
}

// R-043 — evaluate ALL THREE ports before composing the error, and probe a
// busy ctrl port: "another broker/server?" was a misattribution when the
// owner is offbook's own demo from another directory (adoption.md §10).
async function preflightPorts(config: Config): Promise<void> {
	const candidates = [
		{ label: "ws", port: config.brokerWsPort, flag: "--ws-port" },
		{ label: "tcp", port: config.brokerTcpPort, flag: "--tcp-port" },
		{ label: "ctrl", port: config.controlPlanePort, flag: "--ctrl-port" },
	];
	const busy = candidates.filter((c) => !portListenable(c.port));
	if (busy.length === 0) return;
	if (
		busy.some((b) => b.label === "ctrl") &&
		(await probeOffbook(config.controlPlanePort))
	)
		throw new CliError(
			"an offbook from another directory owns these ports (likely the demo) — run `offbook down` there, or pass --ws-port/--ctrl-port",
		);
	throw new CliError(
		`port(s) in use: ${busy.map((b) => `${b.label} ${b.port}`).join(", ")} — another broker/server? set ${busy.map((b) => b.flag).join("/")} (P7); \`offbook doctor\` checks all three ports`,
	);
}
```

Call site (was lines 910-912): `await preflightPorts(config);`. Run the full `bun test` — **any test pinning the old `port ${port} in use` message will fail; update those pins to the new composed message.**

- [ ] **Step 2: Attribution in doctor's `ports` check**

In `src/cli/doctor.ts`'s `ports` check, after the `busy` list is built (line 327) and before the return, add:

```ts
		if (
			busy.some((b) => b.startsWith("ctrl")) &&
			(await probeOffbook(ctx.ports.ctrl))
		)
			return {
				status: "fail",
				detail: `an offbook from another directory owns these ports (ctrl ${ctx.ports.ctrl} answers as offbook — likely the demo)`,
				hint: "run `offbook down` in that directory, or pass --ws-port/--ctrl-port to `offbook up`",
			};
```

Add `probeOffbook` to the `./runfile.ts` import (line 10).

- [ ] **Step 3: Failing tests**

`test/cli-dispatch.test.ts` (tagged `// [itest->R-043]`) — the suite's in-process composed server (ports 19001/12901/19801) IS a live offbook, so `up` against those exact ports must now attribute (all three busy, ctrl answers):

```ts
test("up against ports owned by another offbook attributes it instead of 'another broker?'", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "attr-"));
	const a = io();
	expect(
		await run(
			["up", "--run-dir", scratch, "--ws-port", String(WS), "--tcp-port", String(TCP), "--ctrl-port", String(CTRL)],
			a.io,
		),
	).toBe(1);
	expect(a.err.join("\n")).toContain("an offbook from another directory owns these ports");
});
```

`src/cli/doctor.test.ts` (tagged `// [itest->R-043]`): mirror the existing busy-port test but point `ctx.ports.ctrl` at the file's live composed server's ctrl port → expect the attribution detail; keep a non-offbook listener case (a bare `Bun.listen` on the ctrl port) → expect the generic `port(s) busy` detail (existing test, should still pass).

- [ ] **Step 4: Run red → green, full gates, commit**

Run: `bun test` (0 fails — including the updated message pins), `bun run lint && bun run typecheck`.

```bash
git add src/cli/index.ts src/cli/doctor.ts test/cli-dispatch.test.ts src/cli/doctor.test.ts
git commit -m "feat: port-conflict attribution — probe ctrl, name the other offbook (R-043)"
```

---

### Task 14: Skill journey cross-check + guides link pass

**Files:**
- Verify: `skills/offbook-onboard/SKILL.md` against the shipped behavior; `docs/guides/daily-loop.md` untouched (its CI recipe is out of scope — review-round runners-up, unallocated).

- [ ] **Step 1: Dry-run the skill's verb references against the built CLI**

Run: `bun scripts/check-docs.ts` — exit 0 (verb gate green). Manually walk SKILL.md's journey against the real verbs: `offbook doctor mock/` (positional works), `offbook topics --json` refusal wording matches Task 12's message, `offbook skill install --force` matches Task 7, the ports-refusal wording matches Task 13. Fix any drift in SKILL.md (the skill is wrong by definition — authority chain).

- [ ] **Step 2: Commit if anything moved**

```bash
git add skills/offbook-onboard/SKILL.md
git commit -m "docs: align the skill's wording with shipped verb behavior (R-042)"
```

---

### Task 15: Registry flips + status sweep + full gate run

**Files:**
- Modify: `REQUIREMENTS.md` (R-041/R-042/R-043 → `tested` with IMPL/TEST traces), `AGENTS.md` (Status & next; doc-map line drops "not yet in the tree"), `README.md` (verb overview *maintain* row gains `skill` — adoption.md §2 is its spec)

- [ ] **Step 1: Flip the three registry entries**

For each of R-041/R-042/R-043 in `REQUIREMENTS.md`: `**STATUS**: specified` → `tested`, and add the trace lines between STATUS and COVERS:

```
R-041 —
**IMPL**: src/cli/index.ts, src/cli/checkout.ts, docs/guides/wiring-your-service.md
**TEST**: test/init-templates.test.ts, test/cli-dispatch.test.ts

R-042 —
**IMPL**: skills/offbook-onboard/, src/cli/skill.ts, src/cli/verbs.ts, src/cli/checkout.ts, src/cli/index.ts, src/cli/doctor.ts, scripts/check-docs.ts
**TEST**: src/cli/skill.test.ts, src/cli/checkout.test.ts, test/verb-forms.test.ts, scripts/check-docs.test.ts, src/cli/doctor.test.ts

R-043 —
**IMPL**: src/cli/serve.ts, src/cli/index.ts, src/cli/doctor.ts, docs/guides/wiring-your-service.md
**TEST**: test/cli-dispatch.test.ts, src/cli/doctor.test.ts, test/demo-serve.test.ts
```

`check-docs` verifies every TEST file carries the matching arrow tag — the per-task tags above satisfy it; if it reports a missing/dangling tag, fix the tag, not the trace.

- [ ] **Step 2: Sweep AGENTS.md and README**

- `AGENTS.md` doc map: drop the "(R-042, `specified` — not yet in the tree)" qualifier → "(R-042)".
- `AGENTS.md` Status & next: "The embedding-onboarding design is `specified`" → "The embedding-onboarding surface is `tested`" (keep the rest of the sentence).
- `README.md` Commands/verb table: the *maintain* row gains `skill` (matching adoption.md §2).

- [ ] **Step 3: The full gate set, in CI order**

Run: `bun scripts/check-docs.ts && bun run lint && bun run typecheck && bun run demo-app:build && bun test` — **every one judged by exit code 0.**

- [ ] **Step 4: Final commit**

```bash
git add REQUIREMENTS.md AGENTS.md README.md
git commit -m "docs: flip R-041–R-043 to tested with traces; sweep AGENTS/README (D-028)"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §8 → Tasks 3/4/5; §9 → Tasks 6/7/8/14 (+ `--version` Task 2, VERB_FORMS Task 1); §10 → Tasks 9/10/11/12/13; lifecycle bookkeeping → Task 15. The §9 "installable before any offbook project exists" claim needs no task (it is a property of Task 7's design). Runners-up from the review round (CI recipe, offline up, `.gitignore` append, specs.lock guide sentence) are deliberately NOT in this plan — unallocated by D-028.
- **Ordering constraint:** Task 6 leaves `check-docs` intentionally red on exactly one known error (the skill names `skill install` before the form exists); Task 7 resolves it. Do not reorder 6 after 7 — the SKILL.md content is what Task 7's install tests copy.
- **Type consistency:** `compareSkillTrees` return shape is consumed by Task 8 verbatim; `clientsFromLog`/`specsStalenessWarning` are exported from `src/cli/index.ts` for their pure tests; `VERB_FORMS`/`SUBCOMMAND_FIRST_TOKENS` names match between Tasks 1/6/7.
