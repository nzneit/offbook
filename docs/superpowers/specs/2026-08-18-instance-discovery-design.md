# Instance discovery: manage a running offbook from any directory

**Date:** 2026-08-18
**Status:** approved design (brainstorm round), pre-plan. Revised twice: rev 1 folded a
three-checker adversarial verification pass (code facts, canonical-doc facts, design
quality); rev 2 folds the 35-mode DFMEA round (AIAG-VDA action priority: 15 H / 19 M /
1 L), whose High and Medium actions are all incorporated below.
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

## Non-goals

- No shutdown-over-HTTP: `down` stays signal-based; the frozen "up / down are NOT HTTP
  endpoints" sentence (contracts.md §5) survives untouched.
- No cross-machine or cross-container management. Discovery, naming, and signaling are
  machine-local: pointers and runfiles record their host, foreign-host records are never
  candidates and never touched, and the pid-only paths refuse with a named error rather
  than signal into a foreign pid table (see the host rule).
- No per-instance port auto-allocation; the fixed defaults and `--*-port` flags stand.
- No bulk *management* operations (`down --all`, stop-everything). A read-only table of
  candidates appears in exactly one place: the ambiguity refusal (n=1 discipline).
- `init` and `doctor` stay cwd-scoped this round (doctor gains only the registry-aware
  notes below); the docs sweep therefore drops `cd` only around management verbs, not
  around `init`/`doctor` passages.
- No `demo --serve [dir]` positional; the demo keeps starting from cwd.
- No cross-directory post-mortem `logs`: once an instance is stopped or reclaimed (its
  pointer removed), its log is reachable only in its project directory or via
  `--run-dir`. In the project directory itself, `logs` keeps working post-mortem (see
  the `logs` exception in the resolution rule).

## Design overview

Resolution order for every management verb: a **live** cwd runfile wins (today's
behavior); a stale cwd runfile is reclaimed only when its pid is dead and resolution
falls through to a machine-global index of instances, where a candidate counts as live
only after an **identity** check against the actual server. Identity means a per-boot
random token, not pid equality: the token is written into the runfile at boot and
echoed by the server over HTTP, so pid reuse, pid namespaces, and cross-machine mounts
can never produce a false match. Exactly one live instance: the verb targets it and
says so. Several: a candidate uniquely related to cwd by directory containment wins;
still ambiguous, refuse with a table of candidates and copy-paste selectors. None:
today's "not running" messages, now true, qualified by an honesty note whenever a
live-pid candidate had to be skipped. The index holds pointers only; all state stays in
the per-instance runfile and boot file.

The flagship flow, walked through: `offbook up mock` from `/app` starts the instance
with projectDir `/app/mock` and runDir `/app/mock/.offbook` (both absolute in the boot
file); a later `offbook status` from `/app` finds no `/app/.offbook` runfile, resolves
via the registry (the strict-descendant tiebreak below covers even the multi-instance
case), prints `(using the offbook started in /app/mock)` on stderr, and reports
truthfully.

## Identity: the boot token and the host rule

The DFMEA's four severity-9 findings share one root: **pid equality is not identity.**
A pid matches across reuse (the process died, the number came back), across pid
namespaces (a devcontainer's pid 42 and the host's pid 42 are different processes), and
across machines mounting the same filesystem. All identity in this design therefore
rests on two fields added to the runfile (a G14 field-list amendment, D-032):

- **`token`**: a per-boot random value (128-bit hex) generated by `up`/`demo --serve`,
  baked into the boot file, written into the runfile at every runfile write, and echoed
  by `GET /v1/server`. Verifying an instance means: the server answering the runfile's
  control port returns this runfile's token. Pids are demoted to what they can actually
  do: local liveness (`pidAlive`) and signal delivery.
- **`host`**: `os.hostname()` at boot, recorded in both the runfile and the registry
  pointer. The **host rule**: a runfile or pointer whose host differs from the local
  hostname is never a candidate, never reaped, and never signaled; the pid-only paths
  (local `down`, `--run-dir down`) refuse with a named error
  (`this runfile was written on <host> — offbook cannot manage it from <this host>`)
  instead of signaling into a foreign pid table.

