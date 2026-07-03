# Offbook — v1 Pre-Build Standing-Items Audit, Round 3 (Handoff)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (the **canonical** frozen interfaces — the conflict rule applies: if any other doc disagrees on an interface/API detail, the contract wins and the other doc is the bug), `offbook-design.md`, `offbook-l2-scenarios.md`, `offbook-build-plan.md`, and the prior rounds `offbook-build-gaps.md` (G1–G25) / `offbook-build-gaps-2.md` (F1–F21, R1–R5).

**Status:** **Resolved (2026-06-30).** A fresh-eyes audit run *after* the ergonomics review (EQ/ER/EH/EC/EO/EI) folded — a multi-lens sweep (per-doc extractors + cross-cutting consistency / build-readiness / empirical-unknowns / deferred-scope lenses) over 124 candidates, adversarially verified down to **31 distinct standing items**. They fall in three classes:

- **A — blocks-v1 (5): S1–S5.** Empirical gates the Step-2 build hits directly — three unrun spikes (WS-fidelity, browser-app `connect()` capture, json-schema-faker fidelity F8, mqtt-pattern parity F6/R2) plus the `Violation.severity` mapping (S4, *also* doc-fixable — resolved below). **No doc edit closes a spike;** they are tracked build-gates, not deferrals.
- **C — latent doc-gap (13): S6–S18.** Untracked contradictions / underspecs, mostly *inside* the canonical contract. **All folded** into the canonical docs in this round (see Decision log).
- **B — deferred-recorded (13): S19–S31.** Clean, cross-doc-consistent v2 deferrals with intact v1 seams — **no v1 action**; listed for traceability.

**Why this exists.** The `INDEX.md` "open items" counter tallies only literal `☐` checkboxes in `status:open` docs, so it read **0** even though prose-level open threads, deliberately-deferred v2 items, underspecified frozen-contract fields, and fold-in drift were not represented. Each C-class item below is the same kind of cross-module collision `offbook-contracts.md` exists to prevent — surfaced because it lived in prose, not a checkbox. The single largest defect was the L2-authoring-format fold (**S6**): the P0 decision landed correctly in `offbook-l2-scenarios.md` but was never propagated back, so `design §10`/handoff still framed a *settled* decision as the "single most important open thread."

> **Line numbers cited below are anchors as-of the audit (HEAD `ebfef5b`, 2026-06-30) and drift once edits land.** Anchor by `§N` / type name / heading.

---

## Summary

