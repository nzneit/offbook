# Instance discovery: manage a running offbook from any directory

**Date:** 2026-08-18
**Status:** approved design (brainstorm round), pre-plan; revised after a three-checker
adversarial verification pass (code facts, canonical-doc facts, design quality).
**Origin:** the "undocumented cwd premise" finding, recorded open and unallocated in
`docs/archive/intake/2026-08-12-first-light-acceptance-fixes.md` (Addendum), plus the
runner-up "cwd/run-dir note in daily-loop.md (F1)" in
`docs/archive/intake/2026-08-07-embedding-onboarding-review.md`.

## Problem

Every management verb locates a running instance through exactly one thing: the G14
runfile `<runDir>/offbook.run`, where runDir defaults to the relative path `.offbook`
resolved against the invoking CLI's cwd (`src/cli/runfile.ts`, `src/cli/index.ts`
`runDirOf`). There is no global registry, no home-dir state, no port scanning. The only
escape hatches are `--run-dir` and, on client verbs, `--ctrl-port`.

The wrong-directory experience does not just fail, it misleads:

- `offbook status` says "not running (no runfile in .offbook)" and exits 1 while the
  server runs fine elsewhere.
- `offbook down` prints "offbook: not running" and exits **0** while doing nothing; the
  real server keeps running (the idempotent no-op reads as success).
- `offbook topics` silently falls back to the bundled demo spec (with a note), showing
  thermostat topics instead of the running project's.
- A second `up` hits the R-043 attribution "another offbook owns the control port 9080
  — `offbook down` in that project's directory frees the control port", but nothing can
  tell the user *which* directory that is: `/v1/mode` returns only mode/seed/lastResetSeq,
  and the attribution deliberately makes "no guess at which offbook instance it is"
  (adoption.md §10).