Two liveness-primitive fixes ride along: `pidAlive` treats EPERM as
alive-but-unsignalable (today it reads as dead), and the identity probe retries once
with a longer timeout before concluding not-answering, so a loaded machine does not
demote a healthy instance.

## The registry: pointers, not state

One file per instance:

```
${OFFBOOK_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/offbook}/instances/<sha256(runDir)>.json
```

- The registry is **machine-local state** (documented as such in the contracts.md §5
  registry paragraph); the host rule above is what makes a shared network home safe.
- The fallback path is used verbatim on every platform, resolved against
  `os.homedir()`; if no home directory resolves, the registry is unavailable and the
  best-effort degradation below applies.
- The registry module takes its state dir as an **explicit parameter**; the production
  default is injected only at the CLI entry point. Code that never received a state dir
  throws instead of defaulting into the real home, which removes the class of test
  invocations that bypass the suite's pin (see Testing).
- The hash input is the absolute, symlink-resolved runDir (`realpathSync` after the
  runDir is created). Scans dedupe candidates by **file identity of the target
  runfile** (dev+inode; `realpathSync.native` on Windows), not by path strings, so
  case-insensitive filesystems and mount-aliased paths collapse to one candidate: the
  realpath-keyed pointer wins and the twin is deleted on sight.
- Pointer content: `{ "v": 1, "runDir": "<absolute path>", "host": "<hostname>" }`.
  Nothing else. Ports, pid, token, and startedAt live in the target's `offbook.run`;
  projectDir lives in the target's `offbook.boot.json`. A pointer can never disagree
  with the runfile, only dangle.
- Pointer writes are atomic: the temp file is created **inside `instances/` itself**
  (`<sha>.json.tmp<pid>`) so the rename never crosses a filesystem boundary (EXDEV);
  scans consider only names matching `<64 hex>.json`, so a crash-leaked temp file is
  inert.
- Write/remove sites: inside `writeRunfile` and `clearRunfile` (`src/cli/runfile.ts`),
  which automatically covers all three runfile writers (`launchDetached`'s initial
  write, serve.ts's post-boot rewrite, the `--watch` respawn) and all clearers (`down`,
  the pid-dead reclaim, failed boot). Additionally, resolution step 3 **adopts on
  sight**: a live cwd runfile with no pointer gets one written (this converges
  instances that predate the registry the first time anyone manages them locally).
  `runfile.ts` resolves runDir to absolute internally. On the remove path,
  `clearRunfile` falls back to `path.resolve` when `realpathSync` fails (a runDir that
  never existed never had a pointer under the realpath hash), preserving `down`'s
  idempotence against nonexistent run dirs.
- `launchDetached`'s failed-boot cleanup is double-guarded: it clears the runfile and
  pointer only if (a) the runfile still names the pid this `up` spawned (read-compare
  before remove) and (b) a final control-port probe finds no offbook answering with a
  different token (if one answers, a winner exists and the clear is skipped entirely),
  so a losing concurrent `up` cannot deregister the winner.
- **Reaping (narrow, guarded):** a scan deletes a pointer only when the target runfile
  is missing or the runfile's pid is dead, and only for local-host records. Guards:
  - *Self-heal before the missing-runfile reap:* probe the default control port first;
    if `GET /v1/server` answers with a runDir equal to the pointer's, the instance is
    alive and de-runfiled (someone deleted `.offbook` under it): rewrite the runfile
    from the served identity instead of reaping. Only when nothing answers does the
    reap proceed, and its honesty wording hedges rather than asserts:
    `(last instance: <runDir> — its runfile is gone; if ports are still busy, run
    \`offbook doctor\`)`.
  - *Freshness guard:* immediately before the unlink, re-stat the pointer and skip the
    reap if it changed since the scan read it, so a reap never consumes a successor
    pointer written mid-scan.
  - A pointer whose pid is alive but whose identity check fails or times out is
    *skipped* for this invocation, never deleted: a booting instance legitimately has a
    live pid and a silent control port for up to the 30s readiness window.
  - A corrupt pointer file (unreadable JSON) is skipped and reaped; same-directory
    atomic writes make that state unreachable by normal operation.
