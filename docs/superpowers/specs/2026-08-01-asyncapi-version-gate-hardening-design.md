# AsyncAPI version gate hardening: design

**Date**: 2026-08-01
**Status**: designed (not yet implemented)
**Amends**: `docs/superpowers/specs/2026-07-30-asyncapi-version-support-design.md` (D-018, R-037, R-039). The substance of that design stands; three of its mechanisms change.
**Provenance**: code review of PR #2 (findings 1, 2, and 3), then a design dialog on 2026-08-01. Every behavioral claim below was verified empirically against the installed toolchain (`@asyncapi/parser` 3.6.0, `@asyncapi/specs` 6.11.1) during the dialog. See **Verification** for the raw results.

## Problem

Three defects in the shipped R-037/R-039 implementation.

1. **The version preflight swallows every parse failure and gives actively wrong advice.** `readSpecVersion` returns `undefined` both for "parsed fine, no `asyncapi` field" and for "did not parse at all", and the preflight runs before `parser.parse()`. So a malformed spec, an empty file, or a fetched HTML error page all die with:

   ```
   unsupported AsyncAPI version (no `asyncapi` field found) in service 'svc-a':
   offbook supports 2.0.0 through 3.1.0. Convert the spec first:
     `asyncapi convert <file> --target-version 3.1.0`
   ```

   All three are plausible first-run failures (a wrong `spec-path`, a wrong repo, an auth redirect returning HTML), all three previously reached the parser and surfaced its diagnostics through `failed to parse spec: …`, and `asyncapi convert` is the wrong remedy for every one of them. Spec-load failure is fatal and aborts `up` (design §7 Mode 1), so this message is the entire error the adopter sees. R-036 audited exactly this path and set the bar that every first-run error names what failed plus one concrete next step; this message fails that bar by naming the wrong failure.

2. **`@asyncapi/specs` is imported but not declared.** `src/registry/index.ts` imports `@asyncapi/specs/bindings/mqtt/0.2.0/operation.json` to derive the legal mqtt operation-binding key set. That package is a transitive dependency of `@asyncapi/parser` (`^6.11.1`), not a declared one, so the import resolves only through flat hoisting. A parser upgrade that bumps or drops the dep, or an install under a non-hoisting layout, breaks the build. The path is also an unversioned internal file: the package publishes no `exports` map, so nothing guarantees the subpath is stable.

3. **Legal vendor extensions are reported as unknown binding keys.** The derived key set reads only the schema's `properties`, ignoring its `patternProperties: ^x-[\w\d\.\x2d_]+$`, so a spec-legal `x-vendor-thing` on an mqtt operation binding raises a `binding-unknown-key` warning. Defect 3 is included because it lives in the exact lines defect 2 rewrites: hand-authoring a "legal key set" that is known not to be the legal key set would bake a false positive into a constant, where it is harder to notice than in derived code.

Design work on defect 1 turned up a fourth, pre-existing, defect, recorded here and fixed as a side effect: an unquoted `asyncapi: 2.6` (a YAML float, not a string) makes the parser die with a raw stack trace inside a diagnostic, `TypeError: undefined is not an object (evaluating 'patchWithRc.split')`. That is the same opaque-parser-death class D-018 built the preflight for.

## Scope

In scope: the preflight's firing rule and message, the mechanism that keeps offbook's supported set aligned with the parser's, the `@asyncapi/specs` dependency boundary, and the vendor-extension allowance, plus the requirement, decision, and doc updates that follow.

Out of scope: review findings 4 through 13 (the untested compose wiring, the mis-attributed `$ref`-sibling tripwire, the duplicated channel-binding diagnostic, the `dialect-mismatch` property-name false positive, the `schema: false` wrapper hole, and the nits). Each is independent of this change.

## Decisions (from the design dialog)

- **The gate refuses only what it positively recognizes as untested.** An unreadable or absent `asyncapi` field is not offbook's call to make. The alternative, owning a branded message for each of the three failure classes, duplicates two messages the parser already gets right and puts a second YAML reader in a position to disagree with the parser's about what "not YAML" means.
- **Divergence between offbook's promise and the parser's capability is caught by an install-time drift test, not a runtime recheck.** A post-parse `document.version()` recheck is structurally unreachable while the two sets agree, which they do today, so it would ship as a permanently uncovered `throw` under a per-file coverage floor. The drift test catches the divergence at the dependency bump, which is the moment someone can act on it.
- **`@asyncapi/specs` becomes a devDependency and the binding key set becomes a hand-authored constant**, extending to bindings the reasoning D-018 already applied to `SUPPORTED_SPEC_VERSIONS`: a value being present upstream is not the same as offbook having tested it. Declaring it as a runtime dependency instead would be a smaller diff but would leave production code deriving behavior from a package whose contents can change under a caret range.
- **The refusal message names the tested set rather than a range.** After the firing-rule change the message appears only when a version was read and rejected, which is precisely the in-"range"-but-unsupported case where "2.0.0 through 3.1.0" would tell the user they are supported while refusing them.

