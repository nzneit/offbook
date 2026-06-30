---
type: spec
status: living
summary: Decisions & rationale (§1–§12) — canonical for "why".
---

# Offbook — Design Document

*Knows every line. Needs no cast.*

**Status:** Draft / brainstorm consolidation (revised after a state-of-the-art comparison pass and broker/protocol investigation)
**Scope:** Local development tooling for a browser application that communicates with backend services over MQTT-via-WebSockets.
**Settled headline:** MQTT 3.1.1; mock the services, not the broker; Aedes as dev stand-in. Details and rationale in §3.

---

## 1. Problem & Motivation

A browser application communicates with several backend services using MQTT messages carried over WebSockets. Those backend services each publish an **AsyncAPI specification** in their repositories describing the topics and message payloads they use.

Today, the browser application mocks these communications internally using hardcoded strings/objects. This approach has three concrete failures:

1. **Contract drift goes undetected until deploy.** The hardcoded mocks do not reliably match the specs the real services dictate. Mismatches aren't noticed until the browser application is deployed to a real environment, making breakage late and expensive to diagnose.
2. **No emulation of real responsiveness.** The fixed mocks respond instantly/synchronously and do not reproduce the async character of real MQTT communication. This has caused async bugs (ordering/timing/race issues) that only appear against real latency.
3. **Manual upkeep / rot.** The hardcoded mocks must be updated by hand and silently fall out of date.

### Reframing: what the tool is *for*

The current mocks fail specifically where they diverge from real protocol behavior — they are **contract-untrue** and **timing-untrue**. The purpose of this tool is therefore **fidelity to the contract and to the asynchrony**, not merely "plausible-looking data." The core value proposition is:

> **Move contract-break and async-bug detection from deploy-time to dev-time.**

**The v1 wedge is the contract-break half — bidirectional validation (§5).** Of the values the tool delivers, validation is the one it leads with: it is fully shippable in v1, demonstrable on the very *first run* (the developer can **witness a break get caught** — see `offbook demo`, §9), and it is the value every other part exists to protect (a mock is only worth trusting if it catches breaks — §7, *Spec trustworthiness*). **Async/timing fidelity (§6) and discovery (below) are *supporting* value, not co-headliners** — timing because its differentiated form (adversarial faults) is v2, discovery because it is a by-product of consuming the specs. Leading with one wedge keeps the pitch a sentence, not a paragraph.

A secondary but significant benefit: the tool becomes the canonical **discovery surface** for "what topics and message shapes exist," replacing the browser application's copy-pasted constants.

### Who this is for

**Primary user — the app developer on the browser application.** Fluent in the app's own stack and domain, **not** an MQTT or AsyncAPI expert. Every surface decision serves this developer: the hardcoded-mock pain above, the discovery surface that replaces copy-pasted constants, and the moment-1 onboarding promise (§9) are all theirs.

**"No MQTT knowledge required" is scoped to *getting value*, not to authoring.** This user reaches the tool's two largest values with **zero authoring and zero MQTT fluency**: the app boots and renders against the **L1 schema-valid floor** (§4), and everything it *publishes* is **validated against the spec automatically** (§5, observe-and-surface). **L2/L3 authoring** — scripted causal/timed behavior — is a **progressive, opt-in tier** the same developer grows into, scaffolded by the first-run on-ramp (the EI2 orientation banner; the EQ5/EQ7 teaching diagnostics), **not** a zero-knowledge promise. So when §4 says "the development value lives in L2/L3," it means the *behavioral richness* lives there — the contract-and-timing fidelity that is the core value proposition does **not** wait on authoring.

**Dependency persona — the upstream spec owner (the service team).** **Not** a user Offbook serves or can compel, but the party whose spec hygiene the tool's correctness rests on: the tool is only as truthful as the AsyncAPI specs it consumes (§2, §7), so a stale or partial spec silently **bounds — or inverts** — the value for the primary user. (What the tool *does* about a stale/partial spec — the degraded-spec posture — is a separate, still-open product decision.) **Opportunistic path:** the spec owner *may* run Offbook for their own ends — sanity-checking a spec change against a real client, or as a discovery surface — a concrete instance of §3's note that the tool "may be used by more than just the browser application." Welcome but unplanned-for; it does not make them a primary user.

---

## 2. Goals & Non-Goals

### Goals
- Self-contained, runnable locally in a container, to support local development of the browser application.
- Consume each service's AsyncAPI spec as the source of truth for topics and payload shapes.
- **Bidirectional contract validation**, surfaced loudly and locally.
- Faithful emulation of MQTT async behavior (timing) sufficient to catch real async bugs.
- Eliminate manual mock rot by deriving behavior from consumed specs.
- Good developer ergonomics across the distinct moments the tool is used (see §9).