- Best-effort always: an unwritable or unreadable state dir degrades to cwd-scoped
  behavior with a one-line stderr warning; registry failures never block `up` or any
  other verb. When `up [dir]` cannot write the pointer, the warning must include the
  recovery selector, e.g. `instance registry unavailable — manage this instance from
  <projectDir> or with --run-dir <projectDir>/.offbook`, because discovery from the
  launch cwd depends entirely on the registry in that flow.
- `demo --serve` registers like any instance (it already writes a runfile via
  `launchDetached`); its boot file's `demo: true` flows into `/v1/server`, and every
  naming surface renders it (see verb-by-verb).
- `OFFBOOK_STATE_DIR` exists for test hermeticity and unusual setups; it is documented
  but not a primary interface.

## Resolution rule

One shared resolver returning the resolved instance, not just a port:
`{ runDir (absolute), runfile, source: "cwd" | "registry", skipped: [...] }`, so verbs
can locate `offbook.log`/`offbook.boot.json` for the instance they actually resolved
and disclose what was passed over. Today's seams it replaces or feeds:
`resolveRunning` (status, launchDetached guard), `resolveCtrlPort` (client verbs,
`src/cli/client.ts`), `down`'s direct `readRunfile` + `pidAlive`
(`src/cli/index.ts:1231`), `logs`' `logPath` (`src/cli/index.ts:1333`), and
`specs update`'s `specsStalenessWarning(runDirOf(...))` (`src/cli/index.ts:722-725`).

1. `--ctrl-port` given (client verbs, and newly `status`): use it, skip everything
   below (unchanged semantics; run-dir correspondence stays unverified, so log- and
   boot-file-derived extras are skipped as today).
2. Explicit `--run-dir` given: resolve against that runDir only; the flag is precise
   addressing and disables the global fallback (which is what makes the refusal's
   selectors work). The host rule applies: a foreign-host runfile refuses with the
   named error instead of resolving.
3. Default runDir, runfile present in `<cwd>/.offbook`:
   - **Live** (pid alive AND the control port answers `GET /v1/server` with this
     runfile's token; one retry with a longer timeout first): cwd wins, exactly
     today's semantics. If the runfile predates the token field (a pre-upgrade
     instance), fall back to the old probe (`/v1/mode` answers) and treat as
     live-unverified: local reads and local `down` work as today. Either way, a live
     cwd runfile with no pointer is adopted on sight (pointer written).
   - **Pid alive, port silent or token mismatch**: never reclaimed. Emit the honesty
     note (`an instance here (pid <n>) is not answering on port <n> — booting or
     wedged; \`offbook down\` still stops it` for the silent case; a token mismatch
     names the impostor instead) and fall through to step 4 for read verbs. `down`
     keeps its deliberately-weaker local path here: a host-matching, pid-alive local
     runfile is signalable pid-only (the wedged-server rule), with the
     compare-and-signal guards below.
   - **Pid dead**: reclaim runfile + pointer with a note stating the actual observed
     reason (never "pid N is gone" about a live pid), then fall through to step 4.
