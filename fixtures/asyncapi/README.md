# AsyncAPI test fixtures

Representative specs for developing and testing `registry/`, `validation/`, and the L1 faker. Each exercises a deliberate edge — together they are the **§5 validation-correctness bar** the build must pass before CI trust.

| File | AsyncAPI | Exercises |
|---|---|---|
| `thermostat.yaml` | 3.0.0 | Both directions (`fromClient` command + `toClient` state), topic params, enums — the running example |
| `composition.yaml` | 3.0.0 | `allOf` / `oneOf` (const-discriminated) / `anyOf` — json-schema-faker weak spots; the Ajv recheck must catch non-conforming output (§4) |
| `external-ref.yaml` + `shared/common.yaml` | 3.0.0 | External `$ref` across files + `$id` base URI — the parser bundling/dereference correctness bar (§5, §12.4) |
| `v2-pubsub.yaml` | 2.6.0 | `publish`/`subscribe` — the perspective inversion on the **older** major |
| `qos-retain.yaml` | 3.0.0 | MQTT operation bindings declaring qos/retain — binding-precedence resolution (P1.D2) |

## Direction mapping the registry must produce
Normalize once onto the `Channel` record (§5, `offbook-contracts.md` §1). Note the two majors feel opposite:

- **v3** `send` → `toClient` · `receive` → `fromClient`
- **v2** `subscribe` → `toClient` · `publish` → `fromClient`

(In every fixture the *documented application is the SERVICE*; the SPA is the client/counterparty.)
