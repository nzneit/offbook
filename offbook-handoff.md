---
type: tracker
status: open
summary: What to build, in order — currently pointing at Step 2 (build the v1 core).
---

# Offbook — Agent Handoff

*Knows every line. Needs no cast.*

**Companion to:** `offbook-design.md` — the canonical doc for *all* decisions and rationale. This handoff is **what to do, in what order**. Every "why" lives in the design doc; section refs (e.g. §5) point there.

**One-line goal:** a self-contained dev service that mocks the browser application's MQTT backends from their AsyncAPI specs, validates the browser application's traffic against the contract at dev-time, and reproduces real MQTT timing — moving contract-break and async-bug detection from deploy-time to dev-time. (§1)

**Decision rule:** when anything is ambiguous, choose what best kills the three pains — contract drift undetected until deploy, no async realism, manual mock rot. (§1–2)

---

## Sequence (do in this order)

### Step 1 — De-risk before building (cheap, may change scope)
1. **WS-fidelity spike.** Point the real browser application's MQTT client at a bare Aedes ws listener; confirm connect + subscribe + retained-message receipt using the **same protocol level, WS path, subprotocol, and auth shape as prod**. This probes the one suspected fork divergence (WebSocket transport). (§3, §12.1)
2. **Capture the browser application's actual `connect()` call** — auth fields, ws URL/path, subprotocol, exact protocol level (3.1.1 vs 3.1). Feeds Step 1 and settles auth. (§8, §12.2)
3. **Adopt-vs-build check — RESOLVED: build is justified.** Verified via research + Microcks/Specmatic source-code reading: neither tool covers the gap (*embedded broker + MQTT-over-WS for a browser application + loud bidirectional dev-time validation + stateful scenarios + MQTT-semantic timing faults*) off-the-shelf. Microcks is a provider-side mock-emitter (native MQTT/TCP; its WS binding is raw Jakarta WS, not MQTT-over-WS; no client-publish validation); Specmatic is a CI contract-test runner (native MQTT tcp/ssl, Kafka-only in-memory broker, stateless, Enterprise). Reuse their schema-validation + conformance patterns rather than rebuild. Residual: confirm ergonomic/coverage fit against the real specs and re-verify capability boundaries (both tools move fast) before committing. (§12.6)

**Gate:** items 1–2 gate Step 2 (the WS-fidelity spike + capturing the browser application's `connect()`) **only insofar as the broker's listener config is concerned** — Step 2's first task (`broker/`) **may start in parallel against Aedes defaults** and is buildable now; what items 1–2 gate is the broker's **ws subprotocol/path/auth config being final** (provisional until the spike returns; see build-plan §5). Item 3 (adopt-vs-build) is **resolved in favor of building** (§12.6); only an ergonomic/coverage confirmation against the real specs remains, and it no longer threatens to flip the decision.

### Step 2 — Build the v1 core (only if build is confirmed)
Scaffold the separate repo and implement, roughly in this order:
1. **Broker module** — Aedes ws+tcp bootstrap behind a thin internal interface (`onInbound`, `onSubscribe`, `emit`, `getState`, lifecycle). Nothing above this module imports Aedes. (§3; shapes in `offbook-contracts.md` §2)
2. **Spec Registry** — `@asyncapi/parser` → parsed channels + compiled Ajv validators, with **direction normalization done once onto the `Channel` record** (`send`=`toClient`, `receive`=`fromClient`). (§5; `offbook-contracts.md` §1)
3. **L1 — schema-valid fake** — `json-schema-faker` (pinned, seeded) + **Ajv recheck before emit**. This is the floor; the tool works once this lands. (§4)
4. **Bidirectional validation** — observe-and-surface (not block-at-broker) + a `GET /validation` log CI can assert on. (§5)
5. **Control plane (HTTP) + Bun CLI** thin client over it. (§9)
6. **`specs.lock`** + **`GitRefResolver`** (branch-selecting; v1 default `main`) behind the resolver/version-source interfaces. (§7; `offbook-contracts.md` §6)
7. **Initial-state retained** + **seeded autonomous-emission mode** (toggleable). (§7)
8. **L2 scenarios with seeded `delay`** — but resolve the authoring-format thread first (see Open Threads). (§4, §6)

### Step 3 — Parallel & after
- Open the **L2 authoring-format** thread in parallel with Step 2 — it gates whether v1 *feels* useful. (Open Threads #1)
- Leave **v2 resolution** and **adversarial timing** untouched until v1 is proven.

---

## v1 build checklist (the scope line)

- [ ] Aedes ws+tcp, MQTT 3.1.1, QoS1 + retain
- [ ] Broker module isolates all MQTT/Aedes from the layers above
- [ ] Spec Registry with direction normalization
- [ ] L1 fake: json-schema-faker (pinned, seeded) + Ajv recheck
- [ ] Bidirectional validation, observe-and-surface, `/validation` log
- [ ] Control plane + Bun CLI
- [ ] `specs.lock` + `GitRefResolver` (branch-selecting, v1 default `main`) behind interfaces
- [ ] Retained initial state + seeded toggleable autonomous emission
- [ ] L2 scenarios with seeded `delay` (after authoring format decided)

**Out of v1:** semver→SHA→file resolution, per-service strategy config, `--env`, real auth validation, release-tooling integration, adversarial timing. (§11)

---

## Hard constraints (violating these defeats the purpose)

- **Mock the services, not the broker.** Do not reproduce the proprietary ActiveMQ fork. (§3)
- **Validation = observe-and-surface, never block-at-broker.** Blocking is anti-fidelity. (§5)
- **Use `@asyncapi/parser` + Ajv.** Parser for spec parse/validate (it runs `Spectral → Ajv` under the hood — not plain Ajv); Ajv directly for runtime payload validation. Never hand-roll schema interpretation. Test against external-`$ref`/`$id` specs. (§5, §12.4)
- **Transport isolation.** Behavior, validation, control-plane, and resolution layers must not import Aedes types — they operate only on the normalized message model `{ topic, payload, qos?, retain?, delayMs? }` (direction lives on the `Channel`, not the message). All MQTT lives behind the one broker module. (§3 "Generalizability"; `offbook-contracts.md` §1–2)
- **Build the timing split right.** MQTT-semantic faults in-process; transport faults via Toxiproxy. (§6)
- **MQTT 5 is out of scope.** Prod is 3.1.1. (§3)

---

## Open threads (decide before the relevant build step)

1. **L2 scenario authoring format** — the single most important open thread; if authoring is tedious the tool never gets past L1. Decide format, topic-match + param binding, templating vs L3 boundary, `delay` expression, author-time validation, hot-reload. **Blocks v1 Step 2.8.** (§10)
2. **Release-tooling boundary** — how "environment → deployed semver" is obtained, and whether the mock *calls* the tooling or *consumes its output*. **Gates v2 only.** (§7)

---

## Two judgment calls — now resolved by verification

- **Adopt-vs-build (Step 1.3) — RESOLVED: build is justified.** Verified via research + source-code reading; neither Microcks nor Specmatic covers the gap off-the-shelf (§12.6). Reuse their schema-validation / conformance patterns; re-verify capability boundaries before committing (both tools move fast).
- **v2 resolution layer — RESOLVED: keep it, but only the resolution half.** A registry (Apicurio) or per-commit pinning covers spec *storage*; the environment→deployed-version *binding* is the genuinely novel part no registry or catalog provides, so it is not redundant. Keep `specs.lock` regardless. (§12.7)
