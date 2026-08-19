# Instance discovery: manage a running offbook from any directory

**Date:** 2026-08-18
**Status:** approved design (brainstorm round), pre-plan. Revised three times: rev 1
folded a three-checker adversarial verification pass; rev 2 folded the 35-mode DFMEA
round (AIAG-VDA action priority); rev 3 folds the three-lens ergonomics critique
(daily-driver, automation, conceptual integrity) and restructures around three named
primitives: guarded mutation, the instance state table, and the message catalog.
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
state; and the existing liveness machinery (pid checks, the control-port probe) gives a
starting point that the identity rules below deliberately strengthen.

## Goal

Every management verb (`status`, `down`, `logs`, `topics`, `publish`, `validation`, ...)
works from any directory on the machine, resolving to the running instance and saying
which instance it resolved to. Wrong-directory output becomes truthful. The port-conflict
attribution can name the owning project directory. `offbook up [dir]` starts an instance
for a project without `cd`.

**The user model, in full** (this is what the guides teach; everything else in this
spec is implementation detail the user never has to learn): *Management verbs find the
running offbook anywhere on this machine; if more than one is running, offbook lists
them and asks you to pick with `--run-dir`. `--run-dir` and `--ctrl-port` always pin
exactly.*

## Non-goals

- No shutdown-over-HTTP: `down` stays signal-based; the frozen "up / down are NOT HTTP
  endpoints" sentence (contracts.md §5) survives untouched.
- No cross-machine or cross-container management. Discovery, naming, and signaling are
  machine-local: pointers and runfiles record their host, foreign-host records are
  inert, and the pid-only paths refuse with a named error rather than signal into a
  foreign pid table (the host rule).
- No cross-directory `down` of an instance unrelated to cwd without a selector: when
  the resolved sole candidate is neither an ancestor nor a descendant of cwd, `down`
  is a no-op that lists what is running (exit 0). Deterministic for scripts and
  agents; no TTY sensing.
- No interactive picker: choosing among instances is always a printed table of
  complete, paste-ready commands, never a stdin prompt (agents and scripts must never
  hang). A TTY-only numbered picker can be a fast-follow.
- No per-instance port auto-allocation; the fixed defaults and `--*-port` flags stand.
- No bulk *management* operations (`down --all`, stop-everything). The read-only
  instance table appears wherever a choice is needed, but acting is always singular.
- `init` and `doctor` stay cwd-scoped this round (doctor gains only the registry-aware
  notes below); the docs sweep therefore drops `cd` only around management verbs.
- No `demo --serve [dir]` positional; the demo keeps starting from cwd.
- No cross-directory post-mortem `logs`: once an instance is stopped or reclaimed, its
  log is reachable only in its project directory or via `--run-dir`; in the project
  directory `logs` keeps working post-mortem (see the verb-policy table).