- No adopter doc states the premise; it is implied by cd-then-run examples
  (getting-started's `cd my-mock` + `offbook init`, daily-loop's `cd mock &&` package
  scripts, the onboarding skill's steps 5 and 6).

Two latent facts help any fix: default ports are fixed (ws 9001 / tcp 1883 / ctrl 9080),
so a second instance cannot even start on defaults and n=1 is the overwhelmingly common
state; and the P7 liveness rule (pid alive AND the control port answers as offbook)
already gives a starting point for validating any instance a discovery mechanism
proposes (step 4 below deliberately strengthens it).

## Goal

Every management verb (`status`, `down`, `logs`, `topics`, `publish`, `validation`, ...)
works from any directory on the machine, resolving to the running instance and saying
which instance it resolved to. Wrong-directory output becomes truthful. The port-conflict
attribution can name the owning project directory. `offbook up [dir]` starts an instance
for a project without `cd`.

## Non-goals

- No shutdown-over-HTTP: `down` stays signal-based; the frozen "up / down are NOT HTTP
  endpoints" sentence (contracts.md §5) survives untouched.
- No per-instance port auto-allocation; the fixed defaults and `--*-port` flags stand.
- No bulk *management* operations (`down --all`, stop-everything). A read-only table of
  candidates appears in exactly one place: the ambiguity refusal (n=1 discipline).
- `init` and `doctor` stay cwd-scoped this round (doctor gains only the two
  registry-aware notes below); the docs sweep therefore drops `cd` only around
  management verbs, not around `init`/`doctor` passages.
- No `demo --serve [dir]` positional; the demo keeps starting from cwd.
- No cross-directory post-mortem `logs`: once an instance is stopped or reclaimed (its
  pointer removed), its log is reachable only in its project directory or via
  `--run-dir`. In the project directory itself, `logs` keeps working post-mortem (see
  the `logs` exception in the resolution rule).

## Design overview

Resolution order for every management verb: a **live** cwd runfile wins (today's
behavior); a stale cwd runfile is reclaimed with today's one-line note and resolution
falls through to a machine-global index of instances, where candidates count as live
only after an identity check against the actual server (pid match over HTTP, not just
"some offbook answers this port"). Exactly one live instance: the verb targets it and
says so. Several: a candidate uniquely related to cwd by directory containment wins;
still ambiguous, refuse with a table of candidates and copy-paste selectors. None:
today's "not running" messages, now true. The index holds pointers only; all state stays
in the per-instance runfile and boot file. A new control-plane read, `GET /v1/server`,
provides the identity.

The flagship flow, walked through: `offbook up mock` from `/app` starts the instance
with projectDir `/app/mock` and runDir `/app/mock/.offbook`; a later `offbook status`
from `/app` finds no `/app/.offbook` runfile, resolves via the registry (the
strict-descendant tiebreak below covers even the multi-instance case), prints
`(using the offbook started in /app/mock)` on stderr, and reports truthfully.

## The registry: pointers, not state

One file per instance:

```
${OFFBOOK_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/offbook}/instances/<sha256(runDir)>.json
```

- The fallback path is used verbatim on every platform, resolved against
  `os.homedir()`; if no home directory resolves, the registry is unavailable and the
  best-effort degradation below applies.
- The hash input is the absolute, symlink-resolved runDir (`realpathSync` after the
  runDir is created). Scans additionally dedupe on the stored `runDir` value; the
  realpath-keyed pointer wins and a duplicate keyed under another hash of the same
  runDir is deleted on sight (it is fully covered by its twin).
- Pointer content: `{ "v": 1, "runDir": "<absolute path>" }`. Nothing else. Ports, pid,
  and startedAt live in the target's `offbook.run`; projectDir lives in the target's
  `offbook.boot.json`. A pointer can never disagree with the runfile, only dangle.
- Pointer writes are atomic (write temp file, rename into place), so a scan can never
  observe a mid-write pointer.
- Write/remove sites: inside `writeRunfile` and `clearRunfile` (`src/cli/runfile.ts`),
  which automatically covers all three runfile writers (`launchDetached`'s initial
  write, serve.ts's post-boot rewrite, the `--watch` respawn) and all clearers (`down`,
  stale reclaim, failed boot). `runfile.ts` resolves runDir to absolute internally. On
  the remove path, `clearRunfile` falls back to `path.resolve` when `realpathSync`
  fails (a runDir that never existed never had a pointer under the realpath hash; the
  stored-runDir dedupe covers residual mismatches), preserving `down`'s idempotence
  against nonexistent run dirs.
- `launchDetached`'s failed-boot cleanup becomes conditional: it clears the runfile and
  pointer only if the runfile still names the pid this `up` spawned (read-compare
  before remove), so a losing concurrent `up` cannot deregister the winner serve.ts
  just wrote.
- **Reaping (deliberately narrow):** a scan deletes a pointer only when the target
  runfile is missing or the runfile's pid is dead (`pidAlive` false). A pointer whose
  pid is alive but whose identity check fails or times out is *skipped* for this
  invocation, never deleted: a booting instance legitimately has a live pid and a
  silent control port for up to the 30s readiness window, and a reap there would make a
  healthy instance permanently undiscoverable (nothing rewrites the pointer in a
  non-watch run until the post-boot runfile write). A corrupt pointer file (unreadable
  JSON) is skipped and reaped; atomic writes make that state unreachable by normal
  operation.
- Best-effort always: an unwritable or unreadable state dir degrades to today's
  behavior with a one-line stderr warning; registry failures never block `up` or any
  other verb. When `up [dir]` cannot write the pointer, the warning must include the
  recovery selector, e.g. `instance registry unavailable — manage this instance from
  <projectDir> or with --run-dir <projectDir>/.offbook`, because discovery from the
  launch cwd depends entirely on the registry in that flow.
- `demo --serve` registers like any instance: it already goes through `launchDetached`
  and writes a runfile in `<cwd>/.offbook`. (The contracts.md §5 "nothing written to
  runDir" guarantee is about foreground `offbook demo`, which stays registry-silent.)
- `OFFBOOK_STATE_DIR` exists for test hermeticity and unusual setups; it is documented
  but not a primary interface.

## Resolution rule

One shared resolver returning the resolved instance, not just a port:
`{ runDir (absolute), runfile, source: "cwd" | "registry" }`, so verbs can locate
`offbook.log` and `offbook.boot.json` for the instance they actually resolved. Today's
seams it replaces or feeds: `resolveRunning` (status, launchDetached guard),
`resolveCtrlPort` (client verbs, `src/cli/client.ts`), `down`'s direct
`readRunfile` + `pidAlive` (`src/cli/index.ts:1231`), `logs`' `logPath`
(`src/cli/index.ts:1333`), and `specs update`'s `specsStalenessWarning(runDirOf(...))`
(`src/cli/index.ts:722-725`).

1. `--ctrl-port` given (client verbs, and newly `status`): use it, skip everything
   below (unchanged semantics; run-dir correspondence stays unverified, so log- and
   boot-file-derived extras are skipped as today).
2. Explicit `--run-dir` given: resolve against that runDir only, exactly today's
   semantics. The flag is precise addressing; it disables the global fallback. (This is
   also what makes the ambiguity refusal's selectors work: `--run-dir <abs>` uniquely
   names one instance.)
3. Default runDir, runfile present in `<cwd>/.offbook` **and live** (P7: pid alive AND
   control port answers as offbook): exactly today's semantics. cwd wins. A
   present-but-stale runfile is reclaimed with today's one-line note (replacing the
   terminal "stale runfile" error in `client.ts:32-35`) and resolution falls through to
   step 4; for `down`, the stale cwd runfile is cleared first, then the registry is
   consulted.
4. Otherwise scan the registry (candidates probed concurrently; cost stays bounded by
   reaping plus the n=1 discipline). A pointer is a **live candidate** only if all of:
   the target runfile exists, its pid is alive, and `GET /v1/server` on the runfile's
   control port returns 200 with `pid === runfile.pid`. A 404, timeout, or pid mismatch
   makes the pointer not-a-candidate for this invocation (skipped, and reaped only per
   the narrow reap rule). Identity verification is what makes registry-resolved `down`
   safe: a reused pid behind a stale pointer, with an unrelated offbook owning the
   default port, passes the naive pid+probe conjunction but fails the pid match, and is
   therefore never signaled.
   - **One live candidate:** target it. Print a redirection note to **stderr** (so
     `--json` stdout stays clean): `(using the offbook started in <projectDir>)`. Verbs
     whose own output already names the instance (`down`, `status`) suppress the note.
   - **Two or more:** if exactly one candidate's projectDir is an ancestor of (or equal
     to) cwd, use it; else if exactly one candidate's projectDir is a strict descendant
     of cwd, use it (this covers the flagship `up mock`-from-`/app` case); else exit 1
     with one line per candidate (projectDir, the three ports, pid) and the hint
     `rerun with --run-dir <absolute runDir>`. The refusal table and hint go to stderr
     with empty stdout, exit 1, in both human and `--json` modes.
   - **Zero:** today's not-running errors. Honesty extras, per case: when this
     invocation reaped a pointer whose runfile was missing, `status` adds
     `(last instance: <pointer runDir>, gone)` (built from the pointer alone; the
     target files are gone); when it reaped a pid-dead pointer,
     `(last instance: <projectDir>, pid <n>, gone)`. The reap line is one-shot: only
     the invocation that performed the reap prints it. When live-pid candidates were
     *skipped* (identity unverifiable: booting, wedged, or foreign), `status` and
     `down` add `(an instance in <projectDir> (pid <n>) is not answering on port <n> —
     manage it from that directory or with --run-dir)`; exit codes stay as today
     (status 1, down 0).

