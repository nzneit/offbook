# 2026-08-09: PR 13 review fix handoff (intake)
**Status**: open
**Owner**: whichever agent picks up the fix pass on `embedding-onboarding` (PR 13)

**Companion to:** `docs/specs/adoption.md` §8–§10 (canonical for the embedding surface; where an item says "fix the spec", the shipped behavior was judged correct and the spec text is the odd one out), `REQUIREMENTS.md` (R-041–R-043), `DECISIONS.md` (D-028), `skills/offbook-onboard/SKILL.md` (derived: contracts > guides > skill).

**Scope:** 23 items from the 2026-08-09 four-angle review of PR 13 (code correctness, doc-consistency, test quality, embedding-surface robustness; every Tier 1/2 item re-verified against source, several reproduced live). **Tier 1 blocks merge** (a committed-credential leak and an unrecoverable crash path in the surface this PR ships). Tier 2 items are correctness/coverage of the PR's own claims and should land with it. Tier 3 is follow-up-eligible.

**Why this exists.** The whole-branch review verdict was "ready to merge", but this deeper pass found defects the per-task reviews missed, concentrated in degenerate states (non-directory installs, credentialed remotes, symlinked paths) and in gate/test blind spots. Each item below is self-contained: pick one, decide, fix, verify, tick.

**How to use this doc.**
1. Pick an item (start with Tier 1). Each item is self-contained; no other item or the original review is needed.
2. Make the **Decision owed** (a recommended resolution is given; adopt or override it). Items marked "none — mechanical" can just be done.
3. Resolve it in the **Where** file(s).
4. Verify against **Acceptance**. Repo rule applies: judge single-file `bun test` runs by failure count (the coverage floor can force exit 1 with zero failures); gate on exit codes only for full `bun test` and `bun scripts/check-docs.ts`.
5. Tick the item's `Status` box and append a row to the **Decision log**.

> **Line numbers are anchors as-of `270c5d3` (branch `embedding-onboarding`, 2026-08-09) and drift once edits land.** Anchor by symbol/heading; treat line numbers as hints.

---

## Summary

| ID | Item | Tier | Lands in | Blocks merge? |
|---|---|---|---|---|
| F1 | Origin URL written verbatim (credentials included) into committed artifacts | 1 | `src/cli/checkout.ts` | ✅ |
| F2 | Degenerate skill install (dest is a file) crashes doctor and defeats `--force` recovery | 1 | `src/cli/skill.ts`, `src/cli/doctor.ts` | ✅ |
| F3 | Verb gate grammar over-matches (comments/pipes fail CI) and under-matches (wrapped span hides `status` today) | 2 | `scripts/check-docs.ts`, `skills/offbook-onboard/SKILL.md` | — |
| F4 | `status` prints JSON.parse-restored control characters from an attacker-influenced clientId | 2 | `src/cli/index.ts` (`clientsFromLog`) | — |
| F5 | `probeOffbook` and the foreign-listener attribution branch have zero tests | 2 | `src/cli/runfile.ts` tests, `src/cli/doctor.test.ts`, `test/cli-dispatch.test.ts` | — |
| F6 | adoption.md §10 renders the clients line in a shape that matches neither code nor guides | 2 | `docs/specs/adoption.md` | — |
| F7 | Nonzero clients line and `status --json` clients field untested end-to-end | 2 | `test/demo-serve.test.ts` | — |
| F8 | Boot line logged after `start()` with an await between; hash from a second read | 3 | `src/cli/serve.ts` | — |
| F9 | `rmSync` follows intermediate symlinks: `--force` can delete/write outside the repo | 3 | `src/cli/skill.ts` | — |
| F10 | SKILL.md pre-authorizes `--force` on drift, skipping the refusal listing | 3 | `skills/offbook-onboard/SKILL.md` | — |
| F11 | `.installed-from` stamps the installer's absolute home path into a committed file | 3 | `src/cli/skill.ts` | — |
| F12 | Port-conflict attribution over-claims ("owns these ports", hardcoded "likely the demo") | 3 | `src/cli/index.ts`, `src/cli/doctor.ts` | — |
| F13 | `--dest` naming the toplevel through a symlink triggers a spurious below-toplevel warning | 3 | `src/cli/skill.ts` | — |
| F14 | `--version`/stamp report the enclosing repo's sha when the offbook dir isn't itself a repo | 3 | `src/cli/checkout.ts` | — |
| F15 | Skill-link gate never exercises actual link resolution (no pass or fail case) | 3 | `scripts/check-docs.test.ts` | — |
| F16 | Doctor's not-installed case asserts detail only; pass-when-absent unpinned | 3 | `src/cli/doctor.test.ts` | — |
| F17 | Two-token verb forms pinned docs-to-docs, not to the dispatch | 3 | `test/verb-forms.test.ts`, `src/cli/verbs.ts` | — |
| F18 | Template gate extracts only the first fence; check-5 hand-rolls doctor's shape | 3 | `test/init-templates.test.ts` | — |
| F19 | `--dest` to a non-repo dir (warn-and-proceed branch) untested | 3 | `src/cli/skill.test.ts` | — |
| F20 | `specs update` skips on any `--ctrl-port`; spec says bare-with-no-run-dir | 3 | `docs/specs/adoption.md`, `REQUIREMENTS.md` | — |
| F21 | adoption.md §6 attributes the `--version` shape test to the wrong file | 3 | `docs/specs/adoption.md` | — |
| F22 | Doctor check 8's second warn state absent from the §3 table | 3 | `docs/specs/adoption.md` | — |
| F23 | R-025/R-019/build-plan enumerations not swept for the init README and `skill` verb | 3 | `REQUIREMENTS.md`, `docs/specs/build-plan.md` | — |