4. Otherwise scan the registry (candidates probed concurrently; cost stays bounded by
   reaping plus the n=1 discipline). A pointer is a **live candidate** only if all of:
   host matches, the target runfile exists, its pid is alive, and `GET /v1/server` on
   the runfile's control port returns 200 with this runfile's **token** (retry once,
   longer timeout). A 404, timeout, or token mismatch makes the pointer
   not-a-candidate for this invocation (skipped, and reaped only per the narrow reap
   rule). Token verification is what makes registry-resolved `down` safe: pid reuse,
   pid namespaces, and foreign machines all fail the token match and are never
   signaled.
   - **One live candidate:** target it. Print a redirection note to **stderr**:
     `(using the offbook started in <projectDir>)`, with the demo variant
     `(using the offbook demo started in <dir>)`. In human mode the note is suppressed
     for verbs whose own output names the instance (`down`, `status`); under `--json`
     it always prints (stderr, stdout stays clean). For `down`: if any live-pid
     candidates were *skipped* alongside the one verified candidate, refuse with the
     candidate table instead of signaling, unless the verified candidate wins the
     containment tiebreak.
   - **Two or more:** containment tiebreak, predicate specified: both sides
     realpath-normalized, containment = `path.relative(a, b)` neither escapes to
     `..` nor is absolute (segment-boundary, so `/x/repo` never "contains"
     `/x/repo-wip`). Stage one: exactly one candidate's projectDir is
     ancestor-or-equal of cwd. Stage two: exactly one candidate's projectDir is a
     strict descendant of cwd (the flagship `up mock`-from-`/app` case). Otherwise
     refuse: one line per candidate (projectDir, the three ports, pid, demo marker)
     plus `rerun with --run-dir <absolute runDir>`, on stderr, **exit code 2**
     (documented; distinct from exit 1's "not running" so scripts can branch), and
     under `--json` a stdout refusal object
     `{ "error": "ambiguous", "candidates": [{projectDir, runDir, ports, pid, demo}] }`.
   - **Zero live:** today's not-running errors, reworded to claim only what was
     verified: `offbook is not running (no runfile in .offbook, no verifiable live
     instance in the registry) — run \`offbook up\`, or pass --ctrl-port`. Honesty
     extras, attached to the **resolver result** so every verb's output carries them
     (not just status/down): the one-shot reap lines (hedged missing-runfile variant
     above; `(last instance: <projectDir>, pid <n>, gone)` for a pid-dead reap), and
     whenever live-pid candidates were skipped:
     `(an instance in <projectDir> (pid <n>) is not answering on port <n> — manage it
     from that directory or with --run-dir)`. Exit codes stay as today (status 1,
     down 0).

**`logs` exception:** `logs` is local-first on the *log file*: if
`<cwd>/.offbook/offbook.log` exists, print it (today's semantics, which is what makes
in-directory post-mortem work after `down`). **Divergence banner:** when that local log
exists but its runfile is absent or stale AND steps 2-4 would resolve a live instance
elsewhere, one stderr line precedes it: `showing the local (stopped) log at <path>; a
live offbook runs in <projectDir> — \`offbook logs --run-dir <its runDir>\` for its
log`. Only when no local log exists does `logs` resolve via steps 2-4.

**Script-safety guard on `down`:** when `down` resolves via the registry to a sole
candidate whose projectDir is neither an ancestor nor a descendant of cwd AND stdout is
not a TTY, refuse with the candidate line and the `--run-dir` selector instead of
signaling. Interactive invocations keep the flagship from-anywhere behavior; a headless
`"mock:down": "offbook down"` script can never silently kill an unrelated project's
instance (or a forgotten demo) just because its own instance already exited.

No new flag names anywhere; `status` additionally accepts the already-existing
`--ctrl-port` flag (see verb-by-verb). `projectDir` for notes and refusal tables comes
from `GET /v1/server` for live candidates and from the target's `offbook.boot.json`
otherwise.

**Asymmetry, stated:** local `down` keeps its deliberately-weaker pid-only path so it
can kill a wedged server whose control port stopped answering; the registry path
requires token identity and therefore cannot. A pid-alive/port-dead instance remains
stoppable only from its own directory or via `--run-dir`, on its own host.

## `GET /v1/server`

New control-plane read. (Named `server`, not `instance`: "instance" is a frozen
contract term for materialized channel instances, `InstanceRegistry`/
`InstanceSnapshot`/the `no-instances` diagnostic, contracts.md §3/§5.)

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

- `up` bakes the **resolved absolute runDir** (and projectDir, and the boot token) into
  `offbook.boot.json`; serve.ts treats a still-relative runDir in the boot file as a
  fatal boot error rather than resolving it against its own cwd. This makes serve's
  boot-time resolution a verification no-op, keeps the `--watch` respawn correct even
  when the inherited cwd was moved or deleted mid-run (the absolute path survives in
  the boot file, not in process memory), and closes the flagship double-registration
  hazard (`up mock` from `/app` must never yield a second `/app/.offbook`).
- Uses: (a) the step-3 and step-4 identity checks (token match), which
  registry-resolved `down` depends on; (b) naming the owner in the port-conflict
  attribution; (c) `--ctrl-port` users seeing who they are talking to.
- Version skew: builds without `/v1/server` also wrote no pointers, so a 404 on a
  pointer-found instance simply means not-a-candidate (surfaced by the skip note, not
  silence). For `status --ctrl-port` specifically, a 404 with `/v1/mode` answering
  degrades to mode-only output plus `(this server predates /v1/server — identity
  unavailable; restart it on the new build)`.
- The response uses no new ErrorCode; the closed union is untouched.

## Verb-by-verb changes

- **`up [dir]`**: new optional positional, default `.`. Preflight first: the resolved
  path must exist and be a directory, else exit 1 naming the resolved absolute path,
  **before** any mkdir, boot-file, or pointer write (a typo'd positional must not
  litter the tree). `projectDir = resolve(cwd, dir)` goes into the boot file along
  with the absolute runDir and the boot token. The default runDir becomes
  `<projectDir>/.offbook` (an explicit `--run-dir` stays cwd-relative, as today). The
  EI2 fresh-project orientation check (`src/cli/index.ts:1164`, `handlersDir`) uses
  projectDir instead of cwd. The no-services.yaml failure hint is reworded to say
  `offbook init` must run in `<projectDir>` (not bare "run offbook init", which from
  elsewhere points at the wrong directory).
- **`up` preflight + `doctor` ports check**: when the busy control port answers
  `GET /v1/server` and the token matches the claimed runfile, the attribution names
  the owner and gives the always-correct selector: `another offbook owns the control
  port 9080 (started in <projectDir>) — \`offbook down --run-dir <absolute runDir>\`
  stops it from anywhere on this machine`, with the demo variant `(the bundled demo,
  started in <dir>)`. When the served identity's runDir no longer exists on disk (the
  directory was moved under a running server), the name is printed but marked
  unverified, with a recovery hint. When unverifiable (foreign checkout, no pointer,
  token mismatch), today's generic wording stands; discovery never invents facts.
