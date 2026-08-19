# Instance Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every offbook management verb works from any directory on the machine, resolving to the running instance through a machine-local pointer registry plus a launch-token identity check, and `offbook up [dir]` starts a project's instance without `cd`.

**Architecture:** Identity first (a per-launch random `token` + `host` in the runfile, echoed by a new `GET /v1/server` read), then a pointer registry under `~/.local/state/offbook/instances/` consumed by one shared resolver implementing the spec's 10-row instance state table, then per-verb policy (in-band naming, refusal tables, exit codes 0/1/2) driven by a single message-catalog module, then `up [dir]`, then the derived-docs sweep. All record deletion and pid signaling goes through one guarded-mutation helper (re-read the precondition immediately before acting).

**Tech Stack:** TypeScript on Bun (1.3.x), `bun:test`, Hono (control plane), node:crypto/fs/os/path. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-instance-discovery-design.md` (rev 3). Where this plan and the spec disagree, the spec wins — stop and flag it.

## Global Constraints

- **Branch**: work on `feat/instance-discovery` (the spec's branch). Commit after every task with the message given in the task; do NOT add any Co-Authored-By or AI-attribution trailer.
- **Import style (D-013)**: upward reaches use `#src/…`/`#scripts/…`; same-directory imports stay relative with explicit `.ts` extensions. `test/import-style.test.ts` enforces this.
- **Transport isolation**: nothing in this plan may import `aedes` or any MQTT package; only `src/broker/` may.
- **Formatting**: tabs, double quotes, trailing commas — run `bunx biome check --write <changed files>` before each commit and read what it changed. Never run `biome migrate`.
- **Verification is by exit code, never printed summaries** (bunfig coverage floor fails with exit 1, zero failing tests, no message). `bun test <single-file>` may exit 1 with 0 fails — that is the per-file coverage floor; gate only on full `bun test`.
- **Frozen contract terms**: the endpoint is `/v1/server`, never `/v1/instance` ("instance" = materialized channel instance, contracts §3). The closed `ErrorCode` union in `src/model/index.ts` is untouched — the CLI refusal codes (`ambiguous`/`not-running`/`demo-only`/`wrong-host`/`version-skew`) live only in `src/cli/messages.ts`.
- **Message wording is the catalog's, byte for byte** (spec "Message catalog", M2–M22). Human-facing text never says registry/pointer/token/endpoint. Two automation anchors are contract: the `offbook is not running` leading token and the `(offbook:` note prefix.
- **Exit codes are contract**: 0 = acted or idempotent nothing-of-yours no-op; 1 = not running / request failure / demo-only; 2 = refused-with-selector.
- **`--json` prints exactly one JSON document on stdout**; anything else goes to stderr.
- **State-dir hermeticity**: the registry module takes its state dir as an explicit parameter and throws if it never received one; only CLI entry points call `stateDirFromEnv()`. Tests must never touch the real `~/.local/state` — the `test/preload.ts` net plus per-test `OFFBOOK_STATE_DIR` pinning (Task 5).
- **Port allocation**: unique literal ports per test file (repo convention). Verified free repo-wide on 2026-08-19 (`grep -rhoE "1[0-9]{4}" --include="*.ts" src test demo-app | sort -un` shows nothing in 19202–19799 or 12400–12599): `src/cli/resolve.test.ts` → 19400–19419; `test/instance-discovery.test.ts` → 19430–19449 plus tcp 12490–12495 (the tcp ports ARE bound by the real `up` runs in that file); new `test/cli-dispatch.test.ts` tests → 19450–19479 plus tcp 12496–12499; new `src/cli/runfile.test.ts` cases → 19965–19968 (extend that file's `19960-19964` comment); new doctor cases → 19136–19139. If any of these are taken by the time you implement, re-run the grep and shift the block — never reuse a number that appears anywhere else.
- **Arrow tags**: every new test carries `// [utest->R-0xx]` or `// [itest->R-0xx]` per the strict grammar `^\[(utest|itest|stest)->(R-\d{3})\]$` inside a comment. R-044…R-047 are allocated in Task 1, so tags never dangle.
- **`bun scripts/check-docs.ts` must pass at every commit** that touches docs, REQUIREMENTS.md, DECISIONS.md, or tests.

## File structure (what exists at the end)

| File | Responsibility |
|---|---|
| `src/cli/messages.ts` (new) | The message catalog M2–M22 + instance-table renderer + refusal envelope. The one grep source for wording. |
| `src/cli/guard.ts` (new) | The guarded-mutation helper (one rule, five sites). |
| `src/cli/registry.ts` (new) | Pointer files: state-dir resolution, atomic write, remove, scan+dedupe+corrupt-reap. |
| `src/cli/resolve.ts` (new) | The shared resolver: state-table rows 1–10, tiebreak, self-heal, reap, adopt-on-sight, `attributeCtrlPort`. |
| `src/cli/runfile.ts` | + `token`/`host` fields, EPERM-aware `pidAlive`, `probeServer` (identity probe w/ retry), pointer lifecycle riding `writeRunfile`/`clearRunfile`. |
| `src/model/index.ts` | + `ServerIdentity`. |
| `src/control-plane/index.ts` | + optional `server` cap + `GET /v1/server` route. |
| `src/compose/index.ts` | + `ComposeParts.server` passthrough. |
| `src/cli/serve.ts` | Builds `ServerIdentity`, fatal on relative runDir / missing token, runfile writes carry token+host. |
| `src/cli/index.ts` | Verb policy: `targetFor`, rewritten `status`/`down`/`logs`/`topics`, M3 attribution, `up [dir]`, token generation + identity readiness in `launchDetached`. |
| `src/cli/client.ts` | M11 wording on the legacy `resolveCtrlPort` messages. |
| `src/cli/doctor.ts` | stateDir in `DoctorCtx`; named port attribution; registry-aware runfile notes; M21 skill escalation. |
| `test/preload.ts` (new) + `bunfig.toml` | Suite-wide `OFFBOOK_STATE_DIR` net. |
| `test/instance-discovery.test.ts` (new) | One integration test per state-table row. |
| Docs | contracts.md amendments (Task 1), guides/README/adoption/SKILL sweep (Task 21), intake + D-032 + R-044…R-051 (Tasks 1, 22). |

---

### Task 1: Contract freeze + process scaffolding (intake, D-032, R-044–R-051, contracts.md amendments)

The repo builds against `docs/specs/contracts.md`; freeze the interface first so every later task (and its arrow tags) has a home. No code in this task.

**Files:**
- Create: `docs/intake/2026-08-19-instance-discovery.md`
- Modify: `docs/specs/contracts.md` (lines ~89, ~106, the §5 Reads table after the `GET /v1/pending` row, the §5 G14 bullet at line ~350)
- Modify: `DECISIONS.md` (append D-032), `REQUIREMENTS.md` (append R-044–R-051)

**Interfaces:**
- Consumes: nothing.
- Produces: the R-044…R-047 UIDs later tasks' arrow tags reference; the D-032 anchor text; the contracts wording later doc tests may quote.

- [ ] **Step 1: Write the intake file** `docs/intake/2026-08-19-instance-discovery.md`:

```markdown
# 2026-08-19: Instance discovery — manage a running offbook from any directory (intake)
**Status**: open
**Owner**: nzneit

Source: docs/superpowers/specs/2026-08-18-instance-discovery-design.md (rev 3 —
brainstorm + adversarial verify + 35-mode DFMEA + ergonomics critique). Closes the
archived open finding "the undocumented cwd premise"
(docs/archive/intake/2026-08-12-first-light-acceptance-fixes.md, Addendum) and the
runner-up "cwd/run-dir note in daily-loop.md (F1)"
(docs/archive/intake/2026-08-07-embedding-onboarding-review.md).

## a — server identity: launch token, host rule, GET /v1/server
Pid equality is not identity (four severity-9 DFMEA findings share that root). A
per-launch 128-bit token + os.hostname() land in the runfile and boot file; a new
/v1/server read echoes them; readiness = identity; pidAlive treats EPERM as alive.
→ Resolution: build per the spec → allocates R-044, D-032

## b — machine-local registry + shared resolver + verb policy
Pointer files (pointers, not state) under ${OFFBOOK_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/offbook}/instances/,
one guarded-mutation rule at five sites, the 10-row instance state table, the
3-stage containment tiebreak, in-band naming (M16), the refusal tables and the
0/1/2 exit-code contract, the M2–M22 message catalog.
→ Resolution: build per the spec → allocates R-045, D-032

## c — `offbook up [dir]`
Optional positional; projectDir = resolve(cwd, dir); default runDir
<projectDir>/.offbook; M2 preflight before any write; EI2 checks projectDir.
→ Resolution: build per the spec → allocates R-046

## d — derived-docs sweep
Guides + README + adoption.md §9/§10 + the onboarding skill drop the cwd premise
for management verbs; the two-sentence user model lands in daily-loop; the §10
attribution/refusal wordings are superseded; grep-driven, hit list recorded in D-032.
→ Resolution: sweep per the spec → allocates R-047

## e — scope trims (documented limitations → fast-follow stubs)
Case-alias file-identity dedupe; moved-directory naming; richer version-skew
handling; the optional TTY-only picker.
→ Resolution: deferred stubs → allocates R-048, R-049, R-050, R-051
```

- [ ] **Step 2: Amend contracts.md §1a.** Two edits.

Edit 1 — replace the line ~89 comment (the ONLY site carrying "up/down/logs/status resolve it identically"):

Old:
```
  runDir: string;              // dir for the runfile + offbook.log (§5 process mgmt); cwd-relative, default '.offbook'; up/down/logs/status resolve it identically; init gitignores it
```
New:
```
  runDir: string;              // dir for the runfile + offbook.log (§5 process mgmt); default '.offbook' under the project dir (`up [dir]`'s positional, else cwd); management verbs resolve cwd-first, then the machine-local instance registry (§5, D-032); `--run-dir` stays cwd-relative; init gitignores it
```

Edit 2 — replace the line ~106 DEFAULT_CONFIG comment:

Old:
```
  runDir: '.offbook',              // cwd-relative run-artifact dir (runfile + offbook.log); init adds it to .gitignore
```
New:
```
  runDir: '.offbook',              // run-artifact dir (runfile + offbook.log), resolved per §5 (D-032); init adds it to .gitignore
```

- [ ] **Step 3: Amend the §5 G14 bullet (line ~350).** Two surgical edits inside the existing bullet, then two new blocks after it.

Edit the runfile field list:
Old: `` (`<runDir>/offbook.run`: pid + the three ports + `startedAt`; ``
New: `` (`<runDir>/offbook.run`: pid + the three ports + `startedAt` + the per-launch `token` + `host` — D-032; ``

Edit the cwd parenthetical:
Old: `` `<runDir>` = `config.runDir`, cwd-relative, default `.offbook/` — §1a) ``
New: `` `<runDir>` = `config.runDir`, default `.offbook/` under the project directory (`up [dir]`), else cwd; `--run-dir` stays cwd-relative — §1a, D-032) ``

Then append, as new lines directly after the G14 bullet (the `offbook specs update` sentence stays the bullet's last sentence):

```markdown
<!-- anchor: R-046 -->
- **`offbook up [dir]` (D-032).** Optional positional, default `.`: `projectDir = resolve(cwd, dir)`; the path must exist and be a directory **before** any mkdir/boot-file/pointer write (else exit 1). The boot file carries the **absolute** `projectDir`, `runDir`, and launch `token`; `serve.ts` treats a still-relative runDir in the boot file as a fatal boot error.
<!-- anchor: R-045 -->
- **Instance discovery (D-032) — pointers, not state.** `writeRunfile`/`clearRunfile` also maintain a machine-local pointer `${OFFBOOK_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/offbook}/instances/<sha256(realpath runDir)>.json` holding only `{ v: 1, runDir, host }` — ports/pid/`token`/`startedAt` stay in `offbook.run`, `projectDir` in `offbook.boot.json`, so a pointer can only dangle, never disagree. Writes are atomic inside `instances/` (temp + same-directory rename); scans consider only `<64 hex>.json` names. The registry is machine-local state: `host` (in runfile and pointer) makes a shared network home safe — foreign-host records are inert (never candidates, never reaped, never signaled; the pid-only paths refuse). **Resolution order** for management verbs: `--ctrl-port` wins; then `--run-dir` (exact; no registry; a projectDir whose `.offbook` holds the runfile is accepted); then a **live** cwd runfile; then the registry, where a candidate is live only after an **identity** check — `GET /v1/server` answering with the runfile's `token` (pid equality is not identity). Several live candidates tiebreak by containment (sole ancestor-or-equal of cwd, then sole strict descendant, then sole non-demo) or refuse with a selector table (exit 2). **Deletion law**: a discovery record is deleted only when its target is provably dead or absent, on this host, re-verified immediately before the delete; a live-pid record is only ever skipped. Registry failures degrade to cwd-scoped behavior and never block `up` or any verb.
```

- [ ] **Step 4: Add the `GET /v1/server` row to the §5 Reads table** (after the `GET /v1/pending` row, line ~285), plus its anchor on the line **above** the `### Reads` heading:

Anchor (own line, directly above `### Reads`):
```markdown
<!-- anchor: R-044 -->
```

Table row:
```markdown
| `GET /v1/server` | `ServerIdentity` — `{ pid, token, host, projectDir, runDir, startedAt, demo, ports: { brokerWsPort, brokerTcpPort, controlPlanePort } }` | the identity read behind discovery and `up`'s readiness probe (D-032). Named `server`, **not** `instance` — "instance" stays the §3 channel-instance term. `token` = the per-**launch** lineage id (constant across `--watch` respawns); `pid` = the incarnation. Absent on pre-D-032 builds and identity-less in-process boots — a plain 404, never an error envelope; a 404 on a discovered instance means not-a-candidate | 
```

- [ ] **Step 5: Append D-032 to DECISIONS.md:**

```markdown
### D-032: Instance discovery — manage a running offbook from any directory
**Date**: 2026-08-19
**What**: Management verbs resolve cwd-first, then a machine-local pointer registry (`${OFFBOOK_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/offbook}/instances/<sha256(realpath runDir)>.json`, `{ v: 1, runDir, host }` — pointers, not state), with liveness = **identity**: a per-launch 128-bit `token` + `host` join the G14 runfile and boot file, echoed by the new `GET /v1/server` read; `up`'s readiness probe succeeds only on its own token; `pidAlive` treats EPERM as alive-but-unsignalable. One guarded-mutation rule (re-read the precondition immediately before acting, abort on mismatch) at five sites: pointer reap, runfile reclaim/clear, `down`'s compare-and-signal + SIGKILL re-verify, the failed-boot clear, the self-heal rewrite. Deletion law: a discovery record is deleted only when its target is provably dead or absent, on this host, re-verified immediately before the delete; live-pid records are only ever skipped. Ambiguity refuses with a paste-ready selector table, never a stdin prompt. `offbook up [dir]` bakes absolute projectDir/runDir/token into the boot file (serve.ts treats a relative runDir as fatal). Superseded contracts clause: "up/down/logs/status resolve it identically" (§1a). The §5 "up / down are NOT HTTP endpoints" sentence, the closed ErrorCode union, and `/v1/mode` are untouched (`/v1/mode` keeps exactly one legacy role: the pre-upgrade fallback probe).
**Contract additions**: exit codes 0 (acted / idempotent nothing-of-yours no-op) / 1 (not running, request failure, demo-only) / 2 (refused-with-selector); two automation anchors — the `offbook is not running` leading token and the `(offbook:` stderr-note prefix (wording after the prefix may evolve; automation matches the prefix); `--json` stdout is always exactly one JSON document; the CLI refusal envelope `{ error: { code: ambiguous|not-running|demo-only|wrong-host|version-skew, message }, candidates? }` (CLI-surface codes, NOT the §5 ErrorCode union). **Breaking automation surface** (release-note): `offbook topics --json` with no live server now refuses with the M11 not-running envelope/wording instead of the R-043 run-dir-qualified string; scripted consumers wanting pinned-instance semantics use `--run-dir` (byte-identical to pre-D-032 behavior on the same host).
**Why**: the wrong-directory experience misled (status lied, down no-op'd silently, topics fell back to the demo, the port attribution could not name the owner); fixed ports make n=1 the overwhelming state, so cwd-first + registry + identity keeps the quiet day quiet while making every verb truthful from anywhere.
**Mitigations / notes**: DFMEA rev 2 folded 31 actions (the four severity-9 kill-safety findings collapse into token+host); ergonomics rev 3 folded 26 findings (in-band naming, deterministic exit-0 `down` no-op with the full instance table, three machinery trims taken as documented limitations — case-alias dedupe by realpath string only, moved-directory naming lost until restart, pre-upgrade `--ctrl-port` refuses with a version notice).
**Obligations**: (1) extend the Stryker mutate scope over `src/cli/runfile.ts`, `src/cli/resolve.ts`, `src/cli/registry.ts`, `src/cli/guard.ts` and run one focused full campaign on the new modules before the round closes (until then the changed-file gate measures nothing for `src/cli`); (2) the docs sweep is grep-driven — the greps and hit list are appended to this entry when the sweep lands (Task 21/22 of the plan); (3) fast-follow stubs R-048–R-051.
**From**: docs/intake/2026-08-19-instance-discovery.md (design: docs/superpowers/specs/2026-08-18-instance-discovery-design.md)
**Folds into**: docs/specs/contracts.md (§1a runDir, §5 G14 + Reads table), src/cli/ (runfile, registry, resolve, guard, messages, index, client, serve, doctor), src/control-plane/index.ts, src/compose/index.ts, src/model/index.ts, docs/guides/, README.md, docs/specs/adoption.md §9–§10, skills/offbook-onboard/SKILL.md, AGENTS.md (Status & next), REQUIREMENTS.md (R-044–R-051)
```

- [ ] **Step 6: Append R-044–R-051 to REQUIREMENTS.md** (after the R-043 entry, before the tail comment). STATUS is `specified` for R-044–R-047 (flipped to `tested`/`built` in Task 22); `deferred` for the stubs:

```markdown
#### Server identity — the launch token, host rule, and GET /v1/server
**UID**: R-044
**STATUS**: specified
**COVERS**: docs/specs/contracts.md#R-044
A per-launch 128-bit `token` (lineage — constant across `--watch` respawns) and `host` (`os.hostname()`) join the G14 runfile and boot file; `GET /v1/server` echoes `{ pid, token, host, projectDir, runDir, startedAt, demo, ports }`; `up` bakes absolute projectDir/runDir/token into `offbook.boot.json` and its 30s readiness loop succeeds only when `/v1/server` answers with this launch's token; `serve.ts` treats a relative boot-file runDir or a missing token as a fatal boot error; `pidAlive` treats EPERM as alive; every identity probe retries once with a longer timeout before concluding not-answering.

#### Instance discovery — machine-local registry, shared resolver, verb policy
**UID**: R-045
**STATUS**: specified
**COVERS**: docs/specs/contracts.md#R-045
Pointer files (`{ v: 1, runDir, host }`, atomic same-directory writes, sha256(realpath runDir) names) ride every `writeRunfile`/`clearRunfile`; one verb-agnostic resolver implements the 10-row instance state table (adopt-on-sight, guarded reclaim/reap/self-heal, the deletion law, the host rule) and the 3-stage containment tiebreak; verbs apply the policy table — in-band `offbook @ <projectDir>` naming on registry-resolved reads with byte-identical cwd output, `(offbook:`-prefixed stderr notes only for mutations and anomalies, refusal tables with paste-ready `--run-dir` selectors, the 0/1/2 exit-code contract, `--json` single-document refusal envelopes, `down`'s compare-and-signal and unrelated-sole-candidate exit-0 no-op, `logs`' local-first divergence banner, `topics`' demo-only `--json` refusal, doctor/`up`-preflight attribution naming the owning project.

#### `offbook up [dir]` — start a project's instance without cd
**UID**: R-046
**STATUS**: specified
**COVERS**: docs/specs/contracts.md#R-046
Optional positional (default `.`): `projectDir = resolve(cwd, dir)` must exist and be a directory before any mkdir/boot-file/pointer write (else exit 1 with the M2 hint); default runDir becomes `<projectDir>/.offbook` (`--run-dir` stays cwd-relative); the EI2 fresh-project check and the no-services.yaml hint use projectDir.

#### Manage-from-anywhere docs sweep — guides, README, adoption surface, onboarding skill
**UID**: R-047
**STATUS**: specified
**COVERS**: docs/specs/adoption.md#R-047
Management-verb examples drop the cwd premise (`cd mock &&` package scripts become `offbook up mock`/`offbook down`); daily-loop carries the two-sentence user model verbatim and the scripted-consumer `--run-dir` line; adoption.md §10's attribution gains the named-owner variant and its "no guess at which offbook instance it is" sentence is superseded, as are the pinned `topics --json` refusal wording and §9's step-6 parenthetical; the onboarding skill's steps 5/6 lose `cd mock` and pin their checks to `--run-dir mock/.offbook`; one migration sentence covers pre-upgrade instances.

#### Registry dedupe by file identity on case-insensitive filesystems
**UID**: R-048
**STATUS**: deferred
**COVERS**: docs/superpowers/specs/2026-08-18-instance-discovery-design.md#non-goals
Scans dedupe by realpath string only (D-032 trim); a case-aliased runDir may briefly list one instance twice — dedupe by file identity if a real collision surfaces.

#### Machine-wide naming for a project directory moved under a running server
**UID**: R-049
**STATUS**: deferred
**COVERS**: docs/superpowers/specs/2026-08-18-instance-discovery-design.md#non-goals
A moved projectDir loses machine-wide naming until restart (D-032 trim); a marked-unverified naming surface is the fast-follow.

#### Richer version-skew handling than the M18 refusal
**UID**: R-050
**STATUS**: deferred
**COVERS**: docs/superpowers/specs/2026-08-18-instance-discovery-design.md#non-goals
`status --ctrl-port` against a pre-D-032 server refuses with a version notice (no degraded partial output); richer handling is a fast-follow.

#### TTY-only numbered instance picker
**UID**: R-051
**STATUS**: deferred
**COVERS**: docs/superpowers/specs/2026-08-18-instance-discovery-design.md#non-goals
Choosing among instances is always a printed table of complete paste-ready commands (agents and scripts must never hang); an interactive numbered picker gated on TTY is a fast-follow.
```

- [ ] **Step 7: Add the R-047 anchor to adoption.md NOW** (its COVERS must resolve at THIS commit, not at the Task 21 sweep): insert `<!-- anchor: R-047 -->` on its own line directly above the §10 heading in `docs/specs/adoption.md`. No other adoption.md change happens in this task.

- [ ] **Step 8: Verify the doc gate.**

Run: `bun scripts/check-docs.ts`
Expected: exit 0, `check-docs: ok — 51 requirements, 32 decisions, 1 intake file(s).`

- [ ] **Step 9: Commit**

```bash
git add docs/intake/2026-08-19-instance-discovery.md docs/specs/contracts.md docs/specs/adoption.md DECISIONS.md REQUIREMENTS.md
git commit -m "docs: freeze the D-032 instance-discovery contract (intake round, R-044-R-051)"
```

---

### Task 2: Identity primitives — `ServerIdentity`, runfile `token`/`host`, EPERM-aware `pidAlive`, `probeServer`

**Files:**
- Modify: `src/model/index.ts` (append after the `ErrorCode` union, line ~304)
- Modify: `src/cli/runfile.ts` (header comment, `Runfile`, `pidAlive`, new `probeServer`)
- Test: `src/cli/runfile.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ServerIdentity` (model); `Runfile.token?: string`, `Runfile.host?: string`; `pidAlive(pid: number): boolean` (EPERM → true); `probeServer(port: number, timeoutMs?: number): Promise<ServerProbe>` where `type ServerProbe = { kind: "server"; identity: ServerIdentity } | { kind: "legacy" } | { kind: "silent" }`. `probeOffbook` survives unchanged (legacy probe).

- [ ] **Step 1: Write the failing tests.** Append to `src/cli/runfile.test.ts` (ports 19965–19968 per the file's convention comment):

```ts
// [utest->R-044]
test("probeServer: classifies an identity answer, a legacy /v1/mode answer, and silence", async () => {
	const identity = {
		pid: 4242,
		token: "aa".repeat(16),
		host: "devbox",
		projectDir: "/tmp/p",
		runDir: "/tmp/p/.offbook",
		startedAt: "2026-08-19T00:00:00.000Z",
		demo: false,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 19965 },
	};
	const server = Bun.serve({
		port: 19965,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/server"
				? Response.json(identity)
				: new Response("nope", { status: 404 }),
	});
	try {
		const probe = await probeServer(19965);
		expect(probe.kind).toBe("server");
		if (probe.kind === "server") expect(probe.identity.token).toBe(identity.token);
	} finally {
		server.stop(true);
	}

	// legacy: /v1/server 404s but /v1/mode answers offbook-shaped
	const legacy = Bun.serve({
		port: 19966,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/mode"
				? Response.json({ mode: "passive" })
				: new Response("nope", { status: 404 }),
	});
	try {
		expect((await probeServer(19966)).kind).toBe("legacy");
	} finally {
		legacy.stop(true);
	}

	// silence: nothing listens (the internal one-retry-with-longer-timeout
	// path still concludes silent)
	expect((await probeServer(19967, 60)).kind).toBe("silent");

	// a foreign HTTP server that 404s both paths is silent, not legacy
	const foreign = Bun.serve({
		port: 19968,
		fetch: () => new Response("hello", { status: 200 }),
	});
	try {
		expect((await probeServer(19968, 60)).kind).toBe("silent");
	} finally {
		foreign.stop(true);
	}
});

// [utest->R-044]
test("pidAlive: EPERM counts as alive-but-unsignalable, ESRCH as dead", () => {
	// pid 1 is init: alive, and signaling it as non-root raises EPERM
	expect(pidAlive(1)).toBe(true);
	const dead = Bun.spawnSync(["true"]);
	expect(pidAlive(dead.pid ?? 4_193_998)).toBe(false);
});

// [utest->R-044]
test("readRunfile tolerates and returns token/host fields", async () => {
	const dir = mkdtempSync(join(tmpdir(), "offbook-runfile-token-"));
	await Bun.write(
		join(dir, "offbook.run"),
		JSON.stringify({
			pid: 1,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 3,
			startedAt: "t",
			token: "ff".repeat(16),
			host: "devbox",
		}),
	);
	const run = await readRunfile(dir);
	expect(run?.token).toBe("ff".repeat(16));
	expect(run?.host).toBe("devbox");
	rmSync(dir, { recursive: true, force: true });
});
```

Add the missing imports to the test file's import lines (`probeServer`, `pidAlive`, `readRunfile` from `./runfile.ts`; `mkdtempSync`, `rmSync` from `node:fs`; `tmpdir` from `node:os`; `join` from `node:path` — keep whatever is already imported).

- [ ] **Step 2: Run to verify failure.**

Run: `bun test src/cli/runfile.test.ts`
Expected: FAIL — `probeServer` is not exported. (Remember: this focused run may ALSO exit 1 from the coverage floor; the failing-test count is what matters here.)

- [ ] **Step 3: Implement.**

In `src/model/index.ts`, append after the `ErrorCode` union:

```ts
// R-044/D-032 — the GET /v1/server identity read (contracts §5; named
// `server`, not `instance` — "instance" is the frozen §3 term for
// materialized channel instances). `token` identifies the LAUNCH lineage
// (constant across --watch respawns); `pid` identifies the incarnation.
export interface ServerIdentity {
	pid: number;
	token: string;
	host: string;
	projectDir: string;
	runDir: string; // absolute
	startedAt: string;
	demo: boolean;
	ports: {
		brokerWsPort: number;
		brokerTcpPort: number;
		controlPlanePort: number;
	};
}
```

In `src/cli/runfile.ts`: replace the header comment (lines 1–5):

```ts
// R-019/R-044 — the G14 runfile (contracts §5 process management): `offbook
// up` writes `<runDir>/offbook.run` (pid + the three ports + startedAt +
// the per-launch token + host, D-032); management verbs resolve cwd-first,
// then the machine-local instance registry (the pre-D-032 clause was
// "up/down/logs/status resolve it identically"). Liveness = IDENTITY: pid
// alive AND the control port answering GET /v1/server with the runfile's
// token — pid-alone would trust a reused PID (P7), and pid+port-alone
// would trust whoever answers the port (D-032).
```

Extend the interface:

```ts
export interface Runfile {
	pid: number;
	brokerWsPort: number;
	brokerTcpPort: number;
	controlPlanePort: number;
	startedAt: string;
	token?: string; // R-044: launch lineage id; absent on pre-D-032 runfiles
	host?: string; // R-044: os.hostname() at launch; absent pre-D-032
}
```

Replace `pidAlive`:

```ts
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		// EPERM = the pid EXISTS but is not ours to signal — alive (D-032);
		// reading it as dead invited reclaiming a live instance's records
		return (cause as NodeJS.ErrnoException).code === "EPERM";
	}
}
```

Add `probeServer` after `probeOffbook` (new import at top: `import type { ServerIdentity } from "#src/model/index.ts";`):

```ts
export type ServerProbe =
	| { kind: "server"; identity: ServerIdentity }
	| { kind: "legacy" } // pre-D-032 offbook: /v1/mode answers, no /v1/server
	| { kind: "silent" };

// The identity probe (R-044). One retry with a doubled timeout before
// concluding not-answering — a loaded machine's slow first answer must not
// read as a wedged instance.
export async function probeServer(
	port: number,
	timeoutMs = 500,
): Promise<ServerProbe> {
	const once = async (t: number): Promise<ServerProbe> => {
		try {
			const res = await fetch(`http://localhost:${port}/v1/server`, {
				signal: AbortSignal.timeout(t),
			});
			if (res.ok) {
				const body = (await res.json()) as ServerIdentity;
				return typeof body.token === "string" &&
					typeof body.runDir === "string" &&
					typeof body.pid === "number"
					? { kind: "server", identity: body }
					: { kind: "silent" }; // answers, but not as offbook
			}
			// an HTTP answer without /v1/server: pre-D-032 offbook or a
			// foreign server — the mode probe discriminates
			return (await probeOffbook(port, t))
				? { kind: "legacy" }
				: { kind: "silent" };
		} catch {
			return { kind: "silent" };
		}
	};
	const first = await once(timeoutMs);
	if (first.kind !== "silent") return first;
	return once(timeoutMs * 2);
}
```

- [ ] **Step 4: Run tests.**

Run: `bun test src/cli/runfile.test.ts`
Expected: 0 failing tests. Then `bun run typecheck` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/model/index.ts src/cli/runfile.ts src/cli/runfile.test.ts
git commit -m "feat: identity primitives - ServerIdentity, runfile token/host, EPERM-aware pidAlive, probeServer (R-044)"
```

---

### Task 3: The guarded-mutation helper

**Files:**
- Create: `src/cli/guard.ts`
- Test: `src/cli/guard.test.ts`

**Interfaces:**
- Produces: `guarded<T>(site: { read: () => T | Promise<T>; expect: (current: T) => boolean; act: () => void | Promise<void> }): Promise<boolean>` — re-reads, acts only if `expect` holds, returns whether it acted.

- [ ] **Step 1: Write the failing test** `src/cli/guard.test.ts`:

```ts
// [utest->R-045] — the guarded-mutation rule (design "one rule, five
// sites"): re-read the precondition immediately before acting, abort on
// mismatch. The five call sites each get their own pin where they live;
// this file pins the rule itself.
import { expect, test } from "bun:test";
import { guarded } from "./guard.ts";

test("guarded: acts when the re-read matches, reports true", async () => {
	let acted = false;
	const result = await guarded({
		read: () => 42,
		expect: (v) => v === 42,
		act: () => {
			acted = true;
		},
	});
	expect(result).toBe(true);
	expect(acted).toBe(true);
});

test("guarded: aborts when the precondition changed, reports false", async () => {
	let state = "expected";
	state = "changed-between-scan-and-act";
	let acted = false;
	const result = await guarded({
		read: () => state,
		expect: (v) => v === "expected",
		act: () => {
			acted = true;
		},
	});
	expect(result).toBe(false);
	expect(acted).toBe(false);
});

test("guarded: the re-read happens at act time, not capture time (async)", async () => {
	let record: string | undefined = "present";
	const seen: (string | undefined)[] = [];
	const site = {
		read: async () => {
			await new Promise((r) => setTimeout(r, 10));
			return record;
		},
		expect: (v: string | undefined) => {
			seen.push(v);
			return v !== undefined;
		},
		act: () => {},
	};
	expect(await guarded(site)).toBe(true);
	record = undefined; // vanishes between invocations
	expect(await guarded(site)).toBe(false);
	expect(seen).toEqual(["present", undefined]); // fresh read both times
});
```

- [ ] **Step 2: Run to verify failure.** `bun test src/cli/guard.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement** `src/cli/guard.ts`:

```ts
// R-045/D-032 — guarded mutation, the ONE rule behind every record delete,
// foreign rewrite, and pid signal (design "Guarded mutation: one rule,
// five sites"): re-read the precondition IMMEDIATELY before acting; abort
// on mismatch. Sites: (1) pointer reap, (2) runfile reclaim / post-kill
// clear, (3) down's signal + SIGKILL re-verify, (4) the failed-boot clear,
// (5) the self-heal rewrite. Each site instantiates this helper so tests
// pin the rule per site.
export async function guarded<T>(site: {
	read: () => T | Promise<T>;
	expect: (current: T) => boolean;
	act: () => void | Promise<void>;
}): Promise<boolean> {
	const current = await site.read();
	if (!site.expect(current)) return false;
	await site.act();
	return true;
}
```

- [ ] **Step 4: Run tests.** `bun test src/cli/guard.test.ts` — 0 failing tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/guard.ts src/cli/guard.test.ts
git commit -m "feat: the guarded-mutation helper (R-045)"
```

---

### Task 4: The instance registry — pointers, not state

**Files:**
- Create: `src/cli/registry.ts`
- Test: `src/cli/registry.test.ts`

**Interfaces:**
- Produces: `interface Pointer { v: 1; runDir: string; host: string }`; `stateDirFromEnv(env?: NodeJS.ProcessEnv): string`; `canonicalPath(p: string): string` (realpath, falling back to `path.resolve`); `pointerPath(stateDir, runDir): string`; `writePointer(stateDir, runDir): Promise<void>`; `removePointer(stateDir, runDir): void`; `scanPointers(stateDir): Promise<{ path: string; raw: string; pointer: Pointer }[]>`. Every function throws on a falsy `stateDir`.

- [ ] **Step 1: Write the failing tests** `src/cli/registry.test.ts`:

```ts
// [utest->R-045] — the machine-local instance registry: pointers, not
// state (contracts §5, D-032). No ports are bound in this file.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalPath,
	pointerPath,
	removePointer,
	scanPointers,
	stateDirFromEnv,
	writePointer,
} from "./registry.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "offbook-registry-"));

// biome may flag the empty-env objects below; env params are deliberate
test("stateDirFromEnv: OFFBOOK_STATE_DIR wins, then XDG_STATE_HOME, then ~/.local/state", () => {
	expect(stateDirFromEnv({ OFFBOOK_STATE_DIR: "/x/state" })).toBe("/x/state");
	expect(stateDirFromEnv({ XDG_STATE_HOME: "/x/xdg" })).toBe(
		join("/x/xdg", "offbook"),
	);
	expect(stateDirFromEnv({})).toContain(join(".local", "state", "offbook"));
});

test("registry functions throw when no state dir was injected", async () => {
	expect(() => pointerPath("", "/tmp/x")).toThrow("no state dir");
	await expect(writePointer("", "/tmp/x")).rejects.toThrow("no state dir");
	expect(() => removePointer("", "/tmp/x")).toThrow("no state dir");
	await expect(scanPointers("")).rejects.toThrow("no state dir");
});

test("writePointer: atomic temp INSIDE instances/, sha256(realpath) name, scan round-trips", async () => {
	const state = scratch();
	const runDir = mkdtempSync(join(tmpdir(), "offbook-rundir-"));
	await writePointer(state, runDir);
	const canonical = canonicalPath(runDir);
	const expectedName = `${createHash("sha256").update(canonical).digest("hex")}.json`;
	const names = readdirSync(join(state, "instances"));
	expect(names).toEqual([expectedName]); // no leaked temp files
	const entries = await scanPointers(state);
	expect(entries).toHaveLength(1);
	expect(entries[0].pointer).toMatchObject({ v: 1, runDir: canonical });
	expect(typeof entries[0].pointer.host).toBe("string");
	rmSync(state, { recursive: true, force: true });
	rmSync(runDir, { recursive: true, force: true });
});

test("removePointer: idempotent, and resolves a NONEXISTENT runDir to the same name writePointer used for a live one", async () => {
	const state = scratch();
	const runDir = mkdtempSync(join(tmpdir(), "offbook-rundir-"));
	await writePointer(state, runDir);
	rmSync(runDir, { recursive: true, force: true }); // dir gone before remove
	removePointer(state, runDir); // must still hit the same hash (resolve fallback)
	expect(readdirSync(join(state, "instances"))).toEqual([]);
	removePointer(state, runDir); // idempotent
	rmSync(state, { recursive: true, force: true });
});

test("scanPointers: ignores non-hash names, reaps corrupt pointers, dedupes string-identical twins keeping the realpath-keyed one", async () => {
	const state = scratch();
	const runDir = mkdtempSync(join(tmpdir(), "offbook-rundir-"));
	await writePointer(state, runDir);
	const dir = join(state, "instances");
	// a crash-leaked temp and a foreign file are inert
	await Bun.write(join(dir, `${"a".repeat(64)}.json.tmp999`), "x");
	await Bun.write(join(dir, "README"), "x");
	// a corrupt pointer is reaped on sight (the deletion law's one exception)
	await Bun.write(join(dir, `${"b".repeat(64)}.json`), "{not json");
	// a string-identical twin under a WRONG hash loses to the realpath-keyed one
	const canonical = canonicalPath(runDir);
	await Bun.write(
		join(dir, `${"c".repeat(64)}.json`),
		JSON.stringify({ v: 1, runDir: canonical, host: "twin" }),
	);
	const entries = await scanPointers(state);
	expect(entries).toHaveLength(1);
	const goodName = `${createHash("sha256").update(canonical).digest("hex")}.json`;
	expect(entries[0].path.endsWith(goodName)).toBe(true);
	expect(existsSync(join(dir, `${"b".repeat(64)}.json`))).toBe(false);
	expect(existsSync(join(dir, `${"c".repeat(64)}.json`))).toBe(false);
	rmSync(state, { recursive: true, force: true });
	rmSync(runDir, { recursive: true, force: true });
});

test("canonicalPath: resolves symlinks so a symlinked runDir hashes to its real subtree", () => {
	const real = mkdtempSync(join(tmpdir(), "offbook-real-"));
	const linkParent = mkdtempSync(join(tmpdir(), "offbook-link-"));
	const link = join(linkParent, "alias");
	symlinkSync(real, link);
	expect(canonicalPath(link)).toBe(canonicalPath(real));
	rmSync(linkParent, { recursive: true, force: true });
	rmSync(real, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure.** `bun test src/cli/registry.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement** `src/cli/registry.ts`:

```ts
// R-045/D-032 — the machine-local instance registry (contracts §5):
// POINTERS, NOT STATE. One file per instance,
// <stateDir>/instances/<sha256(realpath runDir)>.json, holding only
// { v, runDir, host } — ports/pid/token/startedAt live in the target's
// offbook.run and projectDir in its offbook.boot.json, so a pointer can
// only dangle, never disagree. The state dir is an EXPLICIT parameter
// everywhere; the production default (stateDirFromEnv) is injected only at
// the CLI entry points, and code that never received one throws instead of
// defaulting into the real home (test hermeticity, D-032).
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface Pointer {
	v: 1;
	runDir: string; // absolute, symlink-resolved at write time
	host: string;
}

export function stateDirFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (env.OFFBOOK_STATE_DIR) return env.OFFBOOK_STATE_DIR;
	const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(base, "offbook");
}

function instancesDir(stateDir: string): string {
	if (!stateDir)
		throw new Error(
			"registry: no state dir injected — pass stateDirFromEnv() at the entry point",
		);
	return join(stateDir, "instances");
}

// realpath after the dir exists; resolve-only when it is already gone, so
// the remove path computes the same name the write path did (down's
// idempotence against nonexistent run dirs)
export function canonicalPath(p: string): string {
	const abs = resolve(p);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}

const hashOf = (canonical: string): string =>
	createHash("sha256").update(canonical).digest("hex");

export function pointerPath(stateDir: string, runDir: string): string {
	return join(instancesDir(stateDir), `${hashOf(canonicalPath(runDir))}.json`);
}

// atomic: the temp lives INSIDE instances/ (rename never crosses a
// filesystem boundary); scans only consider <64 hex>.json names, so a
// crash-leaked temp file is inert
export async function writePointer(
	stateDir: string,
	runDir: string,
): Promise<void> {
	const dir = instancesDir(stateDir);
	mkdirSync(dir, { recursive: true });
	const canonical = canonicalPath(runDir);
	const pointer: Pointer = { v: 1, runDir: canonical, host: hostname() };
	const final = join(dir, `${hashOf(canonical)}.json`);
	const tmp = `${final}.tmp${process.pid}`;
	await Bun.write(tmp, `${JSON.stringify(pointer, null, 2)}\n`);
	renameSync(tmp, final);
}

export function removePointer(stateDir: string, runDir: string): void {
	rmSync(pointerPath(stateDir, runDir), { force: true });
}

const POINTER_NAME = /^[0-9a-f]{64}\.json$/;

// Corrupt pointers are the deletion law's ONE exception: skip and reap
// (same-directory atomic writes make that state unreachable by normal
// operation). A string-identical twin under another hash: the
// realpath-keyed pointer wins, the twin is deleted on sight (D-032;
// file-identity dedupe is the R-048 fast-follow).
export async function scanPointers(
	stateDir: string,
): Promise<{ path: string; raw: string; pointer: Pointer }[]> {
	const dir = instancesDir(stateDir);
	if (!existsSync(dir)) return [];
	const entries: { path: string; raw: string; pointer: Pointer }[] = [];
	for (const name of readdirSync(dir)) {
		if (!POINTER_NAME.test(name)) continue;
		const path = join(dir, name);
		let raw: string;
		let pointer: Pointer;
		try {
			raw = await Bun.file(path).text();
			pointer = JSON.parse(raw) as Pointer;
			if (
				pointer.v !== 1 ||
				typeof pointer.runDir !== "string" ||
				typeof pointer.host !== "string"
			)
				throw new Error("bad pointer shape");
		} catch {
			rmSync(path, { force: true });
			continue;
		}
		entries.push({ path, raw, pointer });
	}
	const byRunDir = new Map<
		string,
		{ path: string; raw: string; pointer: Pointer }
	>();
	for (const e of entries) {
		const keyed = byRunDir.get(e.pointer.runDir);
		if (keyed === undefined) {
			byRunDir.set(e.pointer.runDir, e);
			continue;
		}
		const canonicalName = `${hashOf(e.pointer.runDir)}.json`;
		const winner = e.path.endsWith(canonicalName) ? e : keyed;
		const loser = winner === e ? keyed : e;
		rmSync(loser.path, { force: true });
		byRunDir.set(e.pointer.runDir, winner);
	}
	return [...byRunDir.values()];
}
```

- [ ] **Step 4: Run tests.** `bun test src/cli/registry.test.ts` — 0 failing tests. `bun run typecheck` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/registry.ts src/cli/registry.test.ts
git commit -m "feat: the machine-local instance registry - pointers, not state (R-045)"
```

---

### Task 5: Pointer lifecycle rides `writeRunfile`/`clearRunfile` + suite hermeticity

Every runfile writer becomes a registry writer; every clearer a registry remover. This is the one signature change that ripples — TypeScript enumerates the call sites.

**Files:**
- Modify: `src/cli/runfile.ts` (`writeRunfile`, `clearRunfile`)
- Modify: `src/cli/serve.ts` (both write sites), `src/cli/index.ts` (launchDetached write/clear, cmdDown clears, failed-boot clear)
- Modify: `src/cli/doctor.test.ts` (writeRunfile sites at ~401 and ~426), `test/cli-dispatch.test.ts` (writeRunfile sites at ~621, ~640, ~654, ~701, ~971)
- Create: `test/preload.ts`; Modify: `bunfig.toml`
- Test: `src/cli/runfile.test.ts`

**Interfaces:**
- Consumes: `writePointer`/`removePointer`/`stateDirFromEnv` (Task 4).
- Produces: `writeRunfile(runDir: string, run: Runfile, opts: { stateDir: string }): Promise<{ registered: boolean }>`; `clearRunfile(runDir: string, opts: { stateDir: string }): void`. Both best-effort on the registry half: a pointer failure never blocks the runfile op.

- [ ] **Step 1: Write the failing test.** Append to `src/cli/runfile.test.ts`:

```ts
// [utest->R-045]
test("writeRunfile registers a pointer; clearRunfile removes it; registry failure never blocks", async () => {
	const state = mkdtempSync(join(tmpdir(), "offbook-state-"));
	const dir = mkdtempSync(join(tmpdir(), "offbook-runfile-ptr-"));
	const run = {
		pid: 1,
		brokerWsPort: 1,
		brokerTcpPort: 2,
		controlPlanePort: 3,
		startedAt: "t",
	};
	const { registered } = await writeRunfile(dir, run, { stateDir: state });
	expect(registered).toBe(true);
	expect(existsSync(pointerPath(state, dir))).toBe(true);
	clearRunfile(dir, { stateDir: state });
	expect(existsSync(pointerPath(state, dir))).toBe(false);
	expect(existsSync(join(dir, "offbook.run"))).toBe(false);

	// an unwritable state dir degrades: runfile still written, registered false
	const blocked = join(state, "blocked");
	await Bun.write(blocked, "a FILE where the state dir should be");
	const second = await writeRunfile(dir, run, { stateDir: blocked });
	expect(second.registered).toBe(false);
	expect(existsSync(join(dir, "offbook.run"))).toBe(true);
	rmSync(state, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
});
```

Add imports as needed (`existsSync` from `node:fs`, `pointerPath` from `./registry.ts`, `clearRunfile`/`writeRunfile` from `./runfile.ts`).

- [ ] **Step 2: Run to verify failure.** `bun test src/cli/runfile.test.ts` — FAIL (arity/type errors surface as test failures at import time or assertion failures).

- [ ] **Step 3: Implement in `src/cli/runfile.ts`.** Add the import `import { removePointer, writePointer } from "./registry.ts";` and replace the two functions:

```ts
// D-032: every runfile writer is a registry writer, every clearer a
// remover — the pointer can then only DANGLE, never disagree. Best-effort:
// registry failures never block up or any verb (the caller surfaces M17).
export async function writeRunfile(
	runDir: string,
	run: Runfile,
	opts: { stateDir: string },
): Promise<{ registered: boolean }> {
	mkdirSync(runDir, { recursive: true });
	await Bun.write(runfilePath(runDir), `${JSON.stringify(run, null, 2)}\n`);
	try {
		await writePointer(opts.stateDir, runDir);
		return { registered: true };
	} catch {
		return { registered: false };
	}
}

export function clearRunfile(runDir: string, opts: { stateDir: string }): void {
	rmSync(runfilePath(runDir), { force: true });
	try {
		removePointer(opts.stateDir, runDir);
	} catch {
		// a broken registry must not break down's idempotence
	}
}
```

- [ ] **Step 4: Create `test/preload.ts` and wire it.** The suite-wide net: no test run may ever default into the real `~/.local/state`.

`test/preload.ts`:

```ts
// D-032 hermeticity net: pin OFFBOOK_STATE_DIR for the WHOLE suite before
// any test file loads, so nothing — in-process run() calls, spawned real
// servers (they inherit env; logSafeEnv preserves this var), doctor scans —
// can default into the real ~/.local/state. Test files that assert on scan
// CONTENTS still pin their own per-test dir (set + restore around run()).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.OFFBOOK_STATE_DIR)
	process.env.OFFBOOK_STATE_DIR = mkdtempSync(
		join(tmpdir(), "offbook-suite-state-"),
	);
```

**Documented spec deviation (flag it in the PR):** the spec's hermeticity bullet asks the preload to also "reset the shared scratch dir between test files". Bun's preload runs once per process and offers no between-files hook, so this plan instead makes per-test `OFFBOOK_STATE_DIR` pinning the enforced convention for every test that asserts on registry scans (see `inDiscoveryWorld` and the per-test scratch dirs throughout) — the suite-wide dir is only the guard against touching the real home. If the spec author wants the literal reset, a shared `beforeAll` helper imported by each registry-touching file is the follow-up.

In `bunfig.toml`, add at the top of the `[test]` table (line 2, before `coverage = true`):

```toml
preload = ["./test/preload.ts"]
```

- [ ] **Step 5: Update every caller.** Run `bun run typecheck` and fix each error it lists — the complete set:

1. `src/cli/serve.ts` line ~87 and ~125: add a module-level `const stateDir = stateDirFromEnv();` (import from `./registry.ts`) right after the `log` helper, and pass `{ stateDir }` as the third argument to both `writeRunfile` calls. Both writes also gain identity fields in Task 7 — for now just the arity fix: `await writeRunfile(config.runDir, { pid: process.pid, ...ports, startedAt: new Date().toISOString() }, { stateDir });` (and the respawn write likewise).
2. `src/cli/index.ts`: add `import { stateDirFromEnv } from "./registry.ts";`. In `launchDetached`, add `const stateDir = stateDirFromEnv();` as the first line and pass `{ stateDir }` to the `clearRunfile(runDir)` calls (lines ~1037, ~1072) and the `writeRunfile` call (~1054). In `cmdDown`, add the same const and pass `{ stateDir }` to both `clearRunfile` calls (~1234, ~1245).
3. `src/cli/doctor.test.ts` (~401, ~426): give the file one `const STATE = mkdtempSync(join(tmpdir(), "offbook-doctor-state-"));` near its other module consts and pass `{ stateDir: STATE }` to both `writeRunfile` calls.
4. `test/cli-dispatch.test.ts` (~621, ~640, ~654, ~701, ~971): add `const STATE = process.env.OFFBOOK_STATE_DIR ?? "";` near the port consts (the preload guarantees it is set) and pass `{ stateDir: STATE }` at all five sites.

- [ ] **Step 6: Run the full suite.**

Run: `bun test`
Expected: exit 0. If exit 1 with zero failing tests on a FULL run, a file dropped below the per-file coverage floor — add the missing unit coverage, don't lower the floor.

- [ ] **Step 7: Commit**

```bash
git add src/cli/runfile.ts src/cli/serve.ts src/cli/index.ts src/cli/runfile.test.ts src/cli/doctor.test.ts test/cli-dispatch.test.ts test/preload.ts bunfig.toml
git commit -m "feat: pointer lifecycle rides writeRunfile/clearRunfile; suite-wide state-dir hermeticity (R-045)"
```

---
### Task 6: `GET /v1/server` (control-plane route + compose passthrough)

**Files:**
- Modify: `src/control-plane/index.ts` (caps + route), `src/compose/index.ts` (parts passthrough)
- Test: `src/control-plane/index.test.ts`

**Interfaces:**
- Consumes: `ServerIdentity` (Task 2).
- Produces: `ControlPlaneCaps.server?: () => ServerIdentity`; `ComposeParts.server?: ServerIdentity`; route `GET /v1/server` → `c.json(identity)` when the cap is present, plain Hono 404 when absent (in-process/ephemeral boots and pre-D-032 builds look identical to a prober: not-a-candidate; no ErrorCode involved).

- [ ] **Step 1: Write the failing test.** Append to `src/control-plane/index.test.ts`. The file has NO `createServer`/caps fixture — every test boots through its `boot(n, opts)` helper (compose + `server.app.request`), and `boot` already spreads `opts.parts` into the `compose({...})` call, which is exactly the seam `ComposeParts.server` rides. Pick an `n` no other `boot(` call in the file uses (grep first; the helper derives ports as `18000+n`/`12800+n`/`18800+n`):

```ts
// [utest->R-044]
test("GET /v1/server: echoes the injected identity through compose; 404s (plain, no envelope) when identity-less", async () => {
	const identity = {
		pid: 4242,
		token: "ab".repeat(16),
		host: "devbox",
		projectDir: "/tmp/proj",
		runDir: "/tmp/proj/.offbook",
		startedAt: "2026-08-19T00:00:00.000Z",
		demo: false,
		ports: { brokerWsPort: 18091, brokerTcpPort: 12891, controlPlanePort: 18891 },
	};
	const withId = await boot(91, { parts: { server: identity } });
	const res = await withId.req("/v1/server");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual(identity);

	// identity-less (every existing boot): a PLAIN 404 — no §5 error
	// envelope, the closed ErrorCode union is untouched
	const without = await boot(92);
	const miss = await without.req("/v1/server");
	expect(miss.status).toBe(404);
	expect((await miss.text()).includes('"error"')).toBe(false);
});
```

(If 91/92 are taken by then, shift both; the identity's `ports` values are just echoed data — matching `n` keeps the fixture honest but nothing binds them.)

- [ ] **Step 2: Run to verify failure.** `bun test src/control-plane/index.test.ts` — FAIL (unknown property `server`, then 404 on both).

- [ ] **Step 3: Implement.**

`src/control-plane/index.ts` — add `ServerIdentity` to the existing `#src/model/index.ts` type-import list, and append to `ControlPlaneCaps`:

```ts
	// R-044/D-032 — the /v1/server identity read; absent (undefined) on
	// identity-less boots (in-process tests, `offbook demo` one-shot): the
	// route then 404s plainly, which a prober reads as not-a-candidate
	server?: () => ServerIdentity;
```

In `createServer`, add with the other reads (after the `/v1/mode` route):

```ts
	app.get("/v1/server", (c) =>
		caps.server === undefined ? c.notFound() : c.json(caps.server()),
	);
```

`src/compose/index.ts` — add `ServerIdentity` to the model type-import list; append to `ComposeParts`:

```ts
	server?: ServerIdentity; // R-044: serve.ts's identity; absent in-process
```

In `compose`, right before `const caps: ControlPlaneCaps = {`:

```ts
	const serverIdentity = parts.server;
```

and inside the caps object literal (alphabetically near `seed`/`setMode` is fine; anywhere consistent):

```ts
		server: serverIdentity === undefined ? undefined : () => serverIdentity,
```

- [ ] **Step 4: Run tests.** `bun test src/control-plane/index.test.ts` — 0 failing tests. `bun run typecheck` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/control-plane/index.ts src/compose/index.ts src/control-plane/index.test.ts
git commit -m "feat: GET /v1/server identity read behind an injected cap (R-044)"
```

---

### Task 7: serve.ts serves its identity (fatal on relative runDir / missing token)

**Files:**
- Modify: `src/cli/serve.ts`, `src/cli/boot.ts` (thread `server` into compose)
- Test: create `test/instance-discovery.test.ts` (grows through later tasks)

**Interfaces:**
- Consumes: `ServerIdentity`, `ComposeParts.server`, `stateDirFromEnv` (already imported in Task 5).
- Produces: `ProjectBootOptions.server?: ServerIdentity` and `bootDemo` opts `server?: ServerIdentity` (passed through to `compose`); serve.ts boot-file contract: `token` required, `config.runDir` must be absolute; both runfile writes carry `token` + `host`.

- [ ] **Step 1: Write the failing tests.** Create `test/instance-discovery.test.ts`:

```ts
// [itest->R-044] [itest->R-045]
// Instance discovery integration: serve.ts boot-contract fatals here;
// the state-table row suite lands in this file in a later task.
// Ports for this file (repo convention: unique per file): 19430-19449,
// tcp 12490-12495 (bound by the real `up` runs below).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVE = join(import.meta.dir, "../src/cli/serve.ts");

async function spawnServe(boot: object): Promise<{ code: number; err: string }> {
	const dir = mkdtempSync(join(tmpdir(), "offbook-serve-fatal-"));
	const bootPath = join(dir, "offbook.boot.json");
	await Bun.write(bootPath, JSON.stringify(boot));
	const proc = Bun.spawn([process.execPath, SERVE, bootPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	const err = await new Response(proc.stderr).text();
	rmSync(dir, { recursive: true, force: true });
	return { code, err };
}

// [itest->R-044]
test("serve: a relative runDir in the boot file is a fatal boot error (no ports bound)", async () => {
	const { code, err } = await spawnServe({
		projectDir: "/tmp/nowhere",
		config: { runDir: ".offbook" },
		demo: true,
		token: "aa".repeat(16),
	});
	expect(code).toBe(1);
	expect(err).toContain("relative runDir");
	expect(err).toContain("offbook up");
}, 20_000);

// [itest->R-044]
test("serve: a missing launch token is a fatal boot error", async () => {
	const runDir = mkdtempSync(join(tmpdir(), "offbook-serve-notoken-"));
	const { code, err } = await spawnServe({
		projectDir: "/tmp/nowhere",
		config: { runDir },
		demo: true,
	});
	expect(code).toBe(1);
	expect(err).toContain("no launch token");
	rmSync(runDir, { recursive: true, force: true });
}, 20_000);
```

- [ ] **Step 2: Run to verify failure.** `bun test test/instance-discovery.test.ts` — FAIL: serve currently boots the demo (or dies differently); the `relative runDir` / `no launch token` markers are absent.

- [ ] **Step 3: Implement.**

`src/cli/boot.ts` — add to the model type-import list `ServerIdentity`; add to `ProjectBootOptions`:

```ts
	server?: ServerIdentity; // R-044: serve.ts's identity, threaded to compose
```

pass it in `bootProject`'s `compose({ ... })` call: `server: opts.server,` — and in `bootDemo`, extend the opts type with `server?: ServerIdentity` and pass `server: opts.server,` in its `compose({ ... })` call.

`src/cli/serve.ts`:

1. Extend imports: `import { hostname } from "node:os";`, add `isAbsolute` to the `node:path` import, add `ServerIdentity` to a model type import.
2. Extend `BootFile`:

```ts
	token?: string; // R-044: the launch lineage id `up` baked in (required)
```

3. Directly after `const config = loadConfig(boot.config);` insert:

```ts
	// D-032 — `up` bakes ABSOLUTE paths and the launch token into the boot
	// file. A relative runDir would re-resolve against THIS process's cwd
	// (which may have been moved or deleted under a --watch respawn); a
	// missing token leaves the lineage unidentifiable. Both are fatal —
	// the fix is rerunning `offbook up` on this build.
	if (!isAbsolute(config.runDir))
		throw new Error(
			`boot file carries a relative runDir '${config.runDir}' — rerun \`offbook up\` (this build bakes absolute paths)`,
		);
	if (typeof boot.token !== "string" || boot.token === "")
		throw new Error("boot file carries no launch token — rerun `offbook up`");
	const token = boot.token;
```

4. Move the `ports` const (currently after the boot-line logging) UP to directly after the token check, then build the identity and pass it to boot:

```ts
	const ports = {
		brokerWsPort: config.brokerWsPort,
		brokerTcpPort: config.brokerTcpPort,
		controlPlanePort: config.controlPlanePort,
	};
	const startedAt = new Date().toISOString();
	// R-044 — what GET /v1/server answers; pid/startedAt are THIS
	// incarnation's, token is the lineage's
	const identity: ServerIdentity = {
		pid: process.pid,
		token,
		host: hostname(),
		projectDir: boot.projectDir,
		runDir: config.runDir,
		startedAt,
		demo: boot.demo === true,
		ports,
	};
```

and add `server: identity,` to both the `bootDemo({ config, log })` call (→ `bootDemo({ config, log, server: identity })`) and the `bootProject({ ... })` call.

5. The post-boot runfile write becomes (keeping the Task 5 `{ stateDir }`):

```ts
	// the runfile follows the SERVING pid across --watch respawns (G14);
	// token stays the lineage's, host this machine's (R-044)
	await writeRunfile(
		config.runDir,
		{ pid: process.pid, ...ports, startedAt, token, host: hostname() },
		{ stateDir },
	);
```

6. The `--watch` respawn write likewise gains `token, host: hostname()` in its runfile object.

- [ ] **Step 4: Run tests.** `bun test test/instance-discovery.test.ts` — 0 failing. Then `bun test` (full) — suites that spawn the REAL detached server via `up`/`demo --serve` will FAIL until `up` bakes a token (Task 9). The real-server-spawning set (verified by grepping for `run(["up"`/`--serve` through the bin): `test/cli-dispatch.test.ts`, `test/demo-serve.test.ts`, `test/readme-quickstart.test.ts`, `test/gate-determinism.test.ts` (its ctrl 19850 `up` run). In-process suites (`test/guides-cookbook.test.ts`, `test/ci-settlement.test.ts`, `test/m0-acceptance.test.ts`, the gate-observe/gate-validation files) compose directly and must stay green — if any of THOSE fails, stop and investigate. To keep the tree green per-commit, squash Tasks 7+9 into one commit if the breakage is real in your run; otherwise proceed (Task 9 lands the other half).

- [ ] **Step 5: Commit**

```bash
git add src/cli/serve.ts src/cli/boot.ts test/instance-discovery.test.ts
git commit -m "feat: serve.ts builds and serves its identity; boot-file contract hardened (R-044)"
```

---

### Task 8: The message catalog module

**Files:**
- Create: `src/cli/messages.ts`
- Test: `src/cli/messages.test.ts`

**Interfaces:**
- Produces (consumed by every later task): `InstanceRow { projectDir, demo, ws, tcp, http, pid, runDir }`; `instanceTable(rows: InstanceRow[], verb?: string): string[]`; message functions `M2(path)`, `M3({port, projectDir, runDir, demo, alsoBusy?})`, `M5(pid, projectDir, demo)`, `M6()`, `M8()`, `M9()`, `M10(host, runDir)`, `M11()`, `M11s()`, `M12(pid)`, `M13(projectDir, pid, port)`, `M13wrongToken(projectDir, pid, port, answeringProjectDir)`, `M14(dir, pid)`, `M14missing(dir)`, `M15(projectDir, demo)`, `M15d(dir, runDir)`, `M16(projectDir, ws, http, demo)`, `M17(projectDir, runDir)`, `M18()`, `M19(path, projectDir, runDir)`, `M20(dir)`, `M21()`, `M22()`; `type RefusalCode = "ambiguous" | "not-running" | "demo-only" | "wrong-host" | "version-skew"`; `refusalEnvelope(code, message, candidates?): string` (one JSON document).

- [ ] **Step 1: Write the failing test** `src/cli/messages.test.ts`:

```ts
// [utest->R-045] — the catalog IS the fixture: wording, stream, and exit
// code assertions in cli-dispatch build on these exact strings, and the
// D-032 docs sweep greps them. Two automation anchors are contract.
import { expect, test } from "bun:test";
import {
	instanceTable,
	M3,
	M5,
	M6,
	M11,
	M12,
	M13,
	M16,
	M22,
	refusalEnvelope,
} from "./messages.ts";

test("the two automation anchors: M11 leads with 'offbook is not running'; notes lead with '(offbook:'", () => {
	expect(M11().startsWith("offbook is not running")).toBe(true);
	expect(M12(7).startsWith("offbook is not running")).toBe(false); // M12 is the wedged variant
	expect(M12(7).startsWith("offbook is not answering here")).toBe(true);
	expect(M13("/p", 7, 19801).startsWith("(offbook:")).toBe(true);
});

test("instance table rows: identity line + one complete paste-ready command per instance", () => {
	const rows = instanceTable(
		[
			{
				projectDir: "/app/mock",
				demo: false,
				ws: 9001,
				tcp: 1883,
				http: 9080,
				pid: 41,
				runDir: "/app/mock/.offbook",
			},
			{
				projectDir: "/tmp/demo",
				demo: true,
				ws: 9101,
				tcp: 1983,
				http: 9180,
				pid: 42,
				runDir: "/tmp/demo/.offbook",
			},
		],
		"down",
	);
	expect(rows).toEqual([
		"  /app/mock — ws 9001 · tcp 1883 · http 9080 · pid 41",
		"    offbook down --run-dir /app/mock/.offbook",
		"  /tmp/demo [demo] — ws 9101 · tcp 1983 · http 9180 · pid 42",
		"    offbook down --run-dir /tmp/demo/.offbook",
	]);
});

test("no registry/pointer/token/endpoint vocabulary in human-facing text", () => {
	const all = [
		M3({ port: 9080, projectDir: "/p", runDir: "/p/.offbook", demo: false }),
		M5(1, "/p", false),
		M6(),
		M11(),
		M12(1),
		M13("/p", 1, 2),
		M16("/p", 1, 2, true),
		M22(),
	].join("\n");
	for (const word of ["registry", "pointer", "token", "endpoint", "/v1/"])
		expect(all.includes(word)).toBe(false);
});

test("every catalog template renders non-empty (and keeps the per-file coverage floor honest)", async () => {
	const catalog = await import("./messages.ts");
	const rendered = [
		catalog.M2("/p"),
		catalog.M3({ port: 1, projectDir: "/p", runDir: "/p/.offbook", demo: true, alsoBusy: "; also busy: ws 9001" }),
		catalog.M5(1, "/p", true),
		catalog.M6(),
		catalog.M8(),
		catalog.M9(),
		catalog.M10("h", "/p/.offbook"),
		catalog.M11(),
		catalog.M11s(),
		catalog.M12(1),
		catalog.M13("/p", 1, 2),
		catalog.M13wrongToken("/p", 1, 2, "/q"),
		catalog.M14("/p", 1),
		catalog.M14missing("/p"),
		catalog.M15("/p", true),
		catalog.M15d("/p", "/p/.offbook"),
		catalog.M16("/p", 1, 2, false),
		catalog.M17("/p", "/p/.offbook"),
		catalog.M18(),
		catalog.M19("/l", "/p", "/p/.offbook"),
		catalog.M20("/p"),
		catalog.M21(),
		catalog.M22(),
	];
	for (const m of rendered) expect(m.length).toBeGreaterThan(0);
});

test("refusalEnvelope is exactly one JSON document", () => {
	const doc = refusalEnvelope("ambiguous", "pick one", [
		{
			projectDir: "/p",
			demo: false,
			ws: 1,
			tcp: 2,
			http: 3,
			pid: 4,
			runDir: "/p/.offbook",
		},
	]);
	const parsed = JSON.parse(doc);
	expect(parsed.error.code).toBe("ambiguous");
	expect(parsed.candidates).toHaveLength(1);
	expect(JSON.parse(refusalEnvelope("not-running", "m")).candidates).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify failure.** `bun test src/cli/messages.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement** `src/cli/messages.ts`. The wordings are the spec's catalog **byte for byte** — do not editorialize:

```ts
// R-045/D-032 — the message catalog (spec: docs/superpowers/specs/
// 2026-08-18-instance-discovery-design.md "Message catalog"): every
// discovery-era user-facing string lives HERE, one export per catalog id,
// so wording, stream, and exit code cannot drift between the CLI, the
// tests, and the docs (this file is the D-032 grep source). Ids are sparse:
// unchanged pre-D-032 messages keep their wordings where they already live.
// Voice: lowercase; `offbook <verb> —` / `offbook:` prefixes; hints as
// em-dash clauses with backticked commands; `control port <n>`, never bare
// `port <n>`; NEVER registry/pointer/token/endpoint vocabulary in
// human-facing text. Automation anchors (contract, D-032): the
// `offbook is not running` leading token and the `(offbook:` note prefix.

export interface InstanceRow {
	projectDir: string;
	demo: boolean;
	ws: number;
	tcp: number;
	http: number;
	pid: number;
	runDir: string;
}

// M6/M8/M9 share this shape: one identity line + one complete, double-click
// copyable command per instance — choosing is one paste, never a stdin
// prompt (agents and scripts must never hang).
export function instanceTable(rows: InstanceRow[], verb = "down"): string[] {
	return rows.flatMap((r) => [
		`  ${r.projectDir}${r.demo ? " [demo]" : ""} — ws ${r.ws} · tcp ${r.tcp} · http ${r.http} · pid ${r.pid}`,
		`    offbook ${verb} --run-dir ${r.runDir}`,
	]);
}

export const M2 = (path: string): string =>
	`offbook up: ${path} is not a directory — pass your project directory (e.g. \`offbook up mock\`)`;

export const M3 = (opts: {
	port: number;
	projectDir: string;
	runDir: string;
	demo: boolean;
	alsoBusy?: string; // pre-formatted "; also busy: ws 9001" clause or ""
}): string =>
	`another offbook owns the control port ${opts.port}${opts.alsoBusy ?? ""} (${
		opts.demo
			? `the bundled demo, started in ${opts.projectDir}`
			: `started in ${opts.projectDir}`
	}) — \`offbook down --run-dir ${opts.runDir}\` stops it from anywhere on this machine`;

export const M5 = (pid: number, projectDir: string, demo: boolean): string =>
	demo
		? `offbook down — stopped the demo (pid ${pid}, started in ${projectDir})`
		: `offbook down — stopped (pid ${pid}, started in ${projectDir})`;

export const M6 = (): string =>
	"offbook: not running (in this project) — running elsewhere on this machine:";

export const M8 = (): string =>
	"offbook: several instances are running — pick one:";

export const M9 = (): string =>
	"offbook down: one instance verified but others are not answering — pick one:";

export const M10 = (host: string, runDir: string): string =>
	`offbook: this runfile was written on ${host} — run \`offbook down\` there, or delete ${runDir}/offbook.run if that machine is gone`;

export const M11 = (): string =>
	"offbook is not running (no runfile in .offbook, and nothing else is running on this machine) — run `offbook up`, or pass --ctrl-port";

// status keeps its `offbook: not running (...)` shape with the same clause
export const M11s = (): string =>
	"offbook: not running (no runfile in .offbook, and nothing else is running on this machine)";

// replaces M11 AND M13 when the only skipped instance is cwd's own —
// never printed alongside them
export const M12 = (pid: number): string =>
	`offbook is not answering here (pid ${pid}, runfile in .offbook), and nothing else is running on this machine — \`offbook down\` stops the wedged one; \`offbook logs\` may say why`;

export const M13 = (projectDir: string, pid: number, port: number): string =>
	`(offbook: an instance in ${projectDir} (pid ${pid}) is not answering on control port ${port} — manage it from that directory or with --run-dir)`;

// the spec's row-4 "M13 variant naming both": the port ANSWERED, just as a
// different offbook — saying "not answering" there would be untrue output.
// (The spec declares this variant without pinning its wording; this is the
// plan's proposed wording — flag it with the catalog if it reads wrong.)
export const M13wrongToken = (
	projectDir: string,
	pid: number,
	port: number,
	answeringProjectDir: string,
): string =>
	`(offbook: an instance in ${projectDir} (pid ${pid}) no longer answers for control port ${port} — the offbook in ${answeringProjectDir} does; manage it from its directory or with --run-dir)`;

// one-shot: only the invocation that performed the cleanup prints it
export const M14 = (dir: string, pid: number): string =>
	`(offbook: cleaned up a stopped offbook: ${dir} — pid ${pid} is gone)`;

export const M14missing = (dir: string): string =>
	`(offbook: cleaned up a stopped offbook: ${dir} — its runfile is gone; if ports are still busy, run \`offbook doctor\`)`;

// mutating verbs on registry resolution only (reads name in-band, M16)
export const M15 = (projectDir: string, demo: boolean): string =>
	demo
		? `(offbook: using the bundled demo started in ${projectDir})`
		: `(offbook: using the offbook started in ${projectDir})`;

export const M15d = (dir: string, runDir: string): string =>
	`(offbook: the bundled demo in ${dir} is also running — \`offbook down --run-dir ${runDir}\` stops it)`;

// the in-band header: registry-resolved reads, human mode, first line
export const M16 = (
	projectDir: string,
	ws: number,
	http: number,
	demo: boolean,
): string =>
	`offbook @ ${projectDir} (ws ${ws} · http ${http})${demo ? " — the bundled demo" : ""}`;

export const M17 = (projectDir: string, runDir: string): string =>
	`(offbook: could not record this instance for manage-from-anywhere — manage it from ${projectDir} or with \`--run-dir ${runDir}\`)`;

export const M18 = (): string =>
	"offbook: this server was started by an older offbook build — restart it (`offbook down` then `offbook up`) to manage it from here";

export const M19 = (path: string, projectDir: string, runDir: string): string =>
	`(offbook: showing the local stopped log at ${path}; a live offbook runs in ${projectDir} — \`offbook logs --run-dir ${runDir}\` for its log)`;

export const M20 = (dir: string): string =>
	`the only running offbook is the bundled demo (started in ${dir}) — run \`offbook down\` to stop it, then \`offbook up <dir>\` for your mock`;

export const M21 = (): string =>
	"this skill predates manage-from-anywhere — its advice about which directory to run offbook in is now wrong; run `offbook skill install` to refresh it";

export const M22 = (): string =>
	"offbook down: the instance restarted underneath — rerun `offbook down`";

// The CLI refusal envelope (D-032): mirrors the §5 error-envelope
// convention WITHOUT touching the closed ErrorCode union — these codes
// exist only on the CLI's own --json surface. Contract: --json stdout is
// always exactly ONE JSON document; the stderr table is replaced by the
// envelope in --json mode.
export type RefusalCode =
	| "ambiguous"
	| "not-running"
	| "demo-only"
	| "wrong-host"
	| "version-skew";

export function refusalEnvelope(
	code: RefusalCode,
	message: string,
	candidates?: InstanceRow[],
): string {
	return JSON.stringify({
		error: { code, message },
		...(candidates === undefined ? {} : { candidates }),
	});
}
```

- [ ] **Step 4: Run tests.** `bun test src/cli/messages.test.ts` — 0 failing.

- [ ] **Step 5: Commit**

```bash
git add src/cli/messages.ts src/cli/messages.test.ts
git commit -m "feat: the M2-M22 message catalog + instance table + refusal envelope (R-045)"
```

---

### Task 9: `up`/`demo --serve` bake identity; readiness = identity; guarded failed-boot clear

**Files:**
- Modify: `src/cli/index.ts` (`launchDetached`, `cmdUp`, `cmdDemoServe`)
- Test: `test/instance-discovery.test.ts`

**Interfaces:**
- Consumes: `probeServer`, `guarded`, `M17`, `writeRunfile` (+ `{ registered }`), `stateDirFromEnv`.
- Produces: boot files carry `token` + absolute `projectDir`/`runDir`; runfiles carry `token`/`host`; `up` succeeds only when `/v1/server` answers with this launch's token; the failed-boot clear is guarded (site #4) with its precondition exported pure as `shouldClearFailedBoot(spawned: { pid: number; token: string }, seen: { run: Runfile | undefined; probe: ServerProbe }): boolean`.

- [ ] **Step 1: Write the failing integration test.** Append to `test/instance-discovery.test.ts` (new imports: `run` and `shouldClearFailedBoot` from `#src/cli/index.ts`, `readRunfile` from `#src/cli/runfile.ts`, `pointerPath` from `#src/cli/registry.ts`, `gitSpecProject` from `./project-fixture.ts`, `existsSync` from `node:fs`, and an `io()` helper copied verbatim from `test/cli-dispatch.test.ts` lines 64–68):

```ts
// [itest->R-044] [itest->R-045]
test("up bakes identity: boot file token + absolute paths; /v1/server answers it; runfile + pointer agree; down unregisters", async () => {
	const projectDir = await gitSpecProject();
	const runDir = join(projectDir, ".offbook");
	const prevCwd = process.cwd();
	const state = mkdtempSync(join(tmpdir(), "offbook-idstate-"));
	const prevState = process.env.OFFBOOK_STATE_DIR;
	process.env.OFFBOOK_STATE_DIR = state;
	process.chdir(projectDir);
	try {
		const x = io();
		expect(
			await run(
				["up", "--ci", "--ws-port", "19430", "--tcp-port", "12490", "--ctrl-port", "19431"],
				x.io,
			),
		).toBe(0);
		const boot = JSON.parse(
			await Bun.file(join(runDir, "offbook.boot.json")).text(),
		) as { token?: string; projectDir?: string; config?: { runDir?: string } };
		expect(boot.token).toMatch(/^[0-9a-f]{32}$/);
		expect(boot.projectDir?.startsWith("/")).toBe(true);
		expect(boot.config?.runDir?.startsWith("/")).toBe(true);
		const identity = (await (
			await fetch("http://localhost:19431/v1/server")
		).json()) as { token: string; runDir: string; projectDir: string; demo: boolean };
		expect(identity.token).toBe(boot.token as string);
		expect(identity.demo).toBe(false);
		const runfile = await readRunfile(runDir);
		expect(runfile?.token).toBe(boot.token);
		expect(typeof runfile?.host).toBe("string");
		expect(existsSync(pointerPath(state, runDir))).toBe(true);
		expect(await run(["down"], io().io)).toBe(0);
		expect(existsSync(pointerPath(state, runDir))).toBe(false); // no leftover pointer
	} finally {
		process.chdir(prevCwd);
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		process.env.OFFBOOK_STATE_DIR = prevState;
		rmSync(state, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 90_000);

// [itest->R-045]
test("up with an unwritable state dir prints the could-not-record note and still serves (M17)", async () => {
	const projectDir = await gitSpecProject();
	const runDir = join(projectDir, ".offbook");
	const prevCwd = process.cwd();
	const blocked = mkdtempSync(join(tmpdir(), "offbook-blocked-"));
	const blockedFile = join(blocked, "state-is-a-file");
	await Bun.write(blockedFile, "x");
	const prevState = process.env.OFFBOOK_STATE_DIR;
	process.env.OFFBOOK_STATE_DIR = blockedFile;
	process.chdir(projectDir);
	try {
		const x = io();
		expect(
			await run(
				["up", "--ci", "--ws-port", "19432", "--tcp-port", "12491", "--ctrl-port", "19433"],
				x.io,
			),
		).toBe(0);
		expect(x.err.join("\n")).toContain(
			"(offbook: could not record this instance for manage-from-anywhere",
		);
		expect(await run(["down"], io().io)).toBe(0);
	} finally {
		process.chdir(prevCwd);
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		process.env.OFFBOOK_STATE_DIR = prevState;
		rmSync(blocked, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 90_000);

// [utest->R-044] — guarded site #4's precondition, pinned pure (the
// concurrent-up race cannot be staged against a real 30s boot)
test("shouldClearFailedBoot: our dead spawn clears; a repointed runfile or another token on the port survives", () => {
	const spawned = { pid: 41, token: "cc".repeat(16) };
	const ours = {
		pid: 41,
		brokerWsPort: 1,
		brokerTcpPort: 2,
		controlPlanePort: 3,
		startedAt: "t",
		token: spawned.token,
	};
	const silent = { kind: "silent" as const };
	// our own failed boot: clear
	expect(shouldClearFailedBoot(spawned, { run: ours, probe: silent })).toBe(true);
	// a concurrent up repointed the runfile: its registration survives
	expect(
		shouldClearFailedBoot(spawned, {
			run: { ...ours, pid: 42, token: "dd".repeat(16) },
			probe: silent,
		}),
	).toBe(false);
	// the runfile is already gone: nothing to clear
	expect(shouldClearFailedBoot(spawned, { run: undefined, probe: silent })).toBe(false);
	// another launch answers the port: the winner survives
	expect(
		shouldClearFailedBoot(spawned, {
			run: ours,
			probe: {
				kind: "server",
				identity: {
					pid: 43,
					token: "ee".repeat(16),
					host: "h",
					projectDir: "/w",
					runDir: "/w/.offbook",
					startedAt: "t",
					demo: false,
					ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 3 },
				},
			},
		}),
	).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure.** `bun test test/instance-discovery.test.ts` — the new tests FAIL (no token in the boot file).

- [ ] **Step 3: Implement in `src/cli/index.ts`.**

Imports: add `randomBytes` to the `node:crypto` import; `hostname` from `node:os`; `resolve` (and keep `join`) from `node:path`; `guarded` from `./guard.ts`; `M17` from `./messages.ts`; `probeServer` from `./runfile.ts` (extend the existing import list); `stateDirFromEnv` is already imported (Task 5).

First, the site-#4 precondition as an exported pure function (the concurrent-`up` race cannot be staged deterministically against a real 30s boot, so the predicate itself is the pin — add near `launchDetached`, importing `type { Runfile, ServerProbe }` from `./runfile.ts`):

```ts
// guarded site #4's precondition, extracted pure so its race semantics are
// testable without racing a real boot: the failed-boot clear fires only
// when the runfile still names OUR spawn AND no other launch answers the
// port — a concurrent up's winner (repointed runfile, or a different token
// on the port) must survive the clear
export function shouldClearFailedBoot(
	spawned: { pid: number; token: string },
	seen: { run: Runfile | undefined; probe: ServerProbe },
): boolean {
	return (
		seen.run !== undefined &&
		seen.run.pid === spawned.pid &&
		seen.run.token === spawned.token &&
		!(seen.probe.kind === "server" && seen.probe.identity.token !== spawned.token)
	);
}
```

In `launchDetached` (after `await preflightPorts(config);`):

```ts
	const token = randomBytes(16).toString("hex"); // the launch lineage id (R-044)
	mkdirSync(runDir, { recursive: true });
	const bootFile = join(runDir, "offbook.boot.json");
	await Bun.write(bootFile, JSON.stringify({ ...spec.boot, token }, null, 2));
```

The runfile write gains identity and surfaces M17 on registration failure:

```ts
	const reg = await writeRunfile(
		runDir,
		{
			pid,
			brokerWsPort: config.brokerWsPort,
			brokerTcpPort: config.brokerTcpPort,
			controlPlanePort: config.controlPlanePort,
			startedAt: new Date().toISOString(),
			token,
			host: hostname(),
		},
		{ stateDir },
	);
	if (!reg.registered) io.err(M17(spec.boot.projectDir, runDir));
```

The readiness loop becomes identity (replaces the `probeOffbook` loop body):

```ts
	const deadline = Date.now() + 30_000;
	let ready = false;
	while (Date.now() < deadline) {
		// readiness IS identity (R-044): only THIS launch's token counts —
		// an old instance still draining the port must not green a new up
		const probe = await probeServer(config.controlPlanePort, 300);
		if (probe.kind === "server" && probe.identity.token === token) {
			ready = true;
			break;
		}
		if (!pidAlive(pid)) break;
		await sleep(100);
	}
```

The failed-boot clear becomes guarded site #4 (replaces the bare `clearRunfile(runDir)` inside `if (!ready)`):

```ts
		// guarded site #4: clear only if the runfile still names OUR spawn
		// and no OTHER launch answers the port (a concurrent up's winner —
		// or a late riser of ours — must survive this clear)
		await guarded({
			read: async () => ({
				run: await readRunfile(runDir),
				probe: await probeServer(config.controlPlanePort, 300),
			}),
			expect: (seen) => shouldClearFailedBoot({ pid, token }, seen),
			act: () => clearRunfile(runDir, { stateDir }),
		});
```

In `cmdUp`, make the runDir absolute before `loadConfig` (the boot file must carry it absolute):

```ts
	const runDir = resolve(process.cwd(), runDirOf(values));
```

(`overrides.runDir = runDir` already picks this up; `boot.projectDir: process.cwd()` is already absolute.) Same one-line change in `cmdDemoServe`.

- [ ] **Step 4: Run tests.**

Run: `bun test test/instance-discovery.test.ts` — 0 failing.
Run: `bun test` — full suite green (exit 0). The Task 7 breakage window closes here.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts test/instance-discovery.test.ts
git commit -m "feat: up bakes the launch token + absolute paths; readiness = identity; guarded failed-boot clear (R-044)"
```

---

### Task 10: The resolver, part 1 — probe classification + state-table rows 1–5 (cwd + explicit addressing)

**Files:**
- Create: `src/cli/resolve.ts`
- Test: `src/cli/resolve.test.ts`

**Interfaces:**
- Consumes: `probeServer`, `readRunfile`, `writeRunfile`, `clearRunfile`, `pidAlive`, `runfilePath` (runfile.ts — export `runfilePath` if not already exported; it is); `guarded`; `writePointer`, `canonicalPath` (registry.ts); `M10`, `M14` (messages.ts); `CliError` (client.ts); `DEFAULT_CONFIG` (model).
- Produces (final shapes — Task 11 extends behavior, not types):

```ts
export interface ResolvedInstance {
	runDir: string; // absolute
	run: Runfile;
	identity?: ServerIdentity; // verified rows only (absent on row 2)
	projectDir?: string; // identity's, else the boot file's
	demo: boolean;
	source: "cwd" | "registry";
}
export interface SkippedInstance {
	runDir: string;
	projectDir: string;
	pid: number;
	ctrlPort: number;
	// "dead" occurs ONLY on the explicit --run-dir path (reclaimDead: false
	// preserves today's stale-runfile reporting for read verbs; the cwd and
	// registry paths reclaim dead targets instead, rows 5/8)
	reason: "silent" | "wrong-token" | "dead";
	answeringProjectDir?: string; // row 4: who actually answers the port
}
export interface Resolution {
	resolved?: ResolvedInstance;
	candidates: ResolvedInstance[]; // every verified-live instance seen
	skipped: SkippedInstance[];
	notes: string[]; // pre-formatted `(offbook:` stderr notes
	foreignSeen: boolean; // a foreign-host record was passed over (row 10)
}
// the foreign-host refusal (M10, exit 2) — a CliError subclass so direct
// callers' toThrow assertions hold; verbs catch it to emit the wrong-host
// envelope under --json without the run() renderer double-prefixing
export class WrongHostError extends CliError {}
export function containsOrEqual(ancestor: string, descendant: string): boolean;
export async function resolveInstance(opts: {
	cwd: string;
	runDirFlag?: string;
	stateDir: string;
	selfHealProbePort?: number; // test injection; default 9080 (Task 11)
}): Promise<Resolution>;
```

- [ ] **Step 1: Write the failing tests** `src/cli/resolve.test.ts` (ports 19400–19408):

```ts
// [utest->R-045] — state-table rows 1-5 (the cwd runfile) + explicit
// --run-dir addressing + the host rule. Registry rows are tested with the
// scan in resolve part 2 and test/instance-discovery.test.ts.
// Ports for this file (repo convention: unique per file): 19400-19429.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerIdentity } from "#src/model/index.ts";
import { CliError } from "./client.ts";
import { pointerPath } from "./registry.ts";
import { resolveInstance } from "./resolve.ts";
import { writeRunfile } from "./runfile.ts";

const scratch = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
```

The two helpers every test below uses (`hostname` comes from a static `import { hostname } from "node:os";` at the top):

```ts
function identityServer(
	port: number,
	identity: Partial<ServerIdentity> & { token: string; runDir: string },
): { stop(): void } {
	const full = {
		pid: process.pid,
		host: hostname(),
		projectDir: "/tmp/unset",
		startedAt: "t",
		demo: false,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: port },
		...identity,
	} as ServerIdentity;
	const server = Bun.serve({
		port,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/server"
				? Response.json(full)
				: new Response("nope", { status: 404 }),
	});
	return { stop: () => server.stop(true) };
}

const RUN = (ctrl: number, token?: string, host?: string) => ({
	pid: process.pid,
	brokerWsPort: 1,
	brokerTcpPort: 2,
	controlPlanePort: ctrl,
	startedAt: "t",
	...(token === undefined ? {} : { token }),
	...(host === undefined ? {} : { host }),
});

test("row 1: live cwd runfile + matching token resolves (source cwd) and adopts a pointer", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-cwd-");
	const runDir = join(cwd, ".offbook");
	const token = "11".repeat(16);
	await writeRunfile(runDir, RUN(19400, token), { stateDir: state });
	rmSync(pointerPath(state, runDir), { force: true }); // adopt-on-sight must rewrite it
	const server = identityServer(19400, { token, runDir, projectDir: cwd });
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.source).toBe("cwd");
		expect(res.resolved?.identity?.token).toBe(token);
		expect(res.resolved?.projectDir).toBe(cwd);
		expect(existsSync(pointerPath(state, runDir))).toBe(true);
	} finally {
		server.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("row 2: legacy /v1/mode answer resolves live-unverified locally and adopts", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-cwd-");
	const runDir = join(cwd, ".offbook");
	await writeRunfile(runDir, RUN(19401), { stateDir: state });
	rmSync(pointerPath(state, runDir), { force: true });
	const legacy = Bun.serve({
		port: 19401,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/mode"
				? Response.json({ mode: "autonomous" })
				: new Response("nope", { status: 404 }),
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.source).toBe("cwd");
		expect(res.resolved?.identity).toBeUndefined(); // live-unverified
		expect(existsSync(pointerPath(state, runDir))).toBe(true);
	} finally {
		legacy.stop(true);
		rmSync(state, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("row 3: live pid, silent port — skipped, runfile kept, nothing resolved", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-cwd-");
	const runDir = join(cwd, ".offbook");
	await writeRunfile(runDir, RUN(19402, "22".repeat(16)), { stateDir: state });
	const res = await resolveInstance({ cwd, stateDir: state });
	expect(res.resolved).toBeUndefined();
	expect(res.skipped).toHaveLength(1);
	expect(res.skipped[0].reason).toBe("silent");
	expect(existsSync(join(runDir, "offbook.run"))).toBe(true); // live-pid: only ever skipped
	rmSync(state, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

test("row 4: wrong token — the port belongs to someone else; skipped, never reclaimed", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-cwd-");
	const runDir = join(cwd, ".offbook");
	await writeRunfile(runDir, RUN(19403, "33".repeat(16)), { stateDir: state });
	const server = identityServer(19403, {
		token: "44".repeat(16), // NOT the runfile's
		runDir: "/somewhere/else/.offbook",
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved).toBeUndefined();
		expect(res.skipped[0]?.reason).toBe("wrong-token");
		expect(existsSync(join(runDir, "offbook.run"))).toBe(true);
	} finally {
		server.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("row 5: dead pid — reclaimed (runfile + pointer gone), M14 note, falls through", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-cwd-");
	const runDir = join(cwd, ".offbook");
	const dead = Bun.spawnSync(["true"]);
	await writeRunfile(
		runDir,
		{ ...RUN(19404, "55".repeat(16)), pid: dead.pid ?? 4_193_997 },
		{ stateDir: state },
	);
	const res = await resolveInstance({ cwd, stateDir: state });
	expect(res.resolved).toBeUndefined();
	expect(existsSync(join(runDir, "offbook.run"))).toBe(false);
	expect(existsSync(pointerPath(state, runDir))).toBe(false);
	expect(res.notes.some((n) => n.startsWith("(offbook: cleaned up"))).toBe(true);
	rmSync(state, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

test("--run-dir accepts a projectDir whose .offbook holds the runfile; no registry fallback", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-proj-");
	const runDir = join(proj, ".offbook");
	const token = "66".repeat(16);
	await writeRunfile(runDir, RUN(19405, token), { stateDir: state });
	const server = identityServer(19405, { token, runDir, projectDir: proj });
	try {
		const res = await resolveInstance({
			cwd: "/tmp",
			runDirFlag: proj, // the CONVENIENCE form: projectDir, not runDir
			stateDir: state,
		});
		expect(res.resolved?.runDir).toBe(runDir);
		expect(res.resolved?.source).toBe("cwd"); // precise addressing: no naming duty
	} finally {
		server.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(proj, { recursive: true, force: true });
	}
});

test("row 10 on the explicit path: a foreign-host runfile refuses with the wrote-on-host message, exit 2", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-proj-");
	const runDir = join(proj, ".offbook");
	await writeRunfile(runDir, RUN(19406, "77".repeat(16), "some-other-machine"), {
		stateDir: state,
	});
	await expect(
		resolveInstance({ cwd: "/tmp", runDirFlag: runDir, stateDir: state }),
	).rejects.toThrow("written on some-other-machine");
	try {
		await resolveInstance({ cwd: "/tmp", runDirFlag: runDir, stateDir: state });
	} catch (cause) {
		expect((cause as CliError).exitCode).toBe(2);
	}
	rmSync(state, { recursive: true, force: true });
	rmSync(proj, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure.** `bun test src/cli/resolve.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement** `src/cli/resolve.ts` (part 1 — the registry scan body arrives in Task 11; until then the fall-through returns the empty outcome):

```ts
// R-045/D-032 — the shared, verb-agnostic resolver (spec "The resolver" +
// "The instance state table"). Input: cwd + the optional --run-dir; output:
// the resolved instance, the live-but-unchosen candidates, the skipped
// (alive but not proving identity) instances, and pre-formatted `(offbook:`
// notes. Side effects are EXACTLY the state-table record ops — adopt-on-
// sight, reclaim, reap, self-heal — every one guarded. NO verb policy lives
// here; what each verb does with a Resolution is index.ts's policy table.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ServerIdentity } from "#src/model/index.ts";
import { DEFAULT_CONFIG } from "#src/model/index.ts";
import { CliError } from "./client.ts";
import { guarded } from "./guard.ts";
import { M10, M14 } from "./messages.ts";
import { canonicalPath, writePointer } from "./registry.ts";
import type { Runfile } from "./runfile.ts";
import {
	clearRunfile,
	pidAlive,
	probeServer,
	readRunfile,
	runfilePath,
} from "./runfile.ts";

export interface ResolvedInstance {
	runDir: string; // absolute
	run: Runfile;
	identity?: ServerIdentity; // verified rows only (absent on row 2)
	projectDir?: string; // identity's, else the boot file's
	demo: boolean;
	source: "cwd" | "registry";
}

export interface SkippedInstance {
	runDir: string;
	projectDir: string;
	pid: number;
	ctrlPort: number;
	// "dead" occurs only on the explicit --run-dir path (reclaimDead: false
	// keeps read verbs' stale-runfile reporting byte-identical to pre-D-032;
	// the cwd/registry paths reclaim dead targets instead, rows 5/8)
	reason: "silent" | "wrong-token" | "dead";
	answeringProjectDir?: string; // row 4: who actually answers the port
}

export interface Resolution {
	resolved?: ResolvedInstance;
	candidates: ResolvedInstance[]; // every verified-live instance seen
	skipped: SkippedInstance[];
	notes: string[]; // pre-formatted `(offbook:` stderr notes
	foreignSeen: boolean; // a foreign-host record was passed over (row 10)
}

// M10 as a distinct class: verbs catch it to render the wrong-host refusal
// (stderr verbatim, or the --json envelope) without run()'s `offbook: `
// renderer double-prefixing the catalog wording
export class WrongHostError extends CliError {}

// the boot file names the project truthfully without asking the server —
// readable locally for skipped/unverified instances; the runDir's parent
// is the best remaining name
async function bootProjectDir(runDir: string): Promise<string> {
	try {
		const boot = JSON.parse(
			await Bun.file(join(runDir, "offbook.boot.json")).text(),
		) as { projectDir?: string };
		if (typeof boot.projectDir === "string") return boot.projectDir;
	} catch {}
	return dirname(runDir);
}

// segment-boundary containment on realpath'd absolutes: /x/repo never
// contains /x/repo-wip
export function containsOrEqual(ancestor: string, descendant: string): boolean {
	const rel = relative(ancestor, descendant);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

interface ExamineOutcome {
	resolved?: ResolvedInstance;
	skipped?: SkippedInstance;
	note?: string;
	foreign?: boolean;
}

// state-table rows 1-5 for one runDir (also rows 6-8 when source is
// "registry" — the caller handles row 9's missing-runfile self-heal).
// reclaimDead=false is the explicit --run-dir mode: report the dead
// runfile as skipped ("dead") instead of reclaiming, keeping read verbs'
// stale-runfile output byte-identical to pre-D-032; `down` does its own
// explicit-path cleanup (it always cleared dead runfiles).
async function examineRunDir(
	runDir: string,
	source: "cwd" | "registry",
	stateDir: string,
	reclaimDead = true,
): Promise<ExamineOutcome> {
	const run = await readRunfile(runDir);
	if (run === undefined) return {};
	if (run.host !== undefined && run.host !== hostname())
		return { foreign: true }; // row 10: inert — never a candidate, never reaped
	if (!pidAlive(run.pid)) {
		if (!reclaimDead)
			return {
				skipped: {
					runDir,
					projectDir: await bootProjectDir(runDir),
					pid: run.pid,
					ctrlPort: run.controlPlanePort,
					reason: "dead",
				},
			};
		// row 5 / row 8: target provably dead — reclaim, guarded (site #2:
		// the runfile must still name the pid judged dead)
		const acted = await guarded({
			read: () => readRunfile(runDir),
			expect: (cur) => cur !== undefined && cur.pid === run.pid,
			act: () => clearRunfile(runDir, { stateDir }),
		});
		return acted ? { note: M14(dirname(runDir), run.pid) } : {};
	}
	const probe = await probeServer(run.controlPlanePort);
	if (probe.kind === "server") {
		const id = probe.identity;
		const ours =
			run.token !== undefined
				? id.token === run.token
				: canonicalPath(id.runDir) === canonicalPath(runDir); // pre-D-032 runfile, post-D-032 server
		if (ours) {
			// row 1 / row 6: verified. Adopt-on-sight (best-effort — a broken
			// registry never blocks resolution)
			try {
				await writePointer(stateDir, runDir);
			} catch {}
			return {
				resolved: {
					runDir,
					run,
					identity: id,
					projectDir: id.projectDir,
					demo: id.demo,
					source,
				},
			};
		}
		// row 4 / row 7: the port belongs to someone else — the pid may be
		// reused; never signal, never reclaim, only skip (the note names BOTH)
		return {
			skipped: {
				runDir,
				projectDir: await bootProjectDir(runDir),
				pid: run.pid,
				ctrlPort: run.controlPlanePort,
				reason: "wrong-token",
				answeringProjectDir: id.projectDir,
			},
		};
	}
	if (probe.kind === "legacy" && source === "cwd") {
		// row 2: pre-D-032 server, locally manageable (live-unverified);
		// adopt so it surfaces machine-wide as skipped rather than silence
		try {
			await writePointer(stateDir, runDir);
		} catch {}
		return {
			resolved: {
				runDir,
				run,
				projectDir: await bootProjectDir(runDir),
				demo: false,
				source,
			},
		};
	}
	// row 3 (silent: booting or wedged) and row 7's legacy-elsewhere case:
	// skipped, surfaced by M13, never reaped — a live pid is only ever skipped
	return {
		skipped: {
			runDir,
			projectDir: await bootProjectDir(runDir),
			pid: run.pid,
			ctrlPort: run.controlPlanePort,
			reason: "silent",
		},
	};
}

export async function resolveInstance(opts: {
	cwd: string;
	runDirFlag?: string;
	stateDir: string;
	selfHealProbePort?: number;
}): Promise<Resolution> {
	const { stateDir } = opts;
	const notes: string[] = [];
	const skipped: SkippedInstance[] = [];
	let foreignSeen = false;

	// --run-dir: precise addressing, NO registry fallback (what makes the
	// refusal tables' selectors exact). Convenience: a projectDir whose
	// .offbook holds the runfile counts — users think in project directories.
	if (opts.runDirFlag !== undefined) {
		let runDir = resolve(opts.cwd, opts.runDirFlag);
		if (
			!existsSync(runfilePath(runDir)) &&
			existsSync(runfilePath(join(runDir, DEFAULT_CONFIG.runDir)))
		)
			runDir = join(runDir, DEFAULT_CONFIG.runDir);
		const run = await readRunfile(runDir);
		if (run?.host !== undefined && run.host !== hostname())
			throw new WrongHostError(M10(run.host, runDir), 2); // row 10, pid-only path
		// reclaimDead: false — the explicit path REPORTS a dead runfile
		// (stale wording, byte-identical to pre-D-032) instead of deleting it
		const out = await examineRunDir(runDir, "cwd", stateDir, false);
		if (out.note !== undefined) notes.push(out.note);
		if (out.skipped !== undefined) skipped.push(out.skipped);
		return {
			resolved: out.resolved,
			candidates: out.resolved === undefined ? [] : [out.resolved],
			skipped,
			notes,
			foreignSeen: false,
		};
	}

	// rows 1-5: the cwd runfile — a LIVE cwd runfile wins outright
	const cwdRunDir = resolve(opts.cwd, DEFAULT_CONFIG.runDir);
	const cwdOut = await examineRunDir(cwdRunDir, "cwd", stateDir);
	if (cwdOut.note !== undefined) notes.push(cwdOut.note);
	if (cwdOut.foreign === true) foreignSeen = true;
	if (cwdOut.skipped !== undefined) skipped.push(cwdOut.skipped);
	if (cwdOut.resolved !== undefined)
		return {
			resolved: cwdOut.resolved,
			candidates: [cwdOut.resolved],
			skipped,
			notes,
			foreignSeen,
		};

	// rows 6-10: the registry scan (Task 11)
	const candidates: ResolvedInstance[] = [];
	return { candidates, skipped, notes, foreignSeen };
}
```

- [ ] **Step 4: Run tests.** `bun test src/cli/resolve.test.ts` — 0 failing. `bun run typecheck` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/resolve.ts src/cli/resolve.test.ts
git commit -m "feat: the shared resolver, part 1 - cwd rows and explicit addressing (R-045)"
```

---

### Task 11: The resolver, part 2 — registry rows 6–10, self-heal, tiebreak, `attributeCtrlPort`

**Files:**
- Modify: `src/cli/resolve.ts`
- Test: `src/cli/resolve.test.ts`

**Interfaces:**
- Consumes: `scanPointers` (with `raw` for site #1's freshness), `M14missing`, `M15d`, `writeRunfile`, `rmSync`.
- Produces: the full `resolveInstance` (registry fallback + 3-stage tiebreak) and `attributeCtrlPort(port: number): Promise<{ projectDir: string; runDir: string; demo: boolean } | undefined>`.

- [ ] **Step 1: Write the failing tests.** Append to `src/cli/resolve.test.ts` (ports 19407–19416):

```ts
// [utest->R-045]
test("rows 6-8: registry scan verifies by token, skips the silent, reaps the dead", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-"); // no cwd runfile: forces the scan
	// live + verified
	const liveProj = scratch("offbook-res-live-");
	const liveRun = join(liveProj, ".offbook");
	const token = "88".repeat(16);
	await writeRunfile(liveRun, RUN(19407, token), { stateDir: state });
	const server = identityServer(19407, {
		token,
		runDir: liveRun,
		projectDir: liveProj,
	});
	// live + silent (skipped)
	const silentProj = scratch("offbook-res-silent-");
	const silentRun = join(silentProj, ".offbook");
	await writeRunfile(silentRun, RUN(19408, "99".repeat(16)), { stateDir: state });
	// dead (pointer reaped, runfile reclaimed)
	const deadProj = scratch("offbook-res-dead-");
	const deadRun = join(deadProj, ".offbook");
	const dead = Bun.spawnSync(["true"]);
	await writeRunfile(
		deadRun,
		{ ...RUN(19409, "aa".repeat(16)), pid: dead.pid ?? 4_193_996 },
		{ stateDir: state },
	);
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.runDir).toBe(liveRun); // sole verified candidate
		expect(res.resolved?.source).toBe("registry");
		expect(res.skipped.map((s) => s.runDir)).toEqual([silentRun]);
		expect(existsSync(pointerPath(state, deadRun))).toBe(false);
		expect(existsSync(pointerPath(state, silentRun))).toBe(true); // live-pid: kept
	} finally {
		server.stop();
		for (const d of [state, cwd, liveProj, silentProj, deadProj])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("row 9: pointer whose runfile is missing — self-heal from a served identity, else guarded reap", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	// heal branch: identity on the (injected) default port claims this runDir
	const healProj = scratch("offbook-res-heal-");
	const healRun = join(healProj, ".offbook");
	const token = "bb".repeat(16);
	await writeRunfile(healRun, RUN(19410, token), { stateDir: state });
	rmSync(join(healRun, "offbook.run")); // de-runfiled, pointer dangles
	const server = identityServer(19410, {
		token,
		runDir: healRun,
		projectDir: healProj,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 19410 },
	});
	try {
		const res = await resolveInstance({
			cwd,
			stateDir: state,
			selfHealProbePort: 19410,
		});
		expect(res.resolved?.runDir).toBe(healRun);
		expect(existsSync(join(healRun, "offbook.run"))).toBe(true); // rewritten
		const healed = await readRunfile(healRun);
		expect(healed?.token).toBe(token);
	} finally {
		server.stop();
	}
	// reap branch: nothing answers the probe port → pointer reaped, M14 missing variant
	const goneProj = scratch("offbook-res-gone-");
	const goneRun = join(goneProj, ".offbook");
	await writeRunfile(goneRun, RUN(19411, "cc".repeat(16)), { stateDir: state });
	rmSync(join(goneRun, "offbook.run"));
	const res2 = await resolveInstance({
		cwd,
		stateDir: state,
		selfHealProbePort: 19412, // silent
	});
	expect(existsSync(pointerPath(state, goneRun))).toBe(false);
	expect(res2.notes.some((n) => n.includes("its runfile is gone"))).toBe(true);
	for (const d of [state, cwd, healProj, goneProj])
		rmSync(d, { recursive: true, force: true });
});

// [utest->R-045]
test("tiebreak: ancestor-or-equal beats descendant beats sole-non-demo; prefix siblings never match; ambiguity refuses nothing here (resolver reports)", async () => {
	const state = scratch("offbook-res-state-");
	const base = scratch("offbook-res-tie-");
	// candidate A: projectDir = base/repo (an ANCESTOR of cwd base/repo/sub)
	// candidate B: projectDir = base/repo-wip (a PREFIX SIBLING — must not match)
	const aProj = join(base, "repo");
	const bProj = join(base, "repo-wip");
	const cwd = join(base, "repo", "sub");
	for (const d of [aProj, bProj, cwd]) mkdirSync(d, { recursive: true });
	const aRun = join(aProj, ".offbook");
	const bRun = join(bProj, ".offbook");
	const aTok = "dd".repeat(16);
	const bTok = "ee".repeat(16);
	await writeRunfile(aRun, RUN(19413, aTok), { stateDir: state });
	await writeRunfile(bRun, RUN(19414, bTok), { stateDir: state });
	const aSrv = identityServer(19413, { token: aTok, runDir: aRun, projectDir: aProj });
	const bSrv = identityServer(19414, { token: bTok, runDir: bRun, projectDir: bProj });
	try {
		// stage 1: cwd inside A only → A wins even with B live
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.projectDir).toBe(aProj);
		// from an UNRELATED cwd both are live and unrelated → ambiguous
		const other = scratch("offbook-res-other-");
		const amb = await resolveInstance({ cwd: other, stateDir: state });
		expect(amb.resolved).toBeUndefined();
		expect(amb.candidates).toHaveLength(2);
		rmSync(other, { recursive: true, force: true });
	} finally {
		aSrv.stop();
		bSrv.stop();
		rmSync(state, { recursive: true, force: true });
		rmSync(base, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("tiebreak stage 3: the sole non-demo wins over a live demo, with the demo-passed-over note", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const projA = scratch("offbook-res-real-");
	const projD = scratch("offbook-res-demo-");
	const runA = join(projA, ".offbook");
	const runD = join(projD, ".offbook");
	const tokA = "f1".repeat(16);
	const tokD = "f2".repeat(16);
	await writeRunfile(runA, RUN(19415, tokA), { stateDir: state });
	await writeRunfile(runD, RUN(19416, tokD), { stateDir: state });
	const srvA = identityServer(19415, { token: tokA, runDir: runA, projectDir: projA });
	const srvD = identityServer(19416, {
		token: tokD,
		runDir: runD,
		projectDir: projD,
		demo: true,
	});
	try {
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.projectDir).toBe(projA);
		expect(res.resolved?.demo).toBe(false);
		expect(res.notes.some((n) => n.includes("the bundled demo in"))).toBe(true);
	} finally {
		srvA.stop();
		srvD.stop();
		for (const d of [state, cwd, projA, projD])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-044]
test("attributeCtrlPort: names the owner only when the claimed runfile carries the served token", async () => {
	const proj = scratch("offbook-res-attr-");
	const runDir = join(proj, ".offbook");
	const state = scratch("offbook-res-state-");
	const token = "f3".repeat(16);
	await writeRunfile(runDir, RUN(19417, token), { stateDir: state });
	const server = identityServer(19417, { token, runDir, projectDir: proj });
	try {
		expect(await attributeCtrlPort(19417)).toEqual({
			projectDir: proj,
			runDir,
			demo: false,
		});
	} finally {
		server.stop();
	}
	// claim without proof: served token differs from the runfile's
	const liar = identityServer(19418, { token: "f4".repeat(16), runDir, projectDir: proj });
	try {
		expect(await attributeCtrlPort(19418)).toBeUndefined();
	} finally {
		liar.stop();
	}
	expect(await attributeCtrlPort(19419)).toBeUndefined(); // silence
	rmSync(proj, { recursive: true, force: true });
	rmSync(state, { recursive: true, force: true });
});

// [utest->R-045]
test("guarded site #1: a pointer rewritten between the scan read and the unlink survives the reap", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const proj = scratch("offbook-res-g1-");
	const runDir = join(proj, ".offbook");
	await writeRunfile(runDir, RUN(19420, "a1".repeat(16)), { stateDir: state });
	rmSync(join(runDir, "offbook.run")); // dangling pointer → the reap branch
	const ptr = pointerPath(state, runDir);
	// the self-heal probe fires between the scan's read and the guard's
	// re-read — a fetch side effect deterministically lands INSIDE the race
	// window: rewrite the pointer's bytes (same content, new formatting)
	const rewritten = `${JSON.stringify({ v: 1, runDir: canonicalPath(runDir), host: hostname() })}\n`;
	const server = Bun.serve({
		port: 19420,
		fetch: () => {
			require("node:fs").writeFileSync(ptr, rewritten);
			return new Response("nope", { status: 404 }); // not a heal answer
		},
	});
	try {
		const res = await resolveInstance({
			cwd,
			stateDir: state,
			selfHealProbePort: 19420,
		});
		expect(existsSync(ptr)).toBe(true); // freshness guard skipped the unlink
		expect(res.notes.some((n) => n.includes("its runfile is gone"))).toBe(false);
	} finally {
		server.stop(true);
		for (const d of [state, cwd, proj]) rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("guarded site #5: the self-heal skips when a runfile reappeared before the write", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	const proj = scratch("offbook-res-g5-");
	const runDir = join(proj, ".offbook");
	const token = "a2".repeat(16);
	await writeRunfile(runDir, RUN(19421, token), { stateDir: state });
	rmSync(join(runDir, "offbook.run")); // dangling → the heal branch
	// the identity answer's fetch side effect recreates offbook.run inside
	// the race window (a respawn winning the race); the heal must NOT
	// overwrite it
	const raced = `${JSON.stringify({ ...RUN(19421, token), pid: 424242 })}\n`;
	const identity = {
		pid: process.pid,
		token,
		host: hostname(),
		projectDir: proj,
		runDir,
		startedAt: "t",
		demo: false,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 19421 },
	};
	const server = Bun.serve({
		port: 19421,
		fetch: (req) => {
			require("node:fs").writeFileSync(join(runDir, "offbook.run"), raced);
			return new URL(req.url).pathname === "/v1/server"
				? Response.json(identity)
				: new Response("nope", { status: 404 });
		},
	});
	try {
		await resolveInstance({ cwd, stateDir: state, selfHealProbePort: 19421 });
		const kept = await readRunfile(runDir);
		expect(kept?.pid).toBe(424242); // the raced writer's file survived
	} finally {
		server.stop(true);
		for (const d of [state, cwd, proj]) rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("tiebreak: a symlinked cwd matches its real subtree (stage 1 through realpath, against a live competitor)", async () => {
	const state = scratch("offbook-res-state-");
	const proj = scratch("offbook-res-symproj-");
	const other = scratch("offbook-res-symother-");
	const runDir = join(proj, ".offbook");
	const otherRun = join(other, ".offbook");
	const token = "a3".repeat(16);
	const otherTok = "a4".repeat(16);
	await writeRunfile(runDir, RUN(19422, token), { stateDir: state });
	await writeRunfile(otherRun, RUN(19423, otherTok), { stateDir: state });
	const server = identityServer(19422, { token, runDir, projectDir: proj });
	const competitor = identityServer(19423, {
		token: otherTok,
		runDir: otherRun,
		projectDir: other,
	});
	const linkParent = scratch("offbook-res-symlink-");
	const link = join(linkParent, "alias");
	symlinkSync(proj, link);
	const cwd = join(link, "sub");
	mkdirSync(cwd, { recursive: true });
	try {
		// two live candidates force the tiebreak: cwd addressed VIA the
		// symlink still realpaths into proj's subtree, so stage 1 finds
		// exactly one ancestor-or-equal — the symlinked project, not the
		// competitor
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved?.projectDir).toBe(proj);
	} finally {
		server.stop();
		competitor.stop();
		for (const d of [state, linkParent, proj, other])
			rmSync(d, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("an unreadable registry degrades to cwd-scoped behavior with the could-not-record note, never a throw", async () => {
	const state = scratch("offbook-res-state-");
	const cwd = scratch("offbook-res-emptycwd-");
	rmSync(join(state, "instances"), { recursive: true, force: true });
	await Bun.write(join(state, "instances"), "a FILE where the dir should be");
	const res = await resolveInstance({ cwd, stateDir: state });
	expect(res.resolved).toBeUndefined();
	expect(res.candidates).toEqual([]);
	expect(
		res.notes.some((n) => n.startsWith("(offbook: could not record")),
	).toBe(true);
	rmSync(state, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});
```

Add `attributeCtrlPort` and `readRunfile` to the test file's imports; add `mkdirSync` and `symlinkSync` (node:fs) and `canonicalPath`/`pointerPath` (./registry.ts) if missing. (The `require("node:fs")` inside the fetch handlers is deliberate — a synchronous side effect inside the probe's request; if biome objects to `require`, hoist `import { writeFileSync } from "node:fs";` and call it directly.)

- [ ] **Step 2: Run to verify failure.** `bun test src/cli/resolve.test.ts` — new tests FAIL (empty scan, no `attributeCtrlPort`).

- [ ] **Step 3: Implement.** In `src/cli/resolve.ts`: add imports `rmSync` (node:fs), `scanPointers` (./registry.ts), `M14missing`, `M15d`, `M17` (./messages.ts), `writeRunfile` (./runfile.ts). Replace the two-line registry stub at the end of `resolveInstance` with (indentation inside the `try` is the implementer's/biome's problem — the block below is semantically complete):

```ts
	// rows 6-10: the registry scan — candidates probed concurrently (cost
	// bounded by reaping plus the n=1 discipline). Best-effort always: an
	// unreadable state dir degrades to cwd-scoped behavior with the
	// catalog's degradation note — registry failures never fail a verb.
	const candidates: ResolvedInstance[] = [];
	const selfHealPort = opts.selfHealProbePort ?? DEFAULT_CONFIG.controlPlanePort;
	try {
	const pointers = (await scanPointers(stateDir)).filter(
		(p) => p.pointer.runDir !== canonicalPath(cwdRunDir), // rows 1-5 covered cwd's own
	);
	await Promise.all(
		pointers.map(async ({ path, raw, pointer }) => {
			if (pointer.host !== hostname()) {
				foreignSeen = true; // row 10: inert
				return;
			}
			if (!existsSync(runfilePath(pointer.runDir))) {
				// row 9 — self-heal probe FIRST: /v1/server on the default
				// control port answering with this pointer's runDir means
				// alive-but-de-runfiled; rewrite the runfile from the served
				// identity (guarded site #5), then treat as row 6
				const probe = await probeServer(selfHealPort);
				if (
					probe.kind === "server" &&
					canonicalPath(probe.identity.runDir) === pointer.runDir
				) {
					const id = probe.identity;
					const healedRun: Runfile = {
						pid: id.pid,
						brokerWsPort: id.ports.brokerWsPort,
						brokerTcpPort: id.ports.brokerTcpPort,
						controlPlanePort: id.ports.controlPlanePort,
						startedAt: id.startedAt,
						token: id.token,
						host: id.host,
					};
					await guarded({
						// site #5: the runfile must STILL be missing at write time
						read: () => readRunfile(pointer.runDir),
						expect: (cur) => cur === undefined,
						act: async () => {
							await writeRunfile(pointer.runDir, healedRun, { stateDir });
						},
					});
					candidates.push({
						runDir: pointer.runDir,
						run: healedRun,
						identity: id,
						projectDir: id.projectDir,
						demo: id.demo,
						source: "registry",
					});
					return;
				}
				// row 9 reap branch — guarded site #1: the pointer file must be
				// unchanged since the scan read it AND the target still absent,
				// re-verified immediately before the unlink
				const reaped = await guarded({
					read: () =>
						Bun.file(path)
							.text()
							.catch(() => ""),
					expect: (cur) =>
						cur !== "" &&
						cur === raw &&
						!existsSync(runfilePath(pointer.runDir)),
					act: () => rmSync(path, { force: true }),
				});
				if (reaped) notes.push(M14missing(dirname(pointer.runDir)));
				return;
			}
			const out = await examineRunDir(pointer.runDir, "registry", stateDir);
			if (out.note !== undefined) notes.push(out.note);
			if (out.foreign === true) foreignSeen = true;
			if (out.skipped !== undefined) skipped.push(out.skipped);
			if (out.resolved !== undefined) candidates.push(out.resolved);
		}),
	);
	} catch {
		// M17 is the catalog's degradation message; its recovery selector
		// points at the cwd run dir (the only instance still addressable)
		notes.push(M17(opts.cwd, cwdRunDir));
		return { candidates: [], skipped, notes, foreignSeen };
	}

	if (candidates.length === 1)
		return { resolved: candidates[0], candidates, skipped, notes, foreignSeen };
	if (candidates.length === 0)
		return { candidates, skipped, notes, foreignSeen };

	// several live: the three-stage tiebreak on realpath'd projectDirs.
	// stage 1: sole ancestor-or-equal of cwd; stage 2: sole strict
	// descendant; stage 3: sole non-demo (the forgotten-demo day), with the
	// passed-over demo named (M15d). Otherwise: ambiguous — the verb refuses.
	const cwdReal = canonicalPath(opts.cwd);
	const projOf = (c: ResolvedInstance): string =>
		canonicalPath(c.projectDir ?? dirname(c.runDir));
	const stage1 = candidates.filter((c) => containsOrEqual(projOf(c), cwdReal));
	if (stage1.length === 1)
		return { resolved: stage1[0], candidates, skipped, notes, foreignSeen };
	const stage2 = candidates.filter(
		(c) => containsOrEqual(cwdReal, projOf(c)) && projOf(c) !== cwdReal,
	);
	if (stage2.length === 1)
		return { resolved: stage2[0], candidates, skipped, notes, foreignSeen };
	const nonDemo = candidates.filter((c) => !c.demo);
	if (nonDemo.length === 1) {
		for (const d of candidates.filter((c) => c.demo))
			notes.push(M15d(d.projectDir ?? dirname(d.runDir), d.runDir));
		return { resolved: nonDemo[0], candidates, skipped, notes, foreignSeen };
	}
	return { candidates, skipped, notes, foreignSeen };
```

Append `attributeCtrlPort` at the end of the file:

```ts
// M3's verification (R-044): the port-answerer CLAIMS a runDir; the runfile
// AT that runDir carrying the same token proves the claim — discovery never
// invents facts. undefined = attribute nothing (callers keep the generic
// pre-D-032 wording).
export async function attributeCtrlPort(
	port: number,
): Promise<{ projectDir: string; runDir: string; demo: boolean } | undefined> {
	const probe = await probeServer(port);
	if (probe.kind !== "server") return undefined;
	const id = probe.identity;
	if (id.host !== hostname()) return undefined;
	const run = await readRunfile(id.runDir);
	if (run === undefined || run.token !== id.token) return undefined;
	return { projectDir: id.projectDir, runDir: id.runDir, demo: id.demo };
}
```

- [ ] **Step 4: Run tests.** `bun test src/cli/resolve.test.ts` — 0 failing. `bun run typecheck` — exit 0. `bun test` full — green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/resolve.ts src/cli/resolve.test.ts
git commit -m "feat: the shared resolver, part 2 - registry rows, self-heal, tiebreak, port attribution (R-045)"
```

---
### Task 12: Verb wiring — `targetFor` + the read verbs

**Files:**
- Modify: `src/cli/index.ts`
- Test: `test/cli-dispatch.test.ts`

**Interfaces:**
- Consumes: `resolveInstance`, `Resolution`, `ResolvedInstance` (resolve.ts); the catalog (messages.ts); `stateDirFromEnv`.
- Produces (used by Tasks 13–17): in `src/cli/index.ts`:

```ts
type VerbKind = "read" | "mutate";
interface Target { api: Api; inst?: ResolvedInstance; res?: Resolution }
function rowsOf(candidates: ResolvedInstance[]): InstanceRow[];
function skippedNote(s: SkippedInstance): string; // M13, or the M13wrongToken variant when the skip knows who answers
async function resolveOrRefuse(opts: Parameters<typeof resolveInstance>[0], io: Io, json: boolean): Promise<Resolution | number>; // catches WrongHostError → wrong-host envelope/stderr, exit 2
function withServer(doc: Record<string, unknown>, t: Target): Record<string, unknown>; // merges the identity block into object-shaped --json docs on registry resolution
async function targetFor(values: FlagValues, io: Io, kind: VerbKind, verb: string): Promise<Target | number>;
```

`targetFor` returns an exit code when it refused (having already printed the refusal); otherwise a Target, having printed resolver notes, skip notes, and the naming duty (M16 header for reads / M15 note for mutations — registry-resolved, human mode only).

- [ ] **Step 1: Write the failing tests.** Append to `test/cli-dispatch.test.ts` (extend the file's port comment with `19450-19479 + tcp 12496-12499: instance-discovery verb policy`). New imports: `hostname` from `node:os`, `mkdtempSync`/`rmSync`/`existsSync` if missing, `writeRunfile` already imported, and add a small local helper next to the `io()` helper:

```ts
// a fake discovered instance: an identity server + a matching runfile,
// registered by writeRunfile's pointer write into the CURRENT
// OFFBOOK_STATE_DIR (set per-test)
async function fakeInstance(opts: {
	port: number;
	projectDir: string;
	demo?: boolean;
	routes?: Record<string, unknown>;
}): Promise<{ runDir: string; token: string; stop(): void }> {
	const token = crypto.randomUUID().replaceAll("-", "");
	const runDir = join(opts.projectDir, ".offbook");
	await writeRunfile(
		runDir,
		{
			pid: process.pid,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: opts.port,
			startedAt: "t",
			token,
			host: hostname(),
		},
		{ stateDir: process.env.OFFBOOK_STATE_DIR ?? "" },
	);
	const identity = {
		pid: process.pid,
		token,
		host: hostname(),
		projectDir: opts.projectDir,
		runDir,
		startedAt: "t",
		demo: opts.demo === true,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: opts.port },
	};
	const server = Bun.serve({
		port: opts.port,
		fetch: (req) => {
			const p = new URL(req.url).pathname;
			if (p === "/v1/server") return Response.json(identity);
			const body = opts.routes?.[p];
			if (body !== undefined) return Response.json(body);
			return new Response("nope", { status: 404 });
		},
	});
	return { runDir, token, stop: () => server.stop(true) };
}

// pin the state dir + cwd for one discovery test; restores both
async function inDiscoveryWorld<T>(
	cwd: string,
	fn: () => Promise<T>,
): Promise<T> {
	const prevState = process.env.OFFBOOK_STATE_DIR;
	const prevCwd = process.cwd();
	process.env.OFFBOOK_STATE_DIR = mkdtempSync(join(tmpdir(), "offbook-vp-state-"));
	process.chdir(cwd);
	try {
		return await fn();
	} finally {
		process.chdir(prevCwd);
		rmSync(process.env.OFFBOOK_STATE_DIR ?? "", { recursive: true, force: true });
		// assigning undefined would store the STRING "undefined" — delete instead
		if (prevState === undefined) delete process.env.OFFBOOK_STATE_DIR;
		else process.env.OFFBOOK_STATE_DIR = prevState;
	}
}
```

Then the tests:

```ts
// --- D-032: verb policy over the resolver (instance discovery) ---

// [itest->R-045]
test("read verb, registry-resolved: the M16 header names the instance; cwd-resolved output is byte-identical (no header)", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-proj-"));
	const elsewhere = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(elsewhere, async () => {
		const inst = await fakeInstance({
			port: 19450,
			projectDir: proj,
			routes: { "/v1/state": { state: [] } },
		});
		try {
			const away = io();
			expect(await run(["state"], away.io)).toBe(0);
			expect(away.out[0]).toBe(`offbook @ ${proj} (ws 1 · http 19450)`);
			expect(away.out[1]).toBe("(no retained state)");
			// same verb from the project dir itself: no header, byte-identical
			process.chdir(proj);
			const home = io();
			expect(await run(["state"], home.io)).toBe(0);
			expect(home.out).toEqual(["(no retained state)"]);
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(elsewhere, { recursive: true, force: true });
});

// [itest->R-045]
test("object-shaped --json carries the server block on registry resolution only", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-jsonid-"));
	const elsewhere = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	const diagnostics = {
		diagnostics: [],
		summary: { errors: 0, warnings: 0, info: 0, byKind: {} },
	};
	await inDiscoveryWorld(elsewhere, async () => {
		const inst = await fakeInstance({
			port: 19465,
			projectDir: proj,
			routes: { "/v1/diagnostics": diagnostics },
		});
		try {
			const away = io();
			expect(await run(["diagnostics", "--json"], away.io)).toBe(0);
			expect(away.out).toHaveLength(1);
			const doc = JSON.parse(away.out[0]) as { server?: { projectDir: string } };
			expect(doc.server?.projectDir).toBe(proj);
			// cwd-resolved: byte-identical round-trip, no server block
			process.chdir(proj);
			const home = io();
			expect(await run(["diagnostics", "--json"], home.io)).toBe(0);
			expect(JSON.parse(home.out[0])).toEqual(diagnostics);
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(elsewhere, { recursive: true, force: true });
});

// [itest->R-045]
test("ambiguity: two live instances refuse with the M8 table (exit 2); --json emits exactly one envelope on stdout", async () => {
	const projA = mkdtempSync(join(tmpdir(), "offbook-vp-a-"));
	const projB = mkdtempSync(join(tmpdir(), "offbook-vp-b-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const a = await fakeInstance({ port: 19451, projectDir: projA });
		const b = await fakeInstance({ port: 19452, projectDir: projB });
		try {
			const human = io();
			expect(await run(["scenarios"], human.io)).toBe(2);
			const err = human.err.join("\n");
			expect(err).toContain("offbook: several instances are running — pick one:");
			expect(err).toContain(`offbook scenarios --run-dir ${join(projA, ".offbook")}`);
			expect(human.out).toEqual([]);

			const json = io();
			expect(await run(["scenarios", "--json"], json.io)).toBe(2);
			expect(json.out).toHaveLength(1); // exactly one stdout document
			const envelope = JSON.parse(json.out[0]) as {
				error: { code: string };
				candidates: unknown[];
			};
			expect(envelope.error.code).toBe("ambiguous");
			expect(envelope.candidates).toHaveLength(2);
		} finally {
			a.stop();
			b.stop();
		}
	});
	for (const d of [projA, projB, cwd]) rmSync(d, { recursive: true, force: true });
});

// [itest->R-045]
test("M12 replaces M11 and M13 when the only skipped instance is cwd's own wedged one", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-wedged-"));
	await inDiscoveryWorld(cwd, async () => {
		// live pid, silent port: row 3
		await writeRunfile(
			join(cwd, ".offbook"),
			{
				pid: process.pid,
				brokerWsPort: 1,
				brokerTcpPort: 2,
				controlPlanePort: 19453, // nothing listens here
				startedAt: "t",
				token: "ab".repeat(16),
				host: hostname(),
			},
			{ stateDir: process.env.OFFBOOK_STATE_DIR ?? "" },
		);
		const x = io();
		expect(await run(["scenarios"], x.io)).toBe(1);
		const err = x.err.join("\n");
		expect(err).toContain("offbook is not answering here");
		expect(err).not.toContain("offbook is not running"); // M11 replaced
		expect(err).not.toContain("(offbook: an instance in"); // M13 replaced
	});
	rmSync(cwd, { recursive: true, force: true });
}, 15_000);

// [itest->R-045]
test("zero live, nothing skipped: M11 with its automation anchor, exit 1", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-empty-"));
	await inDiscoveryWorld(cwd, async () => {
		const x = io();
		expect(await run(["scenarios"], x.io)).toBe(1);
		expect(
			x.err.some((l) => l.includes("offbook is not running (no runfile in .offbook, and nothing else is running on this machine)")),
		).toBe(true);
	});
	rmSync(cwd, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure.** `bun test test/cli-dispatch.test.ts` — the four new tests FAIL (`scenarios`/`state` still error with the old resolveCtrlPort wording, no headers, no tables).

- [ ] **Step 3: Implement in `src/cli/index.ts`.**

Imports: add `dirname` to the `node:path` import; `resolveInstance`, `WrongHostError` and the types from `./resolve.ts`; `instanceTable`, `M8`, `M11`, `M12`, `M13`, `M13wrongToken`, `M15`, `M16`, `refusalEnvelope` and `type InstanceRow` from `./messages.ts` (extend the Task 9 import).

Add below `clientFor` (which stays until Task 17):

```ts
// --- D-032: the verb-policy front door over the shared resolver ---

type VerbKind = "read" | "mutate";
interface Target {
	api: Api;
	inst?: ResolvedInstance;
	res?: Resolution;
}

function rowsOf(candidates: ResolvedInstance[]): InstanceRow[] {
	return candidates.map((c) => ({
		projectDir: c.projectDir ?? dirname(c.runDir),
		demo: c.demo,
		ws: c.run.brokerWsPort,
		tcp: c.run.brokerTcpPort,
		http: c.run.controlPlanePort,
		pid: c.run.pid,
		runDir: c.runDir,
	}));
}

// row 4's skip note names BOTH sides (the port answered — as a different
// offbook); every other skip gets the plain not-answering M13
function skippedNote(s: SkippedInstance): string {
	return s.reason === "wrong-token" && s.answeringProjectDir !== undefined
		? M13wrongToken(s.projectDir, s.pid, s.ctrlPort, s.answeringProjectDir)
		: M13(s.projectDir, s.pid, s.ctrlPort);
}

// the one place the wrong-host refusal (M10) is rendered: verbatim catalog
// wording on stderr (never re-prefixed by run()'s renderer), or the
// wrong-host envelope under --json; exit 2 either way
async function resolveOrRefuse(
	opts: Parameters<typeof resolveInstance>[0],
	io: Io,
	json: boolean,
): Promise<Resolution | number> {
	try {
		return await resolveInstance(opts);
	} catch (cause) {
		if (cause instanceof WrongHostError) {
			if (json) io.out(refusalEnvelope("wrong-host", cause.message));
			else io.err(cause.message);
			return 2;
		}
		throw cause;
	}
}

// registry-resolved object-shaped --json documents carry identity in-band
// (the spec's "other shapes gain the same fields where their envelope
// allows"); cwd-resolved output stays byte-identical, so the pinned
// round-trip shapes only grow the block when discovery actually engaged.
// Array-shaped documents (topics/state/scenarios --json) are exempt — their
// envelope does not allow it; scripts pin those with --run-dir.
function withServer(
	doc: Record<string, unknown>,
	t: Target,
): Record<string, unknown> {
	if (t.inst === undefined || t.inst.source !== "registry") return doc;
	return {
		...doc,
		server: {
			projectDir: t.inst.projectDir,
			runDir: t.inst.runDir,
			source: t.inst.source,
			demo: t.inst.demo,
		},
	};
}

// Resolves for one verb invocation and applies the naming/refusal policy
// (spec "Verb policy" + "Naming and notes"): prints resolver notes, M13
// skips, and the registry-resolution naming duty (M16 header for reads on
// stdout, M15 note for mutations on stderr — human mode only; a quiet
// cwd day stays byte-identical). Returns the exit code when it refused:
// 2 = refused-with-selector (M8), 1 = not running (M11/M12).
async function targetFor(
	values: FlagValues,
	io: Io,
	kind: VerbKind,
	verb: string,
): Promise<Target | number> {
	if (values["ctrl-port"] !== undefined) return { api: await clientFor(values) };
	const json = values.json === true;
	const res = await resolveOrRefuse(
		{
			cwd: process.cwd(),
			runDirFlag: str(values["run-dir"]),
			stateDir: stateDirFromEnv(),
		},
		io,
		json,
	);
	if (typeof res === "number") return res;
	for (const n of res.notes) io.err(n);
	if (res.resolved !== undefined) {
		const inst = res.resolved;
		for (const s of res.skipped) io.err(skippedNote(s));
		if (inst.source === "registry" && !json) {
			const projectDir = inst.projectDir ?? dirname(inst.runDir);
			if (kind === "read")
				io.out(
					M16(projectDir, inst.run.brokerWsPort, inst.run.controlPlanePort, inst.demo),
				);
			else io.err(M15(projectDir, inst.demo));
		}
		return { api: api(inst.run.controlPlanePort), inst, res };
	}
	if (res.candidates.length > 1) {
		if (json) io.out(refusalEnvelope("ambiguous", M8(), rowsOf(res.candidates)));
		else {
			io.err(M8());
			for (const line of instanceTable(rowsOf(res.candidates), verb)) io.err(line);
		}
		return 2;
	}
	// zero live. Explicit --run-dir keeps the pre-D-032 wordings byte for
	// byte (the scripting escape hatch) — note a dead-pid runfile was
	// already reclaimed above (row 5), surfacing as no-runfile plus the M14 note.
	const runDirFlag = str(values["run-dir"]);
	if (runDirFlag !== undefined) {
		const s = res.skipped[0];
		const message =
			s === undefined
				? `offbook is not running (no runfile in ${runDirFlag}) — run \`offbook up\`, or pass --ctrl-port`
				: `offbook is not running (stale runfile in ${runDirFlag}, pid ${s.pid}) — run \`offbook up\``;
		if (json) io.out(refusalEnvelope("not-running", message));
		else io.err(message);
		return 1;
	}
	const own =
		res.skipped.length === 1 &&
		res.skipped[0].runDir === resolve(process.cwd(), DEFAULT_CONFIG.runDir)
			? res.skipped[0]
			: undefined;
	if (own !== undefined) {
		// M12 REPLACES M11 and M13 — never printed alongside them
		if (json) io.out(refusalEnvelope("not-running", M12(own.pid)));
		else io.err(M12(own.pid));
		return 1;
	}
	for (const s of res.skipped) io.err(skippedNote(s));
	if (json) io.out(refusalEnvelope("not-running", M11()));
	else io.err(M11());
	return 1;
}
```

Migrate the read verbs — in each of `cmdState`, `cmdScenarios`, `cmdValidation`, `cmdDiagnostics`, `cmdCheck`, replace:

```ts
	const a = await clientFor(values);
```

with (verb string matching the command):

```ts
	const t = await targetFor(values, io, "read", "state");
	if (typeof t === "number") return t;
	const a = t.api;
```

In `cmdMode`, the kind depends on the positional (parse first):

```ts
	const t = await targetFor(
		values,
		io,
		positionals.length > 0 ? "mutate" : "read",
		"mode",
	);
	if (typeof t === "number") return t;
	const a = t.api;
```

In `cmdSpecs` likewise (`update` is mutating): `const t = await targetFor(values, io, update ? "mutate" : "read", "specs"); if (typeof t === "number") return t; const a = t.api;` — the `specs update` staleness call-site change lands in Task 13.

**In-band identity for object-shaped `--json`** (the spec's "other shapes gain the same fields where their envelope allows"): in `cmdValidation`, `cmdDiagnostics`, `cmdSpecs` (list branch), and `cmdMode`, wrap the `--json` document through `withServer` — e.g. cmdValidation's `io.out(JSON.stringify(res, null, 2))` becomes `io.out(JSON.stringify(withServer(res as unknown as Record<string, unknown>, t), null, 2))`. cwd-resolved and `--ctrl-port` documents are unchanged (the `server` block appears only on registry resolution), so the pinned round-trip assertions stay byte-identical on the quiet day. Array-shaped documents (`topics`/`state`/`scenarios --json`) are exempt by envelope shape — scripts pin those with `--run-dir`.

- [ ] **Step 4: Run tests.**

Run: `bun test test/cli-dispatch.test.ts` — the five new tests pass; existing tests that asserted the OLD no-server wordings for these verbs will fail — update them: any assertion expecting `offbook is not running (no runfile in .offbook) — run \`offbook up\`, or pass --ctrl-port` (the resolveCtrlPort string, reached via state/scenarios/etc. with no server AND no `--run-dir` flag) now expects the M11 wording `offbook is not running (no runfile in .offbook, and nothing else is running on this machine) — run \`offbook up\`, or pass --ctrl-port`. Grep the test file for `no runfile in` and `stale runfile` and adjust only default-cwd sites exercising these verbs. Assertions on the **explicit `--run-dir` paths stay green by design**: the live-fixture tests resolve as before, and the dead-pid `stale runfile` assertion (~line 654) is preserved by the resolver's `reclaimDead: false` explicit mode. status keeps its own wording until Task 14; topics until Task 17. Then `bun test` full — green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts test/cli-dispatch.test.ts
git commit -m "feat: verb policy front door + read verbs resolve machine-wide (R-045)"
```

---

### Task 13: Mutating verbs (M15) + `specs update` staleness via the resolved instance

**Files:**
- Modify: `src/cli/index.ts` (`cmdPublish`, `cmdScenario`, `cmdReset`, `cmdSpecs` update branch)
- Test: `test/cli-dispatch.test.ts`

**Interfaces:**
- Consumes: `targetFor` (Task 12).
- Produces: nothing new — policy application only.

- [ ] **Step 1: Write the failing tests.** Append to `test/cli-dispatch.test.ts`:

```ts
// [itest->R-045]
test("mutating verb, registry-resolved: M15 stderr note, never an M16 header", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-mut-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({
			port: 19454,
			projectDir: proj,
			routes: { "/v1/reset": { reset: true, seed: 7, sinceSeq: 3 } },
		});
		try {
			const x = io();
			expect(await run(["reset"], x.io)).toBe(0);
			expect(x.err).toContain(`(offbook: using the offbook started in ${proj})`);
			expect(x.out.some((l) => l.startsWith("offbook @"))).toBe(false);
			expect(x.out).toContain("reset — seed 7 · violation baseline #3");
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

// [itest->R-045]
test("specs update reads the RESOLVED instance's boot record for the staleness warning", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-stale-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await Bun.write(join(proj, "services.yaml"), "services: {}\n"); // current content
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({
			port: 19455,
			projectDir: proj,
			routes: { "/v1/specs/refresh": { specs: [] } },
		});
		// the instance's boot record + a boot line hashing DIFFERENT content
		await Bun.write(
			join(inst.runDir, "offbook.boot.json"),
			JSON.stringify({ projectDir: proj, config: {}, token: inst.token }),
		);
		const staleHash = new Bun.CryptoHasher("sha256").update("older content").digest("hex");
		await Bun.write(
			join(inst.runDir, "offbook.log"),
			`[offbook] 2026-08-19T00:00:00.000Z boot: services.yaml sha256:${staleHash}\n`,
		);
		try {
			const x = io();
			expect(await run(["specs", "update"], x.io)).toBe(0);
			expect(
				x.out.some((l) => l.includes("services.yaml changed since `offbook up` — restart to apply")),
			).toBe(true);
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure.** `bun test test/cli-dispatch.test.ts` — the two new tests FAIL (reset still uses `clientFor`; staleness reads cwd's run dir).

- [ ] **Step 3: Implement.** In `cmdPublish`, `cmdScenario`, `cmdReset`: replace `const a = await clientFor(values);` with the three-line `targetFor(values, io, "mutate", "<verb>")` pattern (verb strings `"publish"`, `"scenario"`, `"reset"`).

In `cmdSpecs`' update branch, the staleness call becomes resolved-instance-aware — replace:

```ts
		if (str(values["ctrl-port"]) === undefined) {
			const warn = await specsStalenessWarning(runDirOf(values));
			if (warn !== undefined) io.out(warn);
		}
```

with:

```ts
		// R-043 semantics under D-032: the staleness warning reads the
		// RESOLVED instance's boot record (skipped under --ctrl-port, where
		// run-dir correspondence stays unverified)
		if (str(values["ctrl-port"]) === undefined && t.inst !== undefined) {
			const warn = await specsStalenessWarning(t.inst.runDir);
			if (warn !== undefined) io.out(warn);
		}
```

- [ ] **Step 4: Run tests.** `bun test test/cli-dispatch.test.ts` then full `bun test` — green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts test/cli-dispatch.test.ts
git commit -m "feat: mutating verbs note their instance; specs update staleness follows resolution (R-045)"
```

---

### Task 14: `status` — machine-wide, identity-aware, `--ctrl-port`, `--json` server block

**Files:**
- Modify: `src/cli/index.ts` (`cmdStatus`, `USAGE` status line)
- Test: `test/cli-dispatch.test.ts`

**Interfaces:**
- Consumes: `resolveInstance`, `probeServer`, catalog (`M8`, `M11s`, `M12`, `M13`, `M16`, `M18`, `refusalEnvelope`, `instanceTable`), `rowsOf`.
- Produces: `status --json` gains `server: { projectDir?, runDir, source, demo }` and `skipped: [...]`; `status --ctrl-port <n>` (identity-only; M18 on legacy, exit 2).

- [ ] **Step 1: Write the failing tests.** Append to `test/cli-dispatch.test.ts`:

```ts
// [itest->R-045]
test("status, registry-resolved: first line names the instance; --json carries the server block + skipped array", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-status-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({
			port: 19456,
			projectDir: proj,
			routes: {
				"/v1/mode": { mode: "autonomous", seed: 1, lastResetSeq: 0 },
				"/v1/specs": { specs: [], resolutionMode: "branch" },
				"/v1/validation": {
					violations: [],
					summary: {
						byOrigin: { client: 0, mock: 0 },
						distinct: { total: 0, client: 0, mock: 0 },
					},
				},
				"/v1/diagnostics": {
					diagnostics: [],
					summary: { errors: 0, warnings: 0, info: 0, byKind: {} },
				},
			},
		});
		try {
			const human = io();
			expect(await run(["status"], human.io)).toBe(0);
			expect(human.out[0]).toBe(`offbook @ ${proj} (ws 1 · http 19456)`);

			const json = io();
			expect(await run(["status", "--json"], json.io)).toBe(0);
			expect(json.out).toHaveLength(1);
			const doc = JSON.parse(json.out[0]) as {
				server: { projectDir: string; source: string; demo: boolean };
				skipped: unknown[];
			};
			expect(doc.server).toMatchObject({
				projectDir: proj,
				source: "registry",
				demo: false,
			});
			expect(doc.skipped).toEqual([]);
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

// [itest->R-045]
test("status --ctrl-port against a pre-upgrade (legacy) server refuses with the older-build message, exit 2", async () => {
	const legacy = Bun.serve({
		port: 19457,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/mode"
				? Response.json({ mode: "passive" })
				: new Response("nope", { status: 404 }),
	});
	try {
		const x = io();
		expect(await run(["status", "--ctrl-port", "19457"], x.io)).toBe(2);
		expect(x.err.join("\n")).toContain("started by an older offbook build");
	} finally {
		legacy.stop(true);
	}
});

// [itest->R-045]
test("status with nothing anywhere: the not-running clause covers the whole machine, exit 1", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const x = io();
		expect(await run(["status"], x.io)).toBe(1);
		expect(x.err.join("\n")).toContain(
			"offbook: not running (no runfile in .offbook, and nothing else is running on this machine)",
		);
	});
	rmSync(cwd, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure.** The three tests FAIL (status is still cwd-only, no --ctrl-port flag).

- [ ] **Step 3: Implement.** Extend the `./messages.ts` import with `M11s` and `M18`. Replace `cmdStatus` wholesale:

```ts
async function cmdStatus(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		"run-dir": { type: "string" },
		"ctrl-port": { type: "string" },
		json: { type: "boolean" },
	});
	if (values["ctrl-port"] !== undefined) return statusByCtrlPort(values, io);
	const json = values.json === true;
	const res = await resolveOrRefuse(
		{
			cwd: process.cwd(),
			runDirFlag: str(values["run-dir"]),
			stateDir: stateDirFromEnv(),
		},
		io,
		json,
	);
	if (typeof res === "number") return res;
	for (const n of res.notes) io.err(n);
	if (res.resolved === undefined) {
		if (res.candidates.length > 1) {
			if (json)
				io.out(refusalEnvelope("ambiguous", M8(), rowsOf(res.candidates)));
			else {
				io.err(M8());
				for (const line of instanceTable(rowsOf(res.candidates), "status"))
					io.err(line);
			}
			return 2;
		}
		const runDirFlag = str(values["run-dir"]);
		if (runDirFlag !== undefined) {
			// explicit addressing keeps status's pre-D-032 wordings
			const s = res.skipped[0];
			io.err(
				`offbook: not running${s !== undefined ? ` (stale runfile, pid ${s.pid})` : ` (no runfile in ${runDirFlag})`}`,
			);
			return 1;
		}
		const own =
			res.skipped.length === 1 &&
			res.skipped[0].runDir === resolve(process.cwd(), DEFAULT_CONFIG.runDir)
				? res.skipped[0]
				: undefined;
		if (own !== undefined) {
			if (json) io.out(refusalEnvelope("not-running", M12(own.pid)));
			else io.err(M12(own.pid));
			return 1;
		}
		for (const s of res.skipped) io.err(skippedNote(s));
		if (json) io.out(refusalEnvelope("not-running", M11s()));
		else io.err(M11s());
		return 1;
	}
	const inst = res.resolved;
	for (const s of res.skipped) io.err(skippedNote(s));
	const run = inst.run;
	const a = api(run.controlPlanePort);
	const clients = clientsFromLog(
		await Bun.file(logPath(inst.runDir))
			.text()
			.catch(() => ""),
	);
	const [modeRes, specsRes, valRes, diagRes] = (await Promise.all([
		a.get("/v1/mode"),
		a.get("/v1/specs"),
		a.get("/v1/validation"),
		a.get("/v1/diagnostics"),
	])) as [
		{ mode: string; seed: number },
		{ specs: SpecInfo[]; warnings?: string[] },
		{ summary: ValidationSummary },
		{ summary: DiagnosticSummary },
	];
	if (json) {
		io.out(
			JSON.stringify(
				{
					server: {
						projectDir: inst.projectDir,
						runDir: inst.runDir,
						source: inst.source,
						demo: inst.demo,
					},
					skipped: res.skipped,
					run,
					mode: modeRes,
					specs: specsRes.specs,
					validation: valRes.summary,
					diagnostics: diagRes.summary,
					clients,
				},
				null,
				2,
			),
		);
		return 0;
	}
	const v = valRes.summary;
	if (inst.source === "registry")
		io.out(
			M16(
				inst.projectDir ?? dirname(inst.runDir),
				run.brokerWsPort,
				run.controlPlanePort,
				inst.demo,
			),
		);
	io.out(`offbook: running (pid ${run.pid}, since ${run.startedAt})`);
	io.out(`  mode ${modeRes.mode} · seed ${modeRes.seed}`);
	io.out(
		`  ports: ws ${run.brokerWsPort} · tcp ${run.brokerTcpPort} · http ${run.controlPlanePort}`,
	);
	io.out(
		`  point your MQTT client at ws://localhost:${run.brokerWsPort} (MQTT 3.1.1)`,
	);
	io.out(
		clients.connects === 0
			? `  clients: no connects observed this run — is your app pointed at ws://localhost:${run.brokerWsPort}?`
			: `  clients: ${clients.connects} connect(s) this run · last ${clients.last?.clientId} at ${clients.last?.at}`,
	);
	if (specsRes.specs.length === 0) io.out("  specs: (none)");
	for (const s of specsRes.specs) {
		const age = specAge(s.fetchedAt);
		io.out(
			`  spec ${s.service}: ${s.source} @ ${shortHash(s.contentHash)} · fetched ${s.fetchedAt}${age ? ` (${age})` : ""}`,
		);
	}
	io.out(
		`  violations: client ${v.byOrigin.client} / mock ${v.byOrigin.mock} — caught ${v.distinct.client} distinct client break(s)`,
	);
	io.out(
		`  diagnostics: ${diagRes.summary.errors} error(s) · ${diagRes.summary.warnings} warning(s)`,
	);
	return 0;
}

// status --ctrl-port (D-032): identity-only reporting — the server's own
// claim, no log- or boot-file-derived extras (their run-dir correspondence
// is what --ctrl-port cannot verify; the identity CAN, so it is shown).
// Pre-upgrade servers refuse with M18 (no degraded partial-output mode).
async function statusByCtrlPort(values: FlagValues, io: Io): Promise<number> {
	const port = toInt(str(values["ctrl-port"]) ?? "", "--ctrl-port");
	const json = values.json === true;
	const probe = await probeServer(port);
	if (probe.kind === "legacy") {
		if (json) io.out(refusalEnvelope("version-skew", M18()));
		else io.err(M18());
		return 2;
	}
	if (probe.kind === "silent")
		throw new CliError(
			`could not reach offbook at http://localhost:${port} — is it running?`,
		);
	const id = probe.identity;
	const a = api(port);
	const [modeRes, specsRes, valRes, diagRes] = (await Promise.all([
		a.get("/v1/mode"),
		a.get("/v1/specs"),
		a.get("/v1/validation"),
		a.get("/v1/diagnostics"),
	])) as [
		{ mode: string; seed: number },
		{ specs: SpecInfo[]; warnings?: string[] },
		{ summary: ValidationSummary },
		{ summary: DiagnosticSummary },
	];
	if (json) {
		io.out(
			JSON.stringify(
				{
					server: {
						projectDir: id.projectDir,
						runDir: id.runDir,
						source: "ctrl-port",
						demo: id.demo,
					},
					skipped: [],
					mode: modeRes,
					specs: specsRes.specs,
					validation: valRes.summary,
					diagnostics: diagRes.summary,
				},
				null,
				2,
			),
		);
		return 0;
	}
	io.out(
		M16(id.projectDir, id.ports.brokerWsPort, id.ports.controlPlanePort, id.demo),
	);
	io.out(`offbook: running (pid ${id.pid}, since ${id.startedAt})`);
	io.out(`  mode ${modeRes.mode} · seed ${modeRes.seed}`);
	io.out(
		`  ports: ws ${id.ports.brokerWsPort} · tcp ${id.ports.brokerTcpPort} · http ${id.ports.controlPlanePort}`,
	);
	io.out(
		`  violations: client ${valRes.summary.byOrigin.client} / mock ${valRes.summary.byOrigin.mock} — caught ${valRes.summary.distinct.client} distinct client break(s)`,
	);
	io.out(
		`  diagnostics: ${diagRes.summary.errors} error(s) · ${diagRes.summary.warnings} warning(s)`,
	);
	return 0;
}
```

Update the `USAGE` status line to `status [--json] [--ctrl-port n]    running/ports/mode/specs/violations at a glance`.

- [ ] **Step 4: Run tests.** New tests green. Existing status tests: the ones asserting `offbook: not running (no runfile in <runDir>)` via a `--run-dir` flag still pass (explicit path keeps old wording); any asserting the DEFAULT-cwd wording now expect the M11s clause — update those assertions. Full `bun test` green. Note suite B asserts on real `status` output — its instance is cwd-resolved, so output is unchanged there.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts test/cli-dispatch.test.ts
git commit -m "feat: status resolves machine-wide, names its instance, gains --ctrl-port identity mode (R-045)"
```

---

### Task 15: `down` — compare-and-signal, relatedness, tables

**Files:**
- Modify: `src/cli/index.ts` (`cmdDown` + new exported `signalInstance`)
- Test: `test/cli-dispatch.test.ts`

**Interfaces:**
- Consumes: resolver, guard, catalog (`M5`, `M6`, `M8`, `M9`, `M10`, `M13`, `M22`, `instanceTable`), `containsOrEqual`, `canonicalPath`.
- Produces: `export async function signalInstance(inst: ResolvedInstance, stateDir: string, io: Io): Promise<number>` (exported for the site-#3 pins).

- [ ] **Step 1: Write the failing tests.** Append to `test/cli-dispatch.test.ts` (import `signalInstance` from `#src/cli/index.ts` and `readRunfile` is already imported):

```ts
// [itest->R-045]
test("down, unrelated sole instance: unconditional exit-0 no-op printing the live-instance table; the instance survives", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-downsafe-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({ port: 19458, projectDir: proj });
		try {
			const x = io();
			expect(await run(["down"], x.io)).toBe(0);
			const out = x.out.join("\n");
			expect(out).toContain(
				"offbook: not running (in this project) — running elsewhere on this machine:",
			);
			expect(out).toContain(`offbook down --run-dir ${join(proj, ".offbook")}`);
			// the unrelated instance was NOT signaled: its identity still answers
			const still = await fetch("http://localhost:19458/v1/server");
			expect(still.status).toBe(200);
			// and its runfile survives
			expect(await readRunfile(join(proj, ".offbook"))).toBeDefined();
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

// [utest->R-045]
test("signalInstance, guarded site #3: a repointed runfile aborts with the restarted-underneath message; nothing is signaled", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-sig-"));
	const runDir = join(proj, ".offbook");
	const state = mkdtempSync(join(tmpdir(), "offbook-vp-state-"));
	// a real, harmless victim process the runfile CURRENTLY names
	const victim = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
	await writeRunfile(
		runDir,
		{
			pid: victim.pid,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 19459,
			startedAt: "t",
		},
		{ stateDir: state },
	);
	try {
		const dead = Bun.spawnSync(["true"]); // the pid the CALLER verified — now stale
		const x = io();
		const code = await signalInstance(
			{
				runDir,
				run: {
					pid: dead.pid ?? 4_193_995,
					brokerWsPort: 1,
					brokerTcpPort: 2,
					controlPlanePort: 19459,
					startedAt: "t",
				},
				demo: false,
				source: "cwd",
			},
			state,
			x.io,
		);
		expect(code).toBe(1);
		expect(x.err.join("\n")).toContain("restarted underneath");
		expect(victim.killed).toBe(false); // the successor was never signaled
		expect(await readRunfile(runDir)).toBeDefined(); // its registration survives
	} finally {
		victim.kill();
		await victim.exited;
		rmSync(proj, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
});

// [itest->R-045]
test("down, related descendant instance: signals it and reports where it was started", async () => {
	const parent = mkdtempSync(join(tmpdir(), "offbook-vp-parent-"));
	const proj = join(parent, "mock");
	mkdirSync(proj, { recursive: true });
	await inDiscoveryWorld(parent, async () => {
		// a real victim that exits on SIGTERM, with a live identity server
		const victim = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
		const runDir = join(proj, ".offbook");
		const token = "cd".repeat(16);
		await writeRunfile(
			runDir,
			{
				pid: victim.pid,
				brokerWsPort: 1,
				brokerTcpPort: 2,
				controlPlanePort: 19460,
				startedAt: "t",
				token,
				host: hostname(),
			},
			{ stateDir: process.env.OFFBOOK_STATE_DIR ?? "" },
		);
		const identity = {
			pid: victim.pid,
			token,
			host: hostname(),
			projectDir: proj,
			runDir,
			startedAt: "t",
			demo: false,
			ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 19460 },
		};
		const server = Bun.serve({
			port: 19460,
			fetch: (req) =>
				new URL(req.url).pathname === "/v1/server"
					? Response.json(identity)
					: new Response("nope", { status: 404 }),
		});
		try {
			const x = io();
			expect(await run(["down"], x.io)).toBe(0); // cwd = parent → descendant wins containment
			expect(x.out.join("\n")).toContain(`stopped (pid ${victim.pid}, started in ${proj})`);
			await victim.exited;
			expect(await readRunfile(runDir)).toBeUndefined(); // cleared + unregistered
		} finally {
			server.stop(true);
			try {
				victim.kill();
			} catch {}
		}
	});
	rmSync(parent, { recursive: true, force: true });
}, 20_000);
```

```ts
// [itest->R-045]
test("down, row 4: a wrong-token cwd runfile is never signaled — naming-both note + not running, exit 0", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-row4down-"));
	await inDiscoveryWorld(cwd, async () => {
		await writeRunfile(
			join(cwd, ".offbook"),
			{
				pid: process.pid, // signaling this would hit the TEST RUNNER
				brokerWsPort: 1,
				brokerTcpPort: 2,
				controlPlanePort: 19466,
				startedAt: "t",
				token: "b1".repeat(16),
				host: hostname(),
			},
			{ stateDir: process.env.OFFBOOK_STATE_DIR ?? "" },
		);
		const identity = {
			pid: process.pid,
			token: "b2".repeat(16), // NOT the runfile's — row 4
			host: hostname(),
			projectDir: "/somewhere/else",
			runDir: "/somewhere/else/.offbook",
			startedAt: "t",
			demo: false,
			ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 19466 },
		};
		const server = Bun.serve({
			port: 19466,
			fetch: (req) =>
				new URL(req.url).pathname === "/v1/server"
					? Response.json(identity)
					: new Response("nope", { status: 404 }),
		});
		try {
			const x = io();
			expect(await run(["down"], x.io)).toBe(0); // reached = nothing was signaled
			expect(x.out).toContain("offbook: not running");
			expect(x.err.join("\n")).toContain("no longer answers for control port 19466");
			expect(await readRunfile(join(cwd, ".offbook"))).toBeDefined(); // kept
		} finally {
			server.stop(true);
		}
	});
	rmSync(cwd, { recursive: true, force: true });
});

// [itest->R-045]
test("down, one verified unrelated + one silent skipped: refuses with the pick-one table (M9), exit 2", async () => {
	const projA = mkdtempSync(join(tmpdir(), "offbook-vp-m9a-"));
	const projB = mkdtempSync(join(tmpdir(), "offbook-vp-m9b-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const verified = await fakeInstance({ port: 19467, projectDir: projA });
		// B: live pid, silent port — a skipped candidate down must not ignore
		await writeRunfile(
			join(projB, ".offbook"),
			{
				pid: process.pid,
				brokerWsPort: 1,
				brokerTcpPort: 2,
				controlPlanePort: 19468, // nothing listens
				startedAt: "t",
				token: "b3".repeat(16),
				host: hostname(),
			},
			{ stateDir: process.env.OFFBOOK_STATE_DIR ?? "" },
		);
		try {
			const x = io();
			expect(await run(["down"], x.io)).toBe(2);
			const err = x.err.join("\n");
			expect(err).toContain("one instance verified but others are not answering");
			expect(err).toContain(`offbook down --run-dir ${join(projA, ".offbook")}`);
			// the verified instance was NOT auto-killed
			expect((await fetch("http://localhost:19467/v1/server")).status).toBe(200);
		} finally {
			verified.stop();
		}
	});
	for (const d of [projA, projB, cwd]) rmSync(d, { recursive: true, force: true });
}, 15_000);

// [utest->R-045]
test("signalInstance, guarded site #2: a successor registered during shutdown survives the post-kill clear", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-succ-"));
	const runDir = join(proj, ".offbook");
	const state = mkdtempSync(join(tmpdir(), "offbook-vp-state-"));
	mkdirSync(runDir, { recursive: true });
	const runfile = join(runDir, "offbook.run");
	const successor = JSON.stringify({
		pid: 555555,
		brokerWsPort: 1,
		brokerTcpPort: 2,
		controlPlanePort: 19469,
		startedAt: "successor",
	});
	// the victim's SIGTERM handler repoints the runfile (a --watch respawn
	// finishing its handoff) and exits — exactly the site-#2 race
	const src = `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(runfile)}, ${JSON.stringify(successor)}); process.exit(0); }); setInterval(() => {}, 1000);`;
	const victim = Bun.spawn([process.execPath, "-e", src]);
	await writeRunfile(
		runDir,
		{
			pid: victim.pid,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 19469,
			startedAt: "t",
		},
		{ stateDir: state },
	);
	try {
		await Bun.sleep(300); // let the handler install
		const x = io();
		expect(
			await signalInstance(
				{
					runDir,
					run: {
						pid: victim.pid,
						brokerWsPort: 1,
						brokerTcpPort: 2,
						controlPlanePort: 19469,
						startedAt: "t",
					},
					demo: false,
					source: "cwd",
				},
				state,
				x.io,
			),
		).toBe(0);
		const kept = await readRunfile(runDir);
		expect(kept?.pid).toBe(555555); // the successor's registration survived
	} finally {
		try {
			victim.kill();
		} catch {}
		rmSync(proj, { recursive: true, force: true });
		rmSync(state, { recursive: true, force: true });
	}
}, 20_000);
```

Add `19460`, `19466-19469` to the file's reserved-port comment (the `19450-19479` block from Task 12).

- [ ] **Step 2: Run to verify failure.** The three tests FAIL (down is still cwd-only; no `signalInstance` export).

- [ ] **Step 3: Implement.** Extend the `./messages.ts` import with `M5`, `M6`, `M9`, `M10`, `M22` and the `./resolve.ts` import with `containsOrEqual`; add `canonicalPath` to the `./registry.ts` import. Then replace `cmdDown` wholesale and add `signalInstance`:

```ts
async function cmdDown(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, { "run-dir": { type: "string" } });
	const stateDir = stateDirFromEnv();
	const explicit = str(values["run-dir"]);
	// the foreign-host refusal (M10) renders verbatim on stderr, exit 2
	const res = await resolveOrRefuse(
		{ cwd: process.cwd(), runDirFlag: explicit, stateDir },
		io,
		false,
	);
	if (typeof res === "number") return res;
	for (const n of res.notes) io.err(n);
	if (res.resolved !== undefined) {
		const inst = res.resolved;
		if (explicit === undefined && inst.source === "registry") {
			// however it was resolved — the demo stage included — an instance
			// unrelated to cwd is never auto-signaled (FM-025)
			const projectDir = canonicalPath(inst.projectDir ?? dirname(inst.runDir));
			const cwdReal = canonicalPath(process.cwd());
			const related =
				containsOrEqual(projectDir, cwdReal) ||
				containsOrEqual(cwdReal, projectDir);
			if (!related) {
				if (res.skipped.length > 0) {
					// one verified + others not answering: the skipped may be
					// the intended target — refuse with the table (M9, exit 2)
					for (const s of res.skipped)
						io.err(skippedNote(s));
					io.err(M9());
					for (const line of instanceTable(rowsOf(res.candidates), "down"))
						io.err(line);
					return 2;
				}
				// nothing of yours: deterministic no-op — the table makes
				// choosing one paste (M6, exit 0)
				io.out(M6());
				for (const line of instanceTable(rowsOf(res.candidates), "down"))
					io.out(line);
				return 0;
			}
		}
		return signalInstance(inst, stateDir, io);
	}
	if (res.candidates.length > 1) {
		io.err(M8());
		for (const line of instanceTable(rowsOf(res.candidates), "down"))
			io.err(line);
		return 2;
	}
	// row 3, the wedged-server path: cwd's own SILENT instance is still
	// signalable pid-only (M12 promises `offbook down` stops it); a
	// wrong-token skip is never signaled — the pid may be reused (row 4)
	const ownRunDir =
		explicit !== undefined
			? (res.skipped[0]?.runDir ?? resolve(process.cwd(), explicit))
			: resolve(process.cwd(), DEFAULT_CONFIG.runDir);
	const own = res.skipped.find(
		(s) => s.runDir === ownRunDir && s.reason === "silent",
	);
	if (own !== undefined) {
		const run = await readRunfile(own.runDir);
		if (run !== undefined)
			return signalInstance(
				{
					runDir: own.runDir,
					run,
					projectDir: own.projectDir,
					demo: false,
					source: "cwd",
				},
				stateDir,
				io,
			);
	}
	// explicit-path dead runfile: down has ALWAYS cleaned these up (P7
	// idempotence) — the resolver's reclaimDead:false left it for us so
	// read verbs could keep reporting it as stale
	const deadOwn = res.skipped.find(
		(s) => s.runDir === ownRunDir && s.reason === "dead",
	);
	if (deadOwn !== undefined) {
		await guarded({
			read: () => readRunfile(deadOwn.runDir),
			expect: (cur) => cur !== undefined && cur.pid === deadOwn.pid,
			act: () => clearRunfile(deadOwn.runDir, { stateDir }),
		});
		io.out("offbook: not running");
		return 0;
	}
	if (res.foreignSeen && explicit === undefined) {
		// row 10 on the pid-only path: never signal into a foreign pid table
		const cwdRunDir = resolve(process.cwd(), DEFAULT_CONFIG.runDir);
		const run = await readRunfile(cwdRunDir);
		if (run?.host !== undefined && run.host !== hostname()) {
			io.err(M10(run.host, cwdRunDir));
			return 2;
		}
	}
	for (const s of res.skipped) io.err(skippedNote(s));
	io.out("offbook: not running");
	return 0;
}

// The signal path (guarded sites #3 and #2), exported so the site pins can
// drive it directly. The TOKEN identifies the lineage; the PID identifies
// the incarnation — compare-and-signal checks the pid, because signaling
// the wrong incarnation is exactly the race being guarded.
export async function signalInstance(
	inst: ResolvedInstance,
	stateDir: string,
	io: Io,
): Promise<number> {
	const { runDir, run } = inst;
	const lineage = run.token;
	// site #3: the runfile must still name the verified pid at signal time
	const signaled = await guarded({
		read: () => readRunfile(runDir),
		expect: (cur) => cur !== undefined && cur.pid === run.pid,
		act: () => process.kill(run.pid, "SIGTERM"),
	});
	if (!signaled) {
		io.err(M22());
		return 1;
	}
	const deadline = Date.now() + 5_000;
	while (pidAlive(run.pid) && Date.now() < deadline) await sleep(50);
	if (pidAlive(run.pid)) {
		// the SIGKILL escalation re-verifies BOTH granularities: the runfile
		// still names this pid, AND the port is silent or answers with the
		// signaled lineage — a new port owner is never killed
		const cur = await readRunfile(runDir);
		const probe = await probeServer(run.controlPlanePort, 300);
		const portIsOurs =
			probe.kind === "silent" ||
			(probe.kind === "server" &&
				lineage !== undefined &&
				probe.identity.token === lineage) ||
			(probe.kind === "legacy" && lineage === undefined);
		if (cur === undefined || cur.pid !== run.pid || !portIsOurs) {
			io.err(M22());
			return 1;
		}
		process.kill(run.pid, "SIGKILL");
		await sleep(100);
	}
	// site #2: clear only while the runfile still names the signaled pid —
	// a --watch successor's registration survives this clear
	await guarded({
		read: () => readRunfile(runDir),
		expect: (cur) => cur !== undefined && cur.pid === run.pid,
		act: () => clearRunfile(runDir, { stateDir }),
	});
	if (inst.identity !== undefined)
		io.out(M5(run.pid, inst.projectDir ?? dirname(runDir), inst.demo));
	else io.out(`offbook down — stopped (pid ${run.pid})`); // unverified: claim only what was proven
	return 0;
}
```

- [ ] **Step 4: Run tests.** New tests green. Existing down tests: the dead-pid `run-down` fixture (~line 698) prints `offbook: not running` exit 0 as before (row 5 reclaim + bare no-op) — but it now ALSO prints the M14 note to stderr; extend that test's expectations if it asserts exact stderr. Suite B's real `down` output is now M5 with projectDir — update its assertion from `offbook down — stopped (pid` if it pins the full line (the instance is verified, so M5 with `started in` applies). Full `bun test` green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts test/cli-dispatch.test.ts
git commit -m "feat: down - compare-and-signal, relatedness guard, instance tables (R-045)"
```

---

### Task 16: `logs` — local-first with the divergence banner

**Files:**
- Modify: `src/cli/index.ts` (`cmdLogs`)
- Test: `test/cli-dispatch.test.ts`

**Interfaces:**
- Consumes: resolver, catalog (`M8`, `M13`, `M16`, `M19`, `instanceTable`), `canonicalPath`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test.** Append to `test/cli-dispatch.test.ts`:

```ts
// [itest->R-045]
test("logs: a local stopped log wins for output with the divergence banner; with no local log the resolved instance's log prints under its header", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-logs-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	mkdirSync(join(cwd, ".offbook"), { recursive: true });
	await Bun.write(join(cwd, ".offbook", "offbook.log"), "old local line\n");
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({ port: 19461, projectDir: proj });
		await Bun.write(join(inst.runDir, "offbook.log"), "live remote line\n");
		try {
			// local log exists: printed, with the banner naming the live one
			const local = io();
			expect(await run(["logs"], local.io)).toBe(0);
			expect(local.out).toContain("old local line");
			expect(
				local.err.some(
					(l) =>
						l.startsWith("(offbook: showing the local stopped log at") &&
						l.includes(proj),
				),
			).toBe(true);
			// no local log: the resolved instance's log prints under its header
			rmSync(join(cwd, ".offbook", "offbook.log"));
			const remote = io();
			expect(await run(["logs"], remote.io)).toBe(0);
			expect(remote.out[0]).toBe(`offbook @ ${proj} (ws 1 · http 19461)`);
			expect(remote.out).toContain("live remote line");
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

// [itest->R-045]
test("logs -f: the divergence banner prints before the follow loop starts", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-logsf-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	mkdirSync(join(cwd, ".offbook"), { recursive: true });
	await Bun.write(join(cwd, ".offbook", "offbook.log"), "old local line\n");
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({ port: 19470, projectDir: proj });
		// -f never returns in-process: drive the real bin (same pattern as
		// the existing follow tests), inheriting the pinned state-dir env
		const proc = Bun.spawn([BIN, "logs", "-f"], {
			cwd,
			env: { ...process.env },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			await pause(1200);
			proc.kill();
			await proc.exited;
			const err = await new Response(proc.stderr).text();
			const out = await new Response(proc.stdout).text();
			expect(err).toContain("(offbook: showing the local stopped log at");
			expect(err).toContain(proj);
			expect(out).toContain("old local line");
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}, 20_000);
```

(`BIN` and `pause` already exist in this file — line ~1130's `const BIN` and the watch tests' `pause` helper; reference them, do not redeclare.)

- [ ] **Step 2: Run to verify failure.** FAIL (logs still errors: no local log / prints without banner).

- [ ] **Step 3: Implement.** Extend the `./messages.ts` import with `M19`. Replace `cmdLogs`:

```ts
async function cmdLogs(rest: string[], io: Io): Promise<number> {
	const { values } = parseFlags(rest, {
		"run-dir": { type: "string" },
		follow: { type: "boolean", short: "f" },
	});
	const explicit = str(values["run-dir"]);
	// logs always runs the resolver — the banner needs its outcome; the
	// local log merely wins for OUTPUT (post-mortem logs keep working in
	// the project directory, a stated non-goal boundary)
	const res = await resolveOrRefuse(
		{ cwd: process.cwd(), runDirFlag: explicit, stateDir: stateDirFromEnv() },
		io,
		false,
	);
	if (typeof res === "number") return res;
	for (const n of res.notes) io.err(n);
	const localRunDir = resolve(process.cwd(), explicit ?? DEFAULT_CONFIG.runDir);
	const localPath = logPath(localRunDir);
	let path = localPath;
	if (existsSync(localPath)) {
		if (
			res.resolved !== undefined &&
			canonicalPath(res.resolved.runDir) !== canonicalPath(localRunDir)
		)
			io.err(
				M19(
					localPath,
					res.resolved.projectDir ?? dirname(res.resolved.runDir),
					res.resolved.runDir,
				),
			);
	} else if (res.resolved !== undefined) {
		if (res.resolved.source === "registry")
			io.out(
				M16(
					res.resolved.projectDir ?? dirname(res.resolved.runDir),
					res.resolved.run.brokerWsPort,
					res.resolved.run.controlPlanePort,
					res.resolved.demo,
				),
			);
		path = logPath(res.resolved.runDir);
	} else if (res.candidates.length > 1) {
		io.err(M8());
		for (const line of instanceTable(rowsOf(res.candidates), "logs"))
			io.err(line);
		return 2;
	} else {
		for (const s of res.skipped) io.err(skippedNote(s));
		throw new CliError(`no log at ${localPath} — has \`offbook up\` run here?`);
	}
	const text = await Bun.file(path).text();
	if (text.trimEnd() !== "") io.out(text.trimEnd());
	if (!values.follow) return 0;
	let offset = Bun.file(path).size;
	while (true) {
		await sleep(300);
		const f = Bun.file(path);
		if (f.size > offset) {
			const appended = await f.slice(offset).text();
			offset = f.size;
			if (appended.trimEnd() !== "") io.out(appended.trimEnd());
		}
	}
}
```

- [ ] **Step 4: Run tests.** New test green; the existing `logs` no-log error test still passes (same wording). Full `bun test` green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts test/cli-dispatch.test.ts
git commit -m "feat: logs - local-first output with the divergence banner, machine-wide resolution (R-045)"
```

---

### Task 17: `topics` — resolver-backed fallback + the `--json` demo refusal

**Files:**
- Modify: `src/cli/index.ts` (`cmdTopics`), `src/cli/client.ts` (drop `resolveCtrlPort`)
- Test: `test/cli-dispatch.test.ts`

**Interfaces:**
- Consumes: resolver, catalog (`M13`, `M16`, `M20`, `M8`, `M11`, `M12`, `refusalEnvelope`, `instanceTable`).
- Produces: `clientFor`/`resolveCtrlPort` are deleted; `targetFor`'s ctrl-port branch inlines the flag parse: replace `return { api: await clientFor(values) };` with `return { api: api(toInt(str(values["ctrl-port"]) ?? "", "--ctrl-port")) };` and delete `clientFor` from index.ts and `resolveCtrlPort` from client.ts (keep `CliError`, `api`, and the envelope handling).

- [ ] **Step 1: Write the failing tests.** Append to `test/cli-dispatch.test.ts`:

```ts
// [itest->R-045]
test("topics --json: a registry-resolved DEMO refuses with the demo-only envelope (exit 1); human mode serves it under a demo-marked header", async () => {
	const demoDir = mkdtempSync(join(tmpdir(), "offbook-vp-demo-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({
			port: 19462,
			projectDir: demoDir,
			demo: true,
			routes: { "/v1/topics": { topics: [] } },
		});
		try {
			const json = io();
			expect(await run(["topics", "--json"], json.io)).toBe(1);
			expect(json.out).toHaveLength(1);
			const envelope = JSON.parse(json.out[0]) as { error: { code: string; message: string } };
			expect(envelope.error.code).toBe("demo-only");
			expect(envelope.error.message).toContain("the only running offbook is the bundled demo");
			const human = io();
			expect(await run(["topics", "--compact"], human.io)).toBe(0);
			expect(human.out[0]).toBe(`offbook @ ${demoDir} (ws 1 · http 19462) — the bundled demo`);
		} finally {
			inst.stop();
		}
	});
	rmSync(demoDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

// [itest->R-045]
test("topics with nothing live: --json refuses with the not-running envelope; human keeps the bundled-demo fallback + note", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-nofall-"));
	await inDiscoveryWorld(cwd, async () => {
		const json = io();
		expect(await run(["topics", "--json"], json.io)).toBe(1);
		expect(json.out).toHaveLength(1);
		expect((JSON.parse(json.out[0]) as { error: { code: string } }).error.code).toBe("not-running");
		const human = io();
		expect(await run(["topics", "--compact"], human.io)).toBe(0);
		expect(human.out[0]).toBe(
			"(no running offbook — showing the bundled demo spec; `offbook up` serves your project's topics)",
		);
	});
	rmSync(cwd, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure.** FAIL (topics still uses `resolveRunning` + the old refusal string).

- [ ] **Step 3: Implement.** Extend the `./messages.ts` import with `M20`. Rewrite `cmdTopics`'s resolution section. Keep the flag parsing, direction handling, and rendering; replace everything between `let topics: TopicInfo[];` and `if (values.json) {` with:

```ts
	let topics: TopicInfo[];
	let note: string | undefined;
	if (values["ctrl-port"] !== undefined) {
		const a = api(toInt(str(values["ctrl-port"]) ?? "", "--ctrl-port"));
		topics = ((await a.get(`/v1/topics${query}`)) as { topics: TopicInfo[] })
			.topics;
	} else {
		const res = await resolveOrRefuse(
			{
				cwd: process.cwd(),
				runDirFlag: str(values["run-dir"]),
				stateDir: stateDirFromEnv(),
			},
			io,
			values.json === true,
		);
		if (typeof res === "number") return res;
		for (const n of res.notes) io.err(n);
		if (res.resolved !== undefined) {
			const inst = res.resolved;
			for (const s of res.skipped) io.err(skippedNote(s));
			const projectDir = inst.projectDir ?? dirname(inst.runDir);
			if (values.json === true && inst.source === "registry" && inst.demo) {
				// the agent path must never mistake demo topics for ingestion
				// (a cwd-resolved demo is deliberate; a discovered one is not)
				io.out(refusalEnvelope("demo-only", M20(projectDir)));
				return 1;
			}
			if (inst.source === "registry" && values.json !== true)
				io.out(
					M16(projectDir, inst.run.brokerWsPort, inst.run.controlPlanePort, inst.demo),
				);
			const a = api(inst.run.controlPlanePort);
			topics = ((await a.get(`/v1/topics${query}`)) as { topics: TopicInfo[] })
				.topics;
		} else if (res.candidates.length > 1) {
			if (values.json === true)
				io.out(refusalEnvelope("ambiguous", M8(), rowsOf(res.candidates)));
			else {
				io.err(M8());
				for (const line of instanceTable(rowsOf(res.candidates), "topics"))
					io.err(line);
			}
			return 2;
		} else {
			// zero live anywhere
			const own =
				res.skipped.length === 1 &&
				res.skipped[0].runDir === resolve(process.cwd(), DEFAULT_CONFIG.runDir)
					? res.skipped[0]
					: undefined;
			if (values.json === true) {
				io.out(
					refusalEnvelope("not-running", own !== undefined ? M12(own.pid) : M11()),
				);
				return 1;
			}
			// the M0 human fallback survives — with the skips disclosed
			for (const s of res.skipped) io.err(skippedNote(s));
			topics = (await demoTopicInfo()).filter(
				(t) => direction === undefined || t.direction === direction,
			);
			note =
				"(no running offbook — showing the bundled demo spec; `offbook up` serves your project's topics)";
		}
	}
```

Then delete `clientFor` from index.ts, inline the ctrl-port parse in `targetFor` (see Interfaces above), and delete `resolveCtrlPort` (and its now-unused `resolveRunning` import) from `src/cli/client.ts`.

- [ ] **Step 4: Run tests.** New tests green. The existing pinned refusal test — the one asserting `no running offbook in this run-dir — run \`offbook up\` here, or pass --ctrl-port; the bundled-demo fallback is human-only` — changes: it now expects exit 1 with the ONE-document `not-running` envelope on stdout (this is the D-032 breaking automation surface; adoption.md follows in Task 21). Update that assertion. Full `bun test` green; `bun run typecheck` green (catches any leftover `resolveCtrlPort` import).

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/client.ts test/cli-dispatch.test.ts
git commit -m "feat: topics resolves machine-wide; --json demo refusal; retire resolveCtrlPort (R-045)"
```

---
### Task 18: `up`-preflight attribution (M3) + doctor (stateDir, named ports, registry notes, M21)

**Files:**
- Modify: `src/cli/index.ts` (`preflightPorts`, `cmdDoctor`), `src/cli/doctor.ts` (`DoctorCtx`, ports check, runfile check, skill check)
- Test: `src/cli/doctor.test.ts`, `test/cli-dispatch.test.ts`

**Interfaces:**
- Consumes: `attributeCtrlPort` (resolve.ts), `M3`, `M21` (messages.ts), `scanPointers`/`canonicalPath`/`pointerPath`/`stateDirFromEnv` (registry.ts).
- Produces: `DoctorCtx` gains `stateDir: string` (every `DoctorCtx` construction site must supply it).

- [ ] **Step 1: Write the failing tests.**

In `src/cli/doctor.test.ts` — first give `ctxWith` a state dir: the file already has the `STATE` scratch const from Task 5; add `stateDir: STATE,` to the `ctxWith` defaults object (this is also what un-breaks the typecheck once `DoctorCtx` grows the field). Then append (ports 19136–19139):

```ts
// [utest->R-045]
test("ports: an attributable owner is NAMED with a paste-ready down command; unverifiable owners keep the generic attribution", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-doctor-owner-"));
	const runDir = join(proj, ".offbook");
	const token = "da".repeat(16);
	await writeRunfile(
		runDir,
		{
			pid: process.pid,
			brokerWsPort: 19130,
			brokerTcpPort: 12995,
			controlPlanePort: 19136,
			startedAt: "t",
			token,
			host: hostname(),
		},
		{ stateDir: STATE },
	);
	const identity = {
		pid: process.pid,
		token,
		host: hostname(),
		projectDir: proj,
		runDir,
		startedAt: "t",
		demo: false,
		ports: { brokerWsPort: 19130, brokerTcpPort: 12995, controlPlanePort: 19136 },
	};
	const server = Bun.serve({
		port: 19136,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/server"
				? Response.json(identity)
				: new Response("nope", { status: 404 }),
	});
	try {
		const report = await runDoctor(
			ctxWith({
				repoRoot: GOOD_REPO_ROOT,
				projectDir: projectWith({}),
				ports: { ws: 19130, tcp: 12995, ctrl: 19136 },
			}),
		);
		const check = byName(report, "ports");
		expect(check.status).toBe("fail");
		expect(check.detail).toContain(`(started in ${proj})`);
		expect(check.hint).toContain(`offbook down --run-dir ${runDir}`);
		expect(check.hint).toContain("from anywhere on this machine");
	} finally {
		server.stop(true);
		rmSync(proj, { recursive: true, force: true });
	}
});

// [utest->R-045]
test("runfile: a live local runfile without a pointer warns that it is not yet manageable from elsewhere", async () => {
	const server = Bun.serve({
		port: 19137,
		fetch: () => Response.json({ mode: "passive" }),
	});
	try {
		const liveDir = mkdtempSync(join(tmpdir(), "offbook-doctor-unreg-"));
		await writeRunfile(
			liveDir,
			{
				pid: process.pid,
				brokerWsPort: 19130,
				brokerTcpPort: 12995,
				controlPlanePort: 19137,
				startedAt: "t",
			},
			{ stateDir: STATE },
		);
		// simulate the pre-upgrade instance: live runfile, NO pointer
		rmSync(pointerPath(STATE, liveDir), { force: true });
		const report = await runDoctor(
			ctxWith({
				repoRoot: GOOD_REPO_ROOT,
				projectDir: projectWith({}),
				runDir: liveDir,
			}),
		);
		const check = byName(report, "runfile");
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("not yet manageable from other directories");
	} finally {
		server.stop(true);
	}
});

// [utest->R-045]
test("skill: an installed skill still teaching `cd mock && offbook up` escalates to the predates-manage-from-anywhere warning", async () => {
	const top = mkdtempSync(join(tmpdir(), "offbook-doctor-m21-"));
	Bun.spawnSync(["git", "init", "-q", top]);
	const installed = join(top, ".claude", "skills", "offbook-onboard");
	mkdirSync(installed, { recursive: true });
	await Bun.write(
		join(installed, "SKILL.md"),
		"6. **First light.** `cd mock && offbook up`. Confirm ingestion.\n",
	);
	const skillOnly = DOCTOR_CHECKS.find((c) => c.name === "skill");
	if (skillOnly === undefined) throw new Error("no skill check");
	const report = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: top }),
		[skillOnly],
	);
	const check = byName(report, "skill");
	expect(check.status).toBe("warn");
	expect(check.detail).toContain("predates manage-from-anywhere");
	rmSync(top, { recursive: true, force: true });
});
```

(`GOOD_REPO_ROOT`, `projectWith`, `byName`, `DOCTOR_CHECKS` are this file's existing helpers/imports — reuse them; add `pointerPath` and `hostname` imports.)

In `test/cli-dispatch.test.ts`, the `up`-preflight side (port 19463):

```ts
// [itest->R-045]
test("up preflight: an attributable control-port owner is named with the from-anywhere down command", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-vp-owner-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-vp-cwd-"));
	await inDiscoveryWorld(cwd, async () => {
		const inst = await fakeInstance({ port: 19463, projectDir: proj });
		try {
			const x = io();
			expect(
				await run(
					["up", "--ws-port", "19464", "--tcp-port", "12496", "--ctrl-port", "19463"],
					x.io,
				),
			).toBe(1);
			const err = x.err.join("\n");
			expect(err).toContain(`(started in ${proj})`);
			expect(err).toContain(`offbook down --run-dir ${join(proj, ".offbook")}`);
		} finally {
			inst.stop();
		}
	});
	rmSync(proj, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify failure.** Both files' new tests FAIL (generic attribution, no stateDir field — the doctor file fails to typecheck first; that counts).

- [ ] **Step 3: Implement.**

`src/cli/index.ts` — in `preflightPorts`, replace the ctrl-busy branch with (import `attributeCtrlPort` from `./resolve.ts`, `M3` from `./messages.ts`):

```ts
	if (busy.some((b) => b.label === "ctrl")) {
		const others = busy.filter((b) => b.label !== "ctrl");
		const alsoBusy =
			others.length > 0
				? `; also busy: ${others.map((b) => `${b.label} ${b.port}`).join(", ")}`
				: "";
		// D-032: name the owner when the port's claim is PROVEN (the served
		// identity matches the claimed runfile's token); a bare offbook-shaped
		// answer keeps the pre-D-032 generic attribution — never a guess
		const owner = await attributeCtrlPort(config.controlPlanePort);
		if (owner !== undefined)
			throw new CliError(
				M3({
					port: config.controlPlanePort,
					projectDir: owner.projectDir,
					runDir: owner.runDir,
					demo: owner.demo,
					alsoBusy,
				}),
			);
		if (await probeOffbook(config.controlPlanePort))
			throw new CliError(
				`another offbook owns the control port ${config.controlPlanePort}${alsoBusy} — \`offbook down\` in that project's directory frees the control port; check the others separately if they persist`,
			);
	}
```

(The trailing generic `port(s) in use` throw stays as-is.)

`src/cli/doctor.ts`:

1. `DoctorCtx` gains `stateDir: string;` (with the comment `// D-032: the instance-registry state dir (injected; tests pin a scratch)`); imports gain `hostname` (node:os), `M21` (./messages.ts — the ports check inlines its detail/hint strings because doctor splits them, so `M3` is NOT imported here), `attributeCtrlPort` (./resolve.ts), `canonicalPath`, `pointerPath`, `scanPointers` (./registry.ts), `pidAlive`, `readRunfile` (./runfile.ts), and `existsSync` (node:fs) if not already present.
2. In the ports check, replace the attributed-fail branch. **Ordering matters**: `attributeCtrlPort` must run BEFORE the legacy `probeOffbook` gate — a current-build owner serves `/v1/server` and its `/v1/mode`, but the attribution is the stronger proof and must win; gating on `probeOffbook` first (the old shape) would also never attribute a server whose `/v1/mode` check races out:

```ts
		if (busy.some((b) => b.startsWith("ctrl"))) {
			const others = busy.filter((b) => !b.startsWith("ctrl"));
			const alsoBusy =
				others.length > 0 ? `; also busy: ${others.join(", ")}` : "";
			// D-032: a PROVEN owner (served identity matches its own runfile's
			// token) is named with a from-anywhere selector; an offbook-shaped
			// answer without proof keeps the pre-D-032 generic attribution
			const owner = await attributeCtrlPort(ctx.ports.ctrl);
			if (owner !== undefined)
				return {
					status: "fail",
					detail: `another offbook owns the control port ${ctx.ports.ctrl}${alsoBusy} (${owner.demo ? `the bundled demo, started in ${owner.projectDir}` : `started in ${owner.projectDir}`})`,
					hint: `\`offbook down --run-dir ${owner.runDir}\` stops it from anywhere on this machine`,
				};
			if (await probeOffbook(ctx.ports.ctrl))
				return {
					status: "fail",
					detail: `another offbook owns the control port ${ctx.ports.ctrl}${alsoBusy}`,
					hint: "`offbook down` in that project's directory frees the control port; check the others separately if they persist",
				};
		}
```

(The trailing generic busy/pass return stays as-is.)

3. Replace `runfileCheck`:

```ts
const runfileCheck: DoctorCheck = {
	name: "runfile",
	async run(ctx) {
		const resolved = await resolveRunning(ctx.runDir);
		// D-032 registry-aware notes: instance records elsewhere, and the
		// pre-upgrade live-local-runfile-without-pointer case (invisible to
		// discovery until restarted or managed locally once). Doctor stays
		// read-only — it reports, never adopts.
		let elsewhere = 0;
		try {
			for (const p of await scanPointers(ctx.stateDir)) {
				if (p.pointer.host !== hostname()) continue;
				if (p.pointer.runDir === canonicalPath(ctx.runDir)) continue;
				const run = await readRunfile(p.pointer.runDir);
				if (run !== undefined && pidAlive(run.pid)) elsewhere++;
			}
		} catch {
			// an unreadable registry degrades the note, never the check
		}
		const elsewhereNote =
			elsewhere === 0
				? ""
				: `; ${elsewhere} other instance record(s) on this machine (\`offbook status\` names the live ones)`;
		if (resolved === undefined)
			return {
				status: "pass",
				detail: `no runfile (nothing running here)${elsewhereNote}`,
			};
		if (resolved.live) {
			const registered = existsSync(pointerPath(ctx.stateDir, ctx.runDir));
			return registered
				? {
						status: "pass",
						detail: `live (pid ${resolved.run.pid})${elsewhereNote}`,
					}
				: {
						status: "warn",
						detail: `live (pid ${resolved.run.pid}) but not yet manageable from other directories`,
						hint: "started by an older offbook build — restart it, or run any offbook verb here once to register it",
					};
		}
		return {
			status: "warn",
			detail: `stale runfile (pid ${resolved.run.pid} not answering)`,
			hint: "`offbook down` cleans it up",
		};
	},
};
```

4. In `skillCheck`, before the final `return diff.identical ? ... : ...`, insert the M21 escalation (the stamp carries no orderable version — `version` is a constant `0.0.0` — so the pre-D-032 CONTENT marker is the truthful discriminator):

```ts
		if (!diff.identical) {
			const installedSkillMd = await Bun.file(join(installed, "SKILL.md"))
				.text()
				.catch(() => "");
			if (installedSkillMd.includes("cd mock && offbook up"))
				return {
					status: "warn",
					detail: M21(),
					hint: `stale/edited skill — \`offbook skill install --force\` from ${top} refreshes it`,
				};
		}
```

5. In `src/cli/index.ts` `cmdDoctor`, add `stateDir: stateDirFromEnv(),` to the `DoctorCtx` literal.

- [ ] **Step 4: Run tests.** `bun test src/cli/doctor.test.ts` (new tests green; the existing attributed-ports test still passes — its fake serves only `/v1/mode`, so the generic branch fires). `bun test test/cli-dispatch.test.ts`; the existing preflight-attribution tests (`attr-` fixtures) keep passing for the same reason. Full `bun test` green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/doctor.ts src/cli/doctor.test.ts test/cli-dispatch.test.ts
git commit -m "feat: named port attribution + registry-aware doctor + skill staleness escalation (R-045)"
```

---

### Task 19: `offbook up [dir]`

**Files:**
- Modify: `src/cli/index.ts` (`cmdUp`, `USAGE`), `src/cli/boot.ts` (init hint names the directory)
- Test: `test/instance-discovery.test.ts`

**Interfaces:**
- Consumes: `M2` (messages.ts).
- Produces: `up [dir]` — `projectDir = resolve(cwd, dir ?? ".")`; default runDir `<projectDir>/.offbook`; explicit `--run-dir` stays cwd-relative.

- [ ] **Step 1: Write the failing tests.** Append to `test/instance-discovery.test.ts` (import `basename`, `dirname` from `node:path`, `statSync` not needed in tests):

```ts
// [itest->R-046]
test("up <missing-dir> and up <file> refuse with the not-a-directory hint BEFORE any write", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "offbook-updir-"));
	const prevCwd = process.cwd();
	process.chdir(cwd);
	try {
		const missing = io();
		expect(await run(["up", "nope"], missing.io)).toBe(1);
		expect(missing.err.join("\n")).toContain("is not a directory — pass your project directory");
		expect(existsSync(join(cwd, "nope"))).toBe(false); // no mkdir happened
		expect(existsSync(join(cwd, ".offbook"))).toBe(false); // and no boot file anywhere

		await Bun.write(join(cwd, "a-file"), "x");
		const file = io();
		expect(await run(["up", "a-file"], file.io)).toBe(1);
		expect(file.err.join("\n")).toContain("is not a directory");
	} finally {
		process.chdir(prevCwd);
		rmSync(cwd, { recursive: true, force: true });
	}
});

// [itest->R-046]
test("up <dir>: projectDir + runDir land under the positional; a later status from the parent resolves to it", async () => {
	const projectDir = await gitSpecProject();
	const parent = dirname(projectDir);
	const dir = basename(projectDir);
	const runDir = join(projectDir, ".offbook");
	const prevCwd = process.cwd();
	const state = mkdtempSync(join(tmpdir(), "offbook-updir-state-"));
	const prevState = process.env.OFFBOOK_STATE_DIR;
	process.env.OFFBOOK_STATE_DIR = state;
	process.chdir(parent); // the flagship flow: up mock from /app
	try {
		const x = io();
		expect(
			await run(
				["up", dir, "--ci", "--ws-port", "19434", "--tcp-port", "12492", "--ctrl-port", "19435"],
				x.io,
			),
		).toBe(0);
		expect(existsSync(join(parent, ".offbook"))).toBe(false); // never a second runDir at the launch cwd
		const boot = JSON.parse(
			await Bun.file(join(runDir, "offbook.boot.json")).text(),
		) as { projectDir?: string; config?: { runDir?: string } };
		expect(boot.projectDir).toBe(projectDir);
		expect(boot.config?.runDir).toBe(runDir);
		const identity = (await (
			await fetch("http://localhost:19435/v1/server")
		).json()) as { projectDir: string; runDir: string };
		expect(identity.projectDir).toBe(projectDir);
		// status from the parent: the strict-descendant tiebreak names it
		const s = io();
		expect(await run(["status"], s.io)).toBe(0);
		expect(s.out[0]).toContain(`offbook @ ${projectDir}`);
		expect(await run(["down", "--run-dir", runDir], io().io)).toBe(0);
	} finally {
		process.chdir(prevCwd);
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		process.env.OFFBOOK_STATE_DIR = prevState;
		rmSync(state, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 90_000);
```

Note: `gitSpecProject()` creates its dir under `tmpdir()`; other suite instances under the same parent are invisible here because the state dir is pinned per-test.

- [ ] **Step 2: Run to verify failure.** `up nope` currently exits 1 only after a failed boot attempt (or scaffolds); the positional is ignored — both tests FAIL.

- [ ] **Step 3: Implement.**

`src/cli/index.ts` — imports gain `statSync` (node:fs), `M2` (extend the messages import). In `cmdUp`, take positionals and derive the two paths (replace the current `const runDir = resolve(process.cwd(), runDirOf(values));`):

```ts
	const { values, positionals } = parseFlags(rest, {
		// (existing flag spec unchanged)
	});
	// R-046: `offbook up [dir]` — the project directory positional, default
	// `.`. Preflight FIRST: refuse before any mkdir, boot-file, or
	// registration write.
	const projectDir = resolve(process.cwd(), positionals[0] ?? ".");
	if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
		io.err(M2(projectDir));
		return 1;
	}
	// default runDir lives under the PROJECT dir; explicit --run-dir stays
	// cwd-relative (§1a, D-032)
	const runDir =
		values["run-dir"] !== undefined
			? resolve(process.cwd(), str(values["run-dir"]) ?? "")
			: join(projectDir, DEFAULT_CONFIG.runDir);
```

Then: `boot.projectDir` becomes `projectDir` (was `process.cwd()`), and the EI2 fresh-project check's `handlersDir` becomes `join(projectDir, "handlers")` (was `process.cwd()`).

`USAGE`: the up line becomes:

```
  up [dir] [--ci] [--strict] [--watch] [--seed n] [--ws-port n] [--tcp-port n] [--ctrl-port n] [--env e]
```

`src/cli/boot.ts` — the no-services hint names the directory `offbook init` must target:

Old:
```ts
			`no services.yaml in ${opts.projectDir} — run \`offbook init\` (or \`offbook demo\` for the bundled spec)`,
```
New:
```ts
			`no services.yaml in ${opts.projectDir} — run \`offbook init ${opts.projectDir}\` (or \`offbook demo\` for the bundled spec)`,
```

- [ ] **Step 4: Run tests.** `bun test test/instance-discovery.test.ts` — green. Full `bun test` — green (the hermetic failed-boot test's marker `server failed to start` is unaffected; its cwd IS a directory).

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/boot.ts test/instance-discovery.test.ts
git commit -m "feat: offbook up [dir] - start a project's instance without cd (R-046)"
```

---

### Task 20: The state-table checklist suite

The spec's Testing section wants the 10-row table auditable as a checklist. Most rows earned their pins inside Tasks 10–19; this task adds the uncovered facets — rows 2/7/10 machine-wide plus the `--watch` respawn token-constancy pin — and the row→test map.

**Files:**
- Test: `test/instance-discovery.test.ts`

- [ ] **Step 1: Add the row→test map** as a comment near the top of `test/instance-discovery.test.ts`:

```ts
// State-table checklist (spec "The instance state table") — where each row
// is pinned:
//   row 1  cwd+token       src/cli/resolve.test.ts "row 1" + the up-bakes-identity test here
//   row 2  cwd+legacy      src/cli/resolve.test.ts "row 2" + "row 2 machine-wide" here
//   row 3  cwd+silent      src/cli/resolve.test.ts "row 3" + cli-dispatch M12 test
//   row 4  cwd wrong-token src/cli/resolve.test.ts "row 4"
//   row 5  cwd dead pid    src/cli/resolve.test.ts "row 5"
//   row 6  pointer+token   src/cli/resolve.test.ts "rows 6-8" + verb-policy tests in cli-dispatch
//   row 7  pointer skipped "rows 6-8" (silent) + "row 7 wrong-token pointer" here
//   row 8  pointer dead    "rows 6-8" (reap)
//   row 9  runfile missing src/cli/resolve.test.ts "row 9" (both branches)
//   row 10 foreign host    src/cli/resolve.test.ts (explicit path) + "row 10 foreign pointer" here
```

- [ ] **Step 2: Write the row tests + the respawn pin** (the three row tests should pass immediately if Tasks 10–11 are correct — treat a failure as a real bug, not a test bug; the respawn test exercises Task 7/9/19 machinery end to end):

```ts
// [itest->R-045]
test("row 7: a pointer-found wrong-token instance is skipped and disclosed, never silence, never touched", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-row7-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-row7-cwd-"));
	const state = mkdtempSync(join(tmpdir(), "offbook-row7-state-"));
	const runDir = join(proj, ".offbook");
	const { writeRunfile } = await import("#src/cli/runfile.ts");
	await writeRunfile(
		runDir,
		{
			pid: process.pid,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 19436,
			startedAt: "t",
			token: "e1".repeat(16),
			host: hostname(),
		},
		{ stateDir: state },
	);
	// the port answers as a DIFFERENT offbook (token mismatch)
	const identity = {
		pid: process.pid,
		token: "e2".repeat(16),
		host: hostname(),
		projectDir: "/somewhere/else",
		runDir: "/somewhere/else/.offbook",
		startedAt: "t",
		demo: false,
		ports: { brokerWsPort: 1, brokerTcpPort: 2, controlPlanePort: 19436 },
	};
	const server = Bun.serve({
		port: 19436,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/server"
				? Response.json(identity)
				: new Response("nope", { status: 404 }),
	});
	try {
		const { resolveInstance } = await import("#src/cli/resolve.ts");
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved).toBeUndefined();
		expect(res.skipped.map((s) => s.reason)).toEqual(["wrong-token"]);
		const { pointerPath } = await import("#src/cli/registry.ts");
		expect(existsSync(pointerPath(state, runDir))).toBe(true); // kept
		expect(existsSync(join(runDir, "offbook.run"))).toBe(true); // kept
	} finally {
		server.stop(true);
		for (const d of [proj, cwd, state]) rmSync(d, { recursive: true, force: true });
	}
});

// [itest->R-045]
test("row 10: a foreign-host pointer is inert — never a candidate, never reaped", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-row10-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-row10-cwd-"));
	const state = mkdtempSync(join(tmpdir(), "offbook-row10-state-"));
	// hand-write a pointer claiming another machine (its runDir does not
	// even exist here — exactly the shared-network-home shape)
	const { canonicalPath } = await import("#src/cli/registry.ts");
	const foreignRun = canonicalPath(join(proj, "gone", ".offbook"));
	const { createHash } = await import("node:crypto");
	const name = `${createHash("sha256").update(foreignRun).digest("hex")}.json`;
	mkdirSync(join(state, "instances"), { recursive: true });
	await Bun.write(
		join(state, "instances", name),
		JSON.stringify({ v: 1, runDir: foreignRun, host: "some-other-machine" }),
	);
	const { resolveInstance } = await import("#src/cli/resolve.ts");
	const res = await resolveInstance({ cwd, stateDir: state });
	expect(res.resolved).toBeUndefined();
	expect(res.foreignSeen).toBe(true);
	expect(existsSync(join(state, "instances", name))).toBe(true); // never reaped
	for (const d of [proj, cwd, state]) rmSync(d, { recursive: true, force: true });
});

// [itest->R-045]
test("row 2 machine-wide: a legacy instance discovered via pointer surfaces as skipped (M13), never silence", async () => {
	const proj = mkdtempSync(join(tmpdir(), "offbook-row2mw-"));
	const cwd = mkdtempSync(join(tmpdir(), "offbook-row2mw-cwd-"));
	const state = mkdtempSync(join(tmpdir(), "offbook-row2mw-state-"));
	const runDir = join(proj, ".offbook");
	const { writeRunfile } = await import("#src/cli/runfile.ts");
	await writeRunfile(
		runDir,
		{
			pid: process.pid,
			brokerWsPort: 1,
			brokerTcpPort: 2,
			controlPlanePort: 19437,
			startedAt: "t",
		},
		{ stateDir: state },
	);
	const legacy = Bun.serve({
		port: 19437,
		fetch: (req) =>
			new URL(req.url).pathname === "/v1/mode"
				? Response.json({ mode: "autonomous" })
				: new Response("nope", { status: 404 }),
	});
	try {
		const { resolveInstance } = await import("#src/cli/resolve.ts");
		const res = await resolveInstance({ cwd, stateDir: state });
		expect(res.resolved).toBeUndefined(); // legacy proves nothing machine-wide
		expect(res.skipped).toHaveLength(1); // ...but is DISCLOSED, not silent
	} finally {
		legacy.stop(true);
		for (const d of [proj, cwd, state]) rmSync(d, { recursive: true, force: true });
	}
});

// [itest->R-044] — the launch-token granularity, pinned end to end: the
// token is the LINEAGE's (constant across --watch respawns), the pid the
// incarnation's; absolute boot-file paths keep the respawn correct even
// after the launch cwd is deleted out from under it
test("--watch respawn with the launch cwd deleted: same token, new pid, correct runfile", async () => {
	const projectDir = await gitSpecProject();
	mkdirSync(join(projectDir, "handlers"), { recursive: true }); // must exist at boot for the watcher
	const runDir = join(projectDir, ".offbook");
	const launchCwd = mkdtempSync(join(tmpdir(), "offbook-respawn-cwd-"));
	const state = mkdtempSync(join(tmpdir(), "offbook-respawn-state-"));
	const prevState = process.env.OFFBOOK_STATE_DIR;
	const prevCwd = process.cwd();
	process.env.OFFBOOK_STATE_DIR = state;
	process.chdir(launchCwd);
	try {
		expect(
			await run(
				["up", projectDir, "--watch", "--ws-port", "19438", "--tcp-port", "12493", "--ctrl-port", "19439"],
				io().io,
			),
		).toBe(0);
		const first = await readRunfile(runDir);
		const token = first?.token;
		expect(token).toMatch(/^[0-9a-f]{32}$/);
		// delete the launch cwd out from under the running server
		process.chdir(projectDir);
		rmSync(launchCwd, { recursive: true, force: true });
		// a handlers/ change forces the whole-process respawn (EH1)
		await Bun.write(join(projectDir, "handlers", "touch.ts"), "export {};\n");
		const deadline = Date.now() + 30_000;
		let second = await readRunfile(runDir);
		while (
			(second === undefined || second.pid === first?.pid) &&
			Date.now() < deadline
		) {
			await Bun.sleep(300);
			second = await readRunfile(runDir);
		}
		expect(second?.pid).not.toBe(first?.pid); // new incarnation
		expect(second?.token).toBe(token); // same lineage
		// the respawned server answers /v1/server with the SAME token
		const answered = { token: "", pid: 0 };
		const deadline2 = Date.now() + 30_000;
		while (Date.now() < deadline2) {
			try {
				const id = (await (
					await fetch("http://localhost:19439/v1/server")
				).json()) as { token: string; pid: number };
				if (id.pid === second?.pid) {
					answered.token = id.token;
					answered.pid = id.pid;
					break;
				}
			} catch {}
			await Bun.sleep(300);
		}
		expect(answered.token).toBe(token as string);
		expect(answered.pid).toBe(second?.pid as number);
	} finally {
		process.chdir(prevCwd);
		await run(["down", "--run-dir", runDir], { out: () => {}, err: () => {} });
		const leftover = await readRunfile(runDir);
		if (leftover) {
			try {
				process.kill(leftover.pid, "SIGKILL");
			} catch {}
		}
		if (prevState === undefined) delete process.env.OFFBOOK_STATE_DIR;
		else process.env.OFFBOOK_STATE_DIR = prevState;
		rmSync(state, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 120_000);
```

(Prefer static imports at the top of the file over the inline `await import(...)` calls above — hoist them when writing the file: `writeRunfile`, `resolveInstance`, `pointerPath`, `canonicalPath`, `createHash`, plus `hostname` (node:os) and `mkdirSync` (node:fs) which the row-7/row-10/respawn tests use.)

- [ ] **Step 3: Run.** `bun test test/instance-discovery.test.ts` — all green. If a row test fails, the resolver has a real defect: fix `src/cli/resolve.ts`, not the test.

- [ ] **Step 4: Commit**

```bash
git add test/instance-discovery.test.ts
git commit -m "test: state-table checklist rows 2/7/10 + the watch-respawn token-constancy pin (R-044, R-045)"
```

---

### Task 21: The derived-docs sweep

Contracts already changed (Task 1); this sweep updates the derived docs (contracts > guides > skill). Grep-driven: run each grep, fix every live-doc hit, leave `docs/archive/` and `docs/superpowers/` untouched (historical records).

**Files:**
- Modify: `docs/guides/daily-loop.md`, `docs/guides/getting-started.md`, `docs/guides/wiring-your-service.md`, `README.md`, `docs/specs/adoption.md`, `skills/offbook-onboard/SKILL.md`, `docs/archive/intake/2026-08-12-first-light-acceptance-fixes.md` (one closure line)

- [ ] **Step 1: Run the sweep greps and capture the hit list** (paste the output into the Task 22 D-032 appendix):

```bash
grep -rn "cd mock\|in that project's directory\|in this run-dir\|resolve it identically\|refuses without a live" docs/guides README.md docs/specs skills src --include="*.md" --include="*.ts"
```

- [ ] **Step 2: `docs/guides/daily-loop.md`.**

The package-script lines (lines ~14–15):
Old: `"mock:up": "cd mock && offbook up",` / `"mock:down": "cd mock && offbook down"`
New: `"mock:up": "offbook up mock",` / `"mock:down": "offbook down"`

After the paragraph ending `…what's running and on which ports.` (~line 22), insert the user model verbatim plus the migration sentence:

```markdown
Management verbs find the running offbook anywhere on this machine; if more
than one is running, offbook lists them and asks you to pick with
`--run-dir`. `--run-dir` and `--ctrl-port` always pin exactly.

(Instances started before this offbook build stay invisible to machine-wide
discovery until restarted, or managed once from their own directory;
`offbook doctor` notes them.)
```

After the CI recipe block (~line 43), add the scripted-consumer line:

```markdown
Scripts and CI that must pin one instance pass `--run-dir mock/.offbook` on
every verb — pinned addressing behaves identically on every offbook build.
```

- [ ] **Step 3: `docs/guides/getting-started.md`.** Line ~11 (`offbook status`, `offbook logs`, `offbook down` all work on it`): append ` — from any directory on this machine`. Leave the `mkdir my-mock && cd my-mock` + `offbook init` example (init stays cwd-scoped; the sweep drops `cd` only around management verbs). In the prose paragraph directly AFTER the init fence (there is no `offbook up` mention there — anchor on the paragraph that names init's scaffold and hands off to the wiring guide), append the user model + migration sentences:

```markdown
Management verbs find the running offbook anywhere on this machine; if more
than one is running, offbook lists them and asks you to pick with
`--run-dir`. `--run-dir` and `--ctrl-port` always pin exactly. (Instances
started before this offbook build stay invisible to machine-wide discovery
until restarted, or managed once from their own directory; `offbook doctor`
notes them.)
```

- [ ] **Step 4: `docs/guides/wiring-your-service.md`.** In section 4 (`## 4. First \`offbook up\``), after the ```sh fence with `offbook up` / `offbook topics`, add:

```markdown
(From the app repo root: `offbook up mock`. Management verbs find the
running offbook anywhere on this machine; if more than one is running,
offbook lists them and asks you to pick with `--run-dir` — `--run-dir` and
`--ctrl-port` always pin exactly. Instances started before this offbook
build stay invisible to machine-wide discovery until restarted, or managed
once from their own directory; `offbook doctor` notes them.)
```

The first-light section's bare `offbook status` / `offbook logs` now work from anywhere; no change needed beyond removing any "in the mock directory" phrasing if present (grep `directory` in this file and reword hits that imply cwd for management verbs).

- [ ] **Step 5: `README.md`.** Line ~53: `Done? Ctrl-C the demo-app, then \`offbook down\`.` → `Done? Ctrl-C the demo-app, then \`offbook down\` (works from any directory).` In the "your own service" block (~60–64), after `offbook up` add a line comment `# management verbs (status/down/logs/topics…) then work from any directory on this machine`. After that block, add the user model + migration prose:

```markdown
Management verbs find the running offbook anywhere on this machine; if more
than one is running, offbook lists them and asks you to pick with
`--run-dir`. `--run-dir` and `--ctrl-port` always pin exactly. (Instances
started before this build stay invisible to machine-wide discovery until
restarted, or managed once from their own directory; `offbook doctor` notes
them.)
```

Do NOT touch the quickstart fence commands themselves (the executable README gate re-runs them verbatim plus flags).

- [ ] **Step 6: `docs/specs/adoption.md`.**

§10 attribution (line ~225) — rewrite the quoted message and the parenthetical: the attribution now has two tiers. Replace the sentence carrying `"another offbook owns the control port \`<n>\`; also busy: …"` and `no guess at which offbook instance it is` with:

```markdown
the message claims only what was verified: when the port's owner PROVES its identity (its served claim matches its own run records — D-032), the attribution names it: "another offbook owns the control port `<n>` (started in `<projectDir>`) — `offbook down --run-dir <runDir>` stops it from anywhere on this machine" (demo-marked when it is the bundled demo; the "also busy" clause appears only when ws/tcp are busy too). An offbook-shaped answer that cannot prove identity (a pre-D-032 build) keeps the pre-D-032 wording — "`offbook down` in that project's directory frees the control port" — and still guesses at nothing. Only when ctrl is free (ws/tcp busy alone) does the generic foreign-process message stand — a stated fallback, not a gap.
```

§10 staleness (line ~229): replace `resolves the run dir as every client verb does (runfile)` with `resolves its instance as every management verb does (the D-032 cwd-then-registry resolution) and reads the RESOLVED instance's boot record`.

§10 topics refusal (line ~230): replace the pinned wording sentence with:

```markdown
**`offbook topics --json` with no resolvable instance refuses** (exit 1; one stdout envelope `{ "error": { "code": "not-running", … } }` carrying the `offbook is not running` wording) instead of silently returning the bundled demo spec, and **a discovered instance that IS the bundled demo also refuses** (`demo-only`, exit 1) — an agent must never mistake demo topics for ingestion. The rationale survives D-032 inverted: pre-D-032 the qualifier was "not here"; now that discovery is machine-wide, a refusal means nothing of yours is running anywhere on this machine. Accordingly the §9 skill's step 6 mandates the `--json` form pinned with `--run-dir mock/.offbook`, so "refusal means `up` failed" stays exactly true. (D-032 release note: this refusal's wording/envelope is a breaking automation surface; scripted consumers pin with `--run-dir`.)
```

§9 step 6 (line ~199): replace the parenthetical `(the \`--json\` form is mandatory here — it refuses without a live server rather than falling back to the bundled demo, §10)` with `(the \`--json --run-dir mock/.offbook\` form is mandatory here — pinned, it refuses unless THIS mock serves, so a refusal means \`up\` failed, §10)`.

(The `<!-- anchor: R-047 -->` line above §10 already exists — Task 1 placed it so R-047's COVERS resolved from the first commit.)

- [ ] **Step 7: `skills/offbook-onboard/SKILL.md`.**

Step 5 (~lines 57–59):
Old: `` `"mock:up": "cd mock && offbook up"`, `"mock:down": "cd mock && offbook down"`. ``
New: `` `"mock:up": "offbook up mock"`, `"mock:down": "offbook down"`. ``

Step 6 opening (~lines 60–64):
Old:
```
6. **First light.** `cd mock && offbook up`. Confirm ingestion with
   `offbook topics --json` — keep the `--json`: it refuses if no server is
   running here (bare `topics` falls back to the bundled demo spec behind
   a printed note), and that refusal means `up` failed; read its output.
```
New:
```
6. **First light.** `offbook up mock` (from the app repo root). Confirm
   ingestion with `offbook topics --json --run-dir mock/.offbook` — keep
   the `--json` and the `--run-dir`: pinned to this mock, it refuses unless
   THIS instance serves (bare `topics` falls back to the bundled demo spec
   behind a printed note), so a refusal means `up` failed; read its output.
```

Step 6 log check (~lines 64–73): change `offbook logs` to `offbook logs --run-dir mock/.offbook` (so a stray root-level log can never feed the agent stale connect lines); `offbook status` may stay bare (discovery resolves it) — leave it.

Port-conflict recipe (~lines 90–94):
Old (the quoted message): `"another offbook owns the control port \`<n>\`; also busy: \`<other labels>\` — \`offbook down\` in that project's directory frees the control port; check the others separately if they persist"`
New: `"another offbook owns the control port \`<n>\` (started in \`<projectDir>\`) — \`offbook down --run-dir <runDir>\` stops it from anywhere on this machine" — run the pasted command; when the owner is an older offbook build the message instead says "\`offbook down\` in that project's directory frees the control port"`.

- [ ] **Step 8: Close the archived finding.** In `docs/archive/intake/2026-08-12-first-light-acceptance-fixes.md`, find the Addendum's "undocumented cwd premise" item and append on its resolution line (or directly under it): `→ Resolved by D-032 / R-044–R-047 (2026-08-19, instance discovery).`

- [ ] **Step 9: Verify.**

Run: `bun scripts/check-docs.ts` — exit 0 (link checks, skill checks, anchors).
Run: `bun test test/readme-quickstart.test.ts test/guides-cookbook.test.ts` then full `bun test` — the executable doc gates still pass (command lines were not changed, only prose).
Run the Step 1 grep again — remaining hits must be only `docs/archive/` + `docs/superpowers/` (historical) and the M3 legacy-fallback wording in `src/cli/index.ts`/`src/cli/doctor.ts`/tests (deliberate, pre-D-032 attributions).

- [ ] **Step 10: Commit**

```bash
git add docs/guides README.md docs/specs/adoption.md skills/offbook-onboard/SKILL.md docs/archive/intake/2026-08-12-first-light-acceptance-fixes.md
git commit -m "docs: the manage-from-anywhere sweep - guides, README, adoption surface, onboarding skill (R-047)"
```

---

### Task 22: Gates, mutation scope, lifecycle flips, intake resolution

**Files:**
- Modify: `stryker.conf.json`, `REQUIREMENTS.md`, `DECISIONS.md`, `AGENTS.md`
- Move: `docs/intake/2026-08-19-instance-discovery.md` → `docs/archive/intake/`

- [ ] **Step 1: Extend the mutation scope.** In `stryker.conf.json`:

```json
	"mutate": [
		"src/engine/**/*.ts",
		"!src/engine/**/*.test.ts",
		"src/cli/runfile.ts",
		"src/cli/registry.ts",
		"src/cli/resolve.ts",
		"src/cli/guard.ts"
	],
```

Then verify the preload interplay: `grep -rn "bunfig" node_modules/@hughescr/stryker-bun-runner/dist/ | head` — confirm what the runner's bunfig sanitization rewrites. If it drops the `preload` key for child runs, confirm the new-module unit tests are env-independent (they all pass explicit `stateDir` scratch dirs — `grep -n "OFFBOOK_STATE_DIR" src/cli/*.test.ts` should show no reliance in `registry.test.ts`/`resolve.test.ts`/`guard.test.ts`/`runfile.test.ts` beyond restoring env), and note the finding in the D-032 appendix.

- [ ] **Step 2: Flip the requirement lifecycles.** In `REQUIREMENTS.md`:
- R-044 → `**STATUS**: tested` plus:
  `**IMPL**: src/model/index.ts, src/cli/runfile.ts, src/control-plane/index.ts, src/compose/index.ts, src/cli/serve.ts, src/cli/boot.ts, src/cli/index.ts`
  `**TEST**: src/cli/runfile.test.ts, src/control-plane/index.test.ts, src/cli/resolve.test.ts, test/instance-discovery.test.ts`
- R-045 → `**STATUS**: tested` plus:
  `**IMPL**: src/cli/registry.ts, src/cli/guard.ts, src/cli/messages.ts, src/cli/resolve.ts, src/cli/runfile.ts, src/cli/index.ts, src/cli/client.ts, src/cli/doctor.ts, test/preload.ts`
  `**TEST**: src/cli/registry.test.ts, src/cli/guard.test.ts, src/cli/messages.test.ts, src/cli/resolve.test.ts, src/cli/doctor.test.ts, test/cli-dispatch.test.ts, test/instance-discovery.test.ts`
- R-046 → `**STATUS**: tested` plus:
  `**IMPL**: src/cli/index.ts, src/cli/boot.ts`
  `**TEST**: test/instance-discovery.test.ts`
- R-047 → `**STATUS**: built` plus:
  `**IMPL**: docs/guides/daily-loop.md, docs/guides/getting-started.md, docs/guides/wiring-your-service.md, README.md, docs/specs/adoption.md, skills/offbook-onboard/SKILL.md`

(The checker demands an arrow tag per UID in every listed TEST file — Tasks 2–20 placed them; `bun scripts/check-docs.ts` verifies both directions.)

- [ ] **Step 3: Append the D-032 appendix.** In the D-032 entry, extend **Obligations** in place: mark obligation (2) discharged by appending `— discharged 2026-08-19: <paste the Task 21 Step 1 grep command + its live-doc hit list, one line per hit>`; append the Step 1 preload-interplay finding as one sentence.

- [ ] **Step 4: Resolve the intake round.** In `docs/intake/2026-08-19-instance-discovery.md`: flip `**Status**: open` → `**Status**: resolved`, then `git mv docs/intake/2026-08-19-instance-discovery.md docs/archive/intake/2026-08-19-instance-discovery.md` (the checker errors on a resolved file still in `docs/intake/`).

- [ ] **Step 5: Update `AGENTS.md` (Status & next).** Append to the status paragraph:

```
Instance discovery is `tested` (R-044–R-046, D-032; R-047 `built`): management verbs resolve cwd-first then a machine-local pointer registry with token-based identity (`GET /v1/server`), `up [dir]` starts a project's instance without cd, refusals print paste-ready `--run-dir` selector tables (exit 2), and the docs sweep dropped the cwd premise from the guides and the onboarding skill. The mutate scope now covers `src/cli/{runfile,registry,resolve,guard}.ts`; the focused full campaign on those modules is a D-032 obligation before engine PRs resume relying on the changed-file gate there.
```

- [ ] **Step 6: The full gate set, in CI order.**

```bash
bun scripts/check-docs.ts   # exit 0
bunx biome check .          # exit 0
bun run typecheck           # exit 0
bun run demo-app:build      # exit 0
bun test                    # exit 0 — THE gate; judge by exit code only
```

- [ ] **Step 7: The mutation campaign (D-032 obligation).** Manual, long-running — run it now if the session allows, otherwise it stays a recorded obligation:

```bash
nvm use default   # Stryker's CLI process needs Node >= 20 on PATH
bun run mutate
```

Record the mutation score for the four new modules in the D-032 appendix; kill any surviving mutants in `guard.ts`/`registry.ts`/`resolve.ts`/`runfile.ts` with targeted tests before closing the round.

- [ ] **Step 8: Commit**

```bash
git add stryker.conf.json REQUIREMENTS.md DECISIONS.md AGENTS.md docs/archive/intake/2026-08-19-instance-discovery.md
git rm --cached docs/intake/2026-08-19-instance-discovery.md 2>/dev/null || true
git commit -m "docs: close the D-032 round - lifecycle flips, mutation scope, intake archived"
```

(If `git mv` already staged the move, the `git rm --cached` is a no-op.)

---

## Execution notes

- **Task order is dependency order** — do not reorder. Tasks 7+9 are the one deliberate breakage window (serve demands a token before up bakes one); if your run shows real cross-task breakage there, squash their commits.
- **Wording discipline**: when a test fails on a string, the catalog (`src/cli/messages.ts`) wins over both the test and your memory of the spec. If the catalog and the spec's table disagree, the spec wins — fix the catalog and say so.
- **Never bind port 9080 in tests** (a developer's real offbook may own it); the self-heal default probe is reached via `selfHealProbePort` injection only.
- **Cleanup invariants for every test that boots a real server**: restore cwd in `finally`, SIGKILL any leftover runfile pid, remove scratch dirs, and never leave a pointer in a shared state dir (pin `OFFBOOK_STATE_DIR` per-test when asserting on scans).
- The archived plans and intake files under `docs/archive/` and `docs/superpowers/` quoting old wordings are historical records — never swept.
