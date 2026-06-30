---
type: handoff
status: open
summary: Running-server observability — log destination, logs, watch, status (EO1–EO4).
folds-into: [offbook-design]
---

# Offbook — Running-Server Observability (Handoff)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (**canonical** — conflict rule: the contract wins; fix other docs to match), `offbook-design.md` (§9 CLI surface + moments 2/3, §8 credential logging), `offbook-l2-scenarios.md` (§8 hot-reload). **Originating review:** end-user ergonomics pass (2026-06-29). **Sibling handoffs:** `offbook-ergonomics-cli-rendering.md` (EO3 reuses ER2), and the other `offbook-ergonomics-*.md` area docs.

**Status:** **Open** — 4 interlocking items. `offbook up` detaches the server (`offbook-contracts.md` §5, line ~313) but nothing says where its output goes or how a dev sees what it's doing. The four items form one cohesive feature — *observe the running detached server* — and are interdependent (the log commands need the log destination first), so resolve them as one unit/PR. Mostly `cli/` + a startup wiring choice; no contract type changes (EO3 reuses the existing `?sinceSeq=`).

**Why this exists.** A detached server whose stdout/stderr has no documented home turns §8's credential-attribution logging and `offbook-l2-scenarios.md` §8's "surface what changed + any new errors **loudly**" into output written to nowhere. The CLI also has no tail (`offbook logs`), no live validation/diagnostics follow, and no one-shot status overview — so the daily-driver and debugging moments fly blind between explicit pulls.

**How to use this doc.**
1. Start with EO1 (the others depend on it).
2. Make each **Decision owed**; adopt or override.
3. Resolve in `cli/` + the `offbook up` wiring.
4. Verify against **Acceptance**.
5. Tick `Status` and add a **Decision log** row.

> **Line numbers are anchors as-of the working tree at HEAD `cadd8a0` (2026-06-29) and drift once edits land.** Anchor by `§N` / heading; line numbers are hints.

---

## Summary

| ID | Item | Tier | Owner / Lands in | Blocks? |
|---|---|---|---|---|
| EO1 | Detached server has no documented log destination | 1 | cli/ · `offbook up` | EO2 |
| EO2 | No `offbook logs [-f]` to tail the server | 2 | cli/ | — |
| EO3 | `validation`/`diagnostics` are one-shot — no live follow | 2 | cli/ | — |
| EO4 | No `offbook status` overview (running? ports? specs? mode? violations?) | 2 | cli/ | — |

---

## Tier 1 — the prerequisite

### EO1 — `offbook up` detaches the server with no documented log destination
- **Where:** `offbook-contracts.md` §5 process management (line ~313: "spawns the server detached, writes a PID + port runfile"); `offbook-design.md` §8 (lines ~270–272, accept-all auth "still receives and logs" credentials "so connections can be attributed in debugging"); `offbook-l2-scenarios.md` §8 hot-reload ("surface … loudly", line ~145).
- **Problem:** the server is spawned detached, but no doc says where its stdout/stderr (ws connect logs, logged credentials, hot-reload notices, autonomous emissions) is written. "Loud" output from a detached process with no log file is invisible.
- **If unaddressed:** §8's credential attribution and l2's loud hot-reload land nowhere a dev can find; the running server is a black box for moments 2 and 3.
- **Decision owed:** log destination + format — a runfile-adjacent file (e.g. `<runDir>/offbook.log`), text vs JSON-lines, and a size cap/rotation. *Recommend* a text log at a runfile-adjacent path, line/size-capped, path printed by `offbook up`.
- **Recommended resolution:** `offbook up` redirects the detached server's stdout/stderr to `<runDir>/offbook.log` (the runfile dir), text format, size-capped; print the path on startup; `offbook down` leaves the file for post-mortem.
- **Acceptance:** after `offbook up`, the path it printed exists and receives a line for each ws connect (including the logged credentials per §8) and each L2 hot-reload swap.
- **Status:** ☐ open

---

## Tier 2 — the observability commands