**`logs` exception:** `logs` is local-first on the *log file*, not the runfile: if
`<cwd>/.offbook/offbook.log` exists, print it (today's semantics, which is what makes
in-directory post-mortem work after `down`); only when no local log exists does it
resolve via steps 2-4 and print the resolved instance's log.

No new flag names anywhere; `status` additionally accepts the already-existing
`--ctrl-port` flag (see verb-by-verb). `projectDir` for notes and refusal tables comes
from `GET /v1/server` for live candidates and from the target's `offbook.boot.json`
otherwise.

**Asymmetry, stated:** local `down` keeps its deliberately-weaker pid-only check so it
can kill a wedged server whose control port stopped answering; the registry path
requires identity verification and therefore cannot. A pid-alive/port-dead instance
remains stoppable only from its own directory or via `--run-dir`.

## `GET /v1/server`

New control-plane read. (Named `server`, not `instance`: "instance" is a frozen
contract term for materialized channel instances, `InstanceRegistry`/
`InstanceSnapshot`/the `no-instances` diagnostic, contracts.md §3/§5.)

```json
{
  "pid": 12345,
  "projectDir": "/home/x/apps/foo/mock",
  "runDir": "/home/x/apps/foo/mock/.offbook",
  "startedAt": "2026-08-18T09:00:00.000Z",
  "demo": false,
  "ports": { "brokerWsPort": 9001, "brokerTcpPort": 1883, "controlPlanePort": 9080 }
}
```

