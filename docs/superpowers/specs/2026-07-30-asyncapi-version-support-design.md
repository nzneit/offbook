# AsyncAPI 2.0.0 through 3.1.0 support: design

**Date**: 2026-07-30
**Status**: designed (not yet implemented)
**Provenance**: brainstorm dialog 2026-07-30, following a deep-research pass the same day. Every behavioral claim in this document was verified empirically during the dialog by running the installed toolchain (`@asyncapi/parser` 3.6.0, `@asyncapi/specs` 6.11.1, `ajv` 8.20.0), plus isolated installs of parser 3.4.0 and 3.5.0. Primary-source citations were confirmed against the AsyncAPI spec text, `parser-js`, `converter-js`, and the `bindings` repo. See **Verification** for the raw results.

## Problem

Offbook ingests adopter-authored AsyncAPI specs and derives a normalized channel catalog used for mocking and bidirectional validation. The declared support surface is vague: `REQUIREMENTS.md` R-004 says direction resolves for "v2 + v3", no adopter-facing doc states a version range at all, and nothing preflights the version a spec declares.

Behind that vagueness sit three defects in the shared ingestion path, all found by research rather than by any failing test:

1. **A valid AsyncAPI 3.x document can silently disable validation entirely.** The spec permits the explicit multi-format payload form, `payload: {schemaFormat, schema}`. Because `registry/index.ts` spreads `msg.payload().json()`, that form yields a channel schema whose top-level keys are `$schema, schemaFormat, schema`, carrying no validation keywords. Such a channel accepts everything: wrong types, unrelated objects, a bare string, `null`. No error, no diagnostic, green forever. This is the false-negative class that R-028 exists to prevent, and no fixture uses that payload form.
2. **A legal tuple payload schema crashes registry construction.** `{type: array, items: [...]}` is valid in both majors and parses fine, then `ajv.compile()` throws `schema is invalid: data/items must be object,boolean` because Offbook stamps 2020-12 over a schema the parser emitted as draft-07. Nothing catches the throw, so it surfaces as a raw Ajv error out of `bootProject` with no channel named.
3. **AsyncAPI 2.x MQTT bindings are not schema-validated.** 2.x's meta-schema maps `mqtt` to an empty schema, so `{qos: 9, retian: true}` parses with zero errors and `qos: 9` flows into a `Channel` typed `qos: 0 | 1 | 2`. The identical binding fails loudly on 3.x.

Defect 1 is an API-shape mistake: `BaseModel.json()` returns the raw node, and the code assumes it is always a bare schema. Defect 2 shares its root cause with the existing D-005 limitation: Offbook validates under a dialect the parser never produced.

## Scope

One hardening project covering both the declared version range and the correctness defects in the path that serves it, because a "we support 2.0.0 through 3.1.0" claim layered over a validator that can silently accept everything would be a false claim.

In scope: the supported-version contract and its preflight, the payload schema boundary in `registry/`, MQTT binding integrity, fixtures and gates for the untested corners, and the doc/provenance updates. Out of scope items are listed at the end.

## Decisions (from the design dialog)

- **Scope is combined**, version breadth plus the three defects, for the reason above.
- **Approach: harden the existing dual path**, not convert-on-ingest. `@asyncapi/converter` would deliver 2.x binding validation for free and collapse the direction logic to one path, but the org's specs are mostly 3.x, so the 2.x path is a shrinking minority not worth a new dependency plus a translation layer. Decisive factor: Offbook's value is telling a developer exactly which channel and payload broke, which argues for diagnostics anchored to the file they edit rather than to a machine-rewritten copy. Narrowing to 3.x-only was also rejected, as it abandons the stated goal.
- **Offbook enforces its own supported-version gate** rather than relying on the parser's rejection, so 1.x users get an actionable message and an opaque ruleset failure cannot pass through unexplained.
- **Payload validation moves to JSON Schema draft-07**, the dialect both spec majors declare and the one the parser actually emits. This is the root-cause fix for defect 2 and for the D-005 `$ref`-sibling limitation, and it requires no schema rewriting, so the no-hand-rolled-schema-interpretation constraint (R1) stays intact. Because draft-07 silently ignores 2020-12-only keywords, it is paired with a dialect-mismatch diagnostic.
- **Binding policing is a value guard plus a key-set check sourced from the official binding schema**, not full Ajv validation against the bundled spec schema. Offbook consumes exactly two binding fields; reading the legal key list from `@asyncapi/specs` avoids hardcoding spec knowledge without loading a bundle or compiling schemas Offbook never uses.
- **D-005's deferred obligation is closed as superseded**, with its tripwire retained and reworded. Under draft-07 the dropped `$ref` sibling is dialect-correct behavior, not a limitation awaiting a 2020-12 schema-parser spike.

