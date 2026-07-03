# Offbook — CI Synchronous Drain / Quiescence (Handoff)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (**canonical** — conflict rule: the contract wins; fix other docs to match), `offbook-design.md` (§9 moment-4, §6 virtual/wall split), `offbook-build-gaps-2.md` (F10 determinism gate). **Originating review:** end-user ergonomics pass (2026-06-29). **Sibling handoffs:** the other `offbook-ergonomics-*.md` area docs.

**Status:** **Resolved** (2026-06-30) — decided in dialog: **actions stay prompt-`202`** (honest, uniform — `202` always means "injected"), and a new **`GET /v1/pending`** read carries the quiescence count + a **`?wait[=ms]`** server-side block-to-quiescence (the CLI `--wait` flag wraps it); no `POST /drain`. Folded into contracts §5, design §9, build-plan Tier 3. See the **Decision log**.

**Why this exists.** Actions return `202` *before* the scheduled emissions they cause have drained (`offbook-contracts.md` §5 line ~259: "actions return promptly after injecting (CI polls /state + /validation for effects)"). In the fast-virtual scheduler (`§3`) emits are delivered on the next event-loop task with **no wall delay**, so the engine *can* run the triggered chain to quiescence synchronously — but that capability isn't exposed, leaving every test author to poll-until-stable against a guessed timeout. This is the one moment-4 affordance the otherwise-excellent CI design leaves unbuilt.

**How to use this doc.**
1. Read the item; make the **Decision owed** (the mechanism is a genuine fork).
2. Adopt or override the **Recommended resolution**.
3. Resolve in `engine/` (drain) + `control-plane/` (how it surfaces) + the contracts §5 note.
4. Verify against **Acceptance**.
5. Tick `Status` and add a **Decision log** row.

> **Line numbers are anchors as-of the working tree at HEAD `cadd8a0` (2026-06-29) and drift once edits land.** Anchor by `§N` / heading; line numbers are hints.

---

## Summary

| ID | Item | Tier | Owner / Lands in | Blocks? |
|---|---|---|---|---|
| EC1 | No quiescence signal — moment-4's "synchronous" promise is served only by polling | 1 | engine/ · control-plane/ · contracts §5 | — |

---

## Tier 1 — moment-4 synchronization

### EC1 — actions 202 before their emissions drain; no drain/quiescence signal exists
- **Where:** `offbook-design.md` §9 moment-4 (line ~283: "reset → publish → **wait** → assert"); `offbook-contracts.md` §5 conventions (line ~259) + the CI loop (line ~315); `offbook-contracts.md` §3 fast-virtual scheduler (lines ~140–141: emit delivered on the next event-loop task while logical `now()` advances by the full seeded delay).
- **Problem:** `/publish` and `/trigger` return `202` after *injecting*, not after the consequent scheduled emission chain completes. The only "wait" is "poll `/state` + `/validation`" with no count of pending emits, no drain endpoint, and no sync mode. A multi-step scenario with cumulative virtual delays fires across several event-loop tasks; the test must poll-until-stable and guess how long.
- **If unaddressed:** moment-4's "synchronous" promise is unmet. Every CI/Playwright author re-implements poll-with-backoff and risks flaky assertions that race a not-yet-drained emit chain — the exact non-determinism the determinism gate (build-gaps-2 F10) exists to eliminate, reintroduced at the API edge.
- **Decision owed:** the mechanism —
  - **(a)** in `passive` + `wallClock:false`, make `/publish` & `/trigger` return `202` only after the emissions they cause have drained (a synchronous 202 — there is no wall delay to pay, so this is just running the virtual queue to quiescence);
  - **(b)** add `GET /v1/pending → { scheduled: number }` to poll to zero (works in wall-paced too);
  - **(c)** add `POST /v1/drain` that runs the virtual queue to quiescence and returns.
  *Recommend (a) as the default for the determinism/CI path + (b) as the general signal for the wall-paced path.* (a) is what "synchronous" means; (b) covers the case where real wall delays are deliberately in play.
- **Recommended resolution:**
  ```
  passive + fast-virtual (the CI path): 202 from /publish & /trigger means
    "every emission this action caused has been delivered" — poll /state once, deterministically.
  wall-paced (interactive): poll GET /v1/pending until { scheduled: 0 }.
  ```
  Run-to-completion dispatch (§3) already orders a single event; extend the drain to the whole *triggered chain* under fast-virtual, where no wall time is owed. Document in contracts §5 that the synchronous-202 guarantee holds only in `passive` + `wallClock:false`.
- **Acceptance:** in `passive` mode, `POST /trigger` for a 3-step scenario whose steps have cumulative virtual delays returns `202` only after `GET /state` already reflects all three emits (no second poll, no sleep); a determinism test asserts the post-trigger `/state` is complete without any wait loop. In wall-paced mode, `GET /v1/pending` reports a nonzero `scheduled` between a trigger and its last delayed emit, reaching `0` when drained.
- **Relates to:** `offbook-build-gaps-2.md` F10 (the gate this protects).
- **Status:** ☑ **resolved** (2026-06-30) — chose **explicit settle, not implicit synchronous-202**: `/publish` & `/trigger` keep meaning "injected" in every mode; the settle signal is **`GET /v1/pending`** → `{ scheduled, settled }` (excludes the perpetual `autonomous` tick) with **`?wait[=ms]`** blocking server-side to `scheduled===0`, bounded by the F10 horizon. CLI `--wait` flag wraps it; `POST /drain` dropped (the force-fast-forward is a v2 niche). Folded → contracts §5 (conventions + Reads + CI loop), design §9 (moment-4 + CLI), build-plan Tier 3.

---

## Cross-cutting note

Self-contained — but coordinate with whoever owns the determinism gate (F10): the synchronous-202 guarantee and the gate both assume `passive` + `wallClock:false`, and the gate's "assert `GET /mode == passive`" precondition is the natural place to also assume drained-on-202.

## Decision log

*(Append one row per resolved item: ID · decision taken · file(s) patched · resolver · date.)*

| ID | Decision taken | File(s) patched | Resolver | Date |
|---|---|---|---|---|
| EC1 | Explicit settle over implicit synchronous-202: actions stay prompt-`202` (uniform "injected" semantics); add `GET /v1/pending → { scheduled, settled }` (excludes the autonomous tick) + `?wait[=ms]` server-side block-to-quiescence (F10-bounded); CLI `--wait` wraps it; no `POST /drain` | offbook-contracts.md §5; offbook-design.md §9; offbook-build-plan.md Tier 3 | CodeReviewJoe | 2026-06-30 |