- **Documented limitations instead of machinery** (ergonomics round scope trims):
  case-aliased runDirs on case-insensitive filesystems may briefly list one instance
  twice (dedupe is by realpath string; file-identity dedupe is a fast-follow if a real
  collision surfaces); a project directory moved under a running server loses
  machine-wide naming until restart (the marked-unverified naming surface is a
  fast-follow R-###); `status --ctrl-port` against a pre-upgrade server refuses with a
  version notice rather than degrading to partial output.

## Design overview

Resolution order for every management verb: a **live** cwd runfile wins (today's
behavior); a stale cwd runfile is reclaimed only when its pid is dead and resolution
falls through to a machine-global index of instances, where a candidate counts as live
only after an **identity** check against the actual server. Identity means a per-launch
random token, not pid equality. Exactly one live instance: the verb targets it and
names it in its own output. Several: a candidate uniquely related to cwd wins
(containment, then the demo rule); still ambiguous, refuse with the instance table.
None: today's "not running" messages, now true, qualified whenever a live-pid
candidate had to be skipped. The index holds pointers only; all state stays in the
per-instance runfile and boot file.

The flagship flow: `offbook up mock` from `/app` starts the instance with projectDir
`/app/mock` and runDir `/app/mock/.offbook` (both absolute in the boot file); a later
`offbook status` from `/app` finds no `/app/.offbook` runfile, resolves via the
registry (the strict-descendant tiebreak), and reports truthfully, naming
`/app/mock` in its own first line. A quiet day is quiet: no stderr notes accumulate
(see Naming and notes).

## Identity: the launch token and the host rule

The DFMEA's four severity-9 findings share one root: **pid equality is not identity.**
All identity therefore rests on two fields added to the runfile (a G14 field-list
amendment, D-032):

- **`token`**: a per-launch random value (128-bit hex) generated by `up`/
  `demo --serve`, baked into the boot file, written into the runfile at every runfile
  write, and echoed by `GET /v1/server`.
- **`host`**: `os.hostname()` at launch, recorded in both the runfile and the registry
  pointer. The **host rule**: a runfile or pointer whose host differs from the local
  hostname is inert (never a candidate, never reaped, never signaled); the pid-only
  paths refuse with catalog message M10.

**Two granularities, named** (an implementer trap the conceptual critique caught):

- The **launch token** identifies a *lineage*: it is constant across `--watch`
  respawns (the respawn reuses the boot file) and dies at `down`. Registry
  resolution, attribution naming, and the readiness probe check the **token**,
  because they ask "is this the offbook that was launched here?".
- The **pid** identifies an *incarnation*: it changes at every respawn. The
  compare-and-signal guard and the SIGKILL re-verify check the **pid**, because the
  token cannot distinguish a respawned successor from the process that was verified,
  and signaling the wrong incarnation is exactly the race being guarded.

Liveness-primitive fixes: `pidAlive` treats EPERM as alive-but-unsignalable (today it
reads as dead), and every identity probe retries once with a longer timeout before
concluding not-answering. **Readiness is identity** (probe unification): `up`'s 30s
readiness loop probes `GET /v1/server` and succeeds only on this launch's token; the
legacy `/v1/mode` probe survives in exactly one role, the pre-upgrade fallback in
state-table row 2.

## Guarded mutation: one rule, five sites

**The rule:** every operation that deletes a discovery record, rewrites one it does
not own, or signals a pid **re-reads its precondition immediately before acting and
aborts on mismatch**. Implemented once as a helper (mutation-gated), instantiated at:

| # | Site | Precondition re-read | Expected | On mismatch |
|---|------|----------------------|----------|-------------|
| 1 | Pointer reap unlink | the pointer file | unchanged since the scan read it | skip the reap |
| 2 | Runfile reclaim / post-kill clear | the runfile | still names the pid judged dead / just signaled | skip the delete |
| 3 | `down` signal (and SIGKILL escalation) | the runfile | still names the verified pid | abort with M22 (never SIGKILL a changed pid) |
| 4 | Failed-boot clear (`launchDetached`) | the runfile + a readiness probe | names the spawned pid AND no other launch token answers | skip the clear (a winner exists) |
| 5 | Self-heal runfile rewrite | the runfile path | still missing at write time | skip the rewrite |

## The instance state table

Observables: record kind (cwd runfile / registry pointer), host, pid (dead / alive;
EPERM counts as alive), identity probe (this token / legacy `/v1/mode` answers, no
token / wrong token / silent). Every liveness word in this spec is a row here:

| Row | Record, host, pid, probe | Read verbs | `down` | Record op | Note |
|-----|--------------------------|-----------|--------|-----------|------|
| 1 | cwd runfile, local, alive, this token | resolve here (source: cwd) | signal (guarded #3) | adopt-on-sight: write missing pointer | none |
| 2 | cwd runfile, local, alive, legacy answers | resolve here, live-unverified | signal (guarded #3) | adopt-on-sight | none locally; skipped elsewhere (row 7) |
| 3 | cwd runfile, local, alive, silent (booting or wedged) | fall through to registry | signal pid-only (guarded #3; the wedged-server path) | keep | M12 or M13 |
| 4 | cwd runfile, local, alive, wrong token | fall through | do **not** signal (the pid may be reused; the port belongs to someone else) | keep | M13 variant naming both |
| 5 | cwd runfile, local, dead | fall through | fall through | reclaim runfile + pointer (guarded #2) | M14 |
| 6 | pointer, local, alive, this token | live candidate | live candidate | none | per Naming and notes |
| 7 | pointer, local, alive, silent / wrong token / 404 | skipped | skipped | keep | M13 |
| 8 | pointer, local, dead | not a candidate | not a candidate | reap (guarded #1) | M14 |
| 9 | pointer, local, runfile missing | self-heal probe first: `GET /v1/server` on the default control port answering with this pointer's runDir means alive-but-de-runfiled: rewrite the runfile from the served identity (guarded #5), then row 6 | same | rewrite or reap (guarded #1) | M14 (missing variant) on reap |
| 10 | any record, foreign host | inert | refuse (M10) on the pid-only paths | never touched | none |

**The deletion law** (rows 5, 8, 9 are its only instances): a discovery record is
deleted only when its target is provably dead or absent, on this host, re-verified
immediately before the delete. A live-pid record is only ever skipped. A corrupt
pointer (unreadable JSON) is the one exception: skip and reap; same-directory atomic
writes make that state unreachable by normal operation.

## The registry: pointers, not state

One file per instance:

```
${OFFBOOK_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/offbook}/instances/<sha256(runDir)>.json
```

- The registry is **machine-local state** (documented as such in the contracts.md §5
  registry paragraph); the host rule is what makes a shared network home safe.
- The fallback path is used verbatim on every platform, resolved against
  `os.homedir()`; no resolvable home means the registry is unavailable and the
  best-effort degradation applies.
- The registry module takes its state dir as an **explicit parameter**; the production
  default is injected only at the CLI entry point. Code that never received a state
  dir throws instead of defaulting into the real home (this removes the class of test
  invocations that bypass the suite's pin; see Testing).
- The hash input is the absolute, symlink-resolved runDir (`realpathSync` after the
  runDir is created). Scans dedupe candidates by realpath string; the realpath-keyed
  pointer wins and a string-identical twin under another hash is deleted on sight.
  (Case-alias dedupe by file identity is a documented limitation / fast-follow.)
- Pointer content: `{ "v": 1, "runDir": "<absolute path>", "host": "<hostname>" }`.
  Nothing else. Ports, pid, token, and startedAt live in the target's `offbook.run`;
  projectDir lives in the target's `offbook.boot.json`. A pointer can never disagree
  with the runfile, only dangle.
- Pointer writes are atomic: the temp file is created **inside `instances/` itself**
  (`<sha>.json.tmp<pid>`) so the rename never crosses a filesystem boundary; scans
  consider only names matching `<64 hex>.json`, so a crash-leaked temp file is inert.
- Write/remove sites: inside `writeRunfile` and `clearRunfile` (`src/cli/runfile.ts`),
  which covers all three runfile writers (`launchDetached`'s initial write, serve.ts's
  post-boot rewrite, the `--watch` respawn) and all clearers (`down`, the pid-dead
  reclaim, failed boot), plus **adopt-on-sight** (state-table rows 1-2) and the
  **self-heal rewrite** (row 9). `runfile.ts` resolves runDir to absolute internally;
  on the remove path `clearRunfile` falls back to `path.resolve` when `realpathSync`
  fails, preserving `down`'s idempotence against nonexistent run dirs.
- Best-effort always: an unwritable or unreadable state dir degrades to cwd-scoped
  behavior with catalog message M17 (which includes the recovery selector, because
  after `up [dir]` discovery from the launch cwd depends entirely on the registry);
  registry failures never block `up` or any other verb.
- `demo --serve` registers like any instance; its boot file's `demo: true` flows into
  `/v1/server` and every naming surface renders it.
- `OFFBOOK_STATE_DIR` exists for test hermeticity and unusual setups; documented, not
  a primary interface.

## The resolver

One shared, verb-agnostic resolver. Input: cwd, `--run-dir`, `--ctrl-port`. Output:
`{ resolved?: { runDir, runfile, projectDir, demo, source: "cwd" | "registry" },
skipped: [{ projectDir, pid, port, reason }], notes: [...] }`. Its only side effects
are the state-table record ops (adopt, reclaim, reap, self-heal), all guarded. It
contains no verb policy; what each verb does with the outcome lives in the verb-policy
table.

1. `--ctrl-port` given (client verbs, and newly `status`): use it, skip everything
   below (unchanged semantics; run-dir correspondence stays unverified, so log- and
   boot-file-derived extras are skipped as today).
2. Explicit `--run-dir <dir>` given: resolve against that runDir only; precise
   addressing, no registry fallback (which is what makes the table's selectors work).
   Convenience: when `<dir>/offbook.run` is absent but `<dir>/.offbook/offbook.run`
   exists, use the latter (users think in project directories). The host rule applies
   (M10 on foreign-host runfiles).
3. Default runDir, runfile present in `<cwd>/.offbook`: state-table rows 1-5.
4. Otherwise scan the registry: rows 6-10, candidates probed concurrently (cost
   bounded by reaping plus the n=1 discipline). With multiple live candidates, the
   tiebreak: both sides realpath-normalized, containment = `path.relative(a, b)`
   neither escapes to `..` nor is absolute (segment-boundary; `/x/repo` never
   contains `/x/repo-wip`). Stage one: exactly one candidate ancestor-or-equal of
   cwd. Stage two: exactly one candidate a strict descendant of cwd. Stage three:
   exactly one candidate is not the demo (the forgotten-demo day resolves to the real
   project, with note M15d naming the demo passed over). Otherwise: ambiguous.

## Verb policy

| Verb class | Resolved (cwd) | Resolved (registry) | Ambiguous | Zero live, none skipped | Zero live, skipped exist |
|---|---|---|---|---|---|
| Read verbs (`topics`, `validation`, `state`, `scenarios`, `specs`, `check`, `diagnostics`) | act; output unchanged | act; **own header names the instance** (M16); `--json` adds identity in-band | refuse: M8, exit 2 | error M11, exit 1 | error M11 + M13 (or M12 when the skipped one is cwd's own), exit 1 |
| Mutating verbs (`publish`, `reset`, `mode` set, `scenario run`, `specs update`) | act | act + stderr note M15 | refuse: M8, exit 2 | error M11, exit 1 | error M11 + M13, exit 1 |
| `status` | act | act; own first line names the instance; `--json` `server` block | refuse: M8 (+ `--json` envelope), exit 2 | M11s, exit 1 | M12/M13, exit 1 |
| `down` | signal (guarded) | related (ancestor or descendant of cwd): signal + M5. Resolved but unrelated to cwd (however it was resolved, the demo stage included): **no-op, exit 0, M6 instance table** | refuse: M8 table, exit 2 | `offbook: not running`, exit 0 | one verified + skipped: refuse M9, exit 2, unless the verified candidate won containment; zero verified + skipped: no-op exit 0 + M13 |
| `logs` | local log exists: print it (+ M19 banner when a live instance would resolve elsewhere) | resolve and print that log | refuse: M8, exit 2 | error (today's wording), exit 1 | error + M13, exit 1 |
| `topics` extras | as read verbs | as read verbs | as read verbs | human: bundled-demo fallback only here (nothing live, nothing skipped); `--json`: M11 refusal | fallback text carries M13 |
| `topics --json` demo rule | n/a (cwd demo is deliberate) | resolved instance reports `demo: true`: refuse M20, exit 1 | | | |

`logs` always runs the resolver (the banner needs its outcome); the local log merely
wins for output. `specs update` reads the *resolved* instance's `offbook.boot.json`
for the staleness warning (skipped under `--ctrl-port`, as today).

## Naming and notes

Read verbs disclose identity **in-band**, not via stderr chatter (the note-fatigue
finding: a note on every verb, all day, trains users to ignore the one line that
matters):

- Human mode, source `registry`: the verb's own first/header line names the instance
  (M16: `offbook @ <projectDir> (ws <n> · http <n>)`, demo-marked when applicable).
  Source `cwd`: output is byte-identical to today (no header, no note).
- `--json`: identity is in the document (`status`: the `server` block
  `{ projectDir, runDir, source, demo }` plus a `skipped` array; other shapes gain the
  same fields where their envelope allows). **Contract: `--json` stdout is always
  exactly one JSON document**; anything else is stderr.
- The stderr note (M15) is reserved for **mutating verbs** on registry resolution and
  for **anomalies** on any verb: candidates skipped (M13), a tiebreak or demo stage
  engaged (M15d), a reap performed (M14), the divergence banner (M19), degradation
  (M17).
- Machine-greppable: every resolver-attached stderr note begins with the stable
  prefix `(offbook:` and that prefix is recorded as contract in D-032 (wording after
  it may evolve; automation matches the prefix).
- Refusals under `--json` are one stdout envelope mirroring the §5 convention:
  `{ "error": { "code": "ambiguous" | "not-running" | "demo-only" | "wrong-host" |
  "version-skew", "message": "<the human wording>" }, "candidates"?: [...] }`
  (candidates populated for `ambiguous`; the stderr table is replaced by the envelope
  in `--json` mode).

## Exit codes (contract, recorded in D-032)

- **0**: acted, or an idempotent nothing-of-yours no-op (`down` with nothing
  resolvable, including the unrelated-sole-candidate table case M6).
- **1**: not running / request failure (M11, M12, `demo-only` M20; today's semantics).
- **2**: refused to act, a selector resolves it (`ambiguous` M8, skipped-alongside
  `down` M9, `wrong-host` M10, `version-skew` M18).

## `GET /v1/server`

New control-plane read. (Named `server`, not `instance`: "instance" is a frozen
contract term for materialized channel instances, contracts.md §3/§5.)

```json
{
  "pid": 12345,
  "token": "9f3c...e1",
  "host": "devbox-07",
  "projectDir": "/home/x/apps/foo/mock",
  "runDir": "/home/x/apps/foo/mock/.offbook",
  "startedAt": "2026-08-18T09:00:00.000Z",
  "demo": false,
  "ports": { "brokerWsPort": 9001, "brokerTcpPort": 1883, "controlPlanePort": 9080 }
}
```

- `up` bakes the **resolved absolute runDir** (and projectDir, and the launch token)
  into `offbook.boot.json`; serve.ts treats a still-relative runDir in the boot file
  as a fatal boot error rather than resolving it against its own cwd. Serve's
  boot-time resolution is thereby a verification no-op, the `--watch` respawn stays
  correct when the inherited cwd was moved or deleted, and the flagship
  double-registration hazard (`up mock` from `/app` yielding a second
  `/app/.offbook`) is closed.
- Version skew: builds without `/v1/server` also wrote no pointers, so a 404 on a
  pointer-found instance means not-a-candidate (state-table row 7, surfaced by M13,
  never silence). `status --ctrl-port` against such a server refuses with M18
  (exit 2); no degraded partial-output mode.
- The response uses no new ErrorCode; the closed union is untouched.

## Verb-by-verb specifics

(The shared behavior lives in the verb-policy table; only per-verb particulars here.)

- **`up [dir]`**: optional positional, default `.`. Preflight first: the resolved path
  must exist and be a directory, else exit 1 with M2, **before** any mkdir, boot-file,
  or pointer write. `projectDir = resolve(cwd, dir)`; default runDir
  `<projectDir>/.offbook` (explicit `--run-dir` stays cwd-relative). The EI2
  fresh-project check (`src/cli/index.ts:1164`) uses projectDir. The no-services.yaml
  hint names the directory `offbook init` must run in.
- **`up` preflight + `doctor` ports check**: when the busy control port answers
  `GET /v1/server` with the claimed runfile's token, the attribution is M3 (named
  owner, complete paste-ready `offbook down --run-dir <runDir>` command, demo-marked).
  Unverifiable: today's generic wording; discovery never invents facts.
- **`doctor`**: registry-aware notes on the runfile check (live registered instance
  elsewhere; live local runfile without a pointer, i.e. a pre-upgrade instance
  invisible to discovery until restarted or managed locally once). The R-042
  skill-staleness check escalates with M21 when the installed skill's stamp predates
  this release. Otherwise cwd-scoped (non-goal).
- **`down`**: compare-and-signal per guarded-mutation site #3 (the identity probe is
  the last operation before SIGTERM; the SIGKILL escalation re-verifies the pid and
  fires only if the port is silent or answers with the signaled lineage's token);
  post-kill clear per site #2. Output M5 (demo-aware). Every non-acting outcome that
  had candidates prints the **instance table** (all live instances: projectDir, three
  ports, pid, demo marker, one complete `offbook down --run-dir <runDir>` command per
  row); choosing is one paste.
- **`status`**: names its instance in its own output; `--json` `server` block +
  `skipped` array; gains the existing `--ctrl-port` flag (identity-only reporting;
  M18 refusal on pre-upgrade servers).
- **`logs`**: local-log-first with the M19 divergence banner.
- **`topics`**: M16 header; the `--json` demo-resolution refusal M20 with a one-hop,
  directory-aware recovery hint (`run \`offbook down\` to stop the demo, then
  \`offbook up <dir>\` for your mock`; never a bare `offbook up` that would collide
  on the fixed ports or target the wrong directory).

## Message catalog

Every new or changed user-facing string, with stream, mode, and exit code. Ids are
sparse: unchanged existing messages (the `up` success lines, the generic port
attribution, `down`'s bare `offbook: not running`) keep their current wordings and
are not re-cataloged. This catalog is the grep source for the D-032 docs sweep and
the fixture for the cli-dispatch assertions; wording, code, and docs cannot drift
independently. Voice
rules applied throughout: lowercase, `offbook <verb> —` or `offbook:` prefixes as
today, hints as em-dash clauses with backticked commands, `control port <n>` (never
bare `port <n>`), directories and pids in messages, **never** registry/pointer/token/
endpoint vocabulary in human-facing text (that vocabulary lives in contracts.md §5
and D-032).

| Id | Message (template) | Stream / mode / exit |
|----|--------------------|----------------------|
| M2 | `offbook up: <path> is not a directory — pass your project directory (e.g. \`offbook up mock\`)` | stderr, exit 1 |
| M3 | `another offbook owns the control port <n> (started in <projectDir>) — \`offbook down --run-dir <runDir>\` stops it from anywhere on this machine` (+ `(the bundled demo, started in <dir>)` variant) | stderr, exit 1 (up preflight) / doctor fail row |
| M5 | `offbook down — stopped (pid <n>, started in <projectDir>)` / `offbook down — stopped the demo (pid <n>, started in <dir>)` | stdout, exit 0 |
| M6 | `offbook: not running (in this project) — running elsewhere on this machine:` + instance table | stdout, exit 0 |
| M8 | `offbook: several instances are running — pick one:` + instance table; `--json`: the `ambiguous` envelope | stderr table / stdout envelope, exit 2 |
| M9 | `offbook down: one instance verified but others are not answering — pick one:` + instance table | stderr, exit 2 |
| M10 | `offbook: this runfile was written on <host> — run \`offbook down\` there, or delete <runDir>/offbook.run if that machine is gone` | stderr, exit 2 |
| M11 | `offbook is not running (no runfile in .offbook, and nothing else is running on this machine) — run \`offbook up\`, or pass --ctrl-port` (status variant keeps its `offbook: not running (...)` shape with the same clause) | stderr, exit 1 |
| M12 | `offbook is not answering here (pid <n>, runfile in .offbook), and nothing else is running on this machine — \`offbook down\` stops the wedged one; \`offbook logs\` may say why` (replaces M11 **and** M13 when the only skipped instance is cwd's own; never printed alongside them) | stderr, exit 1 |
| M13 | `(offbook: an instance in <projectDir> (pid <n>) is not answering on control port <n> — manage it from that directory or with --run-dir)` | stderr note |
| M14 | `(offbook: cleaned up a stopped offbook: <dir> — pid <n> is gone)` / `(offbook: cleaned up a stopped offbook: <dir> — its runfile is gone; if ports are still busy, run \`offbook doctor\`)` (one-shot: only the invocation that performed the cleanup prints it) | stderr note |
| M15 | `(offbook: using the offbook started in <projectDir>)` / demo variant; **M15d**: `(offbook: the bundled demo in <dir> is also running — \`offbook down --run-dir <runDir>\` stops it)` | stderr note (mutating verbs / anomalies only) |
| M16 | `offbook @ <projectDir> (ws <n> · http <n>)` header line, ` — the bundled demo` suffix when demo | stdout first line, human mode, registry-resolved reads |
| M17 | `(offbook: could not record this instance for manage-from-anywhere — manage it from <projectDir> or with \`--run-dir <runDir>\`)` | stderr note |
| M18 | `offbook: this server was started by an older offbook build — restart it (\`offbook down\` then \`offbook up\`) to manage it from here` | stderr, exit 2 |
| M19 | `(offbook: showing the local stopped log at <path>; a live offbook runs in <projectDir> — \`offbook logs --run-dir <runDir>\` for its log)` | stderr note |
| M20 | `the only running offbook is the bundled demo (started in <dir>) — run \`offbook down\` to stop it, then \`offbook up <dir>\` for your mock`; `--json`: the `demo-only` envelope | stderr / stdout envelope, exit 1 |
| M21 | `this skill predates manage-from-anywhere — its advice about which directory to run offbook in is now wrong; run \`offbook skill install\` to refresh it` | doctor warn row |
| M22 | `offbook down: the instance restarted underneath — rerun \`offbook down\`` | stderr, exit 1 |

Instance table row shape (M6/M8/M9 share it):
`  <projectDir> [demo] — ws <n> · tcp <n> · http <n> · pid <n>` followed by
`    offbook down --run-dir <runDir>` (the refused verb substituted), complete and
double-click copyable. The existing `offbook is not running` leading token and the
`(offbook:` note prefix are the two automation-greppable anchors, pinned in D-032.

## Contract, requirements, and docs impact

Amendments to the frozen contract, recorded as the next free `D-###` (D-032 at time of
writing; REQUIREMENTS.md tops out at R-043, DECISIONS.md at D-031):

- **contracts.md §5 (G14) runfile field list**: amended to add **`token`** and
  **`host`**. The existing reader tolerates unknown fields; state-table row 2 covers
  pre-upgrade runfiles.
- **contracts.md §1a**: both runDir comment sites (lines ~89 and ~106). The clause
  "up/down/logs/status resolve it identically" is **superseded**: replaced by
  cwd-first-then-registry resolution and the projectDir-relative default under
  `up [dir]` (`--run-dir` stays cwd-relative).
- **contracts.md §5 (G14)**: the registry paragraph (machine-local state; path
  scheme, pointer shape, same-directory atomic writes, the deletion law and guarded
  mutation, the host rule, best-effort guarantee), the resolution order, and the
  reworded "cwd-relative" parenthetical.
- **contracts.md §5 reads table**: one new row, `GET /v1/server`, with the
  channel-instance disambiguation note.
- **`src/cli/runfile.ts` header comment**: transcribes the superseded clause; swept.
- Untouched: the "up / down are NOT HTTP endpoints" sentence, the ErrorCode union,
  `/v1/mode`.

The **D-032 entry** additionally records:

- The **exit-code contract** (0/1/2 table above) and the two automation anchors (the
  `offbook is not running` leading token, the `(offbook:` note prefix), plus the
  `--json` single-document contract and refusal-envelope shape. The §10
  refusal-semantics change is release-noted as a **breaking automation surface**;
  scripted consumers are pointed at `--run-dir` for pinned-instance semantics
  (byte-identical on the same host).
- The docs sweep is **grep-driven, not memory-driven**: transcription sites are
  enumerated by grepping the catalog's wordings and the pinned phrases (`runfile`,
  `run-dir`, `in this run-dir`, `resolve it identically`, `refuses without a live
  server`) across `docs/`, `skills/`, and `src/**/*.ts` headers; the grep and hit
  list land in the D-032 entry. Two already-missed sites are named now: adoption.md
  §10's staleness-honesty resolution sentence and §9's step-6 parenthetical.
- The mutation-gate scope extension and its campaign obligation (Testing).
- The fast-follow R-### stubs from the scope trims (file-identity dedupe;
  moved-directory unverified naming; any richer version-skew handling; the optional
  TTY-only picker).

Process: an intake round per `docs/specs/doc-system.md` resolving into the next free
`R-###`s (R-044 onward), cut in dependency order:

1. `GET /v1/server` + identity primitives (token/host in runfile and boot file,
   absolute runDir baked by `up`, serve.ts verification, EPERM fix, readiness =
   identity),
2. registry + resolver + state table + verb policy + guarded mutation + attribution
   naming (consumes 1),
3. `up [dir]`,
4. the docs sweep.

The round closes the archived open finding "the undocumented cwd premise" and
discharges the F1 runner-up (daily-loop cwd note).

Docs sweep (derived docs; contracts > guides > skill; management verbs only):

- `docs/guides/daily-loop.md`: `"mock:up": "offbook up mock"`, `"mock:down": "offbook
  down"`; drop `cd mock &&` around management verbs; the **two-sentence user model**
  (Goal section) verbatim; the scripted-consumer `--run-dir` line.
- `docs/guides/getting-started.md`, `docs/guides/wiring-your-service.md`, `README.md`:
  drop implied-cwd phrasings; the user model sentence; one migration sentence
  (instances started before this build stay invisible to machine-wide discovery until
  restarted or managed locally once; doctor notes them).
- `docs/specs/adoption.md` §10: attribution gains the named-owner variant and its
  paste-ready command; "no guess at which offbook instance it is" superseded; the
  pinned `topics --json` refusal wording, its "run-dir qualifier matters" rationale,
  and the two grep-recovered sites superseded.
- `skills/offbook-onboard/SKILL.md`: steps 5/6 lose `cd mock`; step 6's checks are
  **pinned to the instance**: `offbook topics --json --run-dir mock/.offbook` (so
  "refusal means `up` failed" stays exactly true) and `offbook logs --run-dir
  mock/.offbook` (so a stray root-level log cannot feed the agent stale connect
  lines); the port-conflict recipe quotes M3.

## Edge cases

- **Booting instance** (row 3, up to 30s): skipped, never reaped or reclaimed;
  discoverable the moment `/v1/server` answers.
- **Wedged instance**: row 3; stoppable locally or via `--run-dir` on its own host;
  surfaced by M13 elsewhere.
- **Pid reuse, pid namespaces, shared network homes**: token and host rule; never
  named, never signaled, never reaped from the wrong side; the pasted selector on the
  wrong machine refuses with M10.
- **`down` racing a `--watch` respawn**: guarded-mutation site #3 aborts with M22;
  the successor's registration survives site #2.
- **`.offbook` deleted under a running instance**: row 9 self-heal on default ports;
  on custom ports the reap proceeds with the hedged M14 and doctor's ports check
  still names the live owner via `/v1/server`.
- **Concurrent `up`s in one directory**: sites #4 and #1 (freshness) protect the
  winner.
- **Version skew**: pre-upgrade instances are manageable locally (row 2), adopted
  into the registry on first local contact, and surface machine-wide as skipped
  (M13), never as silence; `status --ctrl-port` refuses with M18.
- **Unwritable state dir**: M17, then cwd-scoped behavior exactly as today.
- **`--run-dir` semantics**: never consults the registry; same host, byte-identical
  to today (the scripting escape hatch); accepts a projectDir whose `.offbook`
  exists; foreign hosts refuse with M10.
- **Documented limitations** (see Non-goals): case-aliased duplicate listing;
  moved-directory naming; pre-upgrade `--ctrl-port` identity.

## Testing

- **Guarded-mutation helper**: unit-tested once (precondition unchanged / changed /
  gone), then each of the five sites pinned via the site table (site #1 freshness:
  pointer rewritten between check and unlink survives; #2 conditional clear; #3
  abort on repointed runfile; #4 concurrent-`up` winner survives; #5 self-heal skips
  when a runfile reappeared).
- **State table as checklist**: one integration test per row (the table's cells are
  the assertions), including row 2 (pre-upgrade fallback + adopt-on-sight), row 4
  (wrong-token: nothing reclaimed, nothing signaled), row 9 both branches, row 10
  (foreign-host records inert; M10 on `--run-dir`).
- **Registry unit tests**: temp file inside `instances/` asserted; scan name filter;
  realpath-string dedupe winner; corrupt pointers; idempotent `clearRunfile` on
  nonexistent runDirs; the module throwing when no state dir was injected.
- **Verb policy / catalog**: cli-dispatch assertions driven by the message catalog
  (string, stream, exit code per cell): M6 table on `down`'s unrelated no-op
  (exit 0); M8 ambiguity (stderr table + exit 2, `--json` envelope on stdout,
  nothing else on stdout); M9; M12 replaces M11+M13 (asserted mutually exclusive);
  M16 headers on registry-resolved reads and byte-identical cwd-resolved output;
  M15 only on mutating verbs; M19 (including `-f`); M20 demo refusal; M18; `status
  --json` `server` block + `skipped` array; the two automation anchors greppable.
- **Tiebreak**: both containment stages, the demo stage (M15d), and the negative
  predicate cases (prefix-sibling must not match; symlinked projectDir must match
  its real subtree).
- **`up [dir]`**: happy path (exactly one runfile + one pointer; `/v1/server` runDir
  equals the CLI-resolved one), `up <missing-dir>`, `up <file>` (M2 before any
  write).
- **`GET /v1/server`**: response shape (token, host, demo); relative runDir in the
  boot file is a fatal boot error; a `--watch` respawn with the launch cwd deleted
  keeps serving with a correct runfile and the same token, new pid (pinning the
  launch-token granularity).
- **Hermeticity**: the explicit state-dir parameter makes unpinned test invocations
  throw; the bunfig preload pins `OFFBOOK_STATE_DIR` suite-wide and resets the shared
  scratch dir between test files (every `writeRunfile` caller is a registry writer:
  `src/cli/doctor.test.ts:401,426` and the cli-dispatch fake-runfile sites included);
  server-booting tests keep per-test scratch dirs and no-leftover-pointer asserts
  (the 2026-08-12 lesson, extended).
- **Mutation gate**: extend the mutate scope over `src/cli/runfile.ts`, the resolver
  module, and the guarded-mutation helper; one focused full campaign on the new
  modules before the round closes. Until then the changed-file gate silently measures
  nothing for `src/cli` paths.
- **Doc-system gate**: the new `R-###`s carry arrow-tag comments in both directions
  per `bun scripts/check-docs.ts`.
