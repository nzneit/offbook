# Adoption surface — README, guides, `doctor`, first-run gates <!-- anchor: adoption -->

**Status**: design for `R-034`–`R-036` (see `REQUIREMENTS.md`); decisions folded into `D-016`. This doc is canonical for the adopter-facing document set, the `offbook doctor` verb, and the first-run error/doc-rot gates. The frozen contracts are untouched: no `/v1` endpoint is added, `Diagnostic.kind` stays a closed union, and §4/§5 interfaces are byte-identical — `doctor` is a CLI-local verb (the D-014/D-015 precedent). **§8–§9 (added 2026-08-07)** extend this surface with the embedding-onboarding design for `R-041`–`R-042` (D-028), under the same stance: `offbook skill install` is CLI-local, no contract change.

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
6. **Verb overview** — the CLI verbs grouped by lifecycle: *run* (`up`, `down`, `status`, `logs`, `demo`), *observe* (`topics`, `state`, `validation`, `diagnostics`, `check`), *interact* (`publish`, `scenario`, `scenarios`, `mode`, `reset`), *maintain* (`init`, `specs`, `doctor`). One line each, no flags (flags live in `offbook <cmd>`'s own errors and the guides).
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
- **`scripts/check-docs.test.ts`** — link-gate cases added to the existing checker tests.
- **Error-message pins** — beside the existing CLI tests that already pin messages.
- **`test/init-templates.test.ts`** — the §8 template-parses gate (worked examples uncommented and parsed; as-scaffolded files parse).
- **`src/cli/skill.test.ts`** — `offbook skill install` behaviors: fresh copy, present-identical no-op, present-different refusal, `--force` overwrite.
- **`scripts/check-docs.test.ts`** — §9 gate cases added: relative-link gate over `skills/onboard/**`, verb-existence check.
- All behind the standard `bun test` + `bun scripts/check-docs.ts` gates.

## 7. Paper trail

- **`R-034`** — adopter document set (README + guides + doc-map rule + link gate). §2, §4.
- **`R-035`** — `offbook doctor`. §3.
- **`R-036`** — first-run error audit + executable quickstart/cookbook gates. §4.
- **`D-016`** — approach B (guided path: docs + targeted hardening) over docs-only and productization-now; the §5 hinge table.
- **`R-041`** — embedding substrate (reference templates, doctor discoverability, app-connection recipe, template-parses gate). §8.
- **`R-042`** — onboarding skill + `offbook skill install`. §9.
- **`D-028`** — two-layer embedding onboarding (substrate + agent skill) over editor schemas and the init wizard; the §5 hinge-consumption note.

## 8. Embedding substrate — templates, doctor discoverability, app connection <!-- anchor: embedding-substrate -->

**Status**: design for `R-041` (D-028), 2026-08-07. The §1 journey got a teammate to a moving demo and a wired service; the observed friction now sits one step later, in **embedding** — getting offbook to live in the app repo. Two concrete pains (adopter observation, n=1 discipline): the `services.yaml` shape is recall-from-docs at edit time, and the app's broker URL is hardcoded in client source — an edit the tool itself can never perform (§9 picks that one up).

### Reference-quality `init` templates

`INIT_SERVICES` (currently a minimal commented example) becomes a fill-in-the-blank reference document:

- `gitHost` explained in place: the base URL for slug-form repos, **no built-in default** — a slug without it is a config error (G20).
- The worked example service shows **all three `repo` forms** as commented alternatives: slug (`org/my-service`), full URL, absolute local path.
- Every field annotated required-or-default; the exact wording is written against what `parseServices` implements — the parser is the truth, the template transcribes it.
- `INIT_ENVIRONMENTS` gets the same treatment: a plain-words statement of what the file is for (records requested spec versions per environment; v1 fetches branch tips regardless — resolution-mode: branch) and when an adopter would touch it.
- Both templates close by naming the edit loop: `offbook doctor` validates shape locally without fetching (§3 check 3); its `specs-reachable` check (§3 check 4) confirms each repo resolves.

### Doctor discoverability

`init`'s next-steps output currently reads "set gitHost + your services in services.yaml, then `offbook up`". It gains the middle step — validate with `offbook doctor` as you edit. The capability exists (§3); what was missing is the advertisement at the moment of need.

### App-connection recipe

`docs/guides/wiring-your-service.md` gains a **"Point your app at offbook"** section: extract the client's broker URL behind a build-time env var — real backend as the default, `ws://localhost:9001` in `.env.development` — with the demo-app's runtime `?ws=` override noted as the zero-build variant. A derived guide section under the standard conflict rule; no contract is touched.

### Template-parses gate

`test/init-templates.test.ts` extracts the commented worked example from each scaffolded template, uncomments it, and asserts `parseServices` / `parseEnvironments` accept it; the as-scaffolded files (empty `services: {}` / `default: {}`) must parse too. The templates break loudly if the config shape ever changes — the §4 executable-docs ethos applied to scaffolds.

## 9. Onboarding skill — the agent front door <!-- anchor: onboard-skill -->

**Status**: design for `R-042` (D-028), 2026-08-07. Most of the adopting team has Claude Code available inside the air gap (verified constraint, not a hope). The two §8 frictions are agent-shaped: an agent authors valid yaml without recall, and the app-side refactor is an edit inside the client repo that only an agent (or a human) can perform. The skill is a **layer over §8, never a replacement** — the manual path must stand alone for teammates without an agent, and the skill defers to it.

### Distribution: `offbook skill install [dir]`

- The skill ships in-repo at `skills/onboard/` (a `SKILL.md` plus any support files). A new CLI-local verb, `offbook skill install [dir]` (default `.`, run from the app repo root), copies it to `<dir>/.claude/skills/offbook-onboard/`. Copy-if-absent; if present and different, report the divergence and require `--force`. The source resolves from the running tool itself (no path hunting — `bun link` already put `offbook` on PATH).
- The verb joins the *maintain* group (§2 verb overview + `USAGE`). D-014/D-015 precedent: CLI-local, no `/v1`, no contract change.
- Installing into the app repo (committed) makes onboarding **self-propagating**: the second teammate gets the skill by cloning the app repo. No chicken-and-egg: the skill does not arrive via `init`, so it is installable before anything else exists.

### What the skill drives

The embedding journey end to end, leaning on §8 and the guides at every step:

1. **Preflight** — `offbook doctor`; missing runtime/deps route to the README install steps.
2. **Interview** — where each service's spec lives (gitHost, repo, specPath, branch), one question at a time.
3. **Scaffold** — `offbook init mock/`, fill `services.yaml` from the interview, re-run `doctor` after each edit until clean.
4. **App-side refactor** — find the hardcoded broker URL, extract it behind a build-time env var per the §8 recipe, show the diff, get approval before applying.
5. **Package scripts** — `mock:up` / `mock:down` per `daily-loop.md`.
6. **First light** — `offbook up`; `offbook topics` confirms ingestion; start the app; confirm the connect landed; show `offbook validation --watch`.
7. **CI (offered, optional)** — the `offbook check` recipe from `daily-loop.md`.

### Authority chain

Stated in the skill itself: `contracts.md` > guides > skill. If the skill disagrees with a guide, the skill is wrong — the doc-map conflict rule extended one more derivation step.

### Rot gates

- The §4 relative-link gate extends over `skills/onboard/**`.
- A new check-docs check: every `offbook <verb>` the skill names must exist in the CLI's verb set (sourced from the same `USAGE` block the CLI prints) — no dead-verb references.
- The verb gets ordinary unit tests (§6).
- Agent *behavior* is acknowledged as not CI-testable; the gates pin what is pinnable (links, verbs, templates).
