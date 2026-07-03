# Offbook — v1 Pre-Build PM-Lens Gap Review, Round 4 (Handoff)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (the **canonical** frozen interfaces — the conflict rule applies: if any other doc disagrees on an interface/API detail, the contract wins and the other doc is the bug), `offbook-design.md`, `offbook-build-plan.md`, `offbook-handoff.md`, and the prior rounds `offbook-build-gaps.md` (G1–G25) / `offbook-build-gaps-2.md` (F1–F21, R1–R5) / `offbook-build-gaps-3.md` (S1–S31).

**Status:** **In progress (2026-06-30).** A **product-manager-lens** review — distinct from the engineering/ergonomics audits of rounds 1–3, which examined interface correctness. Five blind lenses (user & value · adoption & onboarding · scope & prioritization · differentiation & positioning · product surface & UX) each swept the live corpus and reported grounded gaps; the findings were synthesized and deduplicated to **nine items, P1–P9**, ranked in three tiers. PM gaps are about *user value, adoption, scope-vs-value, and product UX* — gaps an interface-correctness audit structurally cannot see.

**Convergence is the signal.** Five lenses run blind to each other collided on the same three themes: *stop planning and de-risk* (P1), *the user/persona is undefined* (P3), and *the first-value "aha" is never staged* (P4). Where independent lenses land on one spot, that is the load-bearing gap.

This round **resolved P2–P9** — every actionable PM gap (the Tier-1 product calls through the Tier-3 surface trio), each decided one fork at a time in dialog and folded into the canonical docs. **P1** alone remains — a build-gate (= round-3 S1/S2; run the WS-fidelity + `connect()` spikes, no doc edit closes it).

> **Line numbers / section anchors cited below are as-of HEAD `e19f890` (2026-06-30) and drift once edits land.** Anchor by `§N` / type name / heading.

---

## Summary

