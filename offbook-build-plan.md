# Offbook — v1 Build Plan (P2)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (frozen interfaces — the synchronization point), `offbook-l2-scenarios.md` (L2 authoring), `offbook-design.md` (rationale). This is the scaffold + parallelization + acceptance plan for building v1. Fixtures live in `fixtures/asyncapi/` (P3).

**Status:** ready to build. The contracts are frozen, so the modules below fan out to independent agents behind their interfaces.

---

## 1. Tech stack (decided)

| Concern | Choice | Notes |
|---|---|---|
| Runtime / toolchain | **Bun** | server + CLI from one toolchain, native TS, no build step (§9) |
| Language | **TypeScript** | strict |
| Test runner | **`bun test`** | built-in, zero-dep |
| Lint / format | **Biome** | single fast tool |
| Control-plane HTTP | **Hono** | tiny, typed routing, Bun-native |
| Broker | **Aedes** | ws + tcp, MQTT 3.1.1 (§3) |
| AsyncAPI | **`@asyncapi/parser`** (3.x) | parse + validate; dereferences `$ref` before validating (§5) |
| Schema validation | **Ajv** 8 + `ajv-formats` | runtime payload validation |
| Fake data | **`json-schema-faker@0.6.2`** | pinned exact; seeded (Mulberry32); Ajv-recheck before emit (§4) |
| YAML | **`yaml`** | config + scenario + spec parsing |
| Git fetch | **shell out to `git`** | host-agnostic; shallow-fetch / `git archive` one file at a ref; reuses existing creds |

> Pin exact versions at scaffold time; `json-schema-faker` is pinned to **0.6.2** per §4 (the rewrite is recent — lean on the Ajv recheck). `json-schema-faker`'s `faker`/`chance` are optional extensions and **not** needed (the Mulberry32 seed covers determinism).

## 2. Repo scaffold

Single package, separate repo (§3). **Two structural disciplines enforce the architecture:**
1. **`src/model/` holds the P1 contract types**; every other module imports from it. It is Tier 0 — land it first, then freeze.
2. **`src/broker/` is the only module permitted to import `aedes`** (or any MQTT/transport package). A lint rule (Biome `noRestrictedImports`, or a CI grep) forbids `aedes` imports anywhere else — this is §3's transport-isolation made mechanical.

```
offbook/
  package.json  tsconfig.json  biome.json  Dockerfile  .dockerignore  README.md
  bin/offbook                      # CLI entry (shebang → Bun)
  src/
    model/        # NormalizedMessage, InboundEvent, Channel, Direction, Violation, SchemaError,
                  #   ServiceConfig, ResolvedSpec, Resolver, VersionSource, Handler, HandlerContext … (P1)
    broker/       # BrokerModule over Aedes — ONLY importer of aedes
    registry/     # SpecRegistry: @asyncapi/parser → Channel[] (+ compiled Ajv validators), direction normalize
    ingestion/    # GitRefResolver, StaticManifestSource, lockfile writer, services/environments loaders
    engine/       # scheduler (virtual clock + seeded PRNG), dispatch (trigger paths), L1 faker, L3 registry
    scenarios/    # L2: loader, sorted-path dispatch table, matcher, templating, author-time validation
    validation/   # Violation production, three-tier surfacing (/validation, /diagnostics, warn logs)
    control-plane/# Hono app: /v1/* endpoints, error envelope
    cli/          # thin client over the control plane
    config/       # seed, ports, mode defaults, file paths
  fixtures/asyncapi/   # P3 sample specs (test material)
  scenarios/           # example L2 scenarios (sample, hot-reloaded)
  test/                # or co-located *.test.ts
```

### Port map (all configurable; defaults)
| Listener | Default | Notes |
|---|---|---|
| Broker **ws** (SPA connects) | `9001` | **must match the SPA's connect URL** — confirm in the §12.2 spike |
| Broker **tcp** | `1883` | standard MQTT |
| Control plane (side port) | `9080` | HTTP `/v1/*`; localhost only |

## 3. Work breakdown & dependency graph

Behind the frozen contracts, work fans out in tiers. Each task lists its **dependencies** and a **self-checkable acceptance criterion**.

### Tier 0 — foundation (land first, then freeze)
- **`model/`** — transcribe the P1 contract types verbatim. *Accept:* `tsc` clean; every type in `offbook-contracts.md` §1–6 present and exported. *(One agent, fast. Everything below imports this.)*