### EO2 — no command tails the server log
- **Where:** `offbook-design.md` §9 CLI surface (lines ~295–303 — `up`/`down`/`topics`/`publish`/`state`/`scenario`/`reset`/`mode`/`validation`/`specs update`, no `logs`); depends on EO1.
- **Problem:** with a log file (EO1) there is still no CLI to read or follow it; daily-driver/debugging can't watch connection or emission activity without knowing the file path.
- **If unaddressed:** devs `cat` an undocumented file or fly blind on connection/emission activity.
- **Decision owed:** none — mechanical once EO1 lands.
- **Recommended resolution:** `offbook logs [-f] [-n N]` reads (and with `-f` tails) `<runDir>/offbook.log` resolved from the runfile.
- **Acceptance:** `offbook logs -f` streams new lines as an `mqtt.js` client connects and as autonomous ticks emit; `offbook logs -n 50` prints the last 50 lines and exits.
- **Depends on:** EO1.
- **Status:** ☐ open

### EO3 — `validation` / `diagnostics` are one-shot snapshots with no live follow
- **Where:** `offbook-contracts.md` §5 `GET /v1/validation` (`?sinceSeq=`, line ~266) + `GET /v1/diagnostics` (line ~268); `offbook-design.md` §9 moment-3 (debugging); `offbook-l2-scenarios.md` §8 (hot-reload errors → `/diagnostics`).
- **Problem:** the CLI commands pull a snapshot; the live debugging loop (watching contract breaks) and the live authoring loop (watching scenario-load errors after a save) have no follow mode, and there's no streaming API — the substrate is poll-only.
- **If unaddressed:** a dev debugging breaks or iterating on scenarios re-runs the command in a manual loop, defeating the "tight loop" daily-driver goal.
- **Decision owed:** client-side `--watch` (poll `?sinceSeq=` every N ms) vs a server-side SSE stream. *Recommend client-side `--watch`* — no API change, keeps the existing poll/`sinceSeq` substrate.
- **Recommended resolution:** `offbook validation --watch [--interval 500ms]` polls `?sinceSeq=<last>` and prints new violations via ER2's per-violation renderer as they arrive; same for `offbook diagnostics --watch`.
- **Acceptance:** with `offbook validation --watch` running, a `POST /publish` of an off-contract payload prints the new violation within one interval without re-invoking the command.
- **Relates to:** `offbook-ergonomics-cli-rendering.md` ER2 (shared renderer).
- **Status:** ☐ open

### EO4 — no `offbook status` overview
- **Where:** `offbook-contracts.md` §5 `GET /v1/mode` (line ~269), `GET /v1/specs` (`resolutionMode`, line ~267), `GET /v1/validation` `summary` (line ~266); runfile (line ~313).
- **Problem:** "is it running, on which ports, which specs at which SHAs, what mode, how many violations" requires stitching the runfile + three endpoints; there's no single overview command.
- **If unaddressed:** the most common daily question — "what is my mock doing right now?" — has no one-shot answer.
- **Decision owed:** none — mechanical (compose existing reads + the runfile).
- **Recommended resolution:** `offbook status` reads the runfile + `/mode` + `/specs` + `/validation` summary and prints:
  ```
  offbook ● running   pid 4821   ws :9001   ctrl :9080
  mode: passive   seed: 1
  specs (branch ⚠): serviceC @ a1b2c3d (3 channels)   serviceB @ 9f2c3a1 (dev)
  validation: 0 errors, 2 warnings   (oldestSeq 1)
  ```
  On a stopped server (no live control plane) print `not running` and exit nonzero.
- **Acceptance:** `offbook status` on a running server prints ports, mode, seed, each service's `resolutionMode` + short-sha + channel count, and the violation summary; on a stopped server prints "not running" with a nonzero exit.
- **Status:** ☐ open

---

## Cross-cutting note

EO1 is the keystone — EO2 can't tail a log that has no home. EO3 and EO4 are independent of EO1 (they read the control plane, not the log) and can proceed in parallel; EO3 should reuse ER2's renderer (`offbook-ergonomics-cli-rendering.md`). Highest-leverage first step: EO1, since it also unblocks §8's credential logging and l2 §8's "loud" hot-reload actually being seen.

## Decision log

*(Append one row per resolved item: ID · decision taken · file(s) patched · resolver · date.)*

| ID | Decision taken | File(s) patched | Resolver | Date |
|---|---|---|---|---|
| | | | | |