- serve.ts resolves `config.runDir` to absolute at boot and passes the identity
  (projectDir, absolute runDir, demo flag) into the composed server for the control
  plane to serve. Resolving at boot also hardens the `--watch` respawn against its
  inherited cwd being moved or deleted mid-run.
- Uses: (a) the step-4 liveness check (pid match), which registry-resolved `down`
  depends on; (b) naming the owner in the port-conflict attribution; (c) `--ctrl-port`
  users seeing who they are talking to.
- Version skew is a non-problem for discovery: builds without `/v1/server` also wrote
  no pointers, so every pointer-found instance serves it; a 404 simply means
  not-a-candidate.
- The response uses no new ErrorCode; the closed union is untouched.

## Verb-by-verb changes

- **`up [dir]`**: new optional positional, default `.`. `projectDir =
  resolve(cwd, dir)`; the boot file gets that instead of bare `process.cwd()`. The
  default runDir becomes `<projectDir>/.offbook` (an explicit `--run-dir` stays
  cwd-relative, as today). The EI2 fresh-project orientation check
  (`src/cli/index.ts:1164`, `handlersDir`) uses projectDir instead of cwd.
- **`up` preflight + `doctor` ports check**: when the busy control port answers
  `GET /v1/server` and the pid matches the claimed runfile, the attribution names the
  owner and gives the always-correct selector: `another offbook owns the control port
  9080 (started in <projectDir>) — \`offbook down --run-dir <absolute runDir>\` stops
  it from anywhere`. When unverifiable (foreign checkout, no pointer, pid mismatch),
  today's wording stands; discovery never invents facts.
- **`doctor` runfile check**: when there is no local runfile but the registry holds a
  live candidate, the check's detail gains one note: `no runfile here; a live offbook
  is registered: <projectDir>, ports ws <n> / tcp <n> / http <n>`. Doctor is otherwise
  cwd-scoped (non-goal).
- **`down`**: resolves via the rule above; operates on the resolved runDir exactly as
  today (SIGTERM, 5s, SIGKILL, clear runfile + pointer); names what it stopped
  (`offbook: stopped (pid <n>, started in <projectDir>)`). Registry-resolved `down`
  signals only an identity-verified pid. Still idempotent: nothing resolvable anywhere
  is `offbook: not running`, exit 0, now true (modulo the skipped-candidates honesty
  note above).
- **`status`**: resolves via the rule above; prints which instance it is reporting. The
  R-043 connects line keeps working because the resolver hands it the resolved
  instance's absolute runDir for `offbook.log`. Gains the existing `--ctrl-port` flag:
  with it, `status` reports the server's `/v1/server` + `/v1/mode` identity (project,
  ports, mode, pid) but no log-derived extras (no runfile/log correspondence, exactly
  like the client verbs' unverified `--ctrl-port` path today).
- **`logs`**: local-log-first, then resolved instance's log (see the `logs` exception
  above).
- **`specs update`**: `specsStalenessWarning` reads the *resolved* instance's
  `offbook.boot.json` (via the resolver's runDir) instead of `<cwd>/.offbook`'s, so
  the staleness warning fires from anywhere; it keeps skipping under `--ctrl-port`
  (correspondence unverified), as today.
- **Client verbs** (`topics`, `publish`, `validation`, `state`, `scenario`/
  `scenarios`, `mode`, `reset`, `specs`, `check`, `diagnostics`): `resolveCtrlPort` is
  replaced by the shared resolver; error wording becomes `offbook is not running (no
  runfile in .offbook, no live instance in the registry) — run \`offbook up\`, or pass
  --ctrl-port`.
