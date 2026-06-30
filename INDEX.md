# Offbook — Document Index

> **GENERATED — do not edit by hand.** Regenerate after adding/editing a doc's frontmatter:
> `bun scripts/docs-index.ts`. This index and the per-doc frontmatter are a **temporary,
> intentionally idiosyncratic work-tracking scaffold.** Wind it down at MVP:
> `bun scripts/docs-index.ts --teardown` (strips all frontmatter + deletes this file).

**Frontmatter schema** (top of each doc): `type` (spec · decision-log · handoff · tracker · meta · fixtures) ·
`status` (living · open · resolved · superseded) · `summary` (one line) · optional `supersedes` / `folds-into` / `related`.

**Disciplines.** `offbook-contracts.md` is the canonical authority (the conflict rule). A **handoff is transient:**
when every `☐` item is ticked, its decisions **fold into** the canonical doc named in `folds-into` and its
`status` flips to `resolved` — moving it from *Open work* to *Archive*. The live set you actually track is just the
*Open work* frontier below.

## Open work — the live frontier (1 docs, 0 open items)

| Doc | Open | Folds into | Summary |
|---|---|---|---|
| [Agent Handoff](offbook-handoff.md) | 0 | — | What to build, in order — currently pointing at Step 2 (build the v1 core). |

## Reference — canonical & living

| Doc | Type | Summary |
|---|---|---|
| [AGENTS.md — Offbook](AGENTS.md) | meta | Guidance for agents/humans — doc-map, hard constraints, vocabulary, review angles. |
| [AsyncAPI test fixtures](fixtures/asyncapi/README.md) | fixtures | AsyncAPI test fixtures + the §5 fixture quality bar. |
| [v1 Build Plan (P2)](offbook-build-plan.md) | spec | Tech stack, repo scaffold, tiered dependency graph, per-module acceptance, spike specs. |
| [Interface & API Contracts (v1)](offbook-contracts.md) | spec | Frozen v1 interfaces, HTTP control-plane API, and config schemas — the canonical authority (conflict rule). |
| [Design Document](offbook-design.md) | spec | Decisions & rationale (§1–§12) — canonical for "why". |
| [L2 Scenario Authoring Format](offbook-l2-scenarios.md) | spec | L2 scenario authoring format — declarative YAML behavior layer. |

## Archive — resolved records

| Doc | Type | Status | Lineage | Summary |
|---|---|---|---|---|
| [v1 Pre-Build Gap Resolution, Round 2 (Handoff)](offbook-build-gaps-2.md) | decision-log | resolved | supersedes [build-gaps](offbook-build-gaps.md) | Round-2 v1 pre-build gap resolution (F1–F21, R1–R5); resolved. |
| [v1 Pre-Build Gap Resolution (Handoff)](offbook-build-gaps.md) | decision-log | resolved | — | Round-1 v1 pre-build gap resolution (G1–G25); resolved. |
| [P1 Contract Decisions (working log)](offbook-contracts-decisions.md) | decision-log | resolved | — | P1 dialog/rationale log feeding offbook-contracts.md (provenance, not canonical). |
| [CI Synchronous Drain / Quiescence (Handoff)](offbook-ergonomics-ci-quiescence.md) | handoff | resolved | — | Synchronous-drain / quiescence signal for CI moment-4 (EC1); resolved + folded in. |
| [Human-Readable CLI Rendering (Handoff)](offbook-ergonomics-cli-rendering.md) | handoff | resolved | — | Human-readable offbook topics / validation output (ER1–ER2); resolved + folded in. |
| [Onboarding Scaffold (`offbook init`) (Handoff)](offbook-ergonomics-init-scaffold.md) | handoff | resolved | — | offbook init onboarding scaffold + honest first-run orientation (EI1–EI2); resolved + folded in. |
| [L3 Handler Hot-Reload Parity (Handoff)](offbook-ergonomics-l3-hot-reload.md) | handoff | resolved | — | L3 handler hot-reload parity decision (EH1); resolved + folded in. |
| [Ergonomics Quick Wins (Handoff)](offbook-ergonomics-quick-wins.md) | handoff | resolved | — | 7 quick ergonomics fixes (EQ1–EQ7) — small spec/CLI edits; resolved + folded in. |
| [Running-Server Observability (Handoff)](offbook-ergonomics-server-observability.md) | handoff | resolved | — | Running-server observability — log destination, logs, watch, status (EO1–EO4); resolved + folded in. |
| [Pre-Work Items](offbook-prework.md) | tracker | resolved | — | Pre-work tracker (P0–P4); complete. |
