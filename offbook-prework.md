# Offbook — Pre-Work Items

*Knows every line. Needs no cast.*

**Companion to:** `offbook-design.md` (canonical decisions/rationale) and `offbook-handoff.md` (what-to-do, in-order). This doc tracks the **pre-work that must exist before a team of agents can build v1 in parallel.** The design is verified sound; it is not yet *executable*. Section refs (e.g. §5) point to the design doc.

---

## Why this exists — the two gaps + the agent lens

The current docs are **decision + rationale** and **ordered to-do**. To hand v1 to parallel agents, two kinds of gap remain:

- **Decisions still owed** — not yet decided, so no agent can build that part however well it's written up.
- **Specs still owed** — decided, but not pinned to executable detail (types, schemas, acceptance criteria).

Parallel **autonomous agents** specifically need: **frozen seams** (so they don't renegotiate interfaces mid-build), **self-contained task specs** (a fresh-context agent must know exactly which sections + contracts it needs), **local fixtures** (agents can't reach the proprietary specs/broker), and **checkable acceptance criteria** (a definition of done they can self-verify).

---

## Pre-work items (priority order)

### P0 — Decide the L2 scenario authoring format  *(BLOCKING design decision)* — ✅ DONE
- [x] **Deliverable:** `offbook-l2-scenarios.md` — **complete** (all 7 sub-decisions settled; decision log at end of that doc).
- **Outcome:** declarative YAML, L2/L3 as separate layers (lateral code escape); glob `scenarios/**/*.yaml` with deterministic sorted-path→in-file dispatch order; `{param}` capture + subset-equality `payloadMatch`; pure-substitution templating with seeded helpers and an explicit L2↔L3 boundary; per-step seeded `delay`; two-tier validation (lenient-dev / strict-CI); hot-reload + `/trigger` + `/reset`.
- **Why it blocked:** §10's *"single most important open thread… blocks v1 Step 2.8."* Now unblocked.
- **Feeds:** P1 — the §9 field reference in `offbook-l2-scenarios.md` is the seed for the normalized scenario type + `/trigger` `/reset` request shapes in `offbook-contracts.md`.
- **Refs:** §10, §4, §6.

### P1 — Freeze interface & API contracts  *(largest spec gap)*
- [x] **Deliverable:** `offbook-contracts.md` — **complete.** D1–D6 decided & compiled (normalized message model, broker module, behavior engine, validation, full control-plane API, spec-ingestion seams). Dialog provenance in `offbook-contracts-decisions.md`. Doc-debts from the dialog (vocabulary sweep, §3/§4/§5/§6/§9/§12 reconciliations) cleared across design + L2 docs.
- **Why it blocks:** the design *names* the seams but never pins signatures; parallel agents collide without exact contracts.
- **Contents:**
  - **TypeScript interfaces** for: the normalized message model `{ topic, payload, qos?, retain?, delayMs? }` (direction lives on the `Channel`, not the message); the broker module (`onInbound` / `onSubscribe` / `emit` / `getState` / lifecycle); `Resolver.resolve(repo, ref, specPath) → Promise<ResolvedSpec>` (v1+v2 `GitRefResolver`); `VersionSource (environment) → { service: version }`; behavior-layer registration (L3 / L2 / L1); the validation-result shape. *(All as frozen in `offbook-contracts.md`.)*
  - **Control-plane HTTP API contract** (OpenAPI form): real method / path / request-schema / response-schema / status / error-format for the §9 endpoints (reads `GET /topics`, `/state`, `/validation`, `/specs`, `/diagnostics`, `/mode`; actions `POST /publish`, `/trigger/{name}`, `/reset`, `/mode`). This is the substrate the CLI just wraps.
  - **Config-file schemas:** `environments.yaml` (v1 StaticManifestSource), `specs.lock` (formalize the §7 shape), `services.yaml` (v2 — stub only).
- **Refs:** §3 (Generalizability), §5, §7, §9.

### P2 — Build plan: scaffold + parallelization + acceptance
- [x] **Deliverable:** `offbook-build-plan.md` — **complete** (tech stack, repo scaffold + transport-isolation discipline, port map, tiered work-breakdown/dependency graph, per-module acceptance criteria, P4 spike specs).
- **Why it blocks:** the handoff Step 2 is a *sequential* list; a team needs the dependency graph, the scaffold, and a checkable "done."
- **Contents:**
  - **Repo scaffold:** directory layout; **pinned dependency versions** (aedes, `@asyncapi/parser`, ajv, `json-schema-faker@0.6.2`, Bun toolchain); tsconfig/build; test framework; Dockerfile; **port map** (broker ws, broker tcp, control-plane side port).
  - **Work-breakdown + dependency graph:** which tasks run in parallel behind the frozen interfaces (broker module, spec registry, L1 faker, validation, control plane, CLI, specs.lock/resolver) vs. what must serialize — what an orchestrator fans out.
  - **Acceptance criteria per v1 checklist item** (self-checkable), especially the §5 validation-correctness bar including the external-`$ref`/`$id` test.
- **Refs:** handoff "v1 build checklist", §3, §5, §9.

### P3 — Commit test fixtures (sample AsyncAPI specs)
- [x] **Deliverable:** `fixtures/asyncapi/` — **complete** (thermostat v3 both-directions · composition allOf/oneOf/anyOf · external-ref + shared/common `$id` · v2-pubsub · qos-retain bindings; see `fixtures/asyncapi/README.md`).
- **Why it blocks:** the tool consumes AsyncAPI specs, but agents can't see the real proprietary ones.
- **Contents:** representative specs covering **both directions** (toClient / fromClient) and the known-hard cases — external `$ref`, `$id`, `allOf` / `oneOf` / `anyOf` — so L1 and validation can be developed and the §5 correctness bar actually tested. A oneOf hard schema sits on a **fromClient** operation (composition `receiveSubmission`), so client-publish validation of the hard cases is exercised end-to-end, not just via mock-side L1 recheck.
- **Refs:** §5, §4, §12.4.

### P4 — Specify the two prerequisite spikes as deliverables
- [x] **Specified** in `offbook-build-plan.md` §5 (pass/fail + output artifacts). **Execution is empirical** — needs the real browser application / repos — so it remains for the build team to *run*; the spec is done.
- **Why:** §12.1 (WS-fidelity) and §12.2 (capture `connect()`) are blocking but underspecified as *deliverables*. Each needs a concrete pass/fail and a named **output artifact** agents consume: the `connect()` capture → a config fixture; the WS spike → a go/no-go + any Aedes listener config. Both can run **immediately, in parallel**, and may adjust the broker module before it's built.
- **Refs:** §12.1, §12.2, §8, §3 ("Broker fidelity").

---

## Explicitly out of scope (do NOT spec now)

- **v2 resolution-layer** and **adversarial-timing** specs — the design already defers them behind interfaces (§7, §11, §12.7). Speccing them now repeats the over-engineering risk already flagged.
- A standalone glossary/domain-model doc — fold shared vocabulary into the design doc instead of spawning a doc.

---

## Recommended sequence

1. ~~**P0** — decide L2~~ ✅ **done** (`offbook-l2-scenarios.md`).
2. ~~**P1** — freeze contracts~~ ✅ **done** (`offbook-contracts.md`).
3. ~~**P2 + P3** — build plan + fixtures~~ ✅ **done** (`offbook-build-plan.md`, `fixtures/asyncapi/`).
4. **P4 spikes** run in parallel throughout; their artifacts feed the broker module.

**Dependency note:** P1 is the keystone — once interfaces are frozen, P2's parallel tasks and most of Step 2 can fan out to independent agents.