- **`topics`**: the bundled-demo fallback (human output) and the `--json` refusal fire
  only when steps 3-4 produced nothing live: a stale cwd runfile no longer masks a
  live instance elsewhere.

## Contract, requirements, and docs impact

Amendments to the frozen contract, recorded as the next free `D-###` (D-032 at time of
writing; REQUIREMENTS.md tops out at R-043, DECISIONS.md at D-031):

- **contracts.md §1a**: both runDir comment sites (the `Config` interface comment,
  line ~89, and the `DEFAULT_CONFIG` example comment, line ~106) are amended. The
  clause "up/down/logs/status resolve it identically" is **superseded**, not extended:
  the replacement states cwd-first-then-registry resolution for management verbs and
  the projectDir-relative default under `up [dir]` (`--run-dir` stays cwd-relative).
- **contracts.md §5 (G14)**: a paragraph for the instance registry (path scheme,
  pointer shape, atomic writes, narrow-reap lifecycle, best-effort guarantee) and the
  resolution order; additionally the existing parenthetical "`<runDir>` =
  `config.runDir`, cwd-relative, default `.offbook/`" is reworded to the
  projectDir-relative default, cross-referencing the amended §1a.
- **contracts.md §5 reads table**: one new row, `GET /v1/server`, with a
  disambiguation note against the channel-instance sense of "instance".
- **`src/cli/runfile.ts` header comment**: transcribes the superseded "resolve it
  identically" clause; swept with the contract amendment.
- Untouched: the "up / down are NOT HTTP endpoints" sentence, the ErrorCode union, the
  runfile field list, `/v1/mode`.

Process: an intake round per `docs/specs/doc-system.md` (start from
`docs/intake/_TEMPLATE.md`) resolving into the next free `R-###`s (R-044 onward),
expected cut **in dependency order**:

1. `GET /v1/server` (+ serve.ts absolute-runDir hardening),
2. registry + resolution rule across all management verbs + attribution naming
   (consumes 1: identity-gated liveness, registry-resolved `down` safety),
3. `up [dir]`,
4. the docs sweep below.

The round also closes the archived open finding "the undocumented cwd premise"
(2026-08-12 Addendum) and discharges the F1 runner-up (daily-loop cwd note).

Docs sweep (derived docs; contracts > guides > skill; management verbs only, `init`/
`doctor` passages keep their cwd framing per the non-goal):

- `docs/guides/daily-loop.md`: package scripts become `"mock:up": "offbook up mock"`,
  `"mock:down": "offbook down"`; drop the `cd mock &&` idiom around management verbs; a
  short "manage from anywhere" note.
- `docs/guides/getting-started.md`, `docs/guides/wiring-your-service.md`, `README.md`:
  drop implied-cwd phrasings around management verbs; state the resolution rule in one
  sentence.
- `docs/specs/adoption.md` §10: the attribution wording gains the named-owner variant
  and its `--run-dir` selector; the "no guess at which offbook instance it is" sentence
  is superseded; the pinned `topics --json` refusal wording and its "the run-dir
  qualifier matters" rationale are superseded (new semantics: refuse only when nothing
  is live machine-wide).