- **`doctor` runfile check**: two registry-aware notes. No local runfile but a live
  registered instance: `no runfile here; a live offbook is registered: <projectDir>,
  ports ws <n> / tcp <n> / http <n>`. A live local runfile with no pointer (pre-upgrade
  instance): note that it is invisible to machine-wide discovery until restarted or
  managed locally once. Doctor's skill-staleness check (R-042) escalates its wording
  when the installed skill's stamp predates the discovery release: `this skill predates
  instance discovery — its first-light guidance is inverted; reinstall before
  onboarding`. Doctor is otherwise cwd-scoped (non-goal).
- **`down`**: resolves via the rule above, then **compare-and-signal**: the identity
  probe is the last operation before SIGTERM; immediately before the kill, re-read the
  runfile and abort with `instance restarted underneath — rerun offbook down` if the
  pid changed (the `--watch` respawn window); the kill is guarded against ESRCH. The
  SIGKILL escalation re-verifies: re-read the runfile and escalate only if it still
  names the signaled pid AND the port is silent or answers with that token; a pid that
  no longer matches is never SIGKILLed. After the kill, the clear is conditional:
  re-read once more and clear runfile + pointer only if they still name the signaled
  pid (a respawned successor's registration is never deleted). Output names what it
  stopped, demo-aware: `offbook: stopped (pid <n>, started in <projectDir>)` /
  `stopped the demo started in <dir>`. Still idempotent: nothing resolvable anywhere
  is `offbook: not running`, exit 0, qualified by the skipped-candidates note when
  live-pid candidates exist.
- **`status`**: resolves via the rule above; prints which instance it is reporting.
  The R-043 connects line keeps working (the resolver hands it the resolved absolute
  runDir for `offbook.log`). `--json` gains a `server` block:
  `{ "projectDir": ..., "runDir": ..., "source": "cwd" | "registry" }`, so machine
  consumers can never mistake whose status document they hold; the stderr redirection
  note also still prints under `--json` (suppression is human-mode only). Gains the
  existing `--ctrl-port` flag: identity-only reporting (`/v1/server` + `/v1/mode`),
  no log-derived extras, with the 404 version-skew fallback above.
- **`logs`**: local-log-first with the divergence banner (see the `logs` exception).
- **`specs update`**: `specsStalenessWarning` reads the *resolved* instance's
  `offbook.boot.json` (via the resolver's runDir) instead of `<cwd>/.offbook`'s, so
  the staleness warning fires from anywhere; it keeps skipping under `--ctrl-port`
  (correspondence unverified), as today.
- **Client verbs** (`topics`, `publish`, `validation`, `state`, `scenario`/
  `scenarios`, `mode`, `reset`, `specs`, `check`, `diagnostics`): `resolveCtrlPort` is
  replaced by the shared resolver; the not-running wording claims only what was
  verified (see step 4's zero-live bullet) and carries the resolver's honesty notes.
- **`topics`**: the bundled-demo fallback (human output) fires only when steps 3-4
  produced nothing live *and nothing skipped* (a skipped candidate adds the honesty
  note to the fallback text). `--json`: refuses as today when nothing is live; when
  the *resolved* instance reports `demo: true`, it also refuses, naming the demo:
  `the only running offbook is the bundled demo (started in <dir>) — not this
  project's mock; run \`offbook up\``. An agent must never receive thermostat topics
  as clean JSON while onboarding a real project (the R-043 first-light integrity
  rationale, carried over to machine-wide resolution).

