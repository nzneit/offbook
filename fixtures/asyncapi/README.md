# AsyncAPI test fixtures

Representative specs for developing and testing `registry/`, `validation/`, and the L1 faker. Each exercises a deliberate edge — together they are the **§5 validation-correctness bar** the build must pass before CI trust.

| File | AsyncAPI | Exercises |
|---|---|---|
| `thermostat.yaml` | 3.0.0 | Both directions (`fromClient` command + `toClient` state), topic params, enums — the running example |
| `composition.yaml` | 3.0.0 | `allOf` / `oneOf` (const-discriminated) / `anyOf` — json-schema-faker weak spots; the Ajv recheck must catch non-conforming output (§4). The oneOf sits on **both** a `send` (toClient) and a `receive` (fromClient) operation, so the hard schema is validated on the client-publish path too |
| `external-ref.yaml` + `shared/common.yaml` | 3.0.0 | External `$ref` across files + `$id` base URI + a `$ref` **sibling keyword** (`minLength`) under the declared 2020-12 dialect — the parser bundling/dereference correctness bar (§5, §12.4) |
| `v2-pubsub.yaml` | 2.6.0 | `publish`/`subscribe` — the perspective inversion on the **older** major |
| `qos-retain.yaml` | 3.0.0 | MQTT operation bindings declaring qos/retain — binding-precedence resolution (P1.D2) |

## Direction mapping the registry must produce
Normalize once onto the `Channel` record (§5, `offbook-contracts.md` §1). Note the two majors feel opposite:

- **v3** `send` → `toClient` · `receive` → `fromClient`
- **v2** `subscribe` → `toClient` · `publish` → `fromClient`

(In every fixture the *documented application is the SERVICE*; the browser application is the client/counterparty.)

## Fixture quality bar (author + review checklist)

A fixture's job is to *test something*, so it must clear these — the **"does this actually test what it claims?"** bar. Apply it both when adding a fixture and as a distinct review angle (the validity-only angle misses all of these):

1. **No vacuous values.** Anything meant to exercise a behavior must **differ from the default/trivial outcome**, or a no-logic implementation passes anyway. *(Trap: a binding `qos: 1` when the global default is already `qos 1` — the precedence assertion proves nothing. Use a value that differs, e.g. `qos: 2`.)*
2. **Claim ↔ content match.** Whatever the fixture's description says it exercises must be **structurally present**. *(Claim "`$ref` sibling keyword" → there must be a `$ref` with a sibling; claim "oneOf trap" → mutually-exclusive branches must actually exist.)*
3. **Full-path coverage.** A hard case must sit on **every path that processes it**, or the gap is documented. *(A oneOf / external-`$ref` schema only on a `toClient` operation leaves client-publish (`fromClient`) validation of the hard case untested end-to-end.)*
4. **Internal consistency.** `port` ↔ `protocol`, declared `schemaFormat`/dialect ↔ keywords used (`$defs`/`$id` need 2020-12), `asyncapi` version ↔ structure (v2 `publish`/`subscribe` vs v3 `operations`).
5. **Negative cases exist.** Something must exercise the **rejection** path — a known-bad payload that *must* fail validation — not just happy-path validity.

This bar generalizes to any test fixtures / golden files, not just AsyncAPI specs.