## 1. The version gate

**Rule:** `registry/` refuses only a version it positively read and positively recognizes as untested. Everything else is the parser's verdict.

```ts
// R-037 preflight: check the declared version BEFORE handing the document to the
// parser, because the parser's gate is derived from @asyncapi/specs at install time
// and an unsupported-but-present version can pass it and then die opaquely inside
// Spectral (D-018). Fires ONLY on a version this read positively resolved: an
// unreadable or absent `asyncapi` field is not offbook's call to make, and the
// parser's own diagnostics for those cases are accurate and specific (D-019).
const specVersion = readSpecVersion(opts.specText);
if (specVersion !== undefined && !isSupportedSpecVersion(specVersion)) {
  throw new Error(
    `unsupported AsyncAPI version "${specVersion}" in service '${opts.service}': ` +
      `offbook supports ${SUPPORTED_SPEC_VERSIONS.join(", ")}. ` +
      "Convert the spec first: `asyncapi convert <file> --target-version 3.1.0`",
  );
}
```

`readSpecVersion` keeps its `string | undefined` signature. `undefined` already means "I could not resolve a version", which is exactly the fall-through condition, so no discriminated result type is needed. `isSupportedSpecVersion` keeps its `undefined`-is-false semantics as a pure predicate; only the call site changes. The throw stays inline: option A leaves exactly one call site, so a message helper would be indirection for its own sake.

The message becomes:

```
unsupported AsyncAPI version "2.7.0" in service 'svc-a': offbook supports 2.0.0,
2.1.0, 2.2.0, 2.3.0, 2.4.0, 2.5.0, 2.6.0, 3.0.0, 3.1.0. Convert the spec first:
  `asyncapi convert <file> --target-version 3.1.0`
```

A plain join of `SUPPORTED_SPEC_VERSIONS`, deliberately not collapsed to `2.0.0-2.6.0, 3.0.0, 3.1.0`. Collapsing reads better but needs a run-detection helper with its own edge cases (is `2.6.0` to `3.0.0` contiguous? is contiguity by minor or by patch?), which is cleverness inside a fatal error message. Nine names are noisier and cannot lie. The prose forms in `README.md` and the guides keep the collapsed rendering, where a human wrote and reviewed them.

**What this changes for each input class:**

| input | before | after |
|---|---|---|
| malformed YAML | version error, wrong remedy | the parser's syntax diagnostics via `failed to parse spec:` |
| empty file, HTML error page, YAML with no `asyncapi` | version error, wrong remedy | `This is not an AsyncAPI document. The "asyncapi" field as string is missing.` |
| `asyncapi: '1.2.0'` | branded refusal | branded refusal (unchanged behavior, new set rendering) |
| unquoted `asyncapi: 2.6` | branded refusal | branded refusal, still ahead of the parser's `patchWithRc.split` TypeError |

The fix strictly widens what the gate gets right: nothing that was correctly refused stops being refused.

## 2. The `@asyncapi/specs` boundary

`@asyncapi/specs` moves from undeclared-transitive to an explicit `devDependency` at `^6.11.1`. `src/registry/index.ts` drops its runtime import, so offbook's production dependency graph is unchanged from today's declared set.

Both halves of the binding schema's key contract transcribe cleanly into `registry/`:

```ts
// The mqtt OPERATION binding's legal keys, transcribed from @asyncapi/specs'
// bindings/mqtt/0.2.0/operation.json. Hand-authored and drift-tested rather than
// derived at runtime, for the reason D-018 gave for SUPPORTED_SPEC_VERSIONS: a
// value being present upstream is not the same as offbook having tested it.
// Validating against 0.2.0 stays permissive-correct: its property set is a
// superset of 0.1.0's.
const MQTT_OPERATION_KEYS = new Set([
  "bindingVersion", "messageExpiryInterval", "qos", "retain",
]);

// The same schema permits vendor extensions. Transcribed character-for-character
// from its `patternProperties` key, so the drift test compares source strings
// rather than approximating the intent.
const MQTT_EXTENSION_KEY = /^x-[\w\d\.\x2d_]+$/;
```

The transcription round-trips exactly: `MQTT_EXTENSION_KEY.source === Object.keys(schema.patternProperties)[0]` is `true`. The unknown-key filter gains `&& !MQTT_EXTENSION_KEY.test(k)`, which is the whole of the defect-3 fix.

