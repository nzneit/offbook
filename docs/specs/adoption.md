# Adoption surface — README, guides, `doctor`, first-run gates <!-- anchor: adoption -->

**Status**: design for `R-034`–`R-036` (see `REQUIREMENTS.md`); decisions folded into `D-016`. This doc is canonical for the adopter-facing document set, the `offbook doctor` verb, and the first-run error/doc-rot gates. The frozen contracts are untouched: no `/v1` endpoint is added, `Diagnostic.kind` stays a closed union, and §4/§5 interfaces are byte-identical — `doctor` is a CLI-local verb (the D-014/D-015 precedent). **§8–§10 (added 2026-08-07/08)** extend this surface with the embedding-onboarding design for `R-041`–`R-043` (D-028), under the same stance: `offbook skill install`, `offbook --version`, and the §10 hardening are CLI-local; the one deliberate contract touch is the §6 gitHost-scaffold sentence (the EI1 amendment).

**Audience framing (fixed during design):** layered. The immediate audience is the adopter's own team, cloning from internal git inside the air gap (Bun is installable there, npm dependencies resolve, and spec repos clone from the internal host — verified constraints, not hopes). The org-wide layer is deliberately deferred; every deferral leaves a prepared hinge (§5). n=1 discipline holds: nothing here is built for hypothetical adopters.

## 1. Goal & success criteria

A teammate goes from `git clone` to a moving demo in five minutes, from demo to their real service mocked with one guide open, and when anything fails the tool (not the maintainer) names the next step.

1. **Clone → demo unaided.** `git clone` → `bun install` → `bun link` → `offbook demo --serve` → `bun run demo-app` → browser, following only the README, no questions asked.
2. **One guide to wire a real service.** The wiring guide's steps match what the tool actually prints, end to end.
3. **Errors carry next steps.** Every error reachable on the first-run path names what failed *and* one concrete next action (the existing `no log at … — has \`offbook up\` run here?` pattern, applied uniformly).
4. **Docs cannot rot silently.** The README quickstart and the cookbook recipes are exercised by tests; internal doc links are checked by the doc-system gate.

## 2. The adopter document set <!-- anchor: adopter-docs -->

### `README.md` (new, the front door)

Deliberately short; depth lives in the guides. Sections, in order:

1. **Pitch** — one paragraph: offbook mocks your MQTT-over-WebSockets backend from its AsyncAPI specs, so contract breaks and async bugs surface at dev time, not deploy time.
2. **Mental model** — a small diagram: your app connects to offbook's broker exactly as it would to the real backend (`ws://localhost:9001`); specs go in (`services.yaml` → internal git); mock emissions and contract violations come out (`offbook validation`, demo app, control plane on `:9080`).
3. **Prerequisites** — Bun ≥ the `engines.bun` floor (§3), git access to the internal host. Nothing else.
4. **Quickstart** — demo-first, zero config. The exact command sequence (fenced blocks tagged for the §4 gate):

   ```sh
   git clone <internal-git>/offbook && cd offbook
   bun install
   bun link        # puts `offbook` on your PATH (once)
   ```

   ```sh quickstart
   offbook demo --serve
   bun run demo-app
   ```

   …then open `http://localhost:9090`, click around, click **Break the schema**, watch the violation land. Teardown: Ctrl-C the demo-app, `offbook down`. `<internal-git>` stays a literal reader-substituted placeholder in the README (the host varies by deployment; do not invent one). The clone/install block is untagged (the gate runs inside the repo); only the post-install blocks carry the `quickstart` tag and are executed by the gate.
