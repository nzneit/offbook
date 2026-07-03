# External adversarial AsyncAPI sources

Companion to [`README.md`](./README.md) (the curated fixtures + the **§5 fixture quality bar**). The `README.md` fixtures are **hand-authored** and minimal — one deliberate edge each. **This memo lists real-world, public specs** to use as an *external pressure-test corpus*: run the `registry/` → Ajv → `json-schema-faker` pipeline against messy specs authored by other people, not just our clean curated set. It also records **what genuinely cannot be sourced** and therefore must stay hand-authored.

Sourced via a verified web hunt (2026-06-30); every `raw.githubusercontent.com` URL below was fetched and returned content. **Honesty note:** seams 1–2 are well-served by real corpora; seam 3 (standard `bindings.mqtt`) is thin (mostly `qos`, rarely `retain`); seam 4 (vacuous) has essentially one real positive; **MQTT-over-WebSockets AsyncAPI does not exist in the wild** — see *Gaps*.

**Why external corpora matter (design §12.1a):** the build environment is air-gapped from the real specs. These public specs approximate the messiness of the real corpus so the pipeline's fragile seams get exercised *before* the corpus audit runs. They do **not** substitute for that audit — only the real specs confirm the org's actual binding/transport conventions.

## The four fragile seams (why each is here)
1. **External `$ref` / `$id` / sibling-keyword** — the parser bundles/dereferences before validating; `$id` base-URI handling is surprising. The #1 silent-wrongness trap (design §5, §12.4).
2. **Composed `allOf`/`oneOf`/`anyOf`** — `json-schema-faker`'s documented weak spots; these must make the **Ajv-recheck-after-fake** safety net (design §4) actually fire.
3. **MQTT bindings** (`bindings.mqtt` qos/retain, server bindings) — the transport-specific tier of the qos/retain precedence chain (contracts §2).
4. **Vacuous / assertion-free channel schemas** — real positives for the Mode-2 "validates green but constrains nothing" detector (design §7).

Maps onto the curated fixtures: seam 1 → `external-ref.yaml`, seam 2 → `composition.yaml`, seam 3 → `qos-retain.yaml`/`qos-overrides.yaml`, seam 4 → *(no curated fixture yet — author per Gaps)*.

---

## Seam 1 — external `$ref` / `$id` (best-served)