**The re-import guard is a source-text check, not a lint rule.** Biome 1.9's `noRestrictedImports.paths` matches the exact module specifier string: a bare `@asyncapi/specs` entry does not flag `@asyncapi/specs/bindings/mqtt/0.2.0/operation.json` (verified both ways, see **Verification**). Since the realistic regression is a deep JSON path, a lint rule would be a no-op against the very import it is meant to prevent, and listing today's path would catch only today's path.

The guard therefore follows the repo's established idiom for this constraint, the one `test/transport-isolation.test.ts` uses for the aedes family and `src/ingestion/index.test.ts` uses for G12: walk `src/**/*.ts` and regex the import edge. That catches every subpath, present and future. It lives as a third check in `test/upstream-drift.test.ts`, beside the two drift checks it belongs with.

One consequence worth naming: the `binding-unknown-key` diagnostic's `detail` lists the legal keys, and it now lists them from the constant rather than from the derived set. The same four names today, and the drift test is what keeps that true.

## 3. The upstream drift gate

`test/upstream-drift.test.ts` (new) sits beside the existing structural gates `transport-isolation.test.ts` and `import-style.test.ts`, and carries `// [stest->R-037]` and `// [stest->R-039]`.

1. **Version set.** `SUPPORTED_SPEC_VERSIONS` equals `Object.keys(specs.schemas)`. Exact equality, no filtering: the `2.0.0-rc1`/`2.0.0-rc2` schemas are present on disk but excluded from the export map, so the installed 6.11.1 exposes exactly the nine supported versions. The day a parser bump adds or removes one, offbook's promise and the parser's capability diverge and this goes red at the bump.

   This does not reopen what D-018 rejected. D-018 refused to *derive* the constant, because a schema being present does not mean the ruleset handles it (parser 3.4.0 and 3.5.0 accepted 3.1.0 and then died in Nimma, which this test would not have caught, since 3.1.0 was present and listed). The constant stays hand-authored and separately tested against the real parser; this test only makes upstream drift loud so a human decides whether to test-and-add.

2. **Binding key set.** `MQTT_OPERATION_KEYS` equals the schema's `properties` keys, and `MQTT_EXTENSION_KEY.source` equals its sole `patternProperties` key.

3. **Re-import guard.** No file under `src/` imports `@asyncapi/specs` at any subpath, so the devDependency boundary holds.

## 4. Tests

`src/registry/index.test.ts` gains four cases and rewrites one:

| case | asserts |
|---|---|
| rewrite: "refuses a spec with no asyncapi field" | the parser's `This is not an AsyncAPI document. The "asyncapi" field as string is missing.` reaches the caller through `failed to parse spec:`, not a version error |
| new: malformed YAML | the parser's syntax diagnostics surface; the message does not mention `asyncapi convert` |
| new: unquoted `asyncapi: 2.6` | the branded gate fires first, so the caller never sees the parser's `patchWithRc.split` TypeError |
| new: `x-vendor-thing` on an mqtt operation binding | zero `binding-unknown-key` diagnostics |
| update: the 1.x refusal | the message names every version in `SUPPORTED_SPEC_VERSIONS`, and the assertion is built from the constant so it cannot drift |

`src/model/spec-version.test.ts` is unchanged. Its existing YAML-numeric case ("a YAML-numeric version is normalized to a string") reads as defensive trivia today; a comment now records that an unquoted `2.6` is what stands between an adopter and a raw parser stack trace.

Three assertions are worth a mutation check before calling this done, because each can pass for the wrong reason:

- reverting the `specVersion !== undefined` guard must turn the malformed-YAML case red;
- dropping `MQTT_EXTENSION_KEY` from the unknown-key filter must turn the `x-` case red;
- perturbing either constant must turn the drift gate red.

## 5. Doc and provenance changes

**`REQUIREMENTS.md`.** Both entries gain `test/upstream-drift.test.ts` in `TEST`; `IMPL` is unchanged for both.

- **R-037** currently reads "refuses any spec outside the tested support set … checked parser-free before `parse()`", which is now too broad. It becomes: refuses any spec whose declared version it can read and has not tested, checked parser-free before `parse()`; an unreadable or absent `asyncapi` field defers to the parser's own diagnostics rather than guessing.
- **R-039** currently reads "reports unknown keys against the official mqtt operation-binding key set". It becomes: against a hand-authored key set drift-tested against that schema, honoring the vendor-extension pattern.

**`DECISIONS.md`.** One new entry, **D-019**, amending D-018 rather than superseding it, recording the four decisions above plus the two defects found while designing (the unquoted-`2.6` parser TypeError, and the derived key set rejecting legal `x-` extensions).

**`docs/specs/build-plan.md`** §1 gets a note on the AsyncAPI row naming `@asyncapi/specs` as a dev-only drift-gate dependency. **`biome.json` is untouched**, per the source-text-guard decision in §2.