### Tier 1 — parallel (depend only on `model/` + libs)
- **`broker/`** — Aedes ws+tcp bootstrap; `onInbound`/`onSubscribe`/`emit`/`getState`/lifecycle; accept-all auth + credential log (§8); byte codec; decode-failure → `payload:undefined`+`meta.decodeError`. *Accept:* a browser-style `mqtt.js` client connects over ws (MQTT 3.1.1), subscribes, and receives a retained message; QoS-1 publish round-trips with the DUP-on-redelivery contract intact; a non-JSON publish surfaces (not crashes) and is still delivered raw.
- **`registry/`** — `@asyncapi/parser` → `Channel[]` with **direction normalized onto the channel** (v3 `send`→`toClient`, `receive`→`fromClient`; v2 `subscribe`→`toClient`, `publish`→`fromClient` — i.e. `publish` = the service *receives* ⇒ the client publishes; see §5) + compiled Ajv validators + resolved qos/retain (binding precedence, §2). *Accept:* parses **all** `fixtures/asyncapi/*` including `external-ref` + `qos-retain`; channel directions correct for both v2 and v3 fixtures; validators reject known-bad payloads — **this is the §5 correctness bar**.
- **`ingestion/`** — `GitRefResolver(repo, ref, specPath)`, `StaticManifestSource`, `specs.lock` writer (full `resolved-sha`, `content-hash`, `resolutionMode: branch`). *Accept:* fetches a fixture spec at a branch tip; lockfile records full sha + content-hash; re-run with the same HEAD is byte-identical; honesty warning names the branch.

### Tier 2 — depend on Tier 1
- **`engine/`** — deterministic scheduler (single virtual-clock event loop, awaits `broker.emit` for ordered delivery), seeded Mulberry32 PRNG, two-trigger-path dispatch (§3), L1 faker (json-schema-faker seeded + Ajv-recheck), L3 factory registry. *Accept:* same seed ⇒ byte-identical emission stream + timings; L1 output always Ajv-valid (oneOf edge caught by recheck → `mock` violation, never silent); `reset` restores known state + re-seeds + re-instantiates L3.
- **`validation/`** — produce `Violation` records (kinds, `client`/`mock` origin, structured `SchemaError`); three-tier surfacing. *Accept:* a client off-contract publish → a `schema`/`client` `Violation` with correct `errors[]` while **delivery is not blocked** (observe-and-surface); a malformed payload → `decode` violation; a wrong-direction publish → `direction` violation.

### Tier 3 — depend on Tier 2
- **`scenarios/`** (L2) — per `offbook-l2-scenarios.md`: glob+sorted-path dispatch table, `{param}` matcher + `payloadMatch`, `{{…}}` templating + seeded helpers + L1 autofill, author-time validation → `/diagnostics`, hot-reload. *Accept:* the running-example scenario matches, binds params, templates a response with a seeded ranged delay reproducibly; an overlapping scenario emits a `/diagnostics` overlap warning; a malformed scenario is skipped-loud in dev / fatal in strict.
- **`control-plane/`** — Hono `/v1/*` per `offbook-contracts.md` §5; error envelope; reads + actions + `/mode` + `/diagnostics`. *Accept:* contract test per endpoint; the `reset → publish → poll /validation?sinceSeq=` CI flow returns the expected violation slice; `/publish` infers direction from the channel.

### Tier 4 — thin
- **`cli/`** — Bun CLI, thin client over the HTTP API. **Can start early against the API contract** (stub the server). *Accept:* `offbook up/down/topics/publish/state/scenario/reset/mode/validation/specs update` each hit the right endpoint and render the response.

### Cross-cutting (any time)
- `config/`, the `aedes`-import lint rule, the Dockerfile (`oven/bun` base), CI wiring (lint + `bun test` + the §5 fixture suite).

## 4. Acceptance gate for v1 (the scope line, from the handoff)
All of the handoff's v1 checklist, each with a passing test. The **non-negotiable** ones:
- **§5 validation correctness** — registry + validation green against `external-ref` and `qos-retain` fixtures (false-positive/false-negative are tool-killers).
- **Determinism** — same seed ⇒ identical emission stream + timings + violation ordering (`bun test` re-run stable).
- **Transport isolation** — the `aedes`-import rule passes (no module but `broker/` imports it).
- **Observe-and-surface** — no validation path ever blocks delivery.

## 5. The de-risking spikes (P4 — runnable in parallel now)
These gate/scope the build and are **not** on the module critical path — run them first/alongside (§12.1–2, §12.6):
1. **WS-fidelity spike** — point the real SPA's `mqtt.js` at a bare Aedes ws listener; confirm connect+subscribe+retained receipt at the SPA's actual protocol level/path/subprotocol/auth. *Artifact:* go/no-go + any Aedes listener config; feeds `broker/`.
2. **Capture the SPA's `connect()`** — auth fields, ws URL/path, subprotocol, protocol level; note any **QoS 2** use. *Artifact:* a config fixture + the broker ws port default.
3. **Adopt-vs-build** — already resolved (build justified, §12.6); the residual is an ergonomic fit check against the real specs, not a blocker.

---

*Fixtures (P3): see `fixtures/asyncapi/README.md` for what each spec exercises.*