## 1. The support contract

**Supported matrix**: 3.1.0 (recommended authoring target), 3.0.0, and 2.6.0 down through 2.0.0. Refused: all 1.x, the `2.0.0-rc1` and `2.0.0-rc2` release candidates (present on disk in `@asyncapi/specs` but excluded from its export map, so the parser never accepts them), and any document with a missing or unreadable `asyncapi` field.

The supported set is an **explicit constant that a test cross-checks**, not `Object.keys(specs.schemas)`. Deriving it would reproduce exactly the trap that fooled parser 3.4.0: the schema file is present, the version gate passes, and the ruleset then fails. Offbook's supported set is a promise it tests, so it is written down.

**Parser floor moves from `^3.4.0` to `^3.6.0`.** AsyncAPI 3.1.0 support landed in that release ("Release AsyncAPI 3.1 support that adds ROS 2 binding"). The floor is load-bearing rather than cosmetic: parser 3.4.0 and 3.5.0 both resolve `@asyncapi/specs` 6.11.1, which contains the 3.1.0 schema, pass their own dynamic version gate, and then die inside the Spectral ruleset with `AggregateError: Error running Nimma`. A caret range cannot protect against that.

**Preflight gate.** A pure, parser-free helper (`src/model/spec-version.ts`, tier 0, using the `yaml` dependency already present) reads the `asyncapi` field from raw spec text. `registry/buildRegistry` calls it before `parser.parse()` and, on an unsupported or absent version, throws an Offbook-branded error naming the version found, the supported range, and the remedy (`asyncapi convert`). Placing the helper in `model/` keeps `registry/` and `ingestion/` as tier peers without a cross-import.

**Version provenance becomes visible.** `ingestion/` already does a parser-free shallow `info.version` read (G12); it reads `asyncapi` in the same pass and records it as `spec-version` in `specs.lock` beside `declared-version`. The value joins `SpecInfo`, so `GET /v1/specs` and `offbook doctor` report which major each service is on. For a mostly-3.x fleet this turns "which teams are still on 2.x" into a question the tool answers.

## 2. The payload schema boundary

All of this lives in `registry/index.ts`, which is where the parser output becomes a `Channel`.

**Unwrap the multi-format payload.** A helper extracts the schema, returning `payloadJson.schema` when the payload JSON is an object carrying an object-valued `schema` key alongside `schemaFormat`, and the payload JSON itself otherwise. This is the same discriminator the parser's own `Schema` model uses internally (`_schemaObject = _json.schema`); `BaseModel.json()` returns the raw node verbatim, which is why the wrapper leaks. The helper **must not** branch on the `schemaFormat` string value: the implementation emits `application/vnd.aai.asyncapi;version=X` while the spec text mandates a `+json` suffix, so literal comparison is a trap.

**Validate under draft-07.** Replace the `Ajv2020` instance with Ajv's default draft-07 build, keep `ajv-formats`, and stamp `$schema: http://json-schema.org/draft-07/schema#` explicitly rather than 2020-12. The explicit stamp is verified equivalent to no stamp and makes `channel.schema` self-describing for consumers of `GET /topics`. Consequences, all verified: tuple `items` validates correctly, `additionalItems` is honored instead of silently ignored, and the `external-ref` correctness bar plus the D-005 tripwire behave identically.