| ID | Tier | Item | Disposition |
|---|---|---|---|
| P1 | 1 | Existential WS-fidelity / `connect()` spikes unprobed; planning has outrun building (~52k words, 0 product code) | ☐ **build-gate** — run the spikes before core build (= round-3 S1/S2; design §12.1–2). No doc edit closes it. |
| P2 | 1 | Value silently *inverts* under imperfect specs (false confidence) — no degraded-spec posture | ☑ **resolved** → design §7 (3-mode honesty) + contracts §5/§6 |
| P3 | 1 | Primary user unnamed + "no MQTT knowledge" contradicts human-authored L2/L3 | ☑ **resolved** → design §1/§4/§9 |
| P4 | 2 | No staged first-value "aha"; lead diffuse (3 co-headliners); no dogfoodable milestone | ☑ **resolved** → design §1/§5/§6/§9 + contracts §5 + build-plan §3/§4 + handoff |
| P5 | 2 | v1 over-scoped / mis-sequenced for value (DST engine + `--frozen`/F17 ahead of the lead) | ☑ **resolved** — kept the DST engine in v1 post-M0 (founding pain #2 + moment-4); deferred the `--frozen` reader + F17 to v2 (contracts §6/§7 + design §9/§11 + build-plan) |
| P6 | 2 | Success undefined; "loud" surface invites the alarm fatigue it fears | ☑ **resolved** → design §5 + contracts §5 + build-plan Tier 4 + ergonomics-cli-rendering |
| P7 | 3 | Outer envelope hand-waved — client repoint, up/down lifecycle dead-ends, ports, install path | ☑ **resolved** — connect-print + toggle, defensive lifecycle, 3 port flags, install-from-repo (contracts §5/§1a, design §9, build-plan §2) |
| P8 | 3 | Control-surface holes — no seed CLI handle, no scenario discovery, no one-command CI gate | ☑ **resolved** — `--seed` on up/reset, `GET /scenarios`+`offbook scenarios`, `offbook check` gate, status `/diagnostics` rollup (contracts §5, design §9) |
| P9 | 3 | Positioning — no Glee/Generator dispatch, no MSW/Pact anchors, differentiator not in README | ☑ **resolved** — Glee/Generator dispatch + build-vs-compose (§12.6), MSW/Pact anchors (§1), README "Why Offbook" requirement recorded for the tool repo (build-plan §2) |

---

## Decision log (resolved this round — P2/P3/P4/P6)

*Each: ID · decision(s) taken · file(s) patched · resolver · date. Decided one fork at a time in dialog; P1 (spikes) carries no doc edit.*

| ID | Decision(s) taken | File(s) patched | Resolver | Date |
|---|---|---|---|---|
| P3 | Named the **primary user** = MQTT-naive app developer; **staged the "no MQTT knowledge" promise** (value = L1 floor + automatic validation + discovery with zero authoring; L2/L3 authoring = progressive opt-in tier); named the **spec owner as a dependency persona** (not served/compellable; the tool's correctness rests on its hygiene) with an **opportunistic-use** path | offbook-design.md §1 (new "Who this is for") / §4 / §9 | CodeReviewJoe | 2026-06-30 |
| P2 | **Spec trustworthiness on the content axis** (extended "never lie about fidelity" from version → quality): **Mode 1** spec-load failure = **fatal** (abort `up`, foreground named error, independent of `strict`); **Mode 2** vacuous schema = non-fatal `spec-load` Diagnostic (unambiguous `{}`/`true`/objectless-object shapes only, no grading); **Mode 3** staleness-vs-reality = undetectable → surface spec **provenance/age** (`SpecInfo.fetchedAt`) neutrally + honesty note. **§11 deferral:** graded spec-quality scoring + coverage instrumentation → v2 | offbook-design.md §7/§11; offbook-contracts.md §5 (Diagnostic, `SpecInfo.fetchedAt`, `GET /specs`) + §6 (fatal rule) | CodeReviewJoe | 2026-06-30 |
| P4 | **Validation is the v1 lead** (timing + discovery → *supporting*, not co-headliners); **`offbook demo`** = ephemeral bundled-spec scripted-catch (the run-#1 aha + zero-git on-ramp); explicit **M0 walking-skeleton milestone** (value checkpoint across Tiers 0–3; needs no `ingestion/`). *Refined by the 2026-06-30 grilling → discovery + regression-replication reframed as **floors**, validation a **provisional** lead, and M0 re-pointed to the WS-fidelity harness + `offbook topics` with `offbook demo` demoted to an output (design §1, build-plan §3).* | offbook-design.md §1/§5/§6/§9; offbook-contracts.md §5; offbook-build-plan.md §3/§4; offbook-handoff.md Step 2 | CodeReviewJoe | 2026-06-30 |
| P5 | **Sequencing vs scope, split.** The *sequencing* concern was already resolved by P4's M0 (the DST engine + ingestion + CLI now build *after* the validation lead), so v1 **keeps the DST timing/determinism engine** (founding pain #2 + moment-4 CI). The one *scope* cut: **defer the `up --frozen` by-SHA reader + F17 history-walk to v2** (keep the `specs.lock` *writer* in v1; v1 records `resolved-sha` post-fetch but never reads it back) — reconciling contracts back to design §11 and **resolving a live contract contradiction** (§6 both shipped `--frozen`-by-SHA *and* claimed "v1 only ever hands it a branch tip"). Zero rework: the `Resolver` seam already accepts both ref kinds | offbook-contracts.md §5/§6/§7; offbook-design.md §9/§11; offbook-build-plan.md §2/§3 | CodeReviewJoe | 2026-06-30 |
| P6 | **Validation must earn continued trust:** three **success criteria** (breaks-caught · **false-positive budget = 0** · time-to-first-value) + a **self-scoreboard** (`status` "caught N distinct breaks"); **read-side de-noising** via a `distinct` projection (`ValidationSummary.distinct`, keyed by structural signature) collapsing repeats to `×N` — the raw per-entry log / `seq` / F9 golden / `?sinceSeq=` / CI gate all **untouched** | offbook-design.md §5; offbook-contracts.md §5; offbook-build-plan.md Tier 4; offbook-ergonomics-cli-rendering.md (ER2 note) | CodeReviewJoe | 2026-06-30 |
| P7 | **Adoption envelope (4 forks).** `up`/`status` **print the client connect target** + a documented `MQTT_URL` / `ws://`-on-localhost repoint convention (P7.1); **defensive lifecycle** — port preflight (foreground error), refuse a live double-start, auto-reclaim a stale runfile, idempotent `down`; liveness = pid-alive **and** control-port-answers (P7.2); **three port flags** `--ws-port`/`--tcp-port`/`--ctrl-port` for side-by-side (P7.3); **install-from-repo** (`bunx`/`bun add -d` a git URL) primary, container secondary (P7.4) | offbook-contracts.md §5/§1a; offbook-design.md §9; offbook-build-plan.md §2/Tier 4 | CodeReviewJoe | 2026-06-30 |
| P8 | **Control-surface holes.** `--seed N` on `up`/`reset` (the seed is the **shareable repro token**; `status` already echoes it); **scenario discovery** `GET /v1/scenarios` + `offbook scenarios` (new `ScenarioInfo`); **one-command CI gate** `offbook check` (exits nonzero iff `byOrigin.client > 0` since the last `reset` baseline; `--since` overrides); **`status` gains the `/diagnostics` rollup** so a silently-failed scenario/spec stops reading "0 errors" | offbook-contracts.md §5; offbook-design.md §9; offbook-build-plan.md Tier 4 | CodeReviewJoe | 2026-06-30 |
| P9 | **Positioning (clarifications).** §12.6 gains a **Glee/Generator/Modelina dispatch** (the AsyncAPI-native reach) + a **build-vs-compose** note; §1 gains the **MSW/Pact mental anchors**; DP5 deferred — the README "Why Offbook (vs Microcks/Specmatic/Glee/MSW/Pact)" requirement is **recorded** for the unbuilt tool repo, not written in the design repo | offbook-design.md §1/§12.6; offbook-build-plan.md §2 | CodeReviewJoe | 2026-06-30 |

---

## Notes

- **Method.** Five PM lenses (general-purpose agents) read the live corpus blind to each other; the five lens-reports were synthesized + deduplicated into P1–P9, tiered by product consequence. Each resolved item was then grounded against the live docs (not the synthesis) before folding, per the conflict rule.
- **What the PM lens added.** The engineering/ergonomics rounds (G/F/R/S) hardened the *interfaces*; this round surfaced gaps at the *framing* layer (who/why/proof/success — P2/P3/P6) and the *outer envelope* (get-it-running, get-a-spec-in, witness-a-catch — P4/P7), which interface-correctness audits cannot see. All five lenses independently credited the prior work; this round is additive.
- **P1 dominates.** The single most consequential finding is non-doc: the WS-fidelity + `connect()` spikes (round-3 S1/S2) remain unrun, and planning has outrun building. The strongest next action is to **run the spikes and stand up the M0 walking skeleton** before building the timing/determinism engine and frozen-mode ingestion — i.e. resolve P1, then act on P5.
- **Open frontier.** Only **P1** remains — the WS-fidelity + `connect()` spikes (a build-gate to *run*, not a doc to fold). P2–P9 are all resolved + folded.
- This scaffold winds down at MVP with the rest (`bun scripts/docs-index.ts --teardown`).