- `skills/offbook-onboard/SKILL.md`: steps 5/6 lose `cd mock` around management verbs;
  step 6's refusal rationale ("that refusal means `up` failed") is rewritten for the
  machine-wide semantics; the port-conflict recipe quotes the new attribution.

## Edge cases

- **Booting instance** (pid alive, port silent, up to 30s): skipped as a candidate,
  never reaped; discoverable the moment `/v1/server` answers.
- **Two pointers claiming the same port** (crash leftovers): the pid match arbitrates;
  at most one pid actually owns the port; unverifiable claims are never named and never
  signaled.
- **Reused pid behind a stale pointer + unrelated offbook on the port**: fails the pid
  match; not a candidate; never signaled (the step-4 safety property).
- **Wedged instance** (pid alive, port dead): stoppable only locally or via
  `--run-dir`; surfaced by the skipped-candidates honesty note.
- **Version skew**: an older-build instance wrote no pointer and serves no
  `/v1/server`; discovery does not find it; attribution falls back to today's generic
  wording. Nothing breaks, nothing is invented.
- **Corrupt pointer JSON**: skip and reap (atomic writes make it unreachable by normal
  operation).
- **Missing/corrupt boot file behind a live candidate**: projectDir comes from
  `/v1/server` (which serves the identity it booted with), so notes and tables still
  name it.
- **Unwritable state dir**: one stderr warning (with the recovery selector on
  `up [dir]`), then behave exactly as today.
- **Registry vs. `--run-dir` mismatch dance**: explicit `--run-dir` never consults the
  registry, so scripted/CI invocations keep byte-identical behavior.

## Testing

- **Registry unit tests**: pointer lifecycle (write-on-writeRunfile,
  remove-on-clearRunfile, atomic write), the narrow reap rule (missing-runfile reap,
  dead-pid reap, live-pid-silent-port skip-not-reap), realpath hashing + dedupe winner,
  corrupt pointers, unwritable-dir degradation, `clearRunfile` on a nonexistent runDir
  (idempotence). All under a scratch `OFFBOOK_STATE_DIR`.
- **`test/cli-dispatch.test.ts` integration**: wrong-directory `status`/`down`/`logs`/
  `topics` resolving via the registry (scratch state dir, scratch project dirs,
  non-default ports per the existing hermetic-test pattern); stale-cwd-runfile
  fall-through to a live instance elsewhere; the two-instance ambiguity refusal
  (streams, empty stdout, exit 1) and its `--run-dir` selector; both tiebreak stages
  (ancestor and strict-descendant, the latter via `up mock` + `status` from the
  parent); attribution naming with the `--run-dir` selector on a busy control port;
  identity gating (a fabricated pointer + runfile naming a live-but-unrelated pid is
  skipped and never signaled); the failed-boot conditional clear under a concurrent
  `up`; `up [dir]`; `down` from elsewhere clearing runfile + pointer; `logs`
  local-first post-mortem after `down`; the stderr placement of the redirection note
  under `--json`; `status --ctrl-port`; the doctor registry note.
- **`GET /v1/server`**: control-plane test for the response shape; serve-side test that
  runDir is served absolute.
- **Hermeticity**: `OFFBOOK_STATE_DIR` is pinned to a scratch dir **suite-wide** (bunfig
  test preload/setup), because non-booting tests are registry writers too once pointer
  writes ride `writeRunfile` (`src/cli/doctor.test.ts:401,426` and the fake-runfile
  sites in `test/cli-dispatch.test.ts` call it directly). Server-booting tests
  additionally pin per-test scratch dirs and assert no leftover pointers at the end
  (the 2026-08-12 leaked-instance lesson, extended to the registry). The suite must
  never touch the developer's real `~/.local/state/offbook`.
- **Doc-system gate**: the new `R-###`s carry arrow-tag comments
  (`// [itest->R-###]` etc.) in both directions per `bun scripts/check-docs.ts`.