**Diagnose dialect mismatch.** Because draft-07 ignores unknown keywords, a payload authored with 2020-12 constructs would silently under-validate, which is the worst failure mode for this tool. A recursive scan flags `prefixItems`, `unevaluatedProperties`, `unevaluatedItems`, `dependentRequired`, `dependentSchemas`, `minContains`, `maxContains`, `$dynamicRef`, `$dynamicAnchor`, `$recursiveRef`, and `$recursiveAnchor`, surfacing a diagnostic naming service, topic, and keyword. `$defs` and `definitions` are **not** flagged: both resolve correctly under draft-07, and `fixtures/asyncapi/shared/common.yaml` legitimately uses `$defs`.

**Contain compile failures.** The `ajv.compile()` call is wrapped. On failure the channel still enters the catalog, because discovery is a v1 floor that must survive weak specs, but its `validate` becomes a closure returning a single `SchemaError` describing the compile failure, so every payload on that channel yields an explicit violation instead of validating green. The failure also surfaces in `GET /v1/diagnostics` naming service, topic, and the Ajv message. No new field on `Channel` is required.

**Handle multi-message operations.** When an operation declares more than one message, the channel schema becomes `anyOf` over each message's extracted payload schema; a single message keeps its schema directly. This preserves the single-schema `Channel` shape, so the faker and `/topics` are unaffected, and it fixes both v2 `message.oneOf` unions and v3 multi-message operations, where today only `messages()[0]` is read and variant-two payloads are wrongly reported as violations. `composition.yaml` already exercises `anyOf` through json-schema-faker with zero recheck failures (R-027/F8), so the faker path is known good.

## 3. MQTT binding integrity

**Value guard.** The `qos` read from a spec binding must be an integer in `{0, 1, 2}` and `retain` must be a boolean. On violation, Offbook surfaces a diagnostic naming service, topic, and the offending value, then **falls through to the next tier of the existing precedence chain** (`topicOverrides`, then per-service default, then global) rather than clamping the value or propagating it. This protects the `Channel` type invariant regardless of which spec version supplied the binding.

**Key-set check.** The legal key list is read from `@asyncapi/specs/bindings/mqtt/0.2.0/operation.json`'s `properties` (verified importable as JSON: `qos`, `retain`, `messageExpiryInterval`, `bindingVersion`). Any other key on an `mqtt` operation binding produces a diagnostic, which catches the misspelling class such as `retian` that 2.x accepts silently. Only the key list is read; the schema is deliberately not compiled, because it carries an unresolvable external `$ref` to `http://asyncapi.com/definitions/3.0.0/schema.json` and compiling it would require registering the whole bundled spec schema. Validating against 0.2.0 is the permissive-correct choice, since 0.2.0's property set is a superset of 0.1.0's.

**Channel-binding diagnostic.** The MQTT Channel Binding Object "MUST NOT contain any properties. Its name is reserved for future use." at every binding version, so `qos`/`retain` are legal only at operation level. A 3.x document carrying `mqtt: {qos: 2}` on the channel nonetheless parses clean and Offbook silently uses the default. That becomes a diagnostic telling the author to move it to the operation.

**MQTT 5 fields reported as unhonored.** Offbook is MQTT 3.1.1 only, so `messageExpiryInterval`, `payloadFormatIndicator`, `correlationData`, `contentType`, `responseTopic`, `sessionExpiryInterval`, and `maximumPacketSize` cannot be honored. Their presence produces a one-line notice rather than silence, consistent with the standing principle that the tool never lies about its own fidelity.

## 4. Fixtures and tests

**New fixtures**, both earning their place against the fixture quality bar rather than being version copies:

| File | AsyncAPI | Exercises |
|---|---|---|
| `multi-format.yaml` | 3.1.0 | The explicit `{schemaFormat, schema}` payload form with a strict schema (`required` plus `additionalProperties: false`), on **both** a `send` and a `receive` operation so the hard case sits on every path that processes it. Doubles as the newest-supported-major acceptance fixture and the regression pin for the vacuous-validator defect. |
| `v2-oldest.yaml` | 2.0.0 | The floor of the supported range: `subscribe` plus `publish` direction inversion, and an MQTT operation binding at `qos: 2`, which differs from both the global default (1) and any per-service default, so the binding assertion is not vacuous. |