## Contract, requirements, and docs impact

Amendments to the frozen contract, recorded as the next free `D-###` (D-032 at time of
writing; REQUIREMENTS.md tops out at R-043, DECISIONS.md at D-031):

- **contracts.md §5 (G14) runfile field list**: amended from "pid + the three ports +
  `startedAt`" to add **`token`** and **`host`** (the identity primitives). The
  existing reader tolerates unknown fields, so pre-upgrade runfiles parse; the token
  fallback in step 3 covers them.
- **contracts.md §1a**: both runDir comment sites (the `Config` interface comment,
  line ~89, and the `DEFAULT_CONFIG` example comment, line ~106) are amended. The
  clause "up/down/logs/status resolve it identically" is **superseded**, not extended:
  the replacement states cwd-first-then-registry resolution for management verbs and
  the projectDir-relative default under `up [dir]` (`--run-dir` stays cwd-relative).
- **contracts.md §5 (G14)**: a paragraph for the instance registry (machine-local
  state; path scheme, pointer shape, same-directory atomic writes, the narrow-reap
  lifecycle with its self-heal and freshness guards, the host rule, best-effort
  guarantee) and the resolution order; additionally the existing parenthetical
  "`<runDir>` = `config.runDir`, cwd-relative, default `.offbook/`" is reworded to the
  projectDir-relative default, cross-referencing the amended §1a.
- **contracts.md §5 reads table**: one new row, `GET /v1/server`, with a
  disambiguation note against the channel-instance sense of "instance".
- **`src/cli/runfile.ts` header comment**: transcribes the superseded "resolve it
  identically" clause; swept with the contract amendment.
- Untouched: the "up / down are NOT HTTP endpoints" sentence, the ErrorCode union,
  `/v1/mode`.

The **D-032 entry** additionally records:

- The §10 refusal-semantics change as a **breaking automation surface** (release-note
  it): the former exit-1 "no running offbook in this run-dir" can now be exit 0 with
  another instance's data. Mitigations shipped with it: the leading token `offbook is
  not running` is preserved in the new wording, exit codes are documented as contract
  (1 = not running / request failure, 2 = ambiguous), and the guides gain one line
  telling scripted consumers to pass `--run-dir` for pinned-instance semantics
  (byte-identical behavior on the same host).
- The docs sweep is **grep-driven, not memory-driven**: enumerate transcription sites
  by searching the pinned phrases (`runfile`, `run-dir`, `in this run-dir`, `resolve
  it identically`, `refuses without a live server`, the attribution and refusal
  wordings) across `docs/`, `skills/`, and `src/**/*.ts` headers; the grep and its hit
  list are recorded in the D-032 entry. Two sites the enumerated list had already
  missed are named now: adoption.md §10's staleness-honesty resolution sentence
  (`specs update` "resolves the run dir as every client verb does") and §9's step-6
  parenthetical (topics --json "refuses without a live server").
- The mutation-gate scope extension (below) and its campaign obligation.

Process: an intake round per `docs/specs/doc-system.md` (start from
`docs/intake/_TEMPLATE.md`) resolving into the next free `R-###`s (R-044 onward),
expected cut **in dependency order**:

1. `GET /v1/server` + the identity primitives (token/host in runfile and boot file,
   absolute runDir baked by `up`, serve.ts verification, EPERM fix),
2. registry + resolution rule across all management verbs + attribution naming
   (consumes 1: token-gated liveness, compare-and-signal `down`),
3. `up [dir]`,
4. the docs sweep below.

The round also closes the archived open finding "the undocumented cwd premise"
(2026-08-12 Addendum) and discharges the F1 runner-up (daily-loop cwd note).

Docs sweep (derived docs; contracts > guides > skill; management verbs only, `init`/
`doctor` passages keep their cwd framing per the non-goal):

- `docs/guides/daily-loop.md`: package scripts become `"mock:up": "offbook up mock"`,
  `"mock:down": "offbook down"`; drop the `cd mock &&` idiom around management verbs; a
  short "manage from anywhere" note; the scripted-consumer `--run-dir` line.
- `docs/guides/getting-started.md`, `docs/guides/wiring-your-service.md`, `README.md`:
  drop implied-cwd phrasings around management verbs; state the resolution rule in one
  sentence; one migration sentence: instances started before this build stay invisible
  to machine-wide discovery until restarted or managed locally once (doctor notes
  them).
- `docs/specs/adoption.md` §10: the attribution wording gains the named-owner variant
  and its `--run-dir` selector ("on this machine"); the "no guess at which offbook
  instance it is" sentence is superseded; the pinned `topics --json` refusal wording,
  its "run-dir qualifier matters" rationale, and the two grep-recovered sites above
  are superseded (new semantics: refuse only when nothing verifiable is live
  machine-wide, demo-resolution refuses by name).
- `skills/offbook-onboard/SKILL.md`: steps 5/6 lose `cd mock` around management verbs;
  step 6's refusal rationale ("that refusal means `up` failed") is rewritten for the
  machine-wide semantics; the port-conflict recipe quotes the new attribution.

## Edge cases

- **Booting instance** (pid alive, port silent, up to 30s): skipped as a candidate,
  never reaped or reclaimed; discoverable the moment `/v1/server` answers; surfaced by
  the honesty note meanwhile.
- **Wedged instance** (pid alive, port dead): never reclaimed; stoppable locally or
  via `--run-dir` (same host); surfaced by the skipped-candidates note everywhere
  else.
- **Pid reuse, pid namespaces (devcontainers), shared network homes**: all fail the
  token match and/or the host rule; never named, never signaled, never reaped from the
  wrong side. The `--run-dir` selector pasted on the wrong machine refuses by name.
- **`down` racing a `--watch` respawn**: compare-and-signal aborts on the repointed
  runfile ("instance restarted underneath"); the successor's registration survives the
  conditional clear.
- **`.offbook` (or the project) deleted under a running instance**: the
  missing-runfile reap self-heals via the default-port probe (runfile rewritten from
  the served identity); on custom ports the reap proceeds with the hedged wording, and
  doctor's ports check still names the live owner via `/v1/server`.
- **Project directory moved while running**: `/v1/server` keeps serving the boot-time
  identity; naming surfaces print it marked unverified with a recovery hint.
- **Version skew**: a pre-upgrade instance is manageable locally via the token-less
  fallback and adopted into the registry on first local contact; machine-wide it
  surfaces as a skipped candidate (with note), never as silence. `status --ctrl-port`
  against it degrades to mode-only output with the version notice.
- **Mount-aliased or case-aliased runDirs**: collapsed by file-identity dedupe (one
  candidate, no phantom twin in the refusal table).
- **Concurrent `up`s in one directory**: the double-guarded failed-boot clear (pid
  compare + token probe) cannot deregister the winner; the freshness guard keeps a
  mid-scan reap off the successor pointer.
- **Unwritable state dir**: one stderr warning (with the recovery selector on
  `up [dir]`), then cwd-scoped behavior exactly as today.
- **`--run-dir` semantics**: never consults the registry; on the same host,
  byte-identical to today (the scripting escape hatch); foreign-host runfiles refuse
  by name.

## Testing