5. **Your own service** — three lines: `offbook init`, edit `services.yaml`, `offbook up`; pointer to `docs/guides/wiring-your-service.md`.
6. **Verb overview** — the CLI verbs grouped by lifecycle: *run* (`up`, `down`, `status`, `logs`, `demo`), *observe* (`topics`, `state`, `validation`, `diagnostics`, `check`), *interact* (`publish`, `scenario`, `scenarios`, `mode`, `reset`), *maintain* (`init`, `specs`, `doctor`, `skill` — §9). One line each, no flags (flags live in `offbook <cmd>`'s own errors and the guides).
7. **Pointers** — the guides, and for contributors, `AGENTS.md`.

### `docs/guides/` (new directory)

Task-oriented, adopter-facing — distinct from builder-facing `docs/specs/`. Four guides:

- **`getting-started.md`** — the quickstart expanded: what the demo showed, then `init`, then the first real spec; ends by handing off to the wiring guide.
- **`wiring-your-service.md`** — `services.yaml` (gitHost, repo slug/URL/path, specPath, branch), `environments.yaml`, what `specs.lock` records, `offbook specs update`, reading `offbook topics` to confirm what got ingested, first `offbook up`.
- **`scenario-cookbook.md`** — L2 recipes by task ("ack a command", "chain emissions", "a scripted moment on demand", "deterministic changing values" — L2 has no timer firing, only reactive and on-demand), each a paste-able snippet written against the bundled demo thermostat spec's topics so every recipe is loadable (§4 gate). Derived from `l2-scenarios.md`; never contradicts it.
- **`daily-loop.md`** — embedding offbook in the app repo: a package script starting offbook alongside the dev server, reading `validation`/`status` during development, `offbook check` in CI, watch modes.

**Doc-map rule (added to `AGENTS.md`):** guides are *derived* docs. `contracts.md` and `l2-scenarios.md` stay canonical; a conflict means the guide is wrong — fix the guide.

## 3. `offbook doctor` <!-- anchor: doctor -->

A preflight verb: runs a fixed, ordered list of named checks, each reporting pass / warn / fail with a one-line fix-it hint. For humans (CI keeps using `check`).

| # | name | pass | warn | fail (hint) |
|---|------|------|------|-------------|
| 1 | `runtime` | Bun ≥ `engines.bun` | — | below floor ("upgrade Bun to ≥ X") |
| 2 | `deps` | sentinel packages resolvable (`@asyncapi/parser`, `ajv` — chosen to not trip the transport-isolation gate) | — | missing ("run `bun install`") |
| 3 | `project` | `services.yaml` + `environments.yaml` parse and are schema-valid | no `services.yaml` here ("not an offbook project — `offbook init`, or cd; `offbook demo` needs none") | parse/schema error (file + first error) |
| 4 | `specs-reachable` | every configured service repo resolves (local path exists / `git ls-remote` succeeds, bounded timeout) | `--offline` given, or `services: {}` ("none configured yet") | unreachable ("check gitHost/repo/branch for `<service>`") |
| 5 | `scenarios` | all `scenarios/*.yaml` are well-formed (YAML parses; a list of scenarios, each with `name` and `then` — `when` is optional, absent means on-demand-only) | no scenario files ("none found — see the cookbook") | parse/shape error (file + reason) |
| 6 | `ports` | ws/tcp/ctrl ports free, **or** a live offbook owns them ("already up, pid N") | — | foreign process on a port ("port 9001 busy — stop it or pass `--ws-port`") |
| 7 | `runfile` | no runfile, or runfile pid alive | stale runfile, pid dead ("stale `.offbook/run` — `offbook down` cleans it") | — |
| 8 | `skill` (§9, R-042) | absent (detail names `offbook skill install`), or installed copy byte-identical to the running tool's bundled skill | installed copy differs ("stale/edited skill — `offbook skill install --force` refreshes it") | — |

- **Check 8 scope**: resolves the git toplevel from the examined dir and looks for `.claude/skills/offbook-onboard/`; the compare excludes the `.installed-from` stamp (§9). Absent is a pass, not a warn — not every project wants the skill; a stale skill never fails doctor (it does not break the tool). No git toplevel resolvable (the examined dir is outside any repo — doctor's own temp-dir tests, for one) is likewise a pass, detail "not in a git repo". The warn's hint names the resolved toplevel it compared (`offbook skill install --force` resolves from *cwd*, which can differ when `doctor <elsewhere>` examines another repo — naming the path makes the divergence visible instead of silent).

- **Ports checked**: the defaults `up` would use (ws 9001, tcp 1883, ctrl 9080) unless a runfile exists — live *or* stale — in which case its recorded ports (a stale runfile's ports are exactly the ones `up` will reclaim).
- **Version floor single source**: a new `engines.bun` field in `package.json`; `doctor` reads it (and it is exactly what a future release pipeline pins, §5). The floor value is fixed at implementation time: the Bun `major.minor` the repo is actually developed and tested against (read `bun --version`), never a guessed-lower bound.
- **Flags**: `doctor [dir]` (the project dir to examine, default `.`, mirroring `init [dir]`), `--offline` (skip check 4), `--json`, `--run-dir <dir>` (default `.offbook`, matching client verbs). The verb joins the `USAGE` block and the §2 verb overview under *maintain*.
- **Check 5 is shape-only by design**: full scenario validation (topic binding, `{{param}}` resolvability) requires the resolved spec registry, which requires the network fetch `up` performs — doctor stays fetch-free. On a live server those diagnostics are already surfaced by `/v1/diagnostics` (`offbook diagnostics`).
- **Exit code**: 0 iff no check failed (warns allowed) — the quickstart's "if anything fails, run `offbook doctor`" escape hatch.
- **`--json` shape**: `{ ok: boolean, checks: [{ name: string, status: "pass"|"warn"|"fail", detail: string, hint?: string }] }`.

**Architecture (the wizard door):** `src/cli/doctor.ts` holds a plain array of check objects:

```ts
type CheckStatus = "pass" | "warn" | "fail";
type CheckResult = { status: CheckStatus; detail: string; hint?: string };
type DoctorCheck = { name: string; run(ctx: DoctorCtx): Promise<CheckResult> };
```

Checks are data, not prose in a switch: a future interactive init wizard iterates the same list and prompts fixes instead of printing hints (§5). Doctor reuses `config/`'s loaders and `ingestion/`'s repo-URL resolution for checks 3–4 (transport isolation only restricts `broker/`; unaffected).

## 4. First-run error audit & doc-rot gates <!-- anchor: first-run-gates -->

### Error audit

Scope: every error reachable on the **clone → demo → init → wire-real-spec → up → first publish** path. The bar: each message names what failed and one concrete next step. Errors that `doctor` genuinely diagnoses (checks 1–7) gain a trailing "(try `offbook doctor`)" — only those; no blanket suffix. Each audited message is pinned by a test. The implementation plan carries the message inventory (site, current text, target text); this spec sets the bar and the path.

### README quickstart gate

`test/readme-quickstart.test.ts` holds the quickstart as **canonical data** — the ordered command sequence with its process semantics (detached `demo --serve`; the demo-app server spawned and killed; readiness probed over HTTP: demo-app root returns the page, `/v1/topics` proxies through) — and does two things:

1. **Executes it** end-to-end in a scratch dir on per-file unique ports (appending only `--run-dir` and port flags to the canonical commands — any other divergence between canonical data and what runs is a test bug by definition).
2. **Extracts the README's `sh quickstart`-tagged fences** and asserts they equal the canonical sequence token-for-token (minus the appended flags).

Change the README: the equivalence assertion notices. Change the CLI: the execution breaks. No shell-interpretation harness, no README parsing beyond fence extraction.

### Cookbook gate

`test/guides-cookbook.test.ts` extracts every `yaml scenario`-tagged fence from `scenario-cookbook.md` and loads each against the bundled demo thermostat registry, asserting zero load diagnostics. Every published recipe is guaranteed loadable against a real spec — the fixture-quality-bar ethos ("does this actually work as claimed?") applied to docs.

### Link gate

`scripts/check-docs.ts` grows a relative-link check over `README.md` + `docs/guides/**`: every relative markdown link resolves to an existing file (URL fragments ignored in v1). Failures are doc-system gate failures like any other.

## 5. The productization door (deferred, hinged) <!-- anchor: productization-door -->

Explicitly out of scope now; each item's hinge is already in place so widening the audience later is cheap. Recorded in `D-016` so this reads as a door, not an omission.

| Deferred | Prepared hinge |
|----------|----------------|
| Publish to the internal npm registry | `package.json` `bin`/`engines` already correct; the README's untagged clone/install block is the *only* section that changes (`bunx offbook` replaces clone+link) |
| Versioned releases | `engines.bun` is the pin source; adopt semver tags when the first outside team adopts — no work now |
| Interactive init wizard | `doctor`'s checks-as-data substrate (§3): the wizard iterates the same checks and prompts fixes |
| Compiled single-file binary | `bun build --compile` is a known-viable escape hatch if a machine ever can't get Bun — no work now |

**Hinge consumed (2026-08-07, D-028):** the interactive-wizard niche is now occupied by the §9 onboarding skill — a conversational front door that arrived cheaper than a TTY wizard. The `DoctorCheck[]` substrate stays in place should a non-agent wizard ever be wanted; the deferral itself stands.

## 6. Testing

- **`src/cli/doctor.test.ts`** — per-check failure modes in temp dirs (missing/broken services.yaml, unreachable repo with timeout, busy port, stale runfile), `--json` shape, exit codes. Per-file unique ports, repo convention.
- **`test/readme-quickstart.test.ts`** — the §4 quickstart gate (execution + fence equivalence).
- **`test/guides-cookbook.test.ts`** — the §4 cookbook gate.
- **Error-message pins** — beside the existing CLI tests that already pin messages.
- **`test/init-templates.test.ts`** — the §8 template-parses gate (fenced examples extracted and parsed standalone; as-scaffolded files parse; the scenario example shape-checked).
- **`src/cli/skill.test.ts`** — `offbook skill install` behaviors: fresh copy (stamp written), present-identical no-op, present-different refusal (exit 1, divergence listed), `--force` clean-replace (orphaned old files removed), stamp excluded from the compare, bare/unknown subcommand usage (exit 1), `--version` output shape, toplevel destination resolution, outside-a-repo error, `--dest` override, below-toplevel warning, gitignored-target warning. Doctor check 8's absent/identical/different cases land beside the other per-check cases in `src/cli/doctor.test.ts`.
- **`scripts/check-docs.test.ts`** — the §4 link-gate cases plus the §9 gate cases: intra-skill link rule, verb-existence extraction grammar (placeholder exemption, flag skip, two-token enforcement), SKILL.md frontmatter assertions.
- **VERB_FORMS coherence test** — first tokens ≡ dispatch keys ∪ {`demo`}; VERB_FORMS ↔ USAGE equivalence in both directions (beside the existing CLI dispatch tests).
- All behind the standard `bun test` + `bun scripts/check-docs.ts` gates.

## 7. Paper trail

- **`R-034`** — adopter document set (README + guides + doc-map rule + link gate). §2, §4.
- **`R-035`** — `offbook doctor`. §3.
- **`R-036`** — first-run error audit + executable quickstart/cookbook gates. §4.
- **`D-016`** — approach B (guided path: docs + targeted hardening) over docs-only and productization-now; the §5 hinge table.
- **`R-041`** — embedding substrate (reference templates, doctor discoverability, app-connection recipe, template-parses gate). §8.
- **`R-042`** — onboarding skill + `offbook skill install`. §9.
- **`R-043`** — first-light integrity (status connects line, port-conflict attribution, staleness honesty). §10.
- **`D-028`** — two-layer embedding onboarding (substrate + agent skill) over editor schemas and the init wizard; the §5 hinge-consumption note; amended in place by the 2026-08-07/08 review round (EI1 amendment, third work item).

## 8. Embedding substrate — templates, doctor discoverability, app connection <!-- anchor: embedding-substrate -->

**Status**: design for `R-041` (D-028), 2026-08-07. The §1 journey got a teammate to a moving demo and a wired service; the observed friction now sits one step later, in **embedding** — getting offbook to live in the app repo. Two concrete pains (adopter observation, n=1 discipline): the `services.yaml` shape is recall-from-docs at edit time, and the app's broker URL is hardcoded in client source — an edit the tool itself can never perform (§9 picks that one up).

### Reference-quality `init` templates

`INIT_SERVICES` (currently a minimal commented example) becomes a fill-in-the-blank reference document:

- `gitHost` explained in place: the base URL for slug-form repos, **no built-in default** — a slug without it is a config error (G20). Always a **commented** example, never an active placeholder value (the contracts §6 EI1 amendment, D-028): unset must stay the true config state so a slug hits the clean G20 error, not a fetch failure against a garbage host.
- **Fence convention (the gate's substrate):** each template carries exactly **one** canonical worked example between `# --- example ---` / `# --- end example ---` marker lines, commented at code depth (`# `). Non-canonical alternatives — the URL-form and absolute-path `repo` variants — sit **outside** the fence at prose depth (`## `), so extraction is mechanical and alternatives can never collide into duplicate keys.
- Every field annotated required-or-default; the annotations are written against the owning module (`parseServices` for shape, ingestion for branch defaulting, registry for the qos/retain tiers) and reviewed against contracts §6, which stays canonical — the §8 gate pins *parseability*, not annotation truth.
- `INIT_ENVIRONMENTS` gets the same treatment: a plain-words statement of what the file is for (records requested spec versions per environment; v1 fetches branch tips regardless — resolution-mode: branch), when an adopter would touch it, and a minimal fenced worked example (one named environment with a pinned version).
- Both templates close by naming the edit loop: `offbook doctor` validates shape locally without fetching (§3 check 3); its `specs-reachable` check (§3 check 4) confirms each repo resolves.
- **`init` also scaffolds a `README.md`** into the project dir (review-round fork d): what this directory is (an offbook mock project), how to install offbook — the clone URL **observed** at init time from **the running tool's own checkout** (the `import.meta.dir`-resolved repo root, the same root `--version` reads — explicitly *not* the app repo's remote, which is the natural misreading and would tell teammates to clone the wrong repo) via `git remote get-url origin` (fallback wording "ask a teammate for the offbook clone URL" when no remote answers; the `<internal-git>` never-invent rule holds because the URL is read, not authored) — then "`offbook doctor` first", then guide pointers. The one committed artifact that names the next step for a teammate *without* an agent (the fresh-clone case: `mock/`, scripts, and skill present, `offbook: command not found`). Prose, no fence; pinned by the init unit tests.

### Doctor discoverability

`init`'s next-steps output currently reads "set gitHost + your services in services.yaml, then `offbook up`". It gains the middle step — validate with `offbook doctor` as you edit. The capability exists (§3); what was missing is the advertisement at the moment of need.

### App-connection recipe

`docs/guides/wiring-your-service.md` gains a **"Point your app at offbook"** section: extract the client's broker URL behind a build-time env var — real backend as the default, `ws://localhost:9001` in `.env.development` — with the demo-app's runtime `?ws=` override noted as the zero-build variant. A derived guide section under the standard conflict rule; no contract is touched.

### Template-parses gate

`test/init-templates.test.ts` extracts each template's fenced example region (the marker lines above), strips exactly one leading `# ` per line, and parses the result **standalone** — replace-not-join: the extracted example is never merged with the template's active `services: {}` / `default: {}` lines, so duplicate-key collisions are impossible by construction. Assertions: `parseServices` / `parseEnvironments` accept the extracted examples; the as-scaffolded files parse as-is; and `scenarios/00-example.yaml`'s fenced example satisfies the doctor check-5 **shape** (a list of scenarios, each with `name` and `then` — shape-only, the same line doctor draws (§3): the example's topics exist in no spec, so a registry load is out of reach by design). The templates break loudly if the config shape ever changes — the §4 executable-docs ethos applied to scaffolds.

## 9. Onboarding skill — the agent front door <!-- anchor: onboard-skill -->

**Status**: design for `R-042` (D-028), 2026-08-07. Most of the adopting team has Claude Code available inside the air gap (verified constraint, not a hope). The two §8 frictions are agent-shaped: an agent authors valid yaml without recall, and the app-side refactor is an edit inside the client repo that only an agent (or a human) can perform. The skill is a **layer over §8, never a replacement** — the manual path must stand alone for teammates without an agent, and the skill defers to it.

### Distribution: `offbook skill install`

- The skill ships in-repo at `skills/offbook-onboard/` (a `SKILL.md` plus any support files) — the source directory name **equals** the install directory name, so install is a plain copy and the SKILL.md frontmatter `name` can match both ends (h-sweep). A new CLI-local verb, `offbook skill install`, copies it to `<app repo toplevel>/.claude/skills/offbook-onboard/`. Copy-if-absent; if present and different, report the divergence and require `--force`. The source resolves from the running tool itself (no path hunting — `bun link` already put `offbook` on PATH).
- **Destination resolution (review-round fork f — no positional):** the destination is `git rev-parse --show-toplevel` from the cwd, always; outside a git repo the verb errors with a next step ("not inside a git repository — cd into your app repo") — a skill outside a repo cannot propagate, and the app repo is by definition a clone. `--dest <dir>` is the explicit escape hatch for unusual layouts (a monorepo whose sessions open at a subdir). Deliberately **not** a `[dir]` positional: on `doctor`/`init` that positional means the offbook *project* dir (`mock/`), and `skill install mock/` by analogy would silently install where no session looks — the different argument shape signals the different semantics. Two non-fatal warnings, each naming its consequence: `--dest` below a repo's toplevel warns "a Claude Code session at the repo root won't discover a skill installed here"; a `git check-ignore`d target warns "`.claude/` is gitignored here — the skill won't propagate; un-ignore it or teammates never see it". Warn-and-proceed, not refuse: both states can be intentional. **`--dest` and the repo requirement:** `--dest` skips toplevel resolution entirely — the outside-a-git-repo *error* applies only to the default path; a `--dest` outside any repo installs with the cannot-propagate warning instead of erroring, and a `--dest` inside a repo still gets both propagation warnings.
- **Pinned verb semantics (review-round fork c):** "different" = byte-level tree equality — file set plus contents, the `.installed-from` stamp excluded. `--force` is **clean-replace** (remove the installed dir, re-copy), never overlay: overlay orphans files from older skill versions and jams every future compare. The present-different refusal exits 1 and shows the divergence (changed/added/removed file names). Bare `offbook skill`, or an unknown subcommand, prints a subcommand usage line and exits 1.
- **Provenance stamp:** `skill install` writes version, source commit, install date, source path (best effort — a homedir prefix relativized to `~`, so it reads sensibly on the installing machine and never commits one dev's username/home layout into a teammate's clone), **and the installing checkout's `git remote get-url origin`** to `.installed-from` inside the installed dir — a dedicated file, **not** SKILL.md, so the staleness compare stays byte-exact against the bundled source with a trivial exclusion rule. The origin URL is *observed* at install time from the running tool's checkout (the same root as §8's README trick), never invented at authoring time (the `<internal-git>` placeholder rule holds); it is how a second teammate's agent learns the clone URL. **Fallback (mirrors §8's):** when the checkout has no origin remote, the field is omitted and the skill's locator wording falls back to "ask a teammate for the offbook clone URL" — the locator chain never silently dead-ends.
- **Doc reachability (how the skill finds the guides):** SKILL.md refers to guides by name-in-checkout ("`docs/guides/wiring-your-service.md` in your offbook checkout, located via `.installed-from`"), **never** by relative markdown link — the installed copy lives on a different filesystem subtree than the offbook clone, so cross-tree relative links are broken for the actual consumer by construction. The skill's locator rule: read `.installed-from`; if the recorded source path exists on this machine, the docs are there; otherwise the origin URL names the clone. Copying guide excerpts into the skill was rejected: it doubles the rot surface with no gate reaching into app repos.
- **Version identity (the substrate for the stamp and §3 check 8):** `offbook --version`, handled at dispatch before verb lookup, prints `offbook <package.json version> (<short-sha>[-dirty])` — the sha read by running git in the repo root the CLI resolves via `import.meta.dir`, falling back to `unknown`. Under `bun link` every install is a live symlink to a personal checkout; this is what lets two teammates name their skew at all.
- **Installed-copy edits are drift, not customization:** the skill is a derived artifact (like the guides); local edits belong upstream in `skills/offbook-onboard/`. The §3 check-8 warn plus the show-divergence-before-`--force` refusal keeps a deliberate customizer from silent clobbering, but there is no permanent-fork or merge story (n=1 discipline).
- The verb joins the *maintain* group (§2 verb overview + `USAGE`). D-014/D-015 precedent: CLI-local, no `/v1`, no contract change.
- Installing into the app repo (committed) makes onboarding **self-propagating**: the second teammate gets the skill by cloning the app repo. Scoped honestly (review-round fork d): the skill does not arrive via `init`, so it is installable before any offbook *project* exists in the app repo — but it presupposes the tool itself (clone, `bun install`, `bun link`); preflight step 1 owns the case where `offbook` is missing, and the §8 scaffolded README serves the teammate without an agent.

### What the skill drives

The embedding journey end to end, leaning on §8 and the guides at every step:

1. **Preflight** — `offbook doctor`; missing runtime/deps route to the README install steps.
2. **Interview** — where each service's spec lives (gitHost, repo, specPath, branch), one question at a time.
3. **Scaffold** — `offbook init mock/`, fill `services.yaml` from the interview, re-run `doctor` after each edit until clean.
4. **App-side refactor** — find the hardcoded broker URL, extract it behind a build-time env var per the §8 recipe, show the diff, get approval before applying.
5. **Package scripts** — `mock:up` / `mock:down` per `daily-loop.md`.
6. **First light** — `offbook up`; `offbook topics --json` confirms ingestion (the `--json` form is mandatory here — it refuses without a live server rather than falling back to the bundled demo, §10); start the app; **the acceptance test: the app's connect fingerprint appears** (`offbook status` clients line, §10); show `offbook validation --watch`.
7. **CI (offered, optional)** — the `offbook check` recipe from `daily-loop.md`.

### Authority chain

Stated in the skill itself: `contracts.md` > guides > skill. If the skill disagrees with a guide, the skill is wrong — the doc-map conflict rule extended one more derivation step.

### Rot gates

- The link gate over `skills/offbook-onboard/**` asserts every relative link resolves **within the skill directory itself** (intra-skill only) — true on both filesystems by construction, unlike the §4 rule (resolve-in-repo), which would validate links against the offbook tree while the consumed copy lives in the app repo.
- **Frontmatter gate (h-sweep):** check-docs asserts the SKILL.md frontmatter has `name: offbook-onboard` (matching the directory name at both source and destination — discovery depends on it) and a non-empty `description`.
- **Verb-existence check, one source of truth (review-round fork e; grammar corrected by the follow-up pass):** a leaf module `src/cli/verbs.ts` exports `VERB_FORMS` — every valid invocation form, one- and two-token (`"specs"` **and** `"specs update"` are both members; bare `"skill"` is deliberately absent — only `"skill install"`). Subcommands only: argument values are **not** forms (`mode autonomous`/`mode passive` are `mode` + argument — only `"mode"` is a member). It imports nothing, so check-docs importing it keeps the checker dependency-free in spirit. The extraction rule over `skills/offbook-onboard/**` (inline backtick spans + fenced code blocks) is plain **set membership**: take the tokens after `offbook`, drop `<...>`-shaped placeholders (exempt the whole occurrence) and leading-dash flags; the longest leading one- or two-token form present must be ∈ VERB_FORMS. Bare `offbook skill` fails because `"skill"` is not a member; bare `offbook specs` passes because `"specs"` is; `offbook skill uninstall` fails because two leading tokens are present and `"skill uninstall"` is not a member while bare `"skill"` isn't either; `offbook mode autonomous` passes via `"mode"` (second token is an argument — a second token only participates when the first token has any two-token form in VERB_FORMS). Coherence is pinned by test in both directions — VERB_FORMS' first tokens ≡ the dispatch table's keys ∪ {`demo`}, every form appears in `USAGE`, no USAGE verb line names a form outside the list — under a stated USAGE-parse convention: `<...>` and `[a|b]` bracket groups are arguments, a bare `[word]` names a subcommand iff the two-token form is in VERB_FORMS (the convention makes the test's USAGE read deterministic; it is a test-local read of one literal, not the rejected general USAGE scraper in check-docs).
- **Stated residual:** the gate checks verb *forms* only — flag names and argument semantics are unchecked (a skill naming `--offline` on a verb that dropped it passes). The §3 check-5-note genre: the blind spot is declared, not papered over.
- The verb gets ordinary unit tests (§6).
- Agent *behavior* is acknowledged as not CI-testable; the gates pin what is pinnable (links, verbs, templates).

## 10. First-light integrity <!-- anchor: first-light-integrity -->

**Status**: design for `R-043` (D-028, review-round fork g), 2026-08-08. The FMEA of the embedding journey found the most trust-corrupting failures on the **first-light** path are silent: the app quietly talking to the reachable real backend while offbook runs empty (the adopter concludes the tool does nothing), a busy port blamed on a "foreign process" that is offbook's own demo from another directory, and two advertised loops that succeed while stale. All three fixes share one shape, forced by the frozen contracts: **CLI-local, over existing surfaces — structured `offbook.log` lines (the D-014/D-015 precedent) plus the runfile/`probeOffbook` liveness machinery. No `/v1` endpoint or response shape changes.**

### Connected-clients surface

`offbook status` gains a clients line read from the D-015 connect-fingerprint log lines: connects observed this run, with the last client id and time (`connects: 3, last: web-abc123 14:02:11`). Deliberately *connects observed*, never a live-connection count — that is what the log surface truthfully knows; no disconnect bookkeeping is invented. **Run scoping (the log appends across runs):** the server logs a **boot line** at every startup (see Staleness honesty below — the same line carries the services.yaml hash); "this run" = fingerprint lines after the **last** boot line. Under `up --watch` each respawn writes a new boot line, so the count restarts per respawn — correct for the acceptance-test semantics ("did my app connect to *this* server"). The wiring guide's first-light section and skill step 6 (§9) make "your app's connect fingerprint appears" the **explicit acceptance test** before first light is declared done — closing the silent-real-backend failure (the app connects to production because `.env.development` is missing/unloaded, everything works, offbook sits empty).

### Port-conflict attribution

`up`'s preflight and doctor's `ports` check (§3 check 6) evaluate **all three ports before composing the error** (today's preflight throws on the first busy port — ws — so a ctrl-only rule would never fire in the motivating all-three-busy demo scenario); whenever the **ctrl** port is among the busy set, probe it with the existing `probeOffbook`. If it answers as offbook, the message claims only what was verified: "another offbook owns the control port `<n>`; also busy: `<other labels>` — `offbook down` in that project's directory frees the control port; check the others separately if they persist" (the "also busy" clause appears only when ws/tcp are busy too; no claim of ownership over them, and no guess at which offbook instance it is). Only when ctrl is free (ws/tcp busy alone) does the generic foreign-process message stand — a stated fallback, not a gap.

### Staleness honesty

- **`services.yaml` edits after `up`:** the server's **boot line** (every startup) records what it loaded — `boot: services.yaml sha256:…` for a project boot, `boot: bundled demo spec` for a demo boot. `offbook specs update` resolves the run dir as every client verb does (runfile), reads the served project's `services.yaml` via the run dir's boot record (`projectDir`), hashes it, compares against the **last** boot line, and warns "services.yaml changed since `offbook up` — restart to apply" on mismatch. Skips silently (no warn possible, none owed) when: reached via bare `--ctrl-port` with no run dir; the last boot line records the bundled demo; or no boot line exists (a pre-R-043 log). Today the new service silently never appears while "specs refreshed" prints success.
- **`offbook topics --json` with no live server refuses** (exit 1, "no running offbook in this run-dir — run `offbook up` here, or pass `--ctrl-port`; the bundled-demo fallback is human-only") instead of silently returning the bundled demo spec — the run-dir qualifier matters: in the §10 attribution scenario an offbook *is* running, just not here. An agent must never mistake demo topics for ingestion; accordingly the §9 skill's step 6 mandates the `--json` form. Refusal over a `source` marker: a marker protects only consumers who know to check it; refusal eliminates the class. The human-path fallback and its printed "(no running offbook — showing the bundled demo spec…)" note stay.

### Testing (joins §6)

- **`src/cli/index.test.ts` / `test/cli-dispatch.test.ts`** — status clients line (zero connects, n connects, malformed log lines skipped, **two runs in one log: only post-last-boot-line connects count**); topics `--json` no-server refusal (exit 1, message pinned; the M0 `renderTopics` helper pin stays — the refusal lives in the verb, not the exported helper); specs-update staleness warn (hash match silent, mismatch warns, the three skip cases skip).
- **`src/cli/doctor.test.ts` + up-preflight pins** — busy ctrl port answering as offbook rewrites the message (including **all three ports busy**); non-offbook listener, or ws/tcp busy with ctrl free, keeps the generic message.
