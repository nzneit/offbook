---
type: meta
status: living
summary: Guidance for agents/humans — doc-map, hard constraints, vocabulary, review angles.
---

# AGENTS.md — Offbook

Guidance for any agent (or human) working in this repo. `CLAUDE.md` is a symlink to this file.

## What this is
**Offbook** — a local dev tool (TypeScript/Bun) that mocks a browser application's MQTT-over-WebSockets backend services from their **AsyncAPI** specs: bidirectional dev-time contract validation + DST-inspired async/timing emulation. Goal: move contract-break and async-bug detection from deploy-time to dev-time. The repo is currently **design docs + test fixtures** (pre-build); no app code yet.

## Doc map (which doc is canonical for what)
- **`offbook-contracts.md`** — the **frozen v1 interfaces & HTTP API**. The synchronization point; build against this. *Canonical for types/endpoints/config schemas.*
- **`offbook-design.md`** — decisions & rationale (§1–§12). *Canonical for "why".*
- **`offbook-l2-scenarios.md`** — the L2 scenario authoring format (P0).
- **`offbook-build-plan.md`** — tech stack, repo scaffold, tiered dependency graph, per-module acceptance criteria, spike specs (P2).
- **`offbook-handoff.md`** — what to do, in order. **`offbook-prework.md`** — pre-work tracker.
- **`offbook-contracts-decisions.md`** — the P1 dialog/rationale log (provenance, not canonical).
- **`fixtures/asyncapi/`** — test specs + their README (incl. the **Fixture quality bar**).

**Conflict rule:** if a doc disagrees with `offbook-contracts.md` on an interface/API detail, the contract wins — fix the other doc.

**Work tracking (temporary scaffold).** `INDEX.md` is a generated map of every doc + the open-work frontier; each doc carries `type`/`status`/`summary` frontmatter. Regenerate with `bun scripts/docs-index.ts`. This is intentionally idiosyncratic and gets wound down at MVP: `bun scripts/docs-index.ts --teardown`.

## Hard constraints (violating these defeats the purpose)
- **Transport isolation.** Only `src/broker/` may import `aedes` (or any MQTT/transport package); everything else operates on the normalized message model. A lint rule enforces this.
- **Normalized message has no `direction`** — direction lives on the `Channel` record (normalized once from the spec). The message is `{ topic, payload, qos?, retain?, delayMs? }`.
- **Validation = observe-and-surface, never block-at-broker.** A real MQTT broker is payload-agnostic; surfacing loudly is more prod-faithful.
- **Use `@asyncapi/parser` (parses/validates the doc via Spectral→Ajv) + Ajv directly for runtime payloads.** Never hand-roll schema interpretation; test against the `external-ref`/`qos-retain` fixtures (the §5 correctness bar).
- **MQTT 3.1.1 only** (QoS 0/1/2, default 1; no MQTT 5). The scheduler lives in the **engine** (`broker.emit` is publish-now); seeded determinism via Mulberry32.

## Vocabulary
- **client** = the connecting app under development (this adopter's client is a browser application). **mock** = the tool's own emissions.
- **Direction** (on the `Channel`): `toClient` / `fromClient`. v3 `send`→`toClient`, `receive`→`fromClient`; v2 `subscribe`→`toClient`, `publish`→`fromClient` (publish = the service *receives* ⇒ the client publishes).
- MQTT terms (`topic`, `qos`, `retain`, bindings) stay concrete — generalize the **client** vocabulary, **not** the MQTT transport.

## Review angles (for `/code-review` of these docs/fixtures)
1. **Doc-consistency** — cross-references (`§N`), inter-doc contradictions (contracts is canonical), incomplete decision-sweeps (e.g. renamed terms), contract self-consistency.
2. **Fixture-semantics** — *"does this fixture actually test what it claims?"* See the **Fixture quality bar** in `fixtures/asyncapi/README.md` (no vacuous values; claim↔content; full-path/both-direction coverage; internal consistency; negative cases). The validity-only angle misses all of these.

## Status & next
Pre-work **P0–P4 complete** (L2 format, frozen contracts, build plan, fixtures; spike specs written). Next is **Step 2 — build the v1 core** behind the frozen contracts: Tier 0 `model/` → `broker`/`registry`/`ingestion` → `engine`/`validation` → `scenarios`/`control-plane` → `cli`. The two empirical spikes (WS-fidelity, capture the browser application's `connect()`) are runnable in parallel and may adjust `broker/`.

## Working notes
- **Git identity is the user's to set** — don't run `git config user.*` on their behalf. Commit/push **only when asked**.