- **Registry unit tests**: pointer lifecycle (write-on-writeRunfile,
  remove-on-clearRunfile); atomic write with the temp file asserted to live inside
  `instances/`; the scan name filter (temp/garbage names inert); the narrow reap rule
  (missing-runfile reap with self-heal probe both ways, dead-pid reap,
  live-pid-silent-port skip-not-reap, freshness guard: pointer rewritten between check
  and unlink survives); host rule (foreign-host pointer skipped, never reaped);
  file-identity dedupe (two pointers to one runfile yield one candidate, twin
  deleted); corrupt pointers; unwritable-dir degradation; `clearRunfile` on a
  nonexistent runDir (idempotence); the module throwing when no state dir was
  injected. All under scratch state dirs.
- **`test/cli-dispatch.test.ts` integration**: wrong-directory `status`/`down`/`logs`/
  `topics` resolving via the registry (scratch state dir, scratch project dirs,
  non-default ports per the existing hermetic-test pattern); the pid-dead
  stale-cwd-runfile reclaim + fall-through; the **wedged-instance** case (pid alive,
  port silent: runfile survives `status`, honesty note prints, local `down` still
  signals); the cwd **reused-pid/foreign-port** case (token mismatch: nothing
  reclaimed, nothing signaled, impostor named), symmetric to the registry-path
  identity test (fabricated pointer + runfile naming a live-but-unrelated pid or
  wrong token is skipped and never signaled); `down` racing a `--watch` respawn
  (abort message, successor registration intact); the non-TTY script-safety refusal
  (sole unrelated candidate, stdout piped); both tiebreak stages plus the negative
  predicate cases (prefix-sibling must not match; symlinked projectDir must match its
  real subtree); the ambiguity refusal (stderr table, exit **2**, `--json` stdout
  refusal object); attribution naming with the `--run-dir` selector, including the
  demo variant and the moved-directory unverified variant; `up [dir]` (single
  registration asserted: exactly one runfile + one pointer, `/v1/server` runDir equals
  the CLI-resolved one) plus `up <missing-dir>` and `up <file>` preflight errors;
  `down` from elsewhere clearing runfile + pointer; adopt-on-sight (live pointer-less
  runfile gains a pointer; doctor notes it beforehand); `logs` local-first post-mortem
  after `down` and the divergence banner (ancient local log + live remote, including
  `-f`); `status --json` carrying the `server` block on a registry-resolved run; the
  stderr note placement under `--json`; `status --ctrl-port` (current server, and the
  404-fallback stub); `topics --json` demo-resolution refusal.
- **`GET /v1/server`**: control-plane test for the response shape (token, host, demo
  included); serve-side tests that a relative runDir in the boot file is a fatal boot
  error and that the served runDir equals the boot file's; a `--watch` respawn test
  with the launch cwd deleted before the handler edit (successor keeps serving with a
  correct runfile).
- **Hermeticity**: the registry module's explicit state-dir parameter makes any
  unpinned test invocation **throw** rather than touch `~/.local/state/offbook`
  (removing the bunfig-bypass class: `bun test` from a subdirectory, editor runners,
  direct file runs). The bunfig test preload still pins `OFFBOOK_STATE_DIR` suite-wide
  and **resets the shared scratch dir between test files**, because every
  `writeRunfile` caller is a registry writer (`src/cli/doctor.test.ts:401,426` and the
  fake-runfile sites in `test/cli-dispatch.test.ts` included); server-booting tests
  additionally pin per-test scratch dirs and assert no leftover pointers at the end
  (the 2026-08-12 leaked-instance lesson, extended to the registry).
- **Mutation gate**: extend the mutate scope (stryker.conf.json `mutate` /
  `MUTATION_GATE_GLOBS`) over `src/cli/runfile.ts` and the new resolver module, and
  run one focused full campaign on the new modules before the round closes (the
  CLAUDE.md post-change campaign discipline applied to newly-gated files). Until then
  the changed-file gate silently measures nothing for `src/cli` paths.
- **Doc-system gate**: the new `R-###`s carry arrow-tag comments
  (`// [itest->R-###]` etc.) in both directions per `bun scripts/check-docs.ts`.