**`docs/specs/contracts.md` needs no change.** The preflight's error text and the binding key set are `registry/` internals; neither the `Diagnostic` shape nor the `spec-load` tag list moves, so the canonical contract is untouched.

## Out of scope

Review findings 4 through 13, each independent of this change:

- the compose wiring (`src/compose/index.ts:185`) and `mergeRegistries` diagnostics concatenation are untested end to end, so every registry diagnostic is unit-only;
- the reworded `$ref`-sibling tripwire cannot detect a dialect change, because `@asyncapi/parser` erases the sibling during dereference before Ajv sees anything, so the causal chain asserted in five places is mis-attributed;
- `binding-on-channel` fires once per operation rather than once per channel, duplicating on a channel with both a `send` and a `receive`;
- `dialect-mismatch` walks property names and enum values, so a property literally named `prefixItems` is falsely flagged;
- a `{schemaFormat, schema: false}` payload still accepts everything, since `extractPayloadSchema` requires `typeof schema === "object"`;
- the remaining nits (triple YAML parse of spec text, the truncated `contracts.md` §1 sentence, the redundant spread in `mergeRegistries`, the MQTT5/unknown-key double report, and `shared/common.yaml` still declaring 2020-12).

## Verification

Run against the installed toolchain on 2026-08-01 (`@asyncapi/parser` 3.6.0, `@asyncapi/specs` 6.11.1, Bun 1.3.14).

**Parser diagnostics for the inputs the preflight currently swallows:**

| input | `parser.parse()` error |
|---|---|
| malformed YAML | `Invalid mixed usage of block and flow styles`, `Unexpected end of the stream within a flow collection` |
| empty file | `This is not an AsyncAPI document. The "asyncapi" field as string is missing.` |
| HTML 404 page | same as above |
| valid YAML, no `asyncapi` field | same as above |
| `asyncapi:` as a list | same as above, plus `"asyncapi" property type must be string` |
| `asyncapi: '1.2.0'` | `Version "1.2.0" is not supported. Please use "3.1.0" (latest) version of the specification.` |
| `asyncapi: '2.7.0'` | `Version "2.7.0" is not supported. …` |

**`document.version()`** returns `"3.0.0"`, `"2.6.0"`, `"2.0.0"` for those documents, and `undefined` for an unquoted `asyncapi: 2.6`, which produces no document and this diagnostic:

```
Error thrown during AsyncAPI document validation. Name: TypeError, message: undefined
is not an object (evaluating 'patchWithRc.split'), stack: TypeError: … at getSemver
(node_modules/@asyncapi/parser/cjs/utils.js:17:25) at assertValidAsyncAPIVersion
(node_modules/@asyncapi/parser/cjs/ruleset/formats.js:32:32) …
```

**`@asyncapi/specs` 6.11.1 surface:**

- `Object.keys(specs.schemas)` is `["2.0.0","2.1.0","2.2.0","2.3.0","2.4.0","2.5.0","2.6.0","3.0.0","3.1.0"]`, exactly `SUPPORTED_SPEC_VERSIONS`, with no rc entries to filter.
- `bindings/mqtt/0.2.0/operation.json` `properties` keys are `["bindingVersion","messageExpiryInterval","qos","retain"]`.
- its sole `patternProperties` key is `"^x-[\\w\\d\\.\\x2d_]+$"`, and `/^x-[\w\d\.\x2d_]+$/.source` equals it.
- that pattern accepts `x-vendor-thing` and `x-a.b`; it rejects `x-`, `x-foo!`, `qos`, and `xfoo`.

**Current behavior confirmed defective:**

- all three malformed inputs above produce the version error with the `asyncapi convert` remedy;
- `x-vendor-thing` on an mqtt operation binding produces `binding-unknown-key: 't/ext' mqtt operation binding has unknown key(s) x-vendor-thing; the mqtt binding defines bindingVersion, messageExpiryInterval, qos, retain`;
- `@asyncapi/specs` appears in `bun.lock` only as a dependency of `@asyncapi/parser`, and `package.json` declares neither a dependency nor a devDependency on it.

**Biome `noRestrictedImports` specifier matching** (why the guard is a source-text check). With `"@asyncapi/specs"` added to `paths` for `src/**`, `bun run lint` does not flag `src/registry/index.ts:2`. With the exact string `"@asyncapi/specs/bindings/mqtt/0.2.0/operation.json"` instead, it flags that line immediately. The rule matches whole specifiers, not package prefixes, so it cannot express "this package at any subpath". `biome.json` was restored unmodified after the probe.

**Baseline at `f6abb11`** (the state this design amends): `bun scripts/check-docs.ts`, `bun run lint`, `bun run typecheck`, and `bun test` (423 pass, 0 fail) each exit 0.