---

## Tier 1 — fix before merge

### F1 — Origin URL written verbatim (credentials included) into committed artifacts
- **Where:** `src/cli/checkout.ts` `checkoutOrigin` (line 38) returns `git remote get-url origin` raw; sinks: `src/cli/index.ts` `initReadme` clone line (lines 1409–1413, scaffolded `README.md` the adopter commits) and `src/cli/skill.ts` stamp `originUrl` (lines 87–89, `.installed-from`, which the CLI urges committing and `SKILL.md` lines 17–18 tells agents to read and hand onward).
- **Problem:** No userinfo stripping anywhere. A remote of the form `https://oauth2:glpat-XXXX@git.internal/team/offbook.git` (a common internal-host pattern for avoiding credential helpers) is embedded byte-for-byte.
- **If unaddressed:** A live token lands in the app repo's git history for ~7+ teams, is re-broadcast by the skill's locator step, and survives deletion. This is the exact class of value D-026 kept out of published artifacts.
- **Decision owed:** strip userinfo and keep the URL (recommended), or refuse to embed any URL that carries userinfo (fall back to the ask-a-teammate line). Note scp-like remotes (`git@host:path`) are not `URL`-parseable and carry a conventional username, not a secret; pass them through.
- **Recommended resolution:** sanitize inside `checkoutOrigin` so every current and future sink is covered:
  ```ts
  export async function checkoutOrigin(
    root = repoRoot(),
  ): Promise<string | undefined> {
    const url = await git(["remote", "get-url", "origin"], root);
    if (url === undefined) return undefined;
    try {
      const u = new URL(url);
      u.username = "";
      u.password = "";
      return u.toString();
    } catch {
      return url; // scp-like (git@host:path): no embeddable secret
    }
  }
  ```