`composition.yaml` gains a tuple-form array payload, which validates correctly under the new dialect and would have crashed the registry before. Genuinely malformed cases stay out of `fixtures/`, matching the existing convention that fixtures are representative *valid* specs while negative cases are known-bad payloads; they live as inline test specs: the illegal 2.x binding, the channel-level binding, a `prefixItems` dialect mismatch, an uncompilable schema, and a multi-message operation.

`fixtures/asyncapi/README.md` gains both rows, and its direction-mapping note gains the supported-version statement.

**Tests and gates**:

- A **version-matrix test** asserting every version in the supported constant parses, and that `1.2.0` and `2.0.0-rc1` fail with the branded error. This is also what keeps the constant honest.
- A **vacuous-validator regression test** asserting the `multi-format.yaml` channel *rejects* a known-bad payload. This is the tripwire for the defect; if the unwrap regresses, it flips red rather than going quiet.
- Registry unit tests per behavior: unwrap, dialect (tuple accepted, `additionalItems` honored), dialect-mismatch diagnostic, compile-failure containment, `anyOf` over multi-message operations, value guard fall-through, key-set diagnostic, channel-binding diagnostic, MQTT 5 notice.
- **R-028**, the cross-cutting validation-correctness gate, extends to drive the new fixtures, so the false-negative class is covered by a v1 gate and not only by unit tests.
- Arrow-tag comments (`// [utest->R-###]` and friends) on every new test, as the doc-system gate verifies tags in both directions.

## 5. Doc and provenance changes

- **`D-018`** records the version contract, the draft-07 dialect decision, and the binding policy, with a supersedes note pointing at D-005.
- **`D-005`** gains a superseded-by note. Its deferred obligation (register a 2020-12 schema parser so `$ref` siblings survive) closes: under draft-07 the sibling is correctly ignored per the dialect both majors declare. The tripwire in `external-ref.yaml` and `registry/index.test.ts` is retained and reworded from "known limitation" to "dialect-correct behavior, pinned so a future dialect change is loud".
- **`R-037`** supported-version contract, preflight gate, and `spec-version` provenance. **`R-038`** the payload schema boundary. **`R-039`** MQTT binding integrity. New ids rather than extending `R-004`, which is already `tested` and whose lifecycle the doc gate enforces.
- **`docs/specs/contracts.md`** is canonical for types and endpoints, so it changes for: `spec-version` on `LockEntry` and `SpecInfo`; the dialect statement in §5 (currently "we only stamp `$schema: 2020-12`", which the dialect decision reverses); and the new `/v1/diagnostics` entries (`schema-compile-failed`, `binding-invalid-value`, `binding-unknown-key`, `binding-on-channel`, `mqtt5-field-ignored`, `dialect-mismatch`).
- **`README.md`** and **`docs/guides/wiring-your-service.md`** state the supported range, recommend 3.1.0, and carry the v2 perspective caveat.
- **`package.json`** parser floor to `^3.6.0`.

## Known limitations

- **A 2.x spec authored from the client's perspective loads with every direction inverted, and no tool can detect it.** The spec text is unambiguous (`subscribe` defines messages "produced by the application", `publish` defines messages "consumed by the application"), and Offbook's mapping matches it, as does `converter-js` under its default `pointOfView: 'application'`. But the convention is famously misread: `converter-js` ships a `pointOfView: 'client'` escape hatch and generator templates carry `view=provider` and `inverseOperations=true` flags for documents written the other way. This is documented for adopters, not solved.
- **2020-12 keyword semantics are diagnosed, not honored.** An adopter writing `prefixItems` gets a diagnostic, not validation.
- **Non-JSON-Schema payloads still fail the whole parse.** Avro, Protobuf, OpenAPI, and RAML payloads produce `Unknown schema format` and `document = null`. The multi-format unwrap in this design is a prerequisite for ever supporting them, since a registered schema parser returns its converted schema inside the same wrapper, but registering one is out of scope.
- **A future parser bump changes the unknown-format behavior.** Parser `master` has softened `parseSchema()` to return `input.data` instead of throwing, so the hard failure is specific to 3.6.0 and should be re-verified on upgrade.
- **`retain` applies to Publish only in binding 0.2.0**, narrowed from 0.1.0's "Publish, Subscribe". That narrowing is prose in the binding spec, not schema-enforced, so Offbook does not police it.

