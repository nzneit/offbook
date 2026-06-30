---
type: handoff
status: open
summary: L3 handler hot-reload parity decision (EH1).
folds-into: [offbook-l2-scenarios, offbook-design]
---

# Offbook — L3 Handler Hot-Reload Parity (Handoff)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (**canonical** — conflict rule: the contract wins; fix other docs to match), `offbook-l2-scenarios.md` (§8 hot-reload), `offbook-design.md` (§9 moment-2), `offbook-build-gaps-2.md` (F19 lazy resolve-at-dispatch). **Originating review:** end-user ergonomics pass (2026-06-29). **Sibling handoffs:** the other `offbook-ergonomics-*.md` area docs.

**Status:** **Open** — 1 item, but it carries a genuine decision (reach parity vs make the asymmetry honest). Atomic/isolated to `engine/` L3 loading + a doc/CLI note. One PR once the decision is made.

**Why this exists.** L2 scenarios hot-reload (`offbook-l2-scenarios.md` §8), giving the daily-driver a tight authoring loop. Whether editing an L3 handler `.ts` does the same is unspecified: `reset` "re-instantiates L3 handlers" (`offbook-contracts.md` §5, line ~306) — that re-runs handler *state*, not changed *code*. So the two authoring layers likely have different inner loops (L2 live, L3 restart), and a dev editing a handler can silently run stale code.

**How to use this doc.**
1. Read the item; make the **Decision owed** (a real fork).
2. Adopt or override the **Recommended resolution** for the chosen branch.
3. Resolve in `engine/` (+ docs/CLI note).
4. Verify against the **Acceptance** for the chosen branch.
5. Tick `Status` and add a **Decision log** row.

> **Line numbers are anchors as-of the working tree at HEAD `cadd8a0` (2026-06-29) and drift once edits land.** Anchor by `§N` / heading; line numbers are hints.

---

## Summary

| ID | Item | Tier | Owner / Lands in | Blocks? |
|---|---|---|---|---|
| EH1 | L3 code hot-reload is unspecified — asymmetric, surprising inner loop vs L2 | 1 | engine/ · contracts §5 · l2 §8 | — |

---

## Tier 1 — the authoring inner loop

### EH1 — editing an L3 handler may silently run stale code (no specified hot-reload)
- **Where:** `offbook-l2-scenarios.md` §8 (lines ~145–146, L2 hot-reload, autonomous-mode-only); `offbook-contracts.md` §5 `POST /v1/reset` ("re-instantiates L3 handlers", line ~306 — state, not code); build-plan `engine/` Tier 2 (line ~79: L3 discovered via glob `handlers/**/*.ts`, each `register(pattern, factory)` on import); `offbook-design.md` §9 moment-2 (hot iteration on behavior).
- **Problem:** L2 scenarios re-glob/re-validate/atomic-swap on file change; whether an edited `handlers/**/*.ts` module is re-imported and re-registered is undefined. `reset` re-instantiates handler *state* but does not re-import changed *modules*. The result is two different inner loops for the two authoring layers — and a dev who edits a handler and hits `reset` may be surprised the change didn't take.
- **If unaddressed:** a dev iterating on an L3 handler either runs stale code after saving (no reload) or wrongly assumes `reset` picks up code edits — a confusing, asymmetric daily-driver loop that undercuts moment-2's "fast iteration on behavior."
- **Decision owed:** the genuine fork —
  - **(a) Parity:** hot-reload L3 modules too — watch `handlers/**/*.ts`, re-import changed modules, clear their `register` entries, re-run registration, surface the swap loudly (mirroring l2 §8); autonomous-mode-only, frozen under `passive` like the scenario set.
  - **(b) Honest asymmetry:** declare L3 reload-on-restart-only and make it explicit in the `reset`/`up` output and docs.
  *Recommend (a) if Bun module re-import is clean enough to be reliable; otherwise (b) made loud rather than silent.*
- **Recommended resolution:**
  - **If (a):** the engine's `handlers/` watcher re-imports changed modules, resets the `register` table, re-runs registration, and emits a loud swap notice like l2 §8. Reuse F19 (lazy resolve-at-dispatch against the *current* registry) so re-registration needs no spec reload and survives a `specs/refresh`. Freeze the watcher in `passive` (parity with the scenario set, contracts §5 / l2 §8) so CI determinism is unaffected.
  - **If (b):** `offbook down && up` is required for L3 code changes; the `reset` response and `offbook reset`/`up` CLI output state plainly `L3 handler code changes require a restart (offbook down && up); L2 scenarios hot-reload`, and the docs (l2 §8, design §9) say so.
- **Acceptance:**
  - **(a):** with the server in `autonomous`, editing a handler's reply payload and saving changes the next dispatch's emission with no `down`/`up`; in `passive`, the same edit does **not** change matching within a CI window (watcher frozen).
  - **(b):** the docs and the `reset`/`up` output explicitly state L3 needs a restart; a test asserts that notice is surfaced, and that editing a handler without restart does not change dispatch.
- **Relates to:** `offbook-build-gaps-2.md` F19 (lazy resolve), F10 (passive freeze for determinism).
- **Status:** ☐ open

---

## Cross-cutting note

Self-contained, but the decision interacts with the determinism gate: whichever branch is chosen, the L3 watcher (if any) must be frozen in `passive` exactly as the L2 scenario set is (l2 §8, build-gaps-2 F10) — otherwise a mid-window re-registration reintroduces the non-determinism `passive` exists to remove.

## Decision log

*(Append one row per resolved item: ID · decision taken · file(s) patched · resolver · date.)*

| ID | Decision taken | File(s) patched | Resolver | Date |
|---|---|---|---|---|
| | | | | |