### Non-Goals (at least initially)
- **Not** emitting TypeScript types or other artifacts for external consumers. Any schemas generated are internal to the mocking/faking stack only. (We are deliberately *not* solving the browser application's copy-paste habit by emitting types; we build around the browser application as-is.)
- **Not** validating real authentication. Accept-all auth for now (revisit later — see §8).
- **Not** a production broker or a prod-parity ops tool. It is a dev appliance.

---

## 3. High-Level Architecture

```
                    ┌──────────────────────────────────────┐
                    │            Mock Process (TS)          │
browser ──ws+mqtt3.1.1─►│  Aedes broker (ws + tcp listeners)    │
                    │            │                          │
                    │   ┌────────▼─────────┐                │
                    │   │  Spec Registry   │ ◄── AsyncAPI   │
                    │   │  (parsed channels,│     specs      │
                    │   │   topic matchers, │                │
                    │   │   compiled schemas)│               │
                    │   └────────┬─────────┘                │
                    │            │ dispatch on publish/sub   │
                    │   ┌────────▼─────────┐                │
                    │   │  Behavior Stack  │                │
                    │   │  L3 handlers ─┐  │                │
                    │   │  L2 scenarios─┼─►│ first match wins│
                    │   │  L1 schema fake┘ │                │
                    │   └──────────────────┘                │
                    │                                       │
                    │   HTTP control plane (side port)      │
                    └──────────────────────────────────────┘
                                  ▲
                                  │ HTTP
                         ┌────────┴────────┐
                         │   Bun CLI       │  (+ CI / other consumers)
                         └─────────────────┘
```

### Key decisions

- **Embedded Aedes broker (one TypeScript process).** Aedes is embedded directly so the broker and the behavior engine share state and lifecycle. This is required for the layered behavior model and for validating/intercepting in-flight messages at the broker boundary. The broker exposes both a **WebSocket listener** (so the browser application connects exactly as in prod) and a TCP listener.
  - Rejected alternatives: standalone Mosquitto (the engine becomes just another client reaching into the broker — awkward for stateful fakes and in-flight observation; and it is not the prod broker either, so it buys no real parity) and EMQX (heavy ops features irrelevant to a throwaway local fake). Running the *real* prod broker in dev is also off the table: it is a proprietary, hardware-optimized fork unlikely to be distributable or laptop-runnable. Hence a near-standard stand-in (Aedes) plus "mock the services, not the broker."
- **TypeScript**, chosen because the AsyncAPI tooling ecosystem is strongest in JS/TS (`@asyncapi/parser` is the reference parser) and Aedes is native. (Sharing types with the browser application is explicitly *not* a goal.)
- **HTTP control plane as the substrate**, with a **Bun CLI** as the human front-end over it. HTTP is the substrate because CI/other consumers will drive it programmatically and shouldn't have to shell out to the CLI; the CLI is a thin client so humans and machines drive the same surface.
- **Protocol: MQTT 3.1.1** (confirmed — the prod broker negotiates 3.1.1; see "Broker fidelity" below). **QoS 1** (at-least-once) and **retained last message** are the defaults, configurable per-topic (per-service default + per-topic override). Aedes supports MQTT 3.1/3.1.1 fully, so this is unblocked. **MQTT 5 is explicitly out of scope** — prod does not use it, so emulating it would be *anti*-fidelity.
- **Mock the services, not the broker.** The prod broker is a proprietary, hardware-optimized fork derived from ActiveMQ (assumed ActiveMQ Classic, given MQTT 3.1.1). We deliberately do **not** attempt to run or reproduce that broker. Aedes is a near-standard MQTT 3.1.1 stand-in for the *transport*; the tool's job is to fake the **services** that sit behind the broker, which is what the AsyncAPI specs actually describe. This keeps the conceptual boundary clean and means the proprietary fork's existence mostly does not burden the design.
- **Separate repository.** The tool lives in its own repo (it may be used by more than just the browser application). Consumers use it by *running it and querying it*, not by importing from it.

### Broker fidelity (the one suspected divergence: WebSockets)

The prod fork is *assumed* near-standard MQTT 3.1.1, so Aedes reproduces its QoS, retained-message, and topic behavior. There is no readily-available documentation for the fork — only some scattered docs and tribal knowledge — so this assumption is **unverified and characterized empirically**, not from any spec (AsyncAPI specs describe service payloads, never broker behavior).

The **highest-risk seam is the WebSocket transport layer**, because that is exactly where a proprietary fork is most likely to have customized (subprotocol name, path, framing, handshake headers, TLS termination) *and* it is the layer the browser application's connect code is tuned to. If the fork's WS handshake differs from Aedes's defaults, the browser application could connect cleanly to the mock and fail against prod (or vice versa) — the precise "works in dev, breaks in prod" failure this project exists to kill. This is the load-bearing thing the verification spike (§12) probes. Posture: *try Aedes's defaults, iterate; if the browser application does not connect unchanged, bend Aedes (its hooks/listener config exist for this) to match the fork.* Deeper characterization of the fork's non-WS divergences is deferred unless the spike or later bugs reveal a problem.

### Generalizability & layering boundaries

~70% of this design is a general service-mocking engine (AsyncAPI ingestion, the L3/L2/L1 behavior model, bidirectional validation, the control plane, the v2 resolution/lockfile machinery) — none of it specific to MQTT or to the browser application. The genuinely coupled parts are narrow: the **MQTT-over-WebSockets transport** (Aedes), the **broker-mediated topology**, the **ActiveMQ-fork specifics**, and **browser-application ergonomics**. A future team on Kafka/AMQP/etc. would reuse the upper layers and replace only the transport — a fork point, not a config knob.

**Do NOT build a transport-pluggable platform now.** At n=1, an abstraction encodes the one known case and gets refactored at n=2 anyway. The trigger to extract a real `TransportAdapter` interface is an actual second adopter.

**Do enforce a transport-isolation discipline now** (costs nothing, keeps the option open — reuse as a consequence of clean layering, not a built feature):
- The **behavior engine, validation, control plane, and resolution layers MUST NOT import Aedes types** or depend on MQTT/broker specifics. They operate only on the **normalized message model** (`{ topic, payload, qos?, retain?, delayMs? }`) — pure content + routing. **Direction is not on the message**; it is normalized once onto the `Channel` record (§5) and derived from flow position. See `offbook-contracts.md` §1.
- **All MQTT/Aedes interaction lives behind one thin internal broker module** (`onInbound`, `onSubscribe`, `emit`, `getState`, lifecycle) — the de-facto transport adapter; Aedes is one implementation. See `offbook-contracts.md` §2.
- **Fork-specific quirks** (WS-divergence handling, 3.1.1 pinning) stay inside that module/config, never smeared through the codebase.

---

## 4. Behavior Model — Layered (L3 → L2 → L1)

Behavior is resolved with **first-match-wins, in order L3 → L2 → L1**. This means the tool works on day one (everything falls through to L1) and is progressively enriched upward.

> **Refinement (P1.D3 — see `offbook-contracts.md` §3):** the layers participate by *trigger path*, not as one flat stack. **Reactive** (the client publishes) resolves **L3 → L2** (L1 has no reactive role — unmatched publishes simply get no scripted reply). **Proactive** (subscribe / autonomous tick) resolves **L3 → L1** — L1 is the floor that renders the UI on day one. **Explicit** (`POST /trigger/{name}`) fires a named L2 scenario. So **L1 = proactive floor, L2 = reactive/triggered, L3 = both.**

- **L1 — Schema-valid fake (the floor).** Generate spec-valid payloads from the channel's JSON Schema using **`json-schema-faker`** (the long-standing standard; its 2025–2026 **0.6.x rewrite** is TypeScript/Bun-first with zero prod deps, a `seed` option using a Mulberry32 PRNG, and JSON-Schema-2020-12 composition support — aligning with both the seeded-determinism goal and the Bun choice). **Caveat: the 0.6.x rewrite is recent (v0.6.2 published 2026-05-25) with a thin track record — the "de-facto standard" reputation belongs to the mature 0.5.x line — so pin the exact version and lean on the Ajv recheck below.** **Pin the version, use the `seed` option, and run every generated payload back through Ajv before emitting** — the faker has known weak spots on complex `allOf`/`oneOf`/`anyOf`, external `$ref`, and unusual `format`, so the Ajv recheck makes any non-conforming output fail loudly instead of silently emitting invalid mock data. Any topic the browser application subscribes to that the spec marks `toClient` (browser-receives) can emit spec-valid filler. Zero config; instantly unblocks the UI. Spec-valid **by construction**, which directly addresses contract drift on the service→browser-application direction.
- **L2 — Scenarios (authored).** The primary authored layer: scripted request→response behavior with **timing** (see §6). This is where developers express the interesting, causal behavior the spec cannot describe. **Authoring format is decided — see `offbook-l2-scenarios.md`** (which resolved the former §10 open thread).
- **L3 — Stateful handlers.** Small TS modules registered per topic prefix, holding state (e.g. a fake device tracking on/off and ramping a value), with `publish()` injected.

### Important framing for expectations

AsyncAPI specs describe **shape, not causality**. The spec yields L1 (structure + validation) for free — and the **L1 floor plus automatic validation are the primary user's no-authoring values** (see *Who this is for*, §1). The richer **causal/timed behavior** lives in L2/L3, which are **authored by humans** — a progressive, opt-in tier, not the entry fee. The tool's first-run experience must set this honestly: *the spec gives you validation and structure; humans give you behavior.* (Surfaced by the `offbook up` empty-state orientation banner — EI2.)

---

## 5. Bidirectional Contract Validation (Headline Feature)

This is the primary purpose, directly targeting "drift undetected until deploy." — and the **v1 wedge** (§1): the job the tool leads with, and the one `offbook demo` shows on run #1.

- **Browser application → service:** messages the browser application publishes are validated against the spec's receive-side schemas. The engine **observes and surfaces violations immediately and loudly** (control plane + validation log), so the browser application learns it is off-contract *now*, locally, instead of at deploy time. Note: even with embedded Aedes, the model is **observe-and-surface, not block-at-broker** — real MQTT brokers (ActiveMQ included) are payload-agnostic and deliver off-spec bytes without complaint, so broker-level rejection would be *anti*-fidelity. Surfacing loudly (not blocking delivery) is both sufficient and more prod-faithful. (This also keeps the design portable if the broker ever moves out-of-process and the engine becomes a privileged client.)
- **Service → browser application:** the mock's emissions are spec-valid by construction (L1) or validated at scenario-load time (L2), so the browser application is developed against contract-true responses.
- The control plane exposes a **validation log** (`GET /validation`) of every violation seen. This can become something **CI asserts on**: "did the browser application send anything off-contract during this run?"

### Validation correctness is a quality bar the tool lives or dies on

Because the mock becomes the contract-enforcement surface, **the mock being wrong is dangerous**:
- A **false positive** (flagging a valid message due to mis-parsed spec) trains devs to ignore the tool, making it worthless.
- A **false negative** (passing an off-spec message silently) recreates the exact "didn't notice until deploy" pain.

Mitigations:
- Lean on the **reference AsyncAPI parser** (`@asyncapi/parser`) for spec parse/validate and **Ajv** for runtime message-payload validation. Do **not** hand-roll schema interpretation. (Precise stack: the parser validates the *document* via **Spectral**, which wraps Ajv internally — `parser → Spectral → Ajv`; runtime *payload* checks use **Ajv directly** on validators compiled from the parsed channel schemas. Don't describe document validation as plain Ajv.) This mirrors the stack AsyncAPI's own message-validation guidance and the `asyncapi-validator` library use.
- Use the spec's self-declared `info.version` as a drift/sanity check so a mis-consumed spec announces itself (see §7).
- **Test the validation pipeline against specs that use external `$ref`s and `$id`** before trusting it in CI. The parser bundles/dereferences *before* validating, and `$ref` sibling-keyword and `$id` base-URI handling can produce surprising results — exactly the silent-wrongness §5 warns about.

### Earning continued trust — success criteria, the scoreboard, and de-noising

Correctness (above) is necessary but not sufficient: the tool also dies if it never *shows* the dev it is working, or if it *buries* real breaks in duplicate noise. Beyond "be correct," v1 commits to a small set of **success criteria** — what "worth keeping" looks like:

1. **Breaks caught** — the value proof, and the tool **self-reports** it: `offbook status` surfaces *"caught N distinct contract breaks this session"* (the `byOrigin.client` signal, reframed from a CI-gate input into a visible win tally). A dev tool that never shows its own scoreboard gets dropped the first time it is mildly annoying.
2. **False-positive budget = 0** — a false positive (flagging a *valid* message) is a **P0 bug**, not a tuning knob; it is the single number that protects adoption and makes the correctness bar above measurable.
3. **Time-to-first-value** — one command, seconds: `offbook demo` (§9) is the measurable on-ramp to a witnessed catch.

*(Authoring effort and setup-to-running against real specs are real goals too, but hard to instrument — qualitative, not committed metrics.)*

**De-noising (the third tool-killer).** A chatty off-spec client mints hundreds of identical violations, and a wall of duplicates trains devs to ignore the tool exactly as a false positive does. Fix it at the **read surface only**: both the human `offbook validation` view and the scoreboard operate on a **distinct violation** — keyed by its *structural signature* (`origin + kind + channel + error location/keyword`, **not** the raw offending value) — collapsing repeats to `×N (first…last seq)`. The **raw log is untouched**: the per-entry `seq` array, the bounded ring buffer, the F9 determinism projection, `?sinceSeq=`, and the CI gate (`byOrigin.client === 0`) stay exactly as `offbook-contracts.md` §4/§5 define them (`--json` still returns the raw per-entry array). Aggregation is a derived view, never a change to what is stored or asserted.

### The perspective-inversion trap (normalize once)

In AsyncAPI, operation direction is described from the **documented service's** point of view: the spec's `send` is something the **browser application (the client) receives**, and the spec's `receive` is what the **client publishes**. Normalize this **once at parse time** onto the `Channel` record — `direction: 'toClient' | 'fromClient'` — so no downstream code reasons about the inversion. (Direction lives on the channel, **not** on each message; see `offbook-contracts.md` §1.)

---

## 6. Timing / Async Emulation

The current mocks are **instant and too polite**; real MQTT is neither. Reproducing real async behavior is where the past bugs live, so timing is a **v1 requirement**, not polish. (It is *supporting* value, not the headline wedge: the validation wedge — §1/§5 — is what the tool leads with; timing's *differentiated* form, adversarial faults, is v2, so v1 ships `delay` only.)

**Framing:** this approach is **Deterministic Simulation Testing (DST)-inspired** — seeded, replayable fault/timing injection so failures reproduce by replaying the seed (the technique behind FoundationDB's `BUGGIFY`, Antithesis, TigerBeetle, etc.). Borrow the name and prior art for credibility, but state honestly that it is *DST-inspired*, not full DST: the tool controls message timing/faults, not the browser application's or runtime's entire execution (clock, scheduling, IO).

### v1 scope: `delay` only

`delay` covers the highest-frequency failure: the browser application assuming synchronous-feeling ordering because old mocks answered instantly. Introducing non-zero time forces the browser application's async code to actually run as async (promises resolve off the synchronous tick, loading states render, etc.), surfacing a large share of "worked in the mock, broke with real latency" bugs.

**Design details:**
- A delay is a **property of a scenario step** (a step says "emit this payload, after this delay"). Keeping the step as the unit means v2 primitives are added as *more properties on the same step model*, not a restructuring.
- A delay should be a **reproducible duration, optionally ranged** (e.g. `delay: 150-300ms`), not strictly a constant. Fixed delay is the degenerate zero-width case.
- **Seeded jitter:** ranged delays use a fixed RNG seed so timing is **real-feeling but reproducible run-to-run**. This is important because a fixed delay can always land on the "safe" side of a race and hide a bug, whereas seeded jitter explores the timing window while staying deterministic for CI. The elegant consequence: **seeded timing turns async bugs from un-reproducible heisenbugs into deterministic test fixtures** ("reproduce the bug where the ack lands after the timeout" becomes a repeatable scenario).
- **The scheduler lives in the engine, not the transport** (P1.D2/D3). The engine owns the **logical** clock (`now()` = `fixedEpoch + Σ` seeded delays — not wall-clock), resolves each step's seeded `delayMs`, applies it, and guarantees deterministic ordered delivery (`broker.emit` is publish-now, awaited; dispatch is **run-to-completion per event**). This is precisely *why* the v2 MQTT-semantic faults below must be in-process: they are scheduling manipulations the protocol-unaware transport cannot perform. See `offbook-contracts.md` §3.
- **Async-forcing without paying wall time (the virtual/wall split).** The default scheduler advances logical `now()` by the **full** seeded delay but delivers each emit on the **next event-loop task** — a *single* yield boundary, which is all it takes to push the browser application's promises off the synchronous tick (loading states render, ordering bugs surface) while a 1000-step seeded suite still finishes in well under the wall-sum of its delays. Delivering after a **real wall delay equal to `delayMs`** — **and** pacing autonomous ticks at `tickIntervalMs` of wall time — is the **wall-paced mode selected by `config.wallClock`** (default off; the human-perceptible/UX cadence for `offbook up`), not the CI/replay default. One switch governs both wall behaviors so they can't diverge. See `offbook-contracts.md` §3.

### Deferred to v2 (adversarial timing)

Ordering control, QoS1 **duplicates** (at-least-once genuinely means the browser application can receive a message twice), **out-of-order** delivery, **drop-then-redeliver**, connection blips. These catch rarer/nastier bugs and are where the mock can be *better than real* for development (deterministic, on-demand reproduction). They are additive properties on the same step model, so deferring them costs no rework.

**Build the split right:** implement **MQTT-semantic faults in-process** (duplicate/out-of-order/redelivery — these require MQTT-packet awareness the transport layer doesn't have), and **reuse Toxiproxy for transport-level faults** (latency, bandwidth, connection resets/blips). Toxiproxy is the standard deterministic *transport*-fault tool (HTTP-controllable, official Testcontainers module, and the most-referenced **open-source** chaos tool on GitHub — 243/971 repos — per the 2025 "Chaos Engineering in the Wild" survey; that survey's scope is the top-10 OSS tools on GitHub, so it excludes commercial/non-GitHub tools like Gremlin, AWS FIS, tc/netem, and Istio — don't read it as unqualified industry dominance), but it operates at raw TCP and is protocol-unaware — so it *cannot* do MQTT-semantic faults, which is precisely why those belong in the in-process engine. Don't reimplement transport chaos; don't expect Toxiproxy to do MQTT duplicates.

---

## 7. Spec Ingestion & Versioning

### Liveliness, cleanly separated

Two behaviors that were initially conflated, now decided independently:
- **(a · §7a) Initial state on connect — always on.** The engine guarantees retained state exists for any **materialized** instance, so the UI renders populated immediately (no blank UI until the next tick). **Whether** that state pre-exists or is created on demand splits by whether the `toClient` channel address is parametrized — **eager** for non-parametrized channels, **lazy** (created at first concrete subscribe/command) for parametrized ones. L1/L3 publish initial state with `retain: true`; L1's initial-state faking is **per-instance** — keyed by the instance's params (`fake(channel, params)`), so a multi-device `seedInstances` set renders **distinct** devices, not N identical ones (contracts §3, CR1). This is the materialization policy, owned by the engine-side `InstanceRegistry` (the **normative rules + types are in `offbook-contracts.md` §2** — this elaborates them with examples + rationale):
  - **Non-parametrized `toClient` channels** (e.g. `status/all`): retained initial state is published **eagerly at startup**. There is exactly one concrete topic, so there is nothing to de-wildcard.
  - **Parametrized `toClient` channels** (e.g. `state/{deviceId}`): a concrete instance has no value until one is bound — the spec declares the param, never enumerates ids — so an instance is **materialized lazily** when either (i) a **concrete** subscribe binds its params (`SUBSCRIBE state/thermostat-1`), or (ii) a `fromClient` command **first references** a concrete param (`command/thermostat-1/set` → the reactive path publishes `state/thermostat-1`). The engine keeps a **materialized-instance set** in the engine-owned `InstanceRegistry` (`offbook-contracts.md` §2) — the recorded concrete ids.
  - **Wildcard subscribe** (`SUBSCRIBE state/+` or `state/#`): emit the **existing retained state for every topic matching the filter** — via Aedes' **native retained delivery** from its own retained store (filter tested by `matchesFilter`, F6; R3 — the subscribe hot-path does **not** call `getState()`), **not** a parallel materialized-instance ledger — and **never invent** a param value. A wildcard carries no binding to de-wildcard, so it can only replay what already exists (a cleared topic is excluded; an off-ledger L3/L2 retained publish is included). *(MQTT `+`/`#` are subscribe-side filters here, distinct from the channel-address `{param}` the registry matcher resolves — `offbook-contracts.md` §1.)*
  - **Optional `seedInstances`** — a `ServiceConfig` field (`offbook-contracts.md` §6) keyed by channel address, whose value is a **list of param-maps** so multi-param channels work (e.g. `state/{deviceId}: [{ deviceId: thermostat-1 }, { deviceId: thermostat-2 }]`) — pre-materializes a deterministic demo set at startup, so onboarding isn't a blank UI even before any subscribe or command.
  - **`reset`** re-materializes via `InstanceRegistry.restore(snapshot())` — **exactly the recorded set** (any `seedInstances` plus instances materialized since the last reset), re-seeded — so post-`reset` `/state` is deterministic **by construction**, not empty (the moment-4 CI primitive holds).
- **(b · §7b) Autonomous emission over time — a toggleable, seeded mode.** Whether the mock keeps generating new messages on its own (e.g. telemetry ticking) is a **mode**, on by default for normal startup (onboarding/daily-driver benefit) and off/forced-off under test (to avoid CI flake). When on, emission is **seeded** for run-to-run reproducibility.

### Source of truth: consumed AsyncAPI specs

Specs are consumed from the service repositories. Deriving behavior from consumed specs (rather than hand-written constants) is what kills the **manual rot** pain — provided specs are re-consumed regularly and updating them stays low-friction (`offbook specs update`, with the lockfile making the diff reviewable).

### Spec trustworthiness — fidelity honesty on the *content* axis (v1)

The version-axis honesty below ("never lie about its own fidelity") answers *which spec version did I get*. It does not answer the deeper question the tool's whole value rests on: **is this spec trustworthy at all?** A mock is only as truthful as the specs it consumes, so a spec that is unreachable, vacuous, or stale can quietly **invert** the value — validating the client *green* against a contract that is wrong or asserts nothing is **false confidence**, the exact "ship a break unnoticed" failure this project exists to kill. Three distinct failure modes, three dispositions:

- **Mode 1 — Won't load → fatal.** A service whose spec fails to fetch (unreachable repo, bad creds, missing branch) or parse **aborts `offbook up`** with a named, actionable foreground error (`service X: spec fetch failed — <repo>@<branch>: <cause>`), *before* the server detaches — never a raw git/parse stack trace. Deliberately **stricter than scenario-load**: the spec is the *foundational source of truth* (a missing one means the mock would lie by omission — silently missing channels), whereas a bad scenario is *optional authored enrichment* (just less behavior). So spec-load is fatal **independent of `strict`**, which governs scenarios only (§9; `strict` in `offbook-contracts.md` §1a, skipped-loud per `offbook-l2-scenarios.md` §7). *(A spec that parses but yields zero channels is not a load failure — it falls to Mode 2.)*
- **Mode 2 — Loads but asserts nothing → flag, don't fail.** A channel whose schema is **vacuous** (`{}`, `true`, or `type: object` with neither `properties` nor `required`) lets the client publish anything and validate **green** while the contract checked nothing — silent false confidence (worse than the *unknown-topic* case, which is already loud per §5). At load the tool flags each such channel as a non-fatal **`spec-load` Diagnostic** (`offbook-contracts.md` §5): *"channel X validates green but its schema constrains nothing — passing here is unverified."* Scoped tight to the **unambiguous** vacuous shapes — a conservative "asserts effectively nothing" check, **not** a graded quality score (grading deferred). Surfaced in `/diagnostics` + `offbook status`.
- **Mode 3 — Loads, complete, but stale vs the live service → undetectable; surface provenance.** The tool has only the spec, never a view of the running service (and gaining one would defeat developing *without* the backend), so it **cannot** detect that the spec lags reality. The honest response is **calibration, not detection**: it validates against the **spec as fetched**, so a green result is only as fresh as the spec. It surfaces each service's spec **source + age** (the lockfile's `fetched-at`, exposed as `SpecInfo.fetchedAt` on `GET /specs` + `offbook status`) **neutrally** — no arbitrary "N days = stale" threshold; the dev weighs it, and `offbook specs update` re-consumes. Spec age is also the signal that prompts the upstream **spec-owner dependency** (§1, *Who this is for*) to re-publish. *(Note: §7's existing "drift detection" — `info.version` vs requested — catches a wrong-version **mapping**, not staleness vs reality; these are different axes.)*

### The resolution chain (v2): semver → SHA → spec file

> **v1 readers can skip to §8.** Everything from here to the end of §7 is the v2 resolution layer (deferred). v1 uses only the branch stopgap (fetch the configured branch, default `main`) and `specs.lock`, behind the interfaces noted at the end of this section. Also note the open question in §12 (item 7) of whether this layer should be replaced by a schema registry.

The ideal resolution path is:

> **deployed semver → commit SHA → spec file at that SHA**

- **semver→SHA** is answered by existing release-management tooling (can be determined from a dev's machine).
- **SHA→file** is a universal git operation once the SHA is known.

**Normalize on the SHA as the universal pivot.** Once a SHA is in hand, "fetch a file at a commit" is identical across every repo, so all per-repo messiness is confined to the two end hops.

### Per-repo raggedness → declarative per-service config

Repos are run differently across teams: they are **inconsistent in how they cut versions** (tags vs release branches vs deployment manifests) and **where they place spec files** (root vs `docs/` vs `specs/v1/`, varying filenames/formats). The tool must be flexible here.

Approach: **declarative per-service config selecting from a small closed set of strategies**, e.g. a committed `services.yaml`:

```yaml
serviceA:
  repo: org/service-a
  versionToSha: { strategy: git-tag,         pattern: "v{version}" }
  specPath:     { strategy: fixed,           path: "asyncapi.yaml" }

serviceB:
  repo: org/service-b
  versionToSha: { strategy: release-branch,  pattern: "release/{version}" }
  specPath:     { strategy: glob,            pattern: "docs/**/asyncapi.{yaml,json}" }

serviceC:
  repo: org/service-c
  versionToSha: { strategy: deployment-manifest, source: "<...>" }
  specPath:     { strategy: fixed,           path: "specs/v1/spec.yaml" }
```

- Two small **strategy enums** (one per ragged hop). New service = new config block, not new code. Genuinely novel mechanism = add **one** reusable strategy to the enum.
- **Discipline:** a new strategy must be reusable in principle. Resist a config so expressive it becomes a scripting language, and resist hidden `if service == 'X'` special-casing. For true one-offs, provide an explicit **manual override** (`strategy: manual`, SHA supplied directly and recorded in the lockfile) — honest because it is visible and recorded.

### Semver does double duty

- **Range tolerance:** per-service resolution policy (`exact | minor | highest-lte`) so loosely-tagging teams still resolve ("highest tag `<=` deployed").
- **Drift detection:** after resolving, compare the spec file's `info.version` against what was requested. A mismatch means the per-service mapping is wrong — a loud, early, actionable error instead of a silently-wrong mock.

### `specs.lock` (build in v1, enrich in v2)

The result of resolution is always written down. The lockfile is both the **reproducibility guarantee** and the **debug surface for the resolution layer itself**. The per-service entry below is a **v2-rich illustration** — the **canonical v1 on-disk shape is `offbook-contracts.md` §6** (kebab-case, `resolution-strategy: branch`, the **full** `resolved-sha`, and no `resolved-version`); the extra fields shown here (`resolution-strategy: git-tag`, `resolved-version`) are **v2-only**:

```yaml
serviceA:
  requested-version: 1.4.7        # from environment (release tooling)
  resolution-strategy: git-tag    # which strategy ran
  resolved-version: 1.4.0         # after range policy (highest-lte)
  resolved-sha: a1b2c3d…          # the universal pivot — illustrative; v1 stores the FULL 40/64-hex sha, never abbreviated (contracts §6)
  spec-path: asyncapi.yaml        # where it was found
  declared-version: 1.4.0         # info.version, for the drift check
  content-hash: sha256:...        # exact bytes
  fetched-at: 2026-06-19T...
```

Benefits: reproducibility (rebuild the exact mock even if main moved), debuggability ("works on my machine" answered by diffing two locks; content-hash catches "same tag, changed file"), and **honesty** (records requested vs resolved, so any gap is auditable rather than silent). The content-hash makes two locks comparable at the byte level regardless of how each side resolved.

### Invariants & honesty

- **One running mock = one lockfile = one coherent environment snapshot.** A single instance is pinned to one resolved set; a Frankenstein of dev-serviceA + stage-serviceB is disallowed unless explicitly constructed. Two environments side-by-side = two processes/ports.
- **The tool must never lie about its own fidelity.** When running the v1 branch stopgap (no version pinning), the CLI must warn — naming the **actual per-service branches**, not a blanket `main` — that requested versions are recorded but not honored (e.g. "version pinning unavailable in v1: requested versions in `environments.yaml` are **recorded but NOT honored**; fetching branch tips (serviceA→main, serviceB→dev)") rather than pretend `--env` was honored. The same notice is exposed CI-assertably on `GET /v1/specs.warnings?` in branch mode (`offbook-contracts.md` §5), suppressed under `pinned`/`--frozen` (EQ2) — **both v2; v1 is always branch mode, so the notice always shows**.

### Forward-compatible seams (build into v1)

Even though v1 only implements the simplest path, design these interfaces now so v2 slots in behind them with no downstream change:
- **Resolver interface:** `resolve(repo, ref, specPath) → Promise<ResolvedSpec>`, implemented as `GitRefResolver` in **both** v1 and v2 (fetching a spec at a git ref is identical regardless of ref kind). The v1↔v2 difference is *ref selection*: v1 uses the per-service `branch` (default `main`); v2 resolves a requested semver → a pinned tag/sha. See `offbook-contracts.md` §6.
- **Version source:** `(environment) → {service: version}`, implemented in v1 as `StaticManifestSource` (reads a committed `environments.yaml`); v2 adds `ReleaseToolingSource`.
- Write `specs.lock` with fields that won't need restructuring later.

**Open boundary question for v2:** does the mock **call** the release tooling (another strategy) or **consume its output** (an `environment→{service:version}` map handed in as input)? To be settled when the release-tooling dependency is understood.

---

## 8. Connection Auth

- **v1: accept-all.** Aedes's `authenticate` hook accepts any credentials but still **receives and logs** them (so connections can be attributed in debugging).
- **Principle for later:** when real auth is understood, *mirror the handshake, not the validation* — the browser application's connect code path should run unchanged (same fields populated, same URL shape) so the real connection logic is exercised, but the mock should not actually validate tokens. The failure mode to avoid is a *different* dev connect path, which makes dev "work" while prod auth breaks late.
- **Action item:** capture exactly what the browser application passes to its MQTT client's `connect()` today (auth fields, ws URL shape). This single fact resolves the auth design and confirms the ws/QoS/retain test path.

---

## 9. Developer Ergonomics & Usage Moments

The tool is reached for at four distinct moments with different demands:

1. **Onboarding ("just cloned the browser application, want it to run").** Value = zero-to-running with one command, **no MQTT knowledge required** — the scoped promise: the L1 floor + automatic validation, with authoring a later opt-in tier (see *Who this is for*, §1). Needs **good defaults + retained initial state**. Failure mode: a blank UI and a dev who can't tell what's broken.
2. **Daily driver ("building against a service that isn't running locally").** Needs **fast iteration on behavior** (live hot-reload of L2 scenarios; L3 handler *code* changes auto-restart the process via `offbook up --watch` — data is live, code restarts, EH1) and a **manual publish** affordance to drive the UI by hand.
3. **Debugging ("reproduce a specific situation").** Needs **named scenarios fired on demand** and **reset to known state**; ideally record/replay later.
4. **Automated tests (CI / Playwright).** Needs a **scriptable, synchronous, deterministic** control plane: reset → publish → **settle** (`GET /v1/pending?wait`, the authoritative quiescence signal — one blocking call, no poll-with-timeout, EC1) → assert → teardown, with no random intervals firing mid-assertion.

**Key tension:** moment 1 wants lively/autonomous data; moment 4 wants dead-quiet determinism. Resolved by the §7 split (initial state always on; autonomous emission a seeded, toggleable mode) — seeding delivers liveliness *and* determinism at once.

### Discoverability is the make-or-break for daily use

The biggest ergonomic risk is a dev not knowing **what topics exist, what they may send, and what they'll get back** — exactly the knowledge currently trapped in copy-pasted constants. The tool should *become* the discovery surface: list every topic, its direction (rendered in human output as **"client receives"** for `toClient` / **"client sends"** for `fromClient` — EQ3), its payload shape, and its source service; and offer one-click "send a valid example" for "client sends" (`fromClient`) topics. If the mock answers "what can I talk to and how" better than grepping the codebase, devs will use it as living documentation. **Direction humanization is surface-wide:** every human-facing rendering — `offbook topics` and the `direction` field on the `/publish` response (`offbook-contracts.md` §5) — uses the "client receives/sends" labels, while `--json` and the `?direction=` API filter keep the frozen `toClient`/`fromClient` wire vocab; the renderer and `--receives`/`--sends` filter sugar live in `cli/` (see `offbook-ergonomics-cli-rendering.md`).

### CLI surface (Bun)

Bun chosen for fast startup (a CLI invoked constantly), native TS, built-in shell/arg handling, and running server + CLI from one toolchain with no build step. The CLI is a thin client over the HTTP control plane. Indicative commands:

- `offbook init [--dir .]` — scaffold a fresh project (the onboarding cold-start, EI1): writes, **only if absent** (re-run refuses, nonzero), `services.yaml` (`gitHost: <PLACEHOLDER>` + a commented example service), `environments.yaml` (a commented `service: version`), `scenarios/00-example.yaml` (the l2 §0 sample), an **empty `handlers/`** dir (so `up --watch` has a target), and a **`.gitignore`** that ignores the run-artifact dir (`.offbook/` — the runfile + `offbook.log`; `specs.lock` stays **tracked**); prints next steps (`set gitHost, then offbook up`). Does **not** scaffold `specs.lock` (generated by `up`).
- `offbook demo` — **zero-setup first value (the validation wedge witnessed on run #1, §1/§5).** Boots an *ephemeral* mock against a **bundled** demo spec (a fixture promoted to a shipped demo asset — no `services.yaml`, no git, no `runDir` writes), seeds populated state, then publishes a deliberately **off-contract** payload and shows it caught in `/validation` within seconds, with narration (*"↑ Offbook just caught a contract break that would have shipped silently"*). Ephemeral and self-tearing-down — distinct from `init`, which scaffolds a real project to adopt. This is the evaluation on-ramp that precedes moment 1 (and the only zero-git way to see the tool run, now that spec-load is fatal — §7).
- `offbook up [--watch] [--ci] [--strict]` / `offbook down` — lifecycle. **Two boot profiles over `DEFAULT_CONFIG`:** the **interactive default** (`wallClock=true` for human-perceptible timing, `mode=autonomous`, `strict=false` so a bad scenario surfaces in `/diagnostics` instead of crashing the dev's server), and **`--ci`** — the moment-4 one-flag CI boot that co-sets `mode=passive`, `wallClock=false` (fast-virtual; CI pays no real wall time), and `strict=true`, and forces `--watch` off; the determinism gate's *boots-passive* requirement (§5/contracts §3) **is** `--ci`, which then asserts `GET /mode==passive`. `--strict` exposes the fatal-scenario-load behavior on its own (e.g. while authoring) without the rest of the CI profile. *(`--frozen` — pinned spec resolution — is **v2**; v1 always fetches the branch tip, §7/§11.)* `--watch` (autonomous-only) restarts the server on `handlers/**/*.ts` changes so L3 code edits take effect without a manual `down && up` (EH1; off under `--ci`/`passive`). On a **fresh project** (empty `scenarios/`+`handlers/`), `up` prints one honest orientation line — *"N topics served from L1 schema-fakes (valid filler); author behavior in scenarios/\*.yaml (L2) or handlers/\*.ts (L3); discover: offbook topics"* — suppressed once ≥1 scenario/handler loads (EI2)
- `offbook topics` — discovery (the documentation-replacement win). Default render is a **compact human view** grouped by service: per topic, the human direction label (above), resolved qos/retain, a **per-field summary** (name · type · required-ness; enums as `a | b | c`, numeric bounds, `format`), and the seeded `example`. Composed schemas (`allOf`/`oneOf`/`anyOf`) flatten to the effective field set with `oneOf<…>` markers, deferring the full schema to `--schema`. `--compact`/`-q` collapses to one line per topic, `--no-examples` drops examples, `--json` emits the raw `TopicInfo[]`, `--service`/`--receives`/`--sends` filter (mapping to `?service=`/`?direction=`). It **never** prints raw JSON Schema by default (ER1).
- `offbook publish <topic> [--example | --payload <json> | --payload-file <path> | --payload -] [--qos N] [--retain] [--force] [--wait]` — hand-drive the UI; `--example` generates a schema-valid payload (and is the default when neither `--example` nor a `--payload*` source is given), the `--payload*` sources give an explicit body (mutually exclusive with `--example`, rejected locally to mirror the contract's `400 example-and-payload`). Publishing to a topic that matches **no channel** still publishes raw but **exits nonzero by default** — `--force` to allow the intentional off-contract case — printing `⚠ no channel matches '<topic>' — published raw (flagged in /validation)` (EQ1/EQ4). `--wait` (also on `scenario`) blocks until the emissions this action caused have settled (`GET /v1/pending?wait`), so a script needn't poll (EC1). `--qos`/`--retain` send explicit values that **override the channel's spec binding** (`body ?? channel`, contracts §3/§5); the CLI echoes the effective `qos`/`retain` and prints a one-line `⚠ off-spec override` when they differ from the binding, so an off-spec emit is never silent (also flagged in the divergence warn-log / `offbook logs`).
- `offbook state` — show retained values (see what the browser application sees)
- `offbook scenario <name> [--param k=v]... [--payload <json> | --payload-file <path> | --payload -] [--wait]` / `offbook reset` — debugging / test control; repeatable `--param k=v` binds the scenario's `{{param}}` captures and `--payload*` supplies the inbound payload (EQ4). *(The verb stays `scenario`, not `trigger` — CLI verbs are deliberately decoupled from endpoint names; this hits `POST /v1/trigger/{name}`.)*
- `offbook mode <autonomous|passive>` — the emission toggle (`passive` = no self-initiated emission; both modes are seeded-deterministic, so "passive", not "deterministic")
- `offbook validation` — view the contract-violation log. Default render is **one line per violation** — `#seq` · a severity glyph (`✗`/`⚠`) · origin · kind · topic · a **humanized headline** — closed by a footer `summary` line (errors/warnings · byOrigin · byKind · oldestSeq). For `kind:'schema'` the headline is composed from `errors[0]` (`payload.<instancePath>: <human keyword> (got <value>)`, the value read from `Violation.payload` at the path, dropped for missing-field cases) — **not** the terse `Violation.detail`, which stays stable for the determinism projection (EQ6); other kinds print their already-human `detail`. `-v` expands each with `channel`/`clientId`, the decoded `errors[]`, and a payload excerpt; `--json` is the raw `GET /v1/validation` body; `--since`/`--origin`/`--kind`/`--severity` map to the query params. The per-violation renderer is a **reusable function**, so `--watch [--interval 500ms]` polls `?sinceSeq=<last>` and prints new violations live as they arrive (client-side, no streaming API — EO3) (ER2).
- `offbook diagnostics [--watch]` — view static load/config issues (`GET /v1/diagnostics`): `scenario-load`, `overlap`, `spec-load`, `uninstantiated` (EQ5); `--watch` polls for new entries live, like `validation` (EO3)
- `offbook logs [-f] [-n N]` — read (or `-f` tail) the detached server's `<runDir>/offbook.log` (resolved from the runfile): ws connects, §8 credentials, hot-reload + `--watch` restart notices, autonomous emissions (EO1/EO2)
- `offbook status` — one-shot overview: running?/pid/ports, mode + seed, each service's `resolutionMode` + short-SHA + channel count, and the `/validation` summary (composes the runfile + `/mode` + `/specs` + `/validation`); `not running` + nonzero exit when the control plane is down (EO4)
- `offbook specs update` — refresh specs (keep this low-friction to prevent rot)
- *(v2)* `offbook up --env=<env>`, `offbook specs resolve --env=<env>` (dry-run resolution table)

### Control plane (HTTP, side port)

Indicative endpoints (substrate the CLI wraps): `GET /topics`, `GET /state`, `POST /publish`, `POST /trigger/{name}`, `POST /reset`, `POST /mode`, `GET /mode`, `GET /validation`, `GET /specs`, `GET /diagnostics`. **Now pinned — request/response shapes, the `/v1` prefix, and conventions — in `offbook-contracts.md` §5.** A `resolve` dry-run surface lands in v2.

---

## 10. L2 Scenario Authoring Process — RESOLVED (see `offbook-l2-scenarios.md`)

> **Resolved (P0).** This was the most load-bearing open thread — L2 is the layer developers actually write, and if authoring is tedious the tool never gets enriched past the L1 floor. It is now **decided in `offbook-l2-scenarios.md`** (status: *Decided*), which is **canonical for the authoring format** and unblocks handoff Step 2.8. The questions below are kept as an *answered* checklist; the authoritative detail lives in that doc.

Questions — all answered in `offbook-l2-scenarios.md`:

- **File format** → YAML, one scenario per file under `scenarios/`, discovered by directory.
- **Matching** → topic pattern with `{param}` capture (plus MQTT `+`/`#`) and optional `payloadMatch` subset-equality; `when` matches only `fromClient` publishes.
- **Templating** → `{{param}}` / `{{payload.x}}` / helpers; the templating-vs-L3 boundary is drawn at **"no operators"** (`gt`/regex/ranges are the L3 signal).
- **Timing expression** → per-step `delay` (constant or seeded-ranged), with the **step as the unit** so v2 adversarial-timing properties stay additive.
- **Validation at author-time** → response payloads validated against the spec **at load** (consistent with §5's correctness bar).
- **Loading & hot-reload** → directory discovery; L2 *data* hot-reloads, L3 *code* reloads by supervised restart (`up --watch`, EH1).
- **Determinism hooks** → named scenarios triggered/reset via the control plane; seeding interacts with scenario timing through the engine's seeded clock.

---

## 11. v1 / v2 Split (Decision)

### v1 — the fidelity core
**Goal:** kill the three pains (contract drift, async unrealism, manual rot) against a **single spec version**, shipped soon. Scope:

- Aedes (ws + tcp, MQTT 3.1.1, QoS1 + retain) — §3.
- Layered behavior L3→L2→L1: L1 spec-valid floor, L2 scenarios with seeded `delay` — §4, §6.
- Bidirectional contract validation, surfaced loudly — §5.
- Spec ingestion via the **branch stopgap only** (configured branch, default `main`), built behind the resolver/version-source interfaces — §7.
- `specs.lock` from day one — §7.
- HTTP control plane + Bun CLI — §9.
- Initial state always retained; seeded autonomous-emission mode — §7.

**Explicitly deferred out of v1:** semver→SHA→file resolution, per-service strategy config, `--env`, frozen-mode reproducibility (`up --frozen` by-SHA reader + F17), real auth validation, release-tooling auto-detect integration, adversarial timing, graded spec-quality scoring + coverage instrumentation.

### v2 — the resolution layer & enhancements
**Goal:** sharpen cross-environment fidelity once the core is proven and the release-tooling dependency is understood.

- Three-hop resolution (semver→SHA→file) on SHA-as-pivot.
- Per-service declarative strategy config + manual override; semver range tolerance + `info.version` drift-check.
- `--env` in CLI; `offbook specs resolve` dry-run; **the `up --frozen` by-SHA reader + F17 history-walk** (the reproducibility guarantee made real — v1 records `resolved-sha`, v2 reads it back); richer per-hop lockfile entries.
- Adversarial timing primitives (ordering, duplicates, reorder, drop-redeliver) — additive on the v1 step model.
- **Spec-quality grading + coverage instrumentation** — graded schema-strength scoring (beyond v1's binary vacuous-schema flag, §7 Mode 2) and an observed-topic **coverage rollup** (% of exercised topics resolving to a meaningful matching channel). v1 ships only the binary vacuous flag + per-message `unknown-topic` violation.
- All slotting behind the interfaces v1 already designed for, so nothing downstream changes.

**Rationale for the split:** the core pains (contract drift + async realism) are all solvable against a *single* spec version; they do not require the resolution machinery. The per-environment resolution layer addresses a second-order concern ("behaves differently across environments") whose root cause is largely the drift itself. Treating resolution as v1-blocking risks v1 never shipping; treating it as a v2 enhancement ships a useful tool soon and verifies the release-tooling dependency off the critical path.

---

## 12. Outstanding Action Items / Risks

1. **Verify the transport/WS-fidelity spike (highest priority de-risk).** Point the real browser application's MQTT client at a bare Aedes ws listener and confirm it connects, subscribes, and receives a retained message **using the same protocol level (MQTT 3.1.1), WS path, subprotocol, and auth shape it uses against the prod fork**. This is now specifically the probe for the one suspected divergence (the fork's WebSocket transport, §3). If the browser application connects unchanged, the fork's WS behavior is close enough and you're clear; if not, you've found the divergence cheaply on day one and can bend Aedes's listener/hooks to match.
2. **Capture the browser application's actual `connect()` call** (auth fields, ws URL/path, subprotocol, exact protocol level — confirm 3.1.1 vs the older 3.1) — resolves auth design (§8) and feeds the spike above. Also note whether the browser application/services use **QoS 2** anywhere (the contract allows 0/1/2 per `offbook-contracts.md` §1; QoS 2 is latent capacity until confirmed), and capture each topic's **QoS/retain** so the spec-binding-vs-observed divergence warn-log (P1.D4 tier-3) has a baseline.
3. **Understand the release-management tooling** that maps environment → deployed semver, and decide the boundary: does the mock *call* it or *consume its output*? (§7) — gates v2 resolution.
4. **Validation correctness** is the tool's credibility (§5). Concentrate engineering care on the AsyncAPI-parser + Ajv path; do not hand-roll schema interpretation; test against external-`$ref`/`$id` specs.
5. **L2 authoring format** (§10) — **Resolved** in `offbook-l2-scenarios.md` (the dedicated pass is done); it was the thread most determining whether v1 *feels* right.
6. **Stage-0 adopt-vs-build check.** **Resolved — verified via external research + Microcks/Specmatic source-code reading (2026-06): the build is justified, scoped to the gap below.** Neither tool covers the combination off-the-shelf:
   - **Microcks** (CNCF-incubating since 2026-05-07) is a provider-side **mock *emitter*** + on-demand conformance tester. Source confirms its MQTT producer speaks native MQTT/**TCP** via Paho (`tcp://`, no `ws`/`wss`) to an *external* broker (tested against ActiveMQ Artemis + Mosquitto, MQTT 3.1.1); its standalone "WebSocket" binding is **raw Jakarta WebSocket, not MQTT-over-WS** (a browser `mqtt.js` client cannot use it); and its producers are **emit-only** (the WS `OnMessage` handler is a no-op). The only inbound check is a **bounded, on-demand provider-conformance test** — not loud, continuous validation of what a *client* publishes.
   - **Specmatic** does bidirectional AsyncAPI contract testing, but as a **CI runner** over native MQTT **tcp/ssl** only (no MQTT-over-WS; its in-memory broker is **Kafka-only**, so MQTT needs an external Mosquitto), it is **stateless** schema/correlation-id conformance (no stateful templated scenarios, no timing/fault injection), and MQTT-AsyncAPI is a **commercial Enterprise** feature — not a live local mock a browser application connects to.
   - **Unserved core (confirmed not covered by either):** *embedded in-process broker · MQTT-over-WS for a browser application · loud continuous browser-app→service validation · stateful templated request/response scenarios · MQTT-semantic timing/fault injection.* This is exactly Offbook's scope, so building is justified.
   - **Reuse rather than rebuild:** AsyncAPI schema validation (already adopted via `@asyncapi/parser` + Ajv, §5) and the provider-conformance pattern (maps onto the "CI asserts on the `/validation` log" idea, §5). Note too that Microcks' own MQTT path depends on an *external* standard broker's WS listener for browser reach — precisely the role Aedes plays here (§3), so even the off-the-shelf tool implicitly needs the component we're building.
   - **Residual action / caveat:** both tools move fast (Specmatic added MQTT-AsyncAPI ~Q1 2026; its Kafka-only in-memory-broker limit is hedged "currently"). The remaining spike is *ergonomic/coverage fit against the real specs*; re-verify these capability boundaries before committing to build.
7. **Shrink-or-defer the v2 version-resolution layer.** **Resolved — verified via external research (2026-06): keep `specs.lock`; use a registry or per-commit pinning for *storage*; the environment→deployed-version *binding* is the genuinely novel part and is NOT redundant with a registry.** Findings:
   - **Apicurio Registry** (self-hosted, OSS) supports AsyncAPI as a first-class artifact type with immutable versioning and three content-rule types (validity, compatibility, integrity) — so it can replace the **storage/versioning/governance** half. Caveat: for AsyncAPI *specifically* it only does **syntax-only validity**; compatibility enforcement is unimplemented (Apicurio issue #16, open since 2019). Not a problem here — we get contract enforcement from our own bidirectional validation (§5).
   - **The load-bearing finding:** no schema registry or software catalog (Apicurio, Confluent Schema Registry, Apollo, Backstage) natively tracks *which spec version is deployed in which environment*. That binding is universally externalized to GitOps / deployment config / CI (e.g. a digest pinned in an env var, a git branch per environment). So our **deployed-semver→SHA→spec-at-SHA resolution layer is not redundant** with a registry — a registry replaces only the storage half.
   - **Net:** the over-engineering risk is real for the *storage* concern (prefer Apicurio or simple per-commit pinning via submodule/vendored copy there); the *resolution/environment-binding* half is the part worth building. Keep the content-hashed `specs.lock` regardless — it is the direct analog of digest-pinning.