## Out of scope

- AsyncAPI 1.x support (reachable via `@asyncapi/converter`, which chains 1.0.0 through 3.1.0, but not pursued).
- Convert-on-ingest as an architecture, and any bundled `offbook specs convert` verb.
- Registering Avro, Protobuf, OpenAPI, or RAML schema parsers.
- Honoring 2020-12 semantics natively (the custom schema-parser spike D-005 previously deferred).
- MQTT 5, per the standing MQTT 3.1.1-only constraint.

## Verification

Run during the dialog against the installed toolchain unless noted.

| Claim | Result |
|---|---|
| 1.x rejected | 1.2.0 gives `document = null`, `Version "1.2.0" is not supported. Please use "3.1.0" (latest) version of the specification.` |
| 2.x parses, action not normalized | 2.0.0 and 2.6.0 parse; `op.action()` returns literal `publish`/`subscribe`, so both branches of `directionOf` are live |
| 3.1.0 needs parser 3.6.0 | Isolated installs of 3.4.0 and 3.5.0 both resolve `@asyncapi/specs` 6.11.1, parse 3.0.0 fine, and fail 3.1.0 with `AggregateError: Error running Nimma` |
| 3.1.0 is catalog-identical to 3.0.0 | All five 3.0.0 fixtures re-declared as 3.1.0 produce byte-identical catalogs (topic, direction, qos, retain, schema hash) through the real `buildRegistry` |
| Multi-format payload is vacuous today | Through the real `buildRegistry`, a valid 3.0.0 multi-format channel accepts `{id: 42}`, `{unrelated: 1}`, `"nope"`, and `null`; top-level schema keys are `$schema, schemaFormat, schema` |
| Tuple crash | `items: [...]` parses in 2.6.0 and 3.0.0, then `ajv.compile()` throws `schema is invalid: data/items must be object,boolean`; `prefixItems` compiles |
| Draft-07 fixes it without regression | Under Ajv draft-07: tuple validates correctly (`[1,'a']` rejected), `additionalItems` honored, and the `external-ref` bar plus D-005 tripwire behave identically to 2020-12 |
| Draft-07's cost | `prefixItems` is silently ignored under draft-07, hence the dialect-mismatch diagnostic |
| 2.x bindings unvalidated | 2.6.0 with `{qos: 9, retian: true}` parses with zero errors and returns the value verbatim; identical binding on 3.0.0 fails parse (`Property "retian" is not expected to be here`) |
| Binding key list is importable | `@asyncapi/specs/bindings/mqtt/0.2.0/operation.json` imports as JSON with `additionalProperties: false` and `qos` enum `[0,1,2]`; compiling it fails on an unresolvable external `$ref`, which is why only `properties` keys are read |
| Channel-level binding is silently ignored | 3.0.0 with `mqtt: {qos: 2, retain: true}` on the channel parses clean; `op.bindings().get("mqtt")` is null and Offbook defaults to qos 1 |
| Faker is dialect-safe | json-schema-faker 0.6.2 draws valid data for `prefixItems`, `dependentRequired`, `unevaluatedProperties`, `$defs` and `definitions` refs: 0 recheck failures across 12 seeds each |
| `dependencies` is not a hazard | Draft-07 `dependencies` validates correctly under Ajv2020, so no migration concern either way |
| Avro is rescuable but wrapper-bound | Registering `@asyncapi/avro-schema-parser` turns the parse failure into a converted JSON Schema, delivered inside the same `{schemaFormat, schema}` wrapper, which the current code would render vacuous |