- **Acceptance:** new case in `src/cli/checkout.test.ts` (throwaway repo with origin `https://user:token@example.invalid/x.git`): result contains `example.invalid/x.git` and does not contain `user` or `token`; an scp-like origin round-trips unchanged; existing checkout/skill/init tests still pass (full `bun test` exit 0).
- **Relates to:** F11 (the stamp's other environment-specific value).
- **Status:** ☐ open

### F2 — Degenerate skill install (dest is a file) crashes doctor and defeats `--force` recovery
- **Where:** `src/cli/skill.ts` `cmdSkill` (lines 147–165): `compareSkillTrees` runs before the `--force` branch; `src/cli/doctor.ts` `skillCheck` (line 395): `compareSkillTrees` has no try/catch and `runDoctor` (lines 427–430) runs checks bare.
- **Problem:** If `.claude/skills/offbook-onboard` exists as a file (or the tree contains an unreadable entry), `compareSkillTrees` throws `ENOTDIR`. Reproduced live: `offbook doctor` prints zero check lines and exits 1 with the raw error (checks 1–7 discarded, warn-never-fail broken); both `skill install` and `skill install --force` die the same way, while doctor's hint and SKILL.md's refusals section promise `--force` as the fix. There is no offbook-native way out.
- **If unaddressed:** The two commands the onboarding journey points at for diagnosis and recovery are exactly the two that crash on a broken install.
- **Decision owed:** none — mechanical (guard both sites; `--force` treats a non-directory dest as replaceable).
- **Recommended resolution:** in `cmdSkill`, before the compare: if `existsSync(destDir)` and `!statSync(destDir).isDirectory()`, then with `--force` do `rmSync(destDir, { recursive: true, force: true })` and fall through to `copySkill`; without `--force`, `throw new CliError(...)` naming the state and advising `--force`. Wrap the remaining `compareSkillTrees` call in try/catch and treat a throw as "differs (unreadable)": refuse without `--force`, clean-replace with it. In `skillCheck`, wrap the compare and return `{ status: "warn", detail: "installed skill unreadable/degenerate at <path> — \`offbook skill install --force\` replaces it" }` on throw.
- **Acceptance:** in a temp repo with `.claude/skills/offbook-onboard` created as a *file*: `runDoctor` returns all 8 checks with check 8 `warn` and `ok: true`; `cmdSkill(["install"])` exits 1 with the advisory; `cmdSkill(["install", "--force"])` exits 0 and installs the tree (new cases in `src/cli/doctor.test.ts` + `src/cli/skill.test.ts`, tagged to their existing R-042 arrow-tags); full `bun test` exit 0.
- **Status:** ☑ resolved

---

## Tier 2 — land with the PR (correctness and coverage of the PR's own claims)

### F3 — Verb gate grammar over-matches and under-matches
- **Where:** `scripts/check-docs.ts` `checkSkillVerbs` (lines 257–287); `skills/offbook-onboard/SKILL.md` lines 47–49 (backtick span wrapped across a line break: `` `offbook `` at end-of-line, `` status` `` on the next); gate tests `scripts/check-docs.test.ts` (~line 288).
- **Problem:** (a) Over-match: the token scan strips only `-`-prefixed tokens, so any non-flag second token counts as a subcommand. A legitimate skill line `offbook specs   # provenance` (the exact idiom already at `docs/guides/wiring-your-service.md:74`) or `offbook specs | grep hash` fails the CI-blocking gate with "unknown verb form 'offbook specs #'" (reproduced live). (b) Under-match: the regex `` /`offbook ([^`]+)`|^\s*(?:\$ )?offbook (.+)$/gm `` matches neither half of a wrapped span, so SKILL.md's `status` reference is invisible to the gate today: rename/remove the verb and check-docs stays green, which is what the R-042 gate exists to prevent. Neither shape is covered by the gate's tests.
- **If unaddressed:** (a) the first honest comment or pipe added to the skill blocks CI on a correct line; (b) the "no dead verbs" guarantee has a standing hole.
- **Decision owed:** for (b), extend the regex to scan wrapped spans, or fix the instance and pin the boundary as a documented residual (recommended: the residual is already half-acknowledged in adoption.md §9's compound-span sentence; a full multi-line-span scanner is not worth its complexity here).
- **Recommended resolution:** (a) truncate at shell metacharacters before tokenizing: `const rest = (m[1] ?? m[2] ?? "").split(/[#|&;]/)[0].trim();` (b) reword SKILL.md lines 47–49 so `` `offbook status` `` sits on one line inside one span; (c) add gate tests: a `$ offbook up` bare line (passes), a dead verb in a bare line (fails), `offbook specs # comment` and `offbook specs | grep x` (pass), and a wrapped-span case pinning whichever boundary you chose; (d) extend the §9 residual sentence to state the wrapped-span boundary explicitly.
- **Acceptance:** `bun scripts/check-docs.ts` exit 0 on the corpus; a planted dead verb in a bare line makes it exit 1; the new gate tests pass; `grep -n 'offbook$' skills/offbook-onboard/SKILL.md` inside backtick spans returns nothing (no span ends a line mid-command).
- **Status:** ☐ open

### F4 — `status` prints JSON.parse-restored control characters from an attacker-influenced clientId
- **Where:** `src/cli/index.ts` `clientsFromLog` (line 150: `JSON.parse(m[2])`) and the clients line print (line 1296).
- **Problem:** The fingerprint log line stores the clientId JSON-escaped (which keeps log parsing safe), but `JSON.parse` restores escaped control characters to raw bytes (verified: byte 27 / ESC round-trips), and `cmdStatus` prints the string unfiltered. The broker binds all interfaces, so anything on the LAN (or the app itself) can connect with a clientId crafted to retitle the terminal or cursor-rewrite adjacent status output. The FORCE_COLOR follow-up covers offbook's own colorized output, not this path.
- **If unaddressed:** A hostile or buggy client can spoof/paint over status output (including the validation lines) on the one surface the journey calls the acceptance test.
- **Decision owed:** none — mechanical (sanitize at the parse site so every consumer, including `status --json` and any future one, gets clean strings).
- **Recommended resolution:** in `clientsFromLog`, after the `typeof fields.clientId !== "string"` guard: `const clientId = fields.clientId.replace(/\p{Cc}/gu, "?");` and store that. (`\p{Cc}` is the Unicode control category; avoids spelling raw escape bytes in source.)
- **Acceptance:** new `clientsFromLog` case: a log line whose clientId JSON contains an escaped ESC (build the expectation with `String.fromCharCode(27)` in the test, not a string literal) yields a `last.clientId` containing no character with code < 32 or 127; full `bun test` exit 0.
- **Status:** ☐ open

### F5 — `probeOffbook` and the foreign-listener attribution branch have zero tests
- **Where:** `src/cli/runfile.ts` `probeOffbook` (line 56): no direct tests (`grep -rn probeOffbook` over tests returns nothing); `src/cli/doctor.test.ts` ports cases (~line 344) and `test/cli-dispatch.test.ts` preflight cases (~lines 985–1314) cover only attribution-positive and ctrl-port-free shapes.
- **Problem:** The branch that must NOT attribute (ctrl port held by a non-offbook listener falls back to the generic message) is unpinned in both doctor and `up`. Live probing during review showed the current behavior is correct (foreign responder fails the mode-shape check; hung listener times out at 500ms), so this is coverage, not a bug.
- **If unaddressed:** A regression in `probeOffbook` (e.g. accepting any 200 response) would make offbook falsely accuse "an offbook from another directory" whenever any dev server sits on the ctrl port — the exact lie R-043's attribution exists to prevent — and nothing would fail.
- **Decision owed:** none — mechanical.
- **Recommended resolution:** (a) unit-test `probeOffbook` directly: an HTTP listener returning non-mode JSON → false; a listener that never responds → false within the timeout; a `{"mode":"passive"}` responder → true. (b) One doctor ports case and one `up` preflight case with a plain HTTP server on the *ctrl* port: assert the generic busy message and that no "another directory owns" text appears.
- **Acceptance:** the new tests fail if `probeOffbook` is stubbed to `return true` (spot-check once by hand), pass on the real implementation; full `bun test` exit 0.
- **Relates to:** F12 (wording of the attribution message these tests will pin).
- **Status:** ☐ open

### F6 — adoption.md §10 renders the clients line in a shape that matches neither code nor guides
- **Where:** `docs/specs/adoption.md` §10 "Connected-clients surface" (line 221): `` (`connects: 3, last: web-abc123 14:02:11`) `` vs shipped `src/cli/index.ts:1296`: `clients: 3 connect(s) this run · last web-abc123 at 14:02:11`.
- **Problem:** The canonical spec's only concrete rendering disagrees with the code, the wiring guide, and SKILL.md (which all agree), and with the same sentence's own name for it ("a clients line").
- **If unaddressed:** Anyone implementing or checking against the spec greps for a `connects:` prefix that never appears.
- **Decision owed:** none — mechanical (the shipped rendering is the intended one; fix the spec).
- **Recommended resolution:** replace the parenthetical with the shipped shape, e.g. `` (`clients: 3 connect(s) this run · last web-abc123 at 14:02:11`; zero case: `clients: no connects observed this run — is your app pointed at ws://localhost:<port>?`) ``.
- **Acceptance:** `grep -n "connects: 3, last" docs/specs/adoption.md` returns nothing; the shipped string appears in §10; `bun scripts/check-docs.ts` exit 0.
- **Relates to:** F7 (an end-to-end nonzero test would have caught this class).
- **Status:** ☐ open

### F7 — Nonzero clients line and `status --json` clients field untested end-to-end
- **Where:** `test/cli-dispatch.test.ts` (~line 871) asserts only the zero-connects branch; `test/demo-serve.test.ts` (~line 98) already makes a real ws connect but never runs `status` against it.
- **Problem:** The nonzero rendering (`clients: N connect(s) this run · last <id> at <time>`, `src/cli/index.ts:1296`) and the `clients` field in `status --json` are unpinned, yet SKILL.md makes "a nonzero `clients:` count" the journey's acceptance test.
- **If unaddressed:** A template bug in the nonzero branch (`undefined` clientId, wrong count variable, dropped line) ships undetected and breaks the one signal onboarding tells agents to rely on.
- **Decision owed:** none — mechanical.
- **Recommended resolution:** in `demo-serve.test.ts`, after the existing ws connect, run `status` (and `status --json`) against the live server: assert the text contains `clients: 1 connect(s) this run · last ` and the JSON clients object has `connects: 1` and a string `clientId`; tag to the file's existing R-043 arrow-tag.
- **Acceptance:** the new assertions fail if the nonzero template is broken (spot-check by temporarily printing the wrong variable), pass as shipped; full `bun test` exit 0.
- **Status:** ☐ open

---

## Tier 3 — narrower; follow-up eligible

### F8 — Boot line logged after `start()` with an await between; hash from a second read
- **Where:** `src/cli/serve.ts` lines 45–64: `await composed.start();` then the boot line's hash is computed from a *second* read of `services.yaml` behind another await.
- **Problem:** (a) A client reconnecting the instant ports open lands in the log before the boot line and is excluded from "this run" (status can claim zero connects while the app is connected). (b) The hash reflects post-boot file content, not what `bootProject` loaded: an edit during a slow (git-fetching) boot permanently defeats the `specs update` staleness warning, and a deletion in that window throws into the outer catch and kills an already-started server.
- **Decision owed:** none — mechanical.
- **Recommended resolution:** read `services.yaml` once *before* boot, hash that text, and emit the boot line synchronously after `await composed.start()` resolves (no await between start and `log(...)`). Adopt-or-override: passing the pre-read text into `bootProject` so load and hash share one read is the fuller fix if the plumbing is cheap.
- **Acceptance:** code order shows no `await` between `composed.start()` resolving and the boot-line `log(...)`, and the hash input is read before boot; existing boot-line and staleness tests still pass (full `bun test` exit 0).
- **Status:** ☐ open

### F9 — `rmSync` follows intermediate symlinks: `--force` can delete/write outside the repo
- **Where:** `src/cli/skill.ts` lines 140 (`destDir = join(targetRoot, ".claude", "skills", SKILL_NAME)`) and 165 (`rmSync(destDir, { recursive: true, force: true })`).
- **Problem:** With a dotfiles-managed `.claude` (repo `.claude` symlinked to e.g. `~/dotfiles/claude/`), the delete and the install resolve through the symlink and land under the dotfiles dir (verified empirically under Bun; a symlink at the *final* component is unlinked without following). Deletion stays bounded to the `skills/offbook-onboard` leaf, but the write lands outside the repo and the closing "commit it so teammates get the skill" advice is then wrong.
- **Decision owed:** refuse when `realpath(destDir)` escapes `realpath(targetRoot)`, or proceed with an honest warning (recommended: warn — a symlinked `.claude` is a legitimate setup; correct the propagation advice in that case rather than blocking).
- **Recommended resolution:** before the exists/compare block, resolve `realpathSync` of the deepest existing ancestor of `destDir`; if it is not under `realpathSync(targetRoot)`, print `⚠ .claude here resolves outside this repo (<resolved path>) — the skill will install there and will NOT propagate via this repo's commits` and skip the "commit it" line in the success message.
- **Acceptance:** utest: temp repo with `.claude` symlinked to a sibling dir; `skill install --force` exits 0, prints the resolved-path warning, installs under the resolved dir, deletes nothing else; full `bun test` exit 0.
- **Relates to:** F10 (an agent following the skill can reach this path with no human in the loop).
- **Status:** ☐ open

### F10 — SKILL.md pre-authorizes `--force` on drift, skipping the refusal listing
- **Where:** `skills/offbook-onboard/SKILL.md` lines 57–58 ("doctor warns the installed skill differs...: run `offbook skill install --force`...") vs the refusal path at `src/cli/skill.ts:153-163` whose entire purpose is to show the drift before destruction; step 4 of the same skill requires human approval before touching app source.
- **Problem:** An agent following the skill deletes a teammate's uncommitted local skill edits without anyone seeing the per-file drift listing.
- **Decision owed:** none — mechanical wording fix (bring it in line with step 4's approval discipline).
- **Recommended resolution:** replace with: "run `offbook skill install` (no `--force`) and show the human the drift listing it prints; local edits are drift — upstream anything worth keeping, then re-run with `--force` once the human approves the clean-replace."
- **Acceptance:** SKILL.md contains no unconditional `--force` instruction (`grep -n "install --force" skills/offbook-onboard/SKILL.md` shows it only inside the approve-first wording); `bun scripts/check-docs.ts` exit 0.
- **Status:** ☐ open

### F11 — `.installed-from` stamps the installer's absolute home path into a committed file
- **Where:** `src/cli/skill.ts` line 83: `sourcePath: repoRoot(),`.
- **Problem:** The stamp (committed on the CLI's own advice, excluded from the drift compare) carries one dev's username and home layout into every teammate's clone; it is only meaningful on the installer's machine.
- **Decision owed:** drop the field, or relativize (recommended: keep it best-effort but replace a homedir prefix with `~`, since SKILL.md's locator uses it on the installer's machine where `~` still resolves).
- **Recommended resolution:** `sourcePath: repoRoot().replace(new RegExp("^" + escapeRegExp(homedir())), "~"),` plus a "best effort; valid on the installing machine" note in the stamp comment and adoption.md §9's stamp field list if it names semantics.
- **Acceptance:** a fresh install's stamp contains no `/home/` prefix; `src/cli/skill.test.ts` stamp assertions updated and passing; full `bun test` exit 0.
- **Relates to:** F1.
- **Status:** ☐ open

### F12 — Port-conflict attribution over-claims
- **Where:** `src/cli/index.ts` lines 985–991 ("an offbook from another directory owns these ports (likely the demo) — ..."); same pattern `src/cli/doctor.ts` lines 330–337.
- **Problem:** Only the ctrl port was verified as offbook-owned, but the message asserts ownership of all busy ports and hardcodes "likely the demo" without reading the other instance's identity. With mosquitto on tcp and a demo on ctrl, the dev downs the demo, retries, and still fails (one wasted round-trip).
- **Decision owed:** wording-only fix (recommended), or additionally read the other instance's runfile for identity (not recommended: the runfile location isn't discoverable from a port).
- **Recommended resolution:** claim only what was verified: "another offbook owns the control port <n>; also busy: <other labels> — `offbook down` in that project's directory frees the control port; check the others separately if they persist". Drop "likely the demo". Update the pinned strings in `doctor.test.ts` / `cli-dispatch.test.ts`.
- **Acceptance:** new message pinned by the F5 foreign-listener and existing attribution tests; no test asserts the old "owns these ports (likely the demo)" text; full `bun test` exit 0.
- **Relates to:** F5.
- **Status:** ☐ open

### F13 — `--dest` naming the toplevel through a symlink triggers a spurious below-toplevel warning
- **Where:** `src/cli/skill.ts` lines 121–126: `git rev-parse --show-toplevel` returns the physical path while `resolve(dest)` keeps the logical one, so `resolve(top) !== targetRoot` is true for a symlinked repo root (reproduced live: warning printed, install lands correctly at the toplevel).
- **Recommended resolution:** compare realpaths: `if (top !== undefined && realpathSync(resolve(top)) !== realpathSync(targetRoot)) ...` (mechanical; mirrors the symlink note already in `skill.test.ts:124-125` for the no-dest path).
- **Acceptance:** utest: repo reached via a symlink, `--dest <link>` produces no below-toplevel warning; the genuine below-toplevel case still warns; full `bun test` exit 0.
- **Status:** ☐ open

### F14 — `--version`/stamp report the enclosing repo's sha when the offbook dir isn't itself a repo
- **Where:** `src/cli/checkout.ts` lines 28–33: `git rev-parse --short HEAD` from `repoRoot()` walks up to any enclosing repo (offbook unpacked, not cloned, inside `~/tools` that is itself a repo → foreign sha stamped as provenance).
- **Recommended resolution:** in `checkoutCommit` (and `checkoutOrigin`), first verify `gitToplevel(root)` realpath-equals `root`; otherwise return `"unknown"` (respectively `undefined`).
- **Acceptance:** utest using the existing throwaway-repo helpers: offbook-shaped dir copied (no `.git`) inside an outer repo reports `unknown` and no originUrl; full `bun test` exit 0.
- **Status:** ☐ open

### F15 — Skill-link gate never exercises actual link resolution
- **Where:** `scripts/check-docs.test.ts` (~line 296): cases cover the escaping link, `#anchor`, and https URL, but no intra-skill relative link that exists (pass) or is missing (fail); the resolution clause in `checkSkillLinks` could be deleted and all tests still pass.
- **Recommended resolution:** add two cases: `[x](SKILL.md)` (or another real file) → no errors; `[x](missing.md)` → exactly one "broken link" error.
- **Acceptance:** commenting out the `existsSync` clause makes the new fail-case test fail; restored, 0 failures in the file; full `bun test` exit 0.
- **Status:** ☐ open

### F16 — Doctor's not-installed case asserts detail only; pass-when-absent unpinned
- **Where:** `src/cli/doctor.test.ts` (~line 446): `r2` asserts `detail` contains "not installed" but never `status`; a regression to `fail` (breaking every adopter repo without the optional skill) would pass this test.
- **Recommended resolution:** add `expect(r2.checks[0].status).toBe("pass");` (mechanical).
- **Acceptance:** the assertion is present and the file has 0 failures; full `bun test` exit 0.
- **Status:** ☐ open

### F17 — Two-token verb forms pinned docs-to-docs, not to the dispatch
- **Where:** `test/verb-forms.test.ts` (~line 17): only first tokens are compared against the live `DISPATCH_VERBS`; subcommands (`specs update`, `skill install`) are checked against the USAGE string alone, so a dead two-token form blessed in both places would pass the gate and the gate would then *enforce* narrating it.
- **Decision owed:** how to expose real subcommands: export a `SUBCOMMANDS` map from the owning modules (e.g. `skill.ts` exports `["install"]`, the specs verb exports `["update"]`) and assert every two-token `VERB_FORMS` entry appears there (recommended), or accept the docs-to-docs pin as a stated residual in adoption.md §9.
- **Recommended resolution:** the exported-map variant; wire it into `verb-forms.test.ts` next to the existing first-token comparison.
- **Acceptance:** adding a fake `specs prune` to `VERB_FORMS` + USAGE makes the test fail; as shipped, 0 failures; full `bun test` exit 0.
- **Status:** ☐ open

### F18 — Template gate extracts only the first fence; check-5 hand-rolls doctor's shape
- **Where:** `test/init-templates.test.ts` (~line 27): `lines.indexOf("# --- example ---")` takes the first fence pair only, so a second fenced example in a template goes unparsed; the scenario-shape assertions duplicate doctor check 5's shape instead of running it.
- **Recommended resolution:** loop the extraction (collect all fence pairs, assert each parses standalone, and assert fences are balanced); for the shape, run the real check (extract the example into a temp project and call `runDoctor`, or export and reuse doctor's scenario-shape checker) so the gate drifts with doctor rather than against it.
- **Acceptance:** a planted second fence with an invalid config makes the gate fail; as shipped, 0 failures; full `bun test` exit 0.
- **Status:** ☐ open

### F19 — `--dest` to a non-repo dir (warn-and-proceed branch) untested
- **Where:** `src/cli/skill.ts` lines 127–130 (warn "not inside a git repo — the skill cannot propagate", exit 0); `src/cli/skill.test.ts` covers `--dest` only with repo dirs (the existing non-repo test uses the no-dest path, which exits 1).
- **Recommended resolution:** add a case: `--dest <plain mkdtemp dir>` → exit 0, warning printed, skill installed.
- **Acceptance:** the case passes as shipped and fails if the branch regresses to a throw; full `bun test` exit 0.
- **Status:** ☐ open

### F20 — `specs update` skips on any `--ctrl-port`; spec says bare-with-no-run-dir
- **Where:** `docs/specs/adoption.md` §10 (line 229: "reached via bare `--ctrl-port` with no run dir") vs `src/cli/index.ts` `cmdSpecs` (the staleness check is gated on the flag's absence alone, never consulting the run dir); `REQUIREMENTS.md` R-043's "skipping on `--ctrl-port`-only" tracks the code, so the two normative texts also disagree.
- **Decision owed:** align docs to code (recommended: an explicit `--ctrl-port` targets a server whose correspondence to any run dir is unverified, so the honest move is to skip; document that rationale), or change the code to warn when a run dir is also present.
- **Recommended resolution:** docs-to-code: reword §10's skip list to "whenever `--ctrl-port` is passed (the target server's run dir correspondence is unverified); the last boot line records the bundled demo; or no boot line exists", and align the R-043 phrasing.
- **Acceptance:** §10, R-043, and the code agree on the skip condition; `bun scripts/check-docs.ts` exit 0.
- **Status:** ☐ open

### F21 — adoption.md §6 attributes the `--version` shape test to the wrong file
- **Where:** `docs/specs/adoption.md` §6 (line 131) lists "`--version` output shape" under `src/cli/skill.test.ts`; the pin lives at `test/verb-forms.test.ts:43`.
- **Recommended resolution:** move the phrase to the `test/verb-forms.test.ts` entry (mechanical; R-042's TEST trace already lists the right file).
- **Acceptance:** §6 names `test/verb-forms.test.ts` for the `--version` shape; `bun scripts/check-docs.ts` exit 0.
- **Status:** ☐ open

### F22 — Doctor check 8's second warn state absent from the §3 table
- **Where:** `docs/specs/adoption.md` §3 check-8 row (~line 67) lists only "installed copy differs" as warn; `src/cli/doctor.ts:390-394` also warns "bundled skill missing from the offbook checkout (...) — incomplete checkout?".
- **Recommended resolution:** add the second warn state to the row (and to the check-8 scope bullet if it enumerates states). Mechanical.
- **Acceptance:** the §3 row names both warn states; `bun scripts/check-docs.ts` exit 0.
- **Status:** ☐ open

### F23 — Registry/build-plan enumerations not swept for the init README and `skill` verb
- **Where:** `REQUIREMENTS.md` line 211 (R-025's init-artifact list lacks `README.md`), line 163 (R-019's verb enumeration lacks `skill`), `docs/specs/build-plan.md` line 99 (accept list, same gap); `design.md`'s init bullet already got the sweep.
- **Recommended resolution:** add `README.md` to R-025's list and `skill install` to the two verb enumerations (mechanical; the incomplete-sweep class AGENTS.md's review angle 1 names).
- **Acceptance:** `grep -n "README" REQUIREMENTS.md` shows it in R-025's init list; both verb enumerations include `skill`; `bun scripts/check-docs.ts` exit 0.
- **Status:** ☐ open

---

## Cross-cutting note

Resolve **F1 before F11** (both touch what the stamp/README embed; F1's sanitizer is the shared choke point) and **F2 in one pass across both files** (same root cause, one guard style). **F5 and F12 interlock**: fix the attribution wording (F12) first, then write F5's tests against the new pinned strings, or you will pin strings twice. **F3, F6, F20, F21, F22, F23 are all doc/gate edits** that end in the same acceptance command (`bun scripts/check-docs.ts` exit 0); batching them into one commit keeps the gate churn to one run. Highest-leverage starting point: F2 (it unblocks trustworthy doctor output, which several other acceptances rely on). After Tier 1 lands, re-run the full gate set at HEAD (check-docs, lint, typecheck, full `bun test`) before updating the PR.

## Decision log

*(Append one row per resolved item: ID · decision taken · file(s) patched · resolver · date.)*

| ID | Decision taken | File(s) patched | Resolver | Date |
|---|---|---|---|---|
| F2 | Mechanical guards at both sites (recommended resolution adopted as-is): `cmdSkill` checks `statSync(destDir).isDirectory()` before comparing — non-directory dest throws a `--force`-advising `CliError` without `--force`, clean-replaces with it; `compareSkillTrees` is wrapped in try/catch (unreadable entries treated as "differs"). `skillCheck` wraps its `compareSkillTrees` call and returns `warn` with a `--force`-advising detail on throw instead of letting `runDoctor` crash. | `src/cli/skill.ts`, `src/cli/doctor.ts`, `src/cli/skill.test.ts`, `src/cli/doctor.test.ts` | subagent batch A | 2026-08-09 |