| Source | Raw URL | Ver | License | Assessment |
|---|---|---|---|---|
| **JSON-Schema-Test-Suite** `refRemote.json` **(top pick)** + its `remotes/` companions | `raw.githubusercontent.com/json-schema-org/JSON-Schema-Test-Suite/main/tests/draft2020-12/refRemote.json` · remotes: `…/main/remotes/` (`baseUriChangeFolder/folderInteger.json`, `baseUriChange/`, `nested/`, `draft2020-12/`) | JSON Schema (2020-12; `draft7`/`draft2019-09` subdirs too) | MIT | **Definitive oracle, not nominal.** Named cases for every silent-wrongness variant: "base URI change - change folder in subschema", "retrieved nested refs resolve relative to their URI not $id", "$ref to $ref finds detached $anchor", "Location-independent identifier in remote ref". Use as pass/fail oracle for the bundler/dereferencer. Companions in same dir: `ref.json`, `defs.json`, `anchor.json`, `dynamicRef.json`. |
| **asyncapi/spec** `examples/social-media/` (entry `backend/asyncapi.yaml`; shared `common/{messages,schemas,servers,parameters}.yaml`; + `frontend`/`comments-service`/`notification-service`/`public-api`) | `raw.githubusercontent.com/asyncapi/spec/master/examples/social-media/backend/asyncapi.yaml` (+ `…/social-media/common/schemas.yaml`) | 3.1.0 | Apache-2.0 | **Real multi-file dereference (seams 1+3).** 2-level relative `$ref` chain (`backend` → `../common/messages.yaml#/…` → `./schemas.yaml#/…`) + the classic **sibling-keyword trap** (`allOf: [{$ref: '#/commentId'}, {description: …}]` inside an externally-ref'd file). Also an `mqtt` server (`servers.mosquitto`, `clientId` binding) alongside a `ws` server. Caveat: relative-path refs only (no absolute `$id` rewrite) — pair with JSTS for the `$id` half. |

## Seam 2 — composed `allOf`/`oneOf`/`anyOf` (well-served)

| Source | Raw URL | Ver | License | Assessment |
|---|---|---|---|---|
| **Kraken** WebSocket example **(top pick)** (sibling `…-multiple-channels-asyncapi.yml`) | `raw.githubusercontent.com/asyncapi/spec/master/examples/kraken-websocket-request-reply-message-filter-in-reply-asyncapi.yml` | 3.1.0 | Apache-2.0 | **Real faker-breaker.** `oneOf`-of-`allOf`-over-`$ref` with **const-based discrimination**: `subscriptionStatus` = `type:object` *sibling-to* `oneOf:[error, success]`, each branch an `allOf` of an inline object + a `$ref` to a shared base that `const`-tags `event`. JSF may fill the wrong branch / violate the const → exercises the Ajv recheck. |
| **Gemini** WebSocket example | `raw.githubusercontent.com/asyncapi/spec/master/examples/websocket-gemini-asyncapi.yml` | 3.1.0 | Apache-2.0 | Same strong pattern: `market` = `type:object` + `oneOf:[heartbeat, update]`, each `allOf:[{const-tagged inline}, {$ref default}]`; `additionalProperties:false` on array items; minor `ws` binding. Strong second stress fixture. |
| oneof/anyof examples (2.x + 3.x) — **syntax coverage only** | 3.1.0: `…/spec/master/examples/oneof-asyncapi.yml`, `…/anyof-asyncapi.yml` · 2.6.0: `…/spec/v2.6.0/examples/oneof.yml`, `…/anyof.yml` | 3.1.0 / 2.6.0 | Apache-2.0 | **Nominal only — do not rely on for depth.** Flat `oneOf`/`anyOf` of two single-property objects; no nesting/discriminator/const. Value = 2.x-vs-3.x keyword syntax coverage. (For pure-schema depth use JSTS `allOf.json`/`oneOf.json`/`anyOf.json`, MIT, same base as seam 1.) |

## Seam 3 — MQTT bindings (thin in the wild)

| Source | Raw URL | Ver | License | Assessment |
|---|---|---|---|---|
| **Streetlights MQTT** (2.x — `subscribe`/`publish`) | `raw.githubusercontent.com/asyncapi/spec/v2.6.0/examples/streetlights-mqtt.yml` | 2.6.0 | Apache-2.0 | Real standard binding but **shallow**: `server.protocol: mqtt` + operation-trait `bindings.mqtt.qos: 1`. **No `retain`, no server binding, no lastWill/expiry.** Good for "does the normalizer read `bindings.mqtt.qos` off a 2.x trait." Also anchors the **v2 direction inversion**. |
| **Streetlights MQTT** (3.x — `send`/`receive`) | `raw.githubusercontent.com/asyncapi/spec/master/examples/streetlights-mqtt-asyncapi.yml` | 3.1.0 | Apache-2.0 | Same shallowness (`qos: 1` only). Use as the 3.x-shape twin for the version-normalization fork. |
| **asyncapi/bindings** `mqtt/README.md` — canonical **full** binding shapes (snippets, *not* a parseable spec) | `raw.githubusercontent.com/asyncapi/bindings/master/mqtt/README.md` | binding 0.2.0 | Apache-2.0 | The authoritative shapes to **copy into a hand-authored fixture**: server `{cleanSession, lastWill:{topic,qos,message,retain}, keepAlive, sessionExpiryInterval, bindingVersion:0.2.0}`; operation `{qos:2, retain:true, messageExpiryInterval:60, bindingVersion:0.2.0}`. |
| project-flogo MQTT | `raw.githubusercontent.com/project-flogo/asyncapi/master/examples/mqtt/asyncapi.yml` | 2.0.0 | BSD-3 | ⚠ Bindings are `flogo-mqtt` (vendor extension), **not** standard `bindings.mqtt` — will *not* exercise the mqtt-binding parser. Real value is seam 4 (below) + an authentically messy 2.0.0 doc (`id: urn:…`, `x-*` extensions). |

## Seam 4 — vacuous / assertion-free (worst-served)

| Source | Raw URL | Ver | License | Assessment |
|---|---|---|---|---|
| **project-flogo MQTT** — the only real AsyncAPI positive | `raw.githubusercontent.com/project-flogo/asyncapi/master/examples/mqtt/asyncapi.yml` | 2.0.0 | BSD-3 | **Genuine true-positive:** `components.schemas.message: { type: object }` — no `properties`/`required`/`additionalProperties`; both channels bind it. Exactly the "validates green, constrains nothing" case. |
| JSTS `boolean_schema.json` | `raw.githubusercontent.com/json-schema-org/JSON-Schema-Test-Suite/main/tests/draft2020-12/boolean_schema.json` | JSON Schema | MIT | Tests `true` (accepts all) / `false` (accepts none) vacuity at the schema level (not an AsyncAPI payload). |

**Confirmed non-vacuous — do NOT use as positives:** `simple-asyncapi.yml`, `mercure`, `rpc-client`/`rpc-server`, `correlation-id`, `application-headers`, `slack-rtm`, `gitter` (all have real `properties`; the rpc `queue: {}` is an AMQP binding, not a payload).

---

## Gaps — must hand-author (no usable public source)

1. **MQTT-over-WebSockets AsyncAPI — genuinely absent.** AsyncAPI models `protocol` as a single value per server (`mqtt` OR `ws`), and the `ws` binding is for *raw* WebSocket APIs; there is **no standard idiom for MQTT-tunneled-over-WS** — which is Offbook's exact target. Hand-author it and **decide the normalization rule** (candidates: `protocol: wss` + `bindings.mqtt`, or `protocol: mqtt` + a `bindings.ws` server binding). No public spec will validate this choice — the **corpus audit (design §12.1a)** confirms how the org's real specs actually represent it. *(This absence is consistent with design §3/§7: specs describe payloads, not broker transport — so it is expected, not alarming.)*
2. **A full parseable MQTT-binding spec** with `retain: true` + `messageExpiryInterval` + server `lastWill`/`keepAlive` — real specs top out at `qos: 1`. Assemble from the `asyncapi/bindings` snippets (seam 3, row 3) so retain/expiry/lastWill flow through the whole pipeline. *(Partially covered today by the hand-authored `qos-retain.yaml`.)*
3. **Vacuous variants beyond `type: object`:** channels whose payload is `{}`, `true`, and a message with **no `payload` key at all** (AsyncAPI's default-to-anything). Only the `type: object` variant exists publicly.
4. **Nested `oneOf` with the formal `discriminator` keyword** — real specs (Kraken/Gemini) discriminate via `const`-tagged fields, not `discriminator`. If Offbook adds discriminator-specific handling, author a 2–3-level nested `oneOf` using explicit `discriminator`.

## Vendoring
All sources are permissively licensed (MIT / Apache-2.0 / BSD-3), so small specs may be **vendored** here with attribution + a note of the upstream raw URL and commit. Prefer pinning a commit SHA over `master`/`main` in any vendored copy (upstream moves). Keep JSTS files under their MIT header unmodified when copied.
