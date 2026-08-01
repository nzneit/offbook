# AsyncAPI test fixtures

Representative specs for developing and testing `registry/`, `validation/`, and the L1 faker. Each exercises a deliberate edge — together they are the **§5 validation-correctness bar** the build must pass before CI trust.

| File | AsyncAPI | Exercises |
|---|---|---|
| `thermostat.yaml` | 3.0.0 | Both directions (`fromClient` command + `toClient` state), topic params, enums — the running example |
| `composition.yaml` | 3.0.0 | `allOf` / `oneOf` (const-discriminated) / `anyOf` — json-schema-faker weak spots; the Ajv recheck must catch non-conforming output (§4). The oneOf sits on **both** a `send` (toClient) and a `receive` (fromClient) operation, so the hard schema is validated on the client-publish path too |
| `external-ref.yaml` + `shared/common.yaml` | 3.0.0 | External `$ref` across files + `$id` base URI — the parser bundling/dereference correctness bar (§5, §12.4). Also carries a `$ref` **sibling keyword** (`minLength`), which is **correctly not enforced**: draft-07 is the dialect both majors declare and the one offbook validates under, and draft-07 ignores keywords beside a `$ref`. Dialect-correct behavior rather than a limitation (D-018 supersedes D-005), pinned by a tripwire test so a future dialect change starts enforcing it loudly |
| `v2-pubsub.yaml` | 2.6.0 | `publish`/`subscribe` — the perspective inversion on the **older** major |
| `qos-retain.yaml` | 3.0.0 | MQTT operation bindings declaring qos/retain — the **binding** tier (tier 1) of the precedence chain (P1.D2) |
| `multi-format.yaml` | 3.1.0 | The explicit Multi Format Schema Object payload (`{schemaFormat, schema}`) on **both** a `send` and a `receive` operation — the wrapper the parser returns verbatim, which made the validator accept everything (D-018). Also the newest-supported-major acceptance fixture |
| `v2-oldest.yaml` | 2.0.0 | The **floor** of the supported range: `publish`/`subscribe` inversion plus a 2.x mqtt operation binding at `qos: 2` (2.x validates bindings not at all, so offbook checks them itself) |
| `qos-overrides.yaml` | 3.0.0 | toClient channels with **no** binding — the **config** tiers: a `topicOverrides` per-topic override (tier 2, here `qos 0` — distinct from both global `qos 1` and the per-service default `qos 2`) beats a `qosDefault`/`retainDefault` per-service default (tier 3), via a paired `services.yaml` (`docs/specs/contracts.md` §2/§6, gap G13) |

## Direction mapping the registry must produce
Normalize once onto the `Channel` record (§5, `docs/specs/contracts.md` §1). Note the two majors feel opposite:

- **v3** `send` → `toClient` · `receive` → `fromClient`
- **v2** `subscribe` → `toClient` · `publish` → `fromClient`

(In every fixture the *documented application is the SERVICE*; the browser application is the client/counterparty.)

## Supported AsyncAPI versions
offbook supports **2.0.0 through 2.6.0, 3.0.0, and 3.1.0** (D-018); 3.1.0 is the recommended authoring target. AsyncAPI 1.x is refused: convert it first. Fixtures should stay within this range, and the range itself is pinned by a test over `SUPPORTED_SPEC_VERSIONS`.

## Fixture quality bar (author + review checklist)

A fixture's job is to *test something*, so it must clear these — the **"does this actually test what it claims?"** bar. Apply it both when adding a fixture and as a distinct review angle (the validity-only angle misses all of these):

1. **No vacuous values.** Anything meant to exercise a behavior must **differ from the default/trivial outcome**, or a no-logic implementation passes anyway. *(Trap: a binding `qos: 1` when the global default is already `qos 1` — the precedence assertion proves nothing. Use a value that differs, e.g. `qos: 2`.)*
2. **Claim ↔ content match.** Whatever the fixture's description says it exercises must be **structurally present**. *(Claim "`$ref` sibling keyword" → there must be a `$ref` with a sibling; claim "oneOf trap" → mutually-exclusive branches must actually exist.)*
3. **Full-path coverage.** A hard case must sit on **every path that processes it**, or the gap is documented. *(A oneOf / external-`$ref` schema only on a `toClient` operation leaves client-publish (`fromClient`) validation of the hard case untested end-to-end.)*
4. **Internal consistency.** `port` ↔ `protocol`, declared `schemaFormat`/dialect ↔ keywords used (offbook validates payloads under **draft-07**, so a fixture leaning on a post-draft-07 keyword such as `prefixItems` is testing a diagnostic, not a validation), `asyncapi` version ↔ structure (v2 `publish`/`subscribe` vs v3 `operations`).
5. **Negative cases exist.** Something must exercise the **rejection** path — a known-bad payload that *must* fail validation — not just happy-path validity.

This bar generalizes to any test fixtures / golden files, not just AsyncAPI specs.
