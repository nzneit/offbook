# AGENTS.md — Offbook

Guidance for any agent (or human) working in this repo. `CLAUDE.md` is a symlink to this file.

## What this is
**Offbook** — a local dev tool (TypeScript/Bun) that mocks a browser application's MQTT-over-WebSockets backend services from their **AsyncAPI** specs: bidirectional dev-time contract validation + DST-inspired async/timing emulation. Goal: move contract-break and async-bug detection from deploy-time to dev-time. The repo is currently **design docs + test fixtures** (pre-build); no app code yet.

## Doc map (which doc is canonical for what)
- **`docs/specs/contracts.md`** — the **frozen v1 interfaces & HTTP API**. The synchronization point; build against this. *Canonical for types/endpoints/config schemas.*
- **`docs/specs/design.md`** — decisions & rationale (§1–§12). *Canonical for "why".*
- **`docs/specs/l2-scenarios.md`** — the L2 scenario authoring format.
- **`docs/specs/build-plan.md`** — tech stack, repo scaffold, tiered dependency graph, per-module acceptance, spike specs.
- **`docs/specs/doc-system.md`** — how this documentation system is organized.
- **`REQUIREMENTS.md`** — the enumerable v1 requirements registry (`R-###`); the answer to "what needs building, and is it done".
- **`DECISIONS.md`** — the decision ledger (`D-###`); forward-authoritative provenance.
- **`docs/intake/`** — open review-round items (start from `_TEMPLATE.md`); resolve into `R-###`/`D-###`, then move to `docs/archive/`.
- **`docs/archive/`** — resolved intake + the historical decision-logs (original G/F/S/P/EQ ids, intact).
- **`fixtures/asyncapi/`** — test specs + their README (incl. the **Fixture quality bar**).

**Conflict rule:** if any doc disagrees with `docs/specs/contracts.md` on an interface/API detail, the contract wins — fix the other doc. `REQUIREMENTS.md` indexes the specs; it is never a competing source of truth.

**Doc-system gate.** The corpus is validated by `bun scripts/check-docs.ts`: unique/contiguous `R-###`/`D-###` ids, resolvable `COVERS` anchors, lifecycle consistency (`built`/`tested` require a trace), and well-formed intake. A `tested` requirement's `TEST` files must carry a matching arrow-tag comment (`// [utest->R-###]`, or `itest`/`stest`); the checker verifies tags in both directions (missing and dangling). Run it before committing; it is the CI/pre-commit gate. See `docs/specs/doc-system.md` for the full design.

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
Pre-work complete (L2 format, frozen contracts, build plan, fixtures, doc-system reorg). `REQUIREMENTS.md` is now the work list: build Tier 0 `model/` → `broker`/`registry`/`ingestion` → `engine`/`validation` → `scenarios`/`control-plane` → `cli`, moving each requirement `specified` → `built` → `tested` as its `COVERS` anchor is implemented and tested. The two empirical spikes, `R-006` (WS-fidelity) and `R-007` (capture the browser application's `connect()`), are runnable in parallel against `broker/`'s Aedes defaults and are hard gates on calling v1 done.

## Working notes
- **Git identity is the user's to set** — don't run `git config user.*` on their behalf. Commit/push **only when asked**.
- **`bun run mutate` (Stryker) needs a Node >= 20 binary on `PATH`** to host the Stryker CLI process itself — Bun cannot (a `@babel/generator` CJS/ESM-interop crash: `TypeError: generator is not a function`); the runner plugin itself still drives `bun test`. Mutation testing is manual and never a gate. The runner sanitizes bunfig.toml for its child runs (forces coverage=false), which is why the always-on gate and mutation runs compose safely.
- **`nvm use default` puts a Node 24 on PATH** for `bun run mutate` / focused `stryker run` invocations.
- **`bun test <single-file>` may exit 1 with zero failures** — the per-file coverage floor (bunfig.toml) judges partially-imported files. Exit 1 with 0 fails = coverage floor, not a test failure; gate on full `bun test` runs.