| ID | Class | Item | Disposition |
|---|---|---|---|
| S1 | A | WS-fidelity spike unrun — broker ws listener config provisional | build-gate (design §12.1; run the spike) |
| S2 | A | Browser-app `connect()` not captured (auth/path/subprotocol/protocol-level/QoS2/port) | build-gate (design §12.2; capture artifact) |
| S3 | A | F8 json-schema-faker fidelity spike unrun — gates L1 CI claim + keyed-fallback | build-gate (build-plan spike #3) |
| S4 | A/C | `Violation.severity` had no `kind`→default map; "policy may override" undefined | **resolved** → contracts §4 |
| S5 | A | mqtt-pattern `{p}`→`+p` parity spike (F6/R2) unrun — gates registry matcher | build-gate (build-plan spike #4) |
| S6 | C | L2 format settled in l2-scenarios but design §10/§4/§12.5 + handoff still "open" | **resolved** → design §4/§10/§12.5, handoff |
| S7 | C | `<runDir>` used ~13× but never defined (no default, no Config field) | **resolved** → contracts §1a/§5, design §9 |
| S8 | C | passive/CI boot mechanism unspecified (gate needs `mode==passive`, no flag/field) | **resolved** → contracts §1a/§3, design §9, build-plan |
| S9 | C | `/publish` body `qos`/`retain` precedence vs channel-resolved undefined | **resolved** → contracts §2/§3/§4/§5, design §9, build-plan |
| S10 | C | `?schema=false` slim mode contradicts non-optional `TopicInfo.schema` | **resolved** → contracts §5 |
| S11 | C | `wallClock` flip on interactive `up` had no selection mechanism | **resolved** → contracts §1a/§3 (the `--ci` profile + invariant) |
| S12 | C | scenarios/ "strict mode" had no flag/Config field/selector | **resolved** → contracts §1a, l2 §7, build-plan |
| S13 | C | orphaned `ErrorCode 'unknown-topic'` (no endpoint emits it) | **resolved** → contracts §5 |
| S14 | C | `/publish` 202 `injected` field never typed/explained | **resolved** → contracts §5 |
| S15 | C | tick jitter keyed for determinism (F7) but no Config field/distribution | **resolved** (deferred to v2) → contracts §3 |
| S16 | C | l2 §4 defined `#` as "one-or-more", contradicting MQTT 3.1.1 zero-or-more | **resolved** → l2 §4 |
| S17 | C | contracts + l2 masthead claimed bare `§N`→design, but most are self-refs | **resolved** → contracts + l2 (convention flip + prefix sweep) |
| S18 | C | prework P3 "complete" fixture list omitted `qos-overrides.yaml` | **resolved** → prework P3 |
| S19 | B | v2 adversarial-timing fault steps (duplicate/reorder/drop/redeliver) | deferred (additive on `EmitStep`; §7) |
| S20 | B | `qos-mismatch` ViolationKind → v1 is a tier-3 warn log | deferred (one-line upgrade seam; §7) |
| S21 | B | v2 semver→SHA→file resolution / ingestion machinery | deferred (seams intact; §7) |
| S22 | B | open §7 boundary: mock *calls* vs *consumes* release tooling | deferred (gates v2 resolution) |
| S23 | B | AsyncAPI-3.0 reply-channel auto-response (future L1 reactive) | deferred (design §3 / contracts §3) |
| S24 | B | `InboundEvent.meta.packetId` reserved for v2 (QoS-1 dup fault) | deferred (contracts §1) |
| S25 | B | v1 auth = accept-all; real-auth handshake-mirroring | deferred (design §8; shape depends on S2) |
| S26 | B | `TransportAdapter` not extracted until n=2 | deferred (design §3; isolation discipline holds) |
| S27 | B | storage half of v2 resolution (Apicurio vs per-commit pinning) | deferred (design §12) |
| S28 | B | inline `handler:` step composition | deferred (n=1 discipline; l2 §1) |
| S29 | B | true in-process L3 HMR (v1 ships supervised watch-restart) | deferred behind a Bun spike (l2 §8 / EH1) |
| S30 | B | `config.maxEvents` reserved/inert in v1 | deferred (contracts §1a; F2) |
| S31 | B | deeper characterization of non-WS fork divergences | deferred (spike/bug-triggered; design §3) |

---

## Decision log (C-class — the items folded this round)

*Each: ID · decision taken · file(s) patched · resolver · date. The A-class spikes (S1–S3, S5) and B-class deferrals (S19–S31) carry no doc edit.*

| ID | Decision taken | File(s) patched | Resolver | Date |
|---|---|---|---|---|
| S4 | Normative `ViolationKind`→default-severity map — **all four kinds → `error`** (warnings deterministically 0 in v1; `'warning'` reserved for the v2 `qos-mismatch` promotion); **struck "policy may override"**, noting a v2 `severityOverrides` Config field as a possible enhancement | offbook-contracts.md §4 | CodeReviewJoe | 2026-06-30 |
| S6 | Back-propagated the *settled* L2 format: design §10 retitled **RESOLVED** (questions kept as an answered checklist), §4 bullet + §12.5 updated, handoff Step 2.8 / Step 3 / checklist / Open-threads #1 flipped to resolved | offbook-design.md §4/§10/§12.5; offbook-handoff.md | CodeReviewJoe | 2026-06-30 |
| S7 | Defined `<runDir>` canonically: **`runDir: string`** Config field (cwd-relative default `'.offbook'`) + `DEFAULT_CONFIG`; runfile named `<runDir>/offbook.run`; `init`'s `.gitignore` made concrete | offbook-contracts.md §1a/§5; offbook-design.md §9 | CodeReviewJoe | 2026-06-30 |
| S8 | Boot-switch mechanism: added **`mode`** + **`strict`** Config fields + a single **`offbook up --ci`** boot profile (co-sets `mode=passive`, `wallClock=false`, `strict=true`, `--watch` off); the determinism gate's "boots passive" is `--ci` | offbook-contracts.md §1a/§3; offbook-design.md §9; offbook-build-plan.md | CodeReviewJoe | 2026-06-30 |
| S9 | `/publish` body `qos`/`retain` = **explicit-wins merge** (`body ?? channel ?? default`) routed through `resolveEmit`; an explicit value differing from the channel binding is an intentional off-spec emit, **surfaced** via the tier-3 divergence warn-log + a CLI `⚠ off-spec override` heads-up (never silent) | offbook-contracts.md §2/§3/§4/§5; offbook-design.md §9; offbook-build-plan.md | CodeReviewJoe | 2026-06-30 |
| S10 | `?schema=false` slim mode typed as **`Omit<TopicInfo, 'schema'>[]`** (drops `schema` only; keeps `example`); `schema` stays **required** on the full `TopicInfo` | offbook-contracts.md §5 | CodeReviewJoe | 2026-06-30 |
| S11 | `wallClock` selection folded into the **`up --ci`** profile (S8): interactive `up` → `true`, `--ci` → `false`; invariant stated that the passive/CI boot retains `wallClock=false` | offbook-contracts.md §1a/§3; offbook-design.md §9 | CodeReviewJoe | 2026-06-30 |
| S12 | `strict` selector = the **`strict`** Config field, set by `up --ci` **or** a standalone **`up --strict`**; scenario-load errors fatal-at-startup when strict, else skipped-loud to `/diagnostics` | offbook-contracts.md §1a; offbook-l2-scenarios.md §7; offbook-build-plan.md | CodeReviewJoe | 2026-06-30 |
| S13 | **Removed** orphaned `'unknown-topic'` from the `ErrorCode` union (no endpoint emits it — unmatched `/publish` → 202 + `unknown-topic` *Violation*); added a note flagging the `ViolationKind` name-collision | offbook-contracts.md §5 | CodeReviewJoe | 2026-06-30 |
| S14 | Defined `/publish` 202 **`injected: boolean`** — always `true` (the publish reached the broker, matched or not), mirroring `/trigger`'s `fired` and `/reset`'s `reset` | offbook-contracts.md §5 | CodeReviewJoe | 2026-06-30 |
| S15 | Tick jitter **deferred to v2**: struck "optional seeded jitter either way" (v1 cadence is fixed) and marked F7's `(tickIndex)` keying `[deferred to v2]` | offbook-contracts.md §3 | CodeReviewJoe | 2026-06-30 |
| S16 | l2 §4 `#` "one-or-more" → **"zero-or-more trailing levels"** (`a/#` also matches `a`), matching MQTT 3.1.1 + the canonical F6/R2 spike spec | offbook-l2-scenarios.md §4 | CodeReviewJoe | 2026-06-30 |
| S17 | Flipped the `§`-ref convention in both `offbook-contracts.md` and `offbook-l2-scenarios.md` — **bare `§N` = this doc; cross-doc refs prefixed `design §N` / `l2 §N` / `contracts §N`** — and swept the sibling-meaning bare refs (classifier-verified), removing the ad-hoc `, this doc` / disambiguator patches | offbook-contracts.md (masthead + refs); offbook-l2-scenarios.md (masthead + refs) | CodeReviewJoe | 2026-06-30 |
| S18 | Appended `qos-overrides` config tiers (G13) to the prework P3 "complete" fixture enumeration | offbook-prework.md P3 | CodeReviewJoe | 2026-06-30 |

---

## Notes

- **Coverage verified clean.** The five hard constraints (transport isolation, no-direction-on-message, observe-and-surface, parser+Ajv, MQTT-3.1.1-only, scheduler-in-engine, Mulberry32) hold consistently across docs; the v2-deferral seams are mutually cross-referenced (contracts §7 is the canonical sink); the `specs.lock`/`GitRefResolver`/`VersionSource` v1 seams are execution-complete. Most ergonomics folds landed cleanly — the exceptions surfaced here (S13/S14 from EQ1's unmatched-publish reroute; S7 from the EO1–EO4 `<runDir>` presupposition).
- **A-class is not deferral.** S1–S3 and S5 are **in-scope v1 gates** that require the real browser app / running the spike; `broker/`, `registry/`, and L1 may build provisionally (Aedes defaults / mqtt-pattern / drop-and-surface) and finalize when the spike returns.
- This scaffold winds down at MVP with the rest (`bun scripts/docs-index.ts --teardown`).
