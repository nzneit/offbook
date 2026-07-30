# AsyncAPI 2.0.0 through 3.1.0 Support Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declare and test the AsyncAPI 2.0.0-through-3.1.0 support range, and fix the three ingestion defects in the path that serves it, so no supported spec version can silently validate green against nothing.

**Architecture:** All behavioral change lands in `src/registry/index.ts`, the single place parser output becomes a `Channel`. A new tier-0 helper (`src/model/spec-version.ts`) provides the parser-free version read used both by the registry preflight gate and by `ingestion/` for lockfile provenance. Registry-time findings reach `GET /v1/diagnostics` through a new `SpecRegistry.diagnostics()` member merged by the composition root, following the existing pattern where `src/compose/index.ts` assembles diagnostics from several sources.

**Tech Stack:** TypeScript on Bun 1.3.14, `@asyncapi/parser` 3.6.0, `@asyncapi/specs` 6.11.1, `ajv` 8.x (draft-07 build after Task 3), `ajv-formats`, `yaml`, Biome for lint, `bun test` for tests.

**Spec:** `docs/superpowers/specs/2026-07-30-asyncapi-version-support-design.md`

## Global Constraints

Every task's requirements implicitly include these.

- **Parser floor is `^3.6.0` exactly.** AsyncAPI 3.1.0 support landed in that release. Parser 3.4.0 and 3.5.0 resolve a specs package containing the 3.1.0 schema, pass their own dynamic version gate, then fail inside the Spectral ruleset with `AggregateError: Error running Nimma`.
- **Supported spec versions, verbatim:** `2.0.0`, `2.1.0`, `2.2.0`, `2.3.0`, `2.4.0`, `2.5.0`, `2.6.0`, `3.0.0`, `3.1.0`.
- **Payload validation dialect after Task 3 is JSON Schema draft-07**, stamped explicitly as `http://json-schema.org/draft-07/schema#`. Never 2020-12.
- **Only `src/broker/` may import `aedes` or any MQTT/transport package.** Lint-enforced. Nothing in this plan needs it.
- **Import style (D-013):** upward reaches use `#src/…`; same-directory and downward stay relative with explicit `.ts` extensions. Enforced by `test/import-style.test.ts`.
- **No hand-rolled schema interpretation (R1).** Use `@asyncapi/parser` and Ajv. Reading `properties` keys off an official binding schema is allowed; walking or rewriting adopter schemas is not.
- **Verify by exit code, never by printed pass/fail counts.** `bun test <single-file>` may exit 1 with zero failures because the per-file coverage floor judges partially-imported files. Gate on full `bun test`. Coverage floors are per-file: `lines = 0.74`, `functions = 0.64`.
- **`bun scripts/check-docs.ts` must exit 0 at every commit.** Requirement ids must stay unique and contiguous; a `tested` requirement needs a `TEST` trace whose files carry matching arrow tags (`// [utest->R-###]`, or `itest`/`stest`), verified in both directions.
- **Commit messages carry no `Co-Authored-By` and no AI-attribution trailer.**
- **Prose in docs and comments avoids em-dashes.** Use commas, colons, parentheses, or separate sentences.
- **Touching `fixtures/asyncapi/` couples to the R-027 spike tripwire.** `test/spikes/jsf-fidelity.test.ts` asserts that `SPIKE_FIXTURES` (in `scripts/spike-jsf-fidelity.ts`) covers the `fixtures/asyncapi/*.yaml` listing *exactly*, and its `EXPECTED` map pins draws (channels x 10 seeds) and failures per fixture. So **adding a fixture, or adding a channel to an existing one, makes the full suite red until you update both.** Do the maintenance the tripwire itself prescribes: register the fixture, re-measure, and note the re-measurement citing D-018. Never exempt a fixture from the listing assertion and never relax `failures: 0` to accommodate a draw. Discovered in Task 2, which had to register `multi-format.yaml`; it recurs in Task 3 (a new `composition.yaml` channel) and Task 8 (`v2-oldest.yaml`).

## Deviations from the spec (read before starting)

Two things were discovered while planning that the spec got wrong. Both are deliberate, and both are narrower than what the spec described.

1. **Diagnostics reuse the existing `kind: "spec-load"` rather than adding six new kinds.** The spec listed `schema-compile-failed`, `binding-invalid-value`, `binding-unknown-key`, `binding-on-channel`, `mqtt5-field-ignored`, and `dialect-mismatch` as new `/v1/diagnostics` entries. `Diagnostic.kind` is a closed four-value union and `DiagnosticSummary.byKind` requires all keys present and zero-filled, so six new kinds would churn the model, `src/control-plane/index.ts`, its tests, and the canonical `contracts.md` §5 tables. `spec-load` is already documented as "non-fatal spec-QUALITY findings surfaced at load", which is exactly what these are. The six names survive as a stable machine-greppable prefix on `detail` (for example `dialect-mismatch: '<topic>' uses …`).
2. **`offbook doctor` does not report `spec-version`.** The spec said it would. It cannot: `doctor`'s spec check is deliberately network-free and shape-only, while the spec text lives in a remote repo that only `ingestion/` fetches. The version is recorded in `specs.lock` and exposed on `SpecInfo` via `GET /v1/specs`, which is where an adopter can actually see it.

## File Structure

**Created**

- `src/model/spec-version.ts` — tier-0 pure functions: `readSpecVersion` (parser-free `asyncapi` field read) and the `SUPPORTED_SPEC_VERSIONS` contract plus `isSupportedSpecVersion`. Lives in `model/` so `registry/` and `ingestion/`, which are tier-1 peers, can both use it without cross-importing.
- `src/model/spec-version.test.ts` — unit tests for the above.
- `fixtures/asyncapi/multi-format.yaml` — AsyncAPI 3.1.0, explicit `{schemaFormat, schema}` payload on both a `send` and a `receive` operation.
- `fixtures/asyncapi/v2-oldest.yaml` — AsyncAPI 2.0.0, `subscribe` plus `publish`, MQTT operation binding at `qos: 2`.

**Modified**

- `src/registry/index.ts` — all behavioral change: preflight gate, payload extraction, dialect, diagnostics collection, compile containment, multi-message `anyOf`, binding integrity.
- `src/registry/index.test.ts` — tests for each of the above.
- `src/model/index.ts` — `SpecRegistry.diagnostics()`; `specVersion` on `ResolvedSpec`, `LockEntry`, `SpecInfo`.
- `src/compose/index.ts:183-190` — merge `registry.diagnostics()` into the diagnostics list.
- `src/ingestion/index.ts` — read and record `specVersion`; serialize `spec-version`.
- `src/cli/boot.ts` — carry `specVersion` into `SpecInfo`.
- `fixtures/asyncapi/composition.yaml` — add a tuple-form array payload.
- `fixtures/asyncapi/external-ref.yaml` — reword the D-005 sibling comment.
- `fixtures/asyncapi/README.md` — two new rows, supported-version statement.
- `docs/specs/contracts.md` — dialect reversal in §5, `SpecRegistry.diagnostics()`, `spec-version` on the lockfile and `SpecInfo`.
- `DECISIONS.md` — add `D-018`, add a superseded note to `D-005`.
- `REQUIREMENTS.md` — add `R-037`, `R-038`, `R-039`.
- `README.md`, `docs/guides/wiring-your-service.md` — supported range, 3.1.0 recommendation, v2 perspective caveat.
- `package.json` — parser floor.
- `test/gate-validation.test.ts` — extend R-028 over the new fixtures. **Confirm the filename first** with `ls test/`; the R-028 trace in `REQUIREMENTS.md` is authoritative.

---

### Task 1: Supported-version contract and preflight gate

Establishes the version promise, the parser floor, and the doc ids every later task references. The doc stubs are folded in here so `check-docs` stays green from the first commit and later tasks can add arrow tags against real requirement ids.

**Files:**
- Create: `src/model/spec-version.ts`, `src/model/spec-version.test.ts`
- Modify: `src/registry/index.ts` (preflight gate before `parser.parse`), `package.json` (parser floor), `REQUIREMENTS.md` (add R-037, R-038, R-039), `DECISIONS.md` (add D-018)
- Test: `src/model/spec-version.test.ts`, `src/registry/index.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SUPPORTED_SPEC_VERSIONS: readonly string[]`, `readSpecVersion(specText: string): string | undefined`, `isSupportedSpecVersion(v: string | undefined): boolean`, all exported from `src/model/spec-version.ts`. `buildRegistry` throws `Error` with a message beginning `unsupported AsyncAPI version` for any version outside the set.

- [ ] **Step 1: Write the failing test for the version helper**

Create `src/model/spec-version.test.ts`:

```ts
// [utest->R-037]
import { expect, test } from "bun:test";
// same directory as its subject, so relative per D-013 (NOT the #src/ alias)
import {
	SUPPORTED_SPEC_VERSIONS,
	isSupportedSpecVersion,
	readSpecVersion,
} from "./spec-version.ts";

test("reads the asyncapi version from spec text without a parser", () => {
	expect(readSpecVersion("asyncapi: 3.0.0\ninfo: { title: T, version: 1.0.0 }")).toBe("3.0.0");
	expect(readSpecVersion("asyncapi: '2.6.0'\ninfo: { title: T, version: 1.0.0 }")).toBe("2.6.0");
});

test("a YAML-numeric version is normalized to a string", () => {
	// `asyncapi: 2.6` is a YAML float, not a string; String() keeps the read honest
	expect(readSpecVersion("asyncapi: 2.6")).toBe("2.6");
});

test("absent or unparseable spec text yields undefined, never a throw", () => {
	expect(readSpecVersion("info: { title: T }")).toBeUndefined();
	expect(readSpecVersion("this: [is: not: valid: yaml")).toBeUndefined();
	expect(readSpecVersion("")).toBeUndefined();
});

test("the supported set is exactly the tested promise (2.0.0-2.6.0, 3.0.0, 3.1.0)", () => {
	expect([...SUPPORTED_SPEC_VERSIONS]).toEqual([
		"2.0.0",
		"2.1.0",
		"2.2.0",
		"2.3.0",
		"2.4.0",
		"2.5.0",
		"2.6.0",
		"3.0.0",
		"3.1.0",
	]);
});

test("1.x, the 2.0.0 release candidates, and absent versions are unsupported", () => {
	expect(isSupportedSpecVersion("3.1.0")).toBe(true);
	expect(isSupportedSpecVersion("2.0.0")).toBe(true);
	expect(isSupportedSpecVersion("1.2.0")).toBe(false);
	expect(isSupportedSpecVersion("2.0.0-rc1")).toBe(false);
	expect(isSupportedSpecVersion("4.0.0")).toBe(false);
	expect(isSupportedSpecVersion(undefined)).toBe(false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test src/model/spec-version.test.ts`
Expected: FAIL, module `#src/model/spec-version.ts` cannot be resolved. (Ignore any exit-1-with-zero-failures noise from the per-file coverage floor on focused runs; here the failure is a real resolution error.)

- [ ] **Step 3: Implement the helper**

Create `src/model/spec-version.ts`:

```ts
// R-037 — the AsyncAPI version contract plus a parser-free shallow read of the
// `asyncapi` field. Tier 0 (model): pure functions over raw text, so both
// `registry/` (the preflight gate) and `ingestion/` (lockfile provenance, G12)
// can use them without a cross-import between tier-1 peers.
import { parse as parseYaml } from "yaml";

// The versions offbook PROMISES and TESTS. Deliberately an explicit list rather
// than `Object.keys(specs.schemas)`: the parser derives its accepted set from
// whatever @asyncapi/specs resolves at install time, so a schema being present
// does NOT mean the parser's ruleset handles that version. Parser 3.4.0 and
// 3.5.0 accept a 3.1.0 document past their version gate and then die inside
// Spectral with "Error running Nimma". See D-018.
export const SUPPORTED_SPEC_VERSIONS = [
	"2.0.0",
	"2.1.0",
	"2.2.0",
	"2.3.0",
	"2.4.0",
	"2.5.0",
	"2.6.0",
	"3.0.0",
	"3.1.0",
] as const;

// Best-effort, mirroring ingestion's readDeclaredVersion (G12): no
// @asyncapi/parser, no schema interpretation. A spec that will not yaml-parse,
// or that has no `asyncapi` field, just yields undefined.
export function readSpecVersion(specText: string): string | undefined {
	try {
		const doc = parseYaml(specText) as { asyncapi?: unknown } | null;
		const v = doc?.asyncapi;
		return v === undefined || v === null ? undefined : String(v);
	} catch {
		return undefined;
	}
}

export function isSupportedSpecVersion(v: string | undefined): boolean {
	return (
		v !== undefined && (SUPPORTED_SPEC_VERSIONS as readonly string[]).includes(v)
	);
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `bun test src/model/spec-version.test.ts`
Expected: all 5 tests pass. Exit code may still be 1 on a focused run because of the per-file coverage floor; trust the printed failure count of 0 here, per the bunfig note.

- [ ] **Step 5: Write the failing test for the registry preflight gate**

Append to `src/registry/index.test.ts`. Match the file's existing import block and helper style; if it already has a `registryFor` helper, reuse it rather than redefining one.

```ts
// [utest->R-037]
test("refuses a 1.x spec with an actionable, branded error", async () => {
	const spec = `asyncapi: '1.2.0'
info: { title: Legacy, version: 1.0.0 }
topics:
  t.one:
    publish:
      payload: { type: object }
`;
	const attempt = buildRegistry({
		specText: spec,
		service: "legacy",
		config: DEFAULT_CONFIG,
	});
	await expect(attempt).rejects.toThrow(/unsupported AsyncAPI version "1\.2\.0"/);
	// names the supported range and the remedy, not just the problem
	await expect(attempt).rejects.toThrow(/2\.0\.0/);
	await expect(attempt).rejects.toThrow(/asyncapi convert/);
});

// [utest->R-037]
test("refuses a spec with no asyncapi field", async () => {
	await expect(
		buildRegistry({
			specText: "info: { title: T, version: 1.0.0 }",
			service: "nover",
			config: DEFAULT_CONFIG,
		}),
	).rejects.toThrow(/unsupported AsyncAPI version/);
});

// [utest->R-037]
test("accepts every version in the supported contract", async () => {
	for (const v of SUPPORTED_SPEC_VERSIONS) {
		const spec = v.startsWith("3.")
			? `asyncapi: ${v}
info: { title: T, version: 1.0.0 }
channels:
  c: { address: t/one, messages: { M: { payload: { type: object, properties: { a: { type: string } } } } } }
operations:
  o: { action: send, channel: { $ref: '#/channels/c' } }
`
			: `asyncapi: ${v}
info: { title: T, version: 1.0.0 }
channels:
  t/one:
    subscribe:
      operationId: s
      message:
        payload: { type: object, properties: { a: { type: string } } }
`;
		const reg = await buildRegistry({
			specText: spec,
			service: "s",
			config: DEFAULT_CONFIG,
		});
		expect(reg.channels().length, `version ${v} should yield one channel`).toBe(1);
	}
});
```

Add `SUPPORTED_SPEC_VERSIONS` to the test file's imports. This one is a genuine upward reach from `src/registry/`, so the alias is correct here:

```ts
import { SUPPORTED_SPEC_VERSIONS } from "#src/model/spec-version.ts";
```

Note the contrast with Step 1: `src/model/spec-version.test.ts` sits in the same directory as its subject, so it imports `./spec-version.ts` relatively, per D-013. Apply the rule from `CLAUDE.md`, not the shape of a neighbouring import.

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test src/registry/index.test.ts`
Expected: the three new tests FAIL. The 1.x case currently rejects with `failed to parse spec: Version "1.2.0" is not supported…` from the parser, which does not match `/unsupported AsyncAPI version/`, and the no-version case does not reject at all.

- [ ] **Step 7: Add the preflight gate to the registry**

In `src/registry/index.ts`, add the import beside the existing model import:

```ts
import {
	SUPPORTED_SPEC_VERSIONS,
	isSupportedSpecVersion,
	readSpecVersion,
} from "#src/model/spec-version.ts";
```

Then insert the gate as the first statement inside `buildRegistry`, before the `parser.parse` calls:

```ts
	// R-037 preflight: check the declared version BEFORE handing the document to
	// the parser. The parser's own gate is derived from @asyncapi/specs at
	// install time, so an unsupported-but-present version can pass it and then
	// fail deep in the Spectral ruleset with an opaque "Error running Nimma".
	// Offbook's supported set is a promise it tests, so it is checked here (D-018).
	const specVersion = readSpecVersion(opts.specText);
	if (!isSupportedSpecVersion(specVersion)) {
		throw new Error(
			`unsupported AsyncAPI version ${
				specVersion === undefined ? "(no `asyncapi` field found)" : `"${specVersion}"`
			} in service '${opts.service}': offbook supports ${SUPPORTED_SPEC_VERSIONS[0]} through ${
				SUPPORTED_SPEC_VERSIONS[SUPPORTED_SPEC_VERSIONS.length - 1]
			}. Convert the spec first: \`asyncapi convert <file> --target-version 3.1.0\``,
		);
	}
```

- [ ] **Step 8: Run the registry test to verify it passes**

Run: `bun test src/registry/index.test.ts`
Expected: printed failure count 0.

- [ ] **Step 9: Raise the parser floor**

Edit `package.json`, changing the dependency line to:

```json
    "@asyncapi/parser": "^3.6.0",
```

Run: `bun install`
Expected: exit 0. The installed version is already 3.6.0, so `bun.lock` may be unchanged; that is fine.

- [ ] **Step 10: Add the requirement and decision records**

Append three requirements to `REQUIREMENTS.md`, following the exact field order used by existing entries (`UID`, `STATUS`, `COVERS`, `IMPL`, `TEST`, then the prose line). They start as `specified`, which needs no trace, and Task 10 flips them to `tested`.

```markdown
#### AsyncAPI supported-version contract and preflight
**UID**: R-037
**STATUS**: specified
**COVERS**: docs/superpowers/specs/2026-07-30-asyncapi-version-support-design.md
`registry/` refuses any spec outside the tested support set (2.0.0-2.6.0, 3.0.0, 3.1.0) with a branded, actionable error naming the version, the range, and the convert remedy, checked parser-free before `parse()`; the declared version is recorded as `spec-version` in `specs.lock` and on `SpecInfo`.

#### AsyncAPI payload schema boundary
**UID**: R-038
**STATUS**: specified
**COVERS**: docs/superpowers/specs/2026-07-30-asyncapi-version-support-design.md
`registry/` extracts the payload schema from the Multi Format Schema Object wrapper, validates under draft-07 with an explicit stamp, diagnoses post-draft-07 keywords it cannot honor, contains a compile failure as a violation rather than a crash or a green pass, and validates an operation's multiple messages as `anyOf`.

#### MQTT binding integrity across spec majors
**UID**: R-039
**STATUS**: specified
**COVERS**: docs/superpowers/specs/2026-07-30-asyncapi-version-support-design.md
`registry/` guards binding-supplied `qos`/`retain` values (falling through the §2 precedence chain on a bad value), reports unknown keys against the official mqtt operation-binding key set, reports an mqtt CHANNEL binding as ignored, and reports MQTT-5-only binding fields as unhonored under the MQTT 3.1.1-only constraint.
```

Append `D-018` to `DECISIONS.md`, matching the field order of `D-017` (`Date`, `What`, `Why`, `Mitigations / notes`, `Obligations`, `From`, `Folds into`; copy the exact heading and field style from an existing entry):

```markdown
### D-018: offbook supports AsyncAPI 2.0.0-3.1.0, validates payloads under draft-07, and polices bindings itself
**Date**: 2026-07-30
**What**: Declare a tested support matrix (2.0.0-2.6.0, 3.0.0, 3.1.0; 1.x refused), raise the `@asyncapi/parser` floor to `^3.6.0`, gate the version in `registry/` before `parse()`, and harden the shared ingestion path: unwrap the Multi Format Schema Object payload wrapper, validate under JSON Schema draft-07 with an explicit stamp instead of stamping 2020-12, diagnose post-draft-07 keywords, contain Ajv compile failures, validate multi-message operations as `anyOf`, and police mqtt binding values and keys against the official binding schema's key set. Supersedes D-005's deferred 2020-12 obligation.
**Why**: Three defects were found by research, none by a failing test. A valid 3.x multi-format payload made the channel validator accept everything including `null`, because `BaseModel.json()` returns the wrapper verbatim; that is the false-negative class R-028 exists to prevent. A legal draft-07 tuple schema crashed `bootProject` uncaught, because offbook stamped 2020-12 over a schema the parser emits as draft-07. 2.x maps `mqtt` to an empty schema, so `qos: 9` reached a `Channel` typed `0 | 1 | 2`. Converting 2.x to 3.x on ingest was considered and rejected: the fleet is mostly 3.x, so it would add a dependency and a lossy translation layer to serve a shrinking minority, and it would anchor diagnostics to a document the adopter never wrote. Draft-07 is the dialect BOTH majors declare and the parser actually emits, so validating under it is the root-cause fix and needs no schema rewriting (R1 intact).
**Mitigations / notes**: Draft-07 silently ignores post-draft-07 keywords, so a dialect-mismatch diagnostic makes that loud. The explicit supported-version list is cross-checked by a test, because deriving it from `@asyncapi/specs` reproduces the trap that fooled parser 3.4.0/3.5.0. New findings reuse the existing closed `spec-load` diagnostic kind with a machine-greppable `detail` prefix rather than expanding the `Diagnostic.kind` union. A 2.x spec authored from the client's perspective still loads inverted and no tool can detect that; it is documented for adopters.
**Obligations**: none deferred.
**From**: brainstorm dialog 2026-07-30 after a deep-research pass; every behavioral claim verified empirically against the installed toolchain (results tabulated in the design doc).
**Folds into**: src/model/spec-version.ts, src/registry/index.ts, src/ingestion/index.ts, docs/specs/contracts.md §5/§6, fixtures/asyncapi/, REQUIREMENTS.md (R-037-R-039), DECISIONS.md (D-005 superseded note)
```

- [ ] **Step 11: Verify the doc gate and the full suite**

Run: `bun scripts/check-docs.ts; echo "EXIT=$?"`
Expected: `EXIT=0`, and the printed count rises to 39 requirements and 18 decisions.

Run: `bun test; echo "EXIT=$?"`
Expected: `EXIT=0`.

Run: `bun run lint && bun run typecheck; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 12: Commit**

```bash
git add src/model/spec-version.ts src/model/spec-version.test.ts src/registry/index.ts src/registry/index.test.ts package.json bun.lock REQUIREMENTS.md DECISIONS.md
git commit -m "feat(registry): gate the AsyncAPI supported-version contract (R-037)

Refuse any spec outside the tested set (2.0.0-2.6.0, 3.0.0, 3.1.0) with a
branded error naming the version, the range, and the convert remedy, checked
parser-free before parse(). Raise the parser floor to ^3.6.0: 3.4.0/3.5.0 pass
their own dynamic version gate on a 3.1.0 doc and then fail inside Spectral.

Records D-018 and R-037..R-039."
```

---

### Task 2: Unwrap the Multi Format Schema Object payload

The highest-value fix. Today a valid AsyncAPI 3.x document using the explicit `{schemaFormat, schema}` payload form produces a channel that accepts everything, silently.

**Files:**
- Create: `fixtures/asyncapi/multi-format.yaml`
- Modify: `src/registry/index.ts`
- Test: `src/registry/index.test.ts`

**Interfaces:**
- Consumes: the Task 1 preflight gate (the new fixture declares `3.1.0`, which the gate must already allow).
- Produces: `extractPayloadSchema(payloadJson: unknown): object`, module-private in `src/registry/index.ts`. Tasks 3 and 7 call it.

- [ ] **Step 1: Create the fixture**

Create `fixtures/asyncapi/multi-format.yaml`. The strict schema (`required` plus `additionalProperties: false`) is what makes the regression assertion meaningful, and putting the hard case on both a `send` and a `receive` operation satisfies quality-bar item 3 (full-path coverage).

```yaml
asyncapi: 3.1.0
info:
  title: Multi Format Payloads
  version: 1.0.0
  description: >-
    Payloads authored as the explicit Multi Format Schema Object
    (`{schemaFormat, schema}`), which AsyncAPI 3.x permits for the DEFAULT
    JSON-Schema format, not just for Avro or Protobuf. The parser returns that
    wrapper verbatim from `payload().json()`, so a consumer that spreads it gets
    a schema with no validation keywords: a validator that accepts everything
    (D-018). Both directions carry the form, so the client-publish path is
    covered too. Also the newest-supported-major acceptance fixture.
servers:
  mosquitto:
    host: localhost:1883
    protocol: mqtt
    protocolVersion: '3.1.1'
channels:
  reading:
    address: reading/{sensorId}
    parameters:
      sensorId:
        description: sensor instance id
    messages:
      Reading:
        name: Reading
        payload:
          schemaFormat: 'application/vnd.aai.asyncapi;version=3.1.0'
          schema:
            type: object
            required: [sensorId, celsius]
            additionalProperties: false
            properties:
              sensorId:
                type: string
              celsius:
                type: number
  calibrate:
    address: calibrate/{sensorId}
    parameters:
      sensorId:
        description: sensor instance id
    messages:
      Calibrate:
        name: Calibrate
        payload:
          schemaFormat: 'application/vnd.aai.asyncapi;version=3.1.0'
          schema:
            type: object
            required: [offset]
            additionalProperties: false
            properties:
              offset:
                type: number
operations:
  sendReading:
    action: send
    channel:
      $ref: '#/channels/reading'
  receiveCalibrate:
    action: receive
    channel:
      $ref: '#/channels/calibrate'
```

- [ ] **Step 2: Write the failing regression test**

Append to `src/registry/index.test.ts`:

```ts
// [utest->R-038]
test("a multi-format payload still VALIDATES (the wrapper must be unwrapped)", async () => {
	const reg = await registryFor("multi-format.yaml");
	const reading = reg.match("reading/s1")?.channel;
	expect(reading).toBeDefined();
	// the schema handed to Ajv must be the payload schema, not the wrapper
	expect(Object.keys(reading?.schema as object)).not.toContain("schemaFormat");
	expect(Object.keys(reading?.schema as object)).not.toContain("schema");
	// conforming payload passes
	expect(reading?.validate({ sensorId: "s1", celsius: 21.5 })).toEqual([]);
	// and the tripwire: garbage must NOT pass. Before the unwrap every one of
	// these validated green, which is the false-negative class R-028 forbids.
	expect(reading?.validate({ sensorId: 42, celsius: "hot" }).length).toBeGreaterThan(0);
	expect(reading?.validate({ unrelated: true }).length).toBeGreaterThan(0);
	expect(reading?.validate("not-an-object").length).toBeGreaterThan(0);
	expect(reading?.validate(null).length).toBeGreaterThan(0);
});

// [utest->R-038]
test("the multi-format wrapper is unwrapped on the client-publish path too", async () => {
	const reg = await registryFor("multi-format.yaml");
	const calibrate = reg.match("calibrate/s1")?.channel;
	expect(calibrate?.direction).toBe("fromClient");
	expect(calibrate?.validate({ offset: 0.5 })).toEqual([]);
	expect(calibrate?.validate({ offset: "half" }).length).toBeGreaterThan(0);
	expect(calibrate?.validate({}).length).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test src/registry/index.test.ts`
Expected: both new tests FAIL. The schema's top-level keys are `$schema, schemaFormat, schema`, and every garbage payload validates green.

- [ ] **Step 4: Implement the extraction**

In `src/registry/index.ts`, add this function beside `directionOf`:

```ts
// AsyncAPI 3.x lets a payload be a Multi Format Schema Object (`{schemaFormat,
// schema}`), permitted even for the default JSON-Schema format. `BaseModel.json()`
// returns that wrapper verbatim (the parser's own Schema model unwraps
// `_json.schema` internally for its typed accessors), so spreading it yields a
// schema with NO validation keywords: a validator that accepts everything (D-018).
// Deliberately does NOT branch on the schemaFormat STRING: the implementation
// emits `application/vnd.aai.asyncapi;version=X` while the spec text mandates a
// `+json` suffix, so a literal comparison would silently stop matching.
function extractPayloadSchema(payloadJson: unknown): object {
	if (payloadJson === null || typeof payloadJson !== "object") return {};
	const p = payloadJson as Record<string, unknown>;
	if ("schemaFormat" in p && typeof p.schema === "object" && p.schema !== null) {
		return p.schema as object;
	}
	return p;
}
```

Then replace the schema construction inside the operation loop. Change:

```ts
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			...((msg?.payload()?.json() ?? {}) as object),
		};
```

to:

```ts
		const schema = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			...extractPayloadSchema(msg?.payload()?.json()),
		};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/registry/index.test.ts`
Expected: printed failure count 0.

Run: `bun test; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add src/registry/index.ts src/registry/index.test.ts fixtures/asyncapi/multi-format.yaml
git commit -m "fix(registry): unwrap the Multi Format Schema Object payload (R-038)

A valid AsyncAPI 3.x payload authored as {schemaFormat, schema} produced a
channel schema with no validation keywords, so it accepted everything including
null and bare strings: a silent false negative on a supported version. Extract
the inner schema, and pin it with a multi-format.yaml fixture whose garbage
payloads must be rejected on both the send and receive paths."
```

---

### Task 3: Validate under draft-07

Root-cause fix for the tuple crash and the silently-ignored `additionalItems`, and the reason D-005's obligation closes.

**Files:**
- Modify: `src/registry/index.ts`, `fixtures/asyncapi/composition.yaml`, `fixtures/asyncapi/external-ref.yaml`, `docs/specs/contracts.md`, `DECISIONS.md`
- Test: `src/registry/index.test.ts`

**Interfaces:**
- Consumes: `extractPayloadSchema` from Task 2.
- Produces: module constant `DRAFT_07 = "http://json-schema.org/draft-07/schema#"`, and every `Channel.schema` now carries that `$schema` value. Tasks 6 and 7 reuse `DRAFT_07`.

- [ ] **Step 1: Add a tuple payload to the composition fixture**

`composition.yaml` is the schema-shapes fixture, so the tuple case belongs there. Add a third channel and its operation, matching the file's existing indentation and comment style. Read the file first to place these consistently; the `window` channel below is additive and must not disturb the existing `allOf`/`oneOf`/`anyOf` channels.

Add under `channels:`:

```yaml
  window:
    address: window/{sensorId}
    parameters:
      sensorId:
        description: sensor instance id
    messages:
      Window:
        name: Window
        payload:
          # Draft-07 TUPLE validation: `items` as an ARRAY constrains positions.
          # Legal in both spec majors (the Schema Object is a draft-07 superset),
          # but it made ajv.compile() THROW while offbook stamped 2020-12, which
          # renamed the tuple form to `prefixItems` (D-018). Under draft-07 it
          # validates positionally, and `additionalItems` is honored.
          type: array
          items:
            - type: string
            - type: number
          additionalItems: false
```

Add under `operations:`:

```yaml
  sendWindow:
    action: send
    channel:
      $ref: '#/channels/window'
```

> **AMENDED DURING EXECUTION (2026-07-30).** Steps 1 and 1b below were **not** taken. Implementation measured that **json-schema-faker 0.6.2 cannot draw a valid draft-07 tuple**: it emits objects with numeric keys (for example `[{"0":"aG88rL","1":441.48}, ...]`) and fails the Ajv recheck **10/10 seeds**, unchanged by `additionalItems` or `minItems`. A tuple channel in `composition.yaml` therefore fails the R-027 faker-floor spike and would flip **D-008**'s measured verdict, which is a separate question from the dialect. The tuple regression case was implemented as an **inline test spec** in `src/registry/index.test.ts` instead, `composition.yaml` and the spike expectation were left untouched, and the finding is recorded in D-018 with the keyed-fallback question left open. Steps 2 onward were followed as written.

- [ ] ~~**Step 1b: Re-measure the spike expectation for composition.yaml**~~ (superseded, see above)

Adding the `window` channel gives `composition.yaml` a third channel, so the R-027 tripwire's pinned draw count changes (see the Global Constraints bullet on this coupling). In `test/spikes/jsf-fidelity.test.ts`, update the `composition.yaml` entry from `{ draws: 20, failures: 0 }` to the freshly measured value, which should be `{ draws: 30, failures: 0 }` for three channels at ten seeds each, and add a comment noting the re-measurement and citing D-018.

**Measure, do not assume.** Run the suite and read the actual numbers rather than trusting the arithmetic. If `failures` comes back non-zero, STOP and report: it would mean json-schema-faker cannot draw valid data for a draft-07 tuple, which is a genuine finding about the dialect change and not something to paper over by adjusting the expectation.

No fixture is being added here, so `SPIKE_FIXTURES` itself needs no change.

- [ ] **Step 2: Write the failing dialect tests**

Append to `src/registry/index.test.ts`:

```ts
// [utest->R-038]
test("draft-07 tuple `items` validates positionally instead of crashing the build", async () => {
	const reg = await registryFor("composition.yaml");
	const window = reg.match("window/s1")?.channel;
	expect(window).toBeDefined();
	expect(window?.validate(["a", 1])).toEqual([]);
	// wrong order and wrong type at position 1 are both caught
	expect(window?.validate([1, "a"]).length).toBeGreaterThan(0);
	expect(window?.validate(["a", "b"]).length).toBeGreaterThan(0);
	// additionalItems: false is honored under draft-07 (2020-12 ignores it)
	expect(window?.validate(["a", 1, "extra"]).length).toBeGreaterThan(0);
});

// [utest->R-038]
test("channel schemas declare the draft-07 dialect they are validated under", async () => {
	const reg = await registryFor("thermostat.yaml");
	const schema = reg.channels()[0].schema as { $schema?: string };
	expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test src/registry/index.test.ts`
Expected: FAIL. The tuple test fails hard, because `ajv.compile()` throws `schema is invalid: data/items must be object,boolean` while building the `composition.yaml` registry, which will surface as an error from `registryFor` rather than an assertion failure. The `$schema` test fails on the 2020-12 value.

- [ ] **Step 4: Switch the dialect**

In `src/registry/index.ts`, replace the Ajv import:

```ts
import Ajv2020 from "ajv/dist/2020";
```

with:

```ts
import Ajv from "ajv";
```

Add the constant beside `extractPayloadSchema`:

```ts
// The dialect BOTH spec majors declare for the Schema Object ("a superset of
// JSON Schema Draft 07") and the one @asyncapi/parser actually emits. Stamping
// 2020-12 over it was the root cause of the tuple-compile crash and of
// `additionalItems` being silently ignored (D-018). Stamped explicitly so
// `channel.schema`, which GET /topics hands out, is self-describing.
const DRAFT_07 = "http://json-schema.org/draft-07/schema#";
```

Replace the Ajv construction:

```ts
	const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
```

with:

```ts
	const ajv = addFormats(new Ajv({ allErrors: true, strict: false }));
```

And the stamp:

```ts
		const schema = {
			$schema: DRAFT_07,
			...extractPayloadSchema(msg?.payload()?.json()),
		};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test src/registry/index.test.ts`
Expected: printed failure count 0, including the pre-existing `external-ref` tests and the D-005 tripwire, whose behavior is unchanged under draft-07 (the external `pattern` is still enforced, the `$ref` sibling `minLength` is still not).

Run: `bun test; echo "EXIT=$?"`
Expected: `EXIT=0`. If `src/engine/faker.test.ts` or the R-027 spike test fails, stop: it would mean json-schema-faker draws differently for the new tuple channel. Investigate before proceeding rather than adjusting seeds.

- [ ] **Step 6: Reword the D-005 tripwire comment in the fixture**

In `fixtures/asyncapi/external-ref.yaml`, the comment above `minLength: 3` currently frames the dropped sibling as a limitation awaiting a 2020-12 spike. Replace that comment block with:

```yaml
          # A 2020-12 reader would honor this `minLength` beside the `$ref`; a draft-07
          # reader ignores `$ref` siblings, and draft-07 is the dialect BOTH spec majors
          # declare and the parser emits, so offbook validating under it means the sibling
          # is correctly NOT enforced (D-018 supersedes D-005's deferred 2020-12 spike).
          # The external `pattern` IS inlined and enforced. The tripwire in
          # registry/index.test.ts pins this so a future dialect change is loud.
```

Update the corresponding tripwire test comment in `src/registry/index.test.ts` from "KNOWN LIMITATION (D-005 …)" to reference D-018 as dialect-correct behavior. Keep the assertions exactly as they are.

- [ ] **Step 7: Reverse the dialect statement in the canonical contract**

`docs/specs/contracts.md` §5 currently says the bundled schema is handed to Ajv with only a 2020-12 stamp (search for `2020-12` and for `$schema`). Contracts is canonical, so this must change, not merely the guide. Replace each 2020-12 assertion about the payload dialect with the draft-07 statement, for example:

> **`Channel.schema` is validated under JSON Schema draft-07**, the dialect both AsyncAPI majors declare for the Schema Object and the one `@asyncapi/parser` emits; `registry/` stamps `$schema: http://json-schema.org/draft-07/schema#` explicitly so the schema `GET /topics` hands out is self-describing (D-018). Keywords added after draft-07 (`prefixItems`, `unevaluatedProperties`, `dependentRequired`, and friends) cannot be honored and are surfaced as a `spec-load` diagnostic rather than silently ignored.

Leave the surrounding bundling requirements (parser-provided, never hand-rolled `$ref` walking, R1) intact.

- [ ] **Step 8: Add the superseded note to D-005**

In `DECISIONS.md`, append to `D-005`'s `Obligations (deferred spike)` field:

```markdown
**Superseded by**: D-018 (2026-07-30). offbook now validates under draft-07, the dialect both majors declare and the parser emits, so the dropped `$ref` sibling is dialect-correct behavior rather than a limitation, and the 2020-12 schema-parser spike is no longer an obligation. The tripwire is retained and reworded so a future dialect change stays loud.
```

- [ ] **Step 9: Verify all gates**

Run: `bun scripts/check-docs.ts; echo "EXIT=$?"`
Expected: `EXIT=0`.

Run: `bun test; echo "EXIT=$?"` then `bun run lint && bun run typecheck; echo "EXIT=$?"`
Expected: `EXIT=0` for both.

- [ ] **Step 10: Commit**

```bash
git add src/registry/index.ts src/registry/index.test.ts fixtures/asyncapi/composition.yaml fixtures/asyncapi/external-ref.yaml docs/specs/contracts.md DECISIONS.md
git commit -m "fix(registry): validate payloads under draft-07, not 2020-12 (R-038)

Both spec majors define the Schema Object as a draft-07 superset and the parser
emits draft-07, so stamping 2020-12 was the root cause of a legal tuple schema
crashing ajv.compile() and of additionalItems being silently ignored. Verified
the external-ref bar and the D-005 tripwire behave identically.

Reverses the 2020-12 statement in contracts.md §5 (canonical) and closes
D-005's deferred obligation as superseded by D-018."
```

---

### Task 4: A diagnostics channel on the registry

Plumbing plus its first consumer. Registry-time findings cannot be recomputed from `Channel` alone, so the registry carries them out.

**Files:**
- Modify: `src/model/index.ts`, `src/registry/index.ts`, `src/compose/index.ts`, `docs/specs/contracts.md`
- Test: `src/registry/index.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SpecRegistry.diagnostics(): readonly Diagnostic[]`. Both `buildRegistry` and `mergeRegistries` implement it. Tasks 5, 6, and 8 push into the same array. Diagnostic `detail` strings begin with a stable tag followed by `: `.

- [ ] **Step 1: Write the failing test**

Append to `src/registry/index.test.ts`:

```ts
// [utest->R-039]
test("an mqtt CHANNEL binding is reported as ignored, not silently dropped", async () => {
	const spec = `asyncapi: 3.0.0
info: { title: T, version: 1.0.0 }
channels:
  c:
    address: t/chanbound
    bindings: { mqtt: { qos: 2, retain: true } }
    messages: { M: { payload: { type: object, properties: { a: { type: string } } } } }
operations:
  o: { action: send, channel: { $ref: '#/channels/c' } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	// MQTT defines qos/retain on the OPERATION only: the Channel Binding Object
	// "MUST NOT contain any properties" at every binding version, so the values
	// are ignored and the channel keeps the global defaults.
	expect(reg.match("t/chanbound")?.channel.qos).toBe(1);
	const found = reg.diagnostics().filter((d) => d.detail.startsWith("binding-on-channel:"));
	expect(found.length).toBe(1);
	expect(found[0].kind).toBe("spec-load");
	expect(found[0].severity).toBe("warning");
	expect(found[0].source).toBe("t/chanbound");
});

// [utest->R-039]
test("a clean spec produces no registry diagnostics", async () => {
	const reg = await registryFor("thermostat.yaml");
	expect(reg.diagnostics()).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/registry/index.test.ts`
Expected: FAIL, `reg.diagnostics is not a function`.

- [ ] **Step 3: Add `diagnostics()` to the contract type**

In `src/model/index.ts`, extend the interface:

```ts
export interface SpecRegistry {
	match(
		topic: string,
	): { channel: Channel; params: Record<string, string> } | undefined;
	matchesFilter(filter: string, topic: string): boolean;
	channels(): readonly Channel[];
	// Registry-time spec-QUALITY findings (D-018): problems discoverable only
	// while building the catalog, so they cannot be recomputed from Channel
	// later (binding placement, dialect mismatch, a schema that would not
	// compile). Collected once at build; the composition root merges them into
	// GET /v1/diagnostics beside the computed ones. Uses the existing closed
	// `spec-load` kind with a machine-greppable `detail` tag prefix.
	diagnostics(): readonly Diagnostic[];
}
```

`Diagnostic` is declared later in the same file, which is fine for a TypeScript interface reference.

- [ ] **Step 4: Collect and expose diagnostics in the registry**

In `src/registry/index.ts`, add `Diagnostic` to the type import from `#src/model/index.ts`.

Declare the array beside `const channels: Channel[] = [];`:

```ts
	const diagnostics: Diagnostic[] = [];
```

Inside the operation loop, after `const address = ch.address() ?? "";`, add the first consumer:

```ts
		// MQTT defines qos/retain on the OPERATION binding only: the Channel
		// Binding Object "MUST NOT contain any properties. Its name is reserved
		// for future use." at every binding version. A channel-level mqtt binding
		// nonetheless parses clean, so say it is ignored rather than defaulting
		// in silence (D-018).
		const channelMqtt = ch.bindings().get("mqtt")?.value<Record<string, unknown>>();
		if (channelMqtt && Object.keys(channelMqtt).length > 0) {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `binding-on-channel: '${address}' declares an mqtt CHANNEL binding (${Object.keys(
					channelMqtt,
				).join(", ")}); MQTT defines qos/retain on the operation only, so these are ignored`,
				source: address,
			});
		}
```

Add to the returned object in `buildRegistry`:

```ts
		diagnostics: () => diagnostics,
```

And to `mergeRegistries`'s returned object:

```ts
		diagnostics: () => registries.flatMap((r) => [...r.diagnostics()]),
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test src/registry/index.test.ts`
Expected: printed failure count 0.

- [ ] **Step 6: Wire the diagnostics into the control plane**

In `src/compose/index.ts`, add the registry's diagnostics to the list at lines 183-190:

```ts
		diagnostics: () => [
			...(runtime?.diagnostics() ?? []),
			...registry.diagnostics(),
			...specQualityDiagnostics(registry.channels()),
			...uninstantiatedDiagnostics(
				registry.channels(),
				engine.instances.snapshot(),
			),
		],
```

- [ ] **Step 7: Document the contract change**

In `docs/specs/contracts.md`, add `diagnostics()` to the `SpecRegistry` interface block (around line 45-49) with a short comment, and note in §5's diagnostics prose that `spec-load` entries now also carry registry-time findings tagged by a `detail` prefix (`binding-on-channel`, `binding-invalid-value`, `binding-unknown-key`, `mqtt5-field-ignored`, `dialect-mismatch`, `schema-compile-failed`).

- [ ] **Step 8: Verify all gates**

Run: `bun test; echo "EXIT=$?"`
Expected: `EXIT=0`. If any test builds a fake `SpecRegistry` object literal, it will now fail to typecheck for a missing `diagnostics`; add `diagnostics: () => []` to those fakes.

Run: `bun run lint && bun run typecheck && bun scripts/check-docs.ts; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 9: Commit**

```bash
git add src/model/index.ts src/registry/index.ts src/registry/index.test.ts src/compose/index.ts docs/specs/contracts.md
git commit -m "feat(registry): carry registry-time diagnostics to /v1/diagnostics (R-039)

Registry-time findings cannot be recomputed from Channel, so SpecRegistry gains
diagnostics(), merged by the composition root beside the computed ones. First
consumer: an mqtt CHANNEL binding, which is illegal per the binding spec at
every version yet parses clean, is now reported as ignored instead of silently
falling back to the default qos."
```

---

### Task 5: Diagnose keywords draft-07 cannot honor

Draft-07 ignores unknown keywords, so a 2020-12-authored payload would silently under-validate. This makes that loud.

**Files:**
- Modify: `src/registry/index.ts`
- Test: `src/registry/index.test.ts`

**Interfaces:**
- Consumes: the `diagnostics` array from Task 4.
- Produces: diagnostics tagged `dialect-mismatch: `.

- [ ] **Step 1: Write the failing test**

Append to `src/registry/index.test.ts`:

```ts
// [utest->R-038]
test("post-draft-07 keywords are surfaced, since draft-07 ignores them silently", async () => {
	const spec = `asyncapi: 3.0.0
info: { title: T, version: 1.0.0 }
channels:
  c:
    address: t/modern
    messages:
      M:
        payload:
          type: object
          required: [items]
          properties:
            items:
              type: array
              prefixItems:
                - type: string
          unevaluatedProperties: false
operations:
  o: { action: send, channel: { $ref: '#/channels/c' } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const found = reg.diagnostics().filter((d) => d.detail.startsWith("dialect-mismatch:"));
	expect(found.length).toBe(1);
	expect(found[0].severity).toBe("warning");
	expect(found[0].source).toBe("t/modern");
	// names every offending keyword so the author can fix them all at once
	expect(found[0].detail).toContain("prefixItems");
	expect(found[0].detail).toContain("unevaluatedProperties");
});

// [utest->R-038]
test("$defs and definitions are NOT reported: both work under draft-07", async () => {
	// the repo's own shared/common.yaml uses $defs, so flagging it would cry wolf
	const reg = await registryFor("external-ref.yaml");
	expect(reg.diagnostics().filter((d) => d.detail.startsWith("dialect-mismatch:"))).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/registry/index.test.ts`
Expected: the first new test FAILS, `found.length` is 0.

- [ ] **Step 3: Implement the scan**

In `src/registry/index.ts`, add beside `DRAFT_07`:

```ts
// Keywords JSON Schema introduced after draft-07. offbook validates under
// draft-07, where these are unknown and therefore SILENTLY IGNORED, which is
// the worst failure mode for a contract checker, so their presence is surfaced
// (D-018). `$defs` and `definitions` are deliberately absent: both resolve
// correctly under draft-07, and fixtures/asyncapi/shared/common.yaml
// legitimately uses `$defs`.
const POST_DRAFT07_KEYWORDS = new Set([
	"prefixItems",
	"unevaluatedProperties",
	"unevaluatedItems",
	"dependentRequired",
	"dependentSchemas",
	"minContains",
	"maxContains",
	"$dynamicRef",
	"$dynamicAnchor",
	"$recursiveRef",
	"$recursiveAnchor",
]);

function postDraft07Keywords(
	node: unknown,
	found: Set<string> = new Set(),
): Set<string> {
	if (Array.isArray(node)) {
		for (const item of node) postDraft07Keywords(item, found);
		return found;
	}
	if (node === null || typeof node !== "object") return found;
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (POST_DRAFT07_KEYWORDS.has(key)) found.add(key);
		postDraft07Keywords(value, found);
	}
	return found;
}
```

Inside the operation loop, after `const schema = { ... }`, add:

```ts
		const modernKeywords = postDraft07Keywords(schema);
		if (modernKeywords.size > 0) {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `dialect-mismatch: '${address}' uses post-draft-07 keyword(s) ${[
					...modernKeywords,
				]
					.sort()
					.join(", ")}; offbook validates under draft-07 (the dialect both AsyncAPI majors declare), so these are NOT enforced`,
				source: address,
			});
		}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/registry/index.test.ts`
Expected: printed failure count 0.

Run: `bun test; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add src/registry/index.ts src/registry/index.test.ts
git commit -m "feat(registry): diagnose post-draft-07 keywords (R-038)

Draft-07 ignores prefixItems, unevaluatedProperties, dependentRequired and
friends rather than erroring, which would under-validate silently. Name every
offending keyword per channel. \$defs and definitions are excluded: both work
under draft-07 and shared/common.yaml uses \$defs."
```

---

### Task 6: Contain a schema that will not compile

**Files:**
- Modify: `src/registry/index.ts`
- Test: `src/registry/index.test.ts`

**Interfaces:**
- Consumes: `DRAFT_07`, the `diagnostics` array.
- Produces: a channel whose `validate` returns one `SchemaError` with `keyword: "offbook:schema-compile-failed"`.

- [ ] **Step 1: Write the failing test**

This needs a payload the AsyncAPI parser **accepts** but Ajv refuses to compile, which is a narrow set: the parser validates payloads against the draft-07-based Schema Object meta-schema, so most malformed schemas (`minLength: not-a-number`, `multipleOf: 0`, `type: 17`, `required: nope`) are rejected at parse and never reach Ajv. **An invalid regex is the realistic case**: `pattern: '['` satisfies the meta-schema (which treats `format: regex` as an annotation) and then makes Ajv throw `Invalid regular expression: missing terminating ] for character class`. Verified during planning; do not substitute another shape without re-checking it the same way.

```ts
// [utest->R-038]
test("a schema that will not compile yields violations, never a crash and never green", async () => {
	const spec = `asyncapi: 3.0.0
info: { title: T, version: 1.0.0 }
channels:
  c:
    address: t/broken
    messages:
      M:
        payload:
          type: object
          properties:
            bad:
              type: string
              pattern: '['
operations:
  o: { action: send, channel: { $ref: '#/channels/c' } }
`;
	// does not throw: discovery is a v1 floor that must survive a weak spec
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const broken = reg.match("t/broken")?.channel;
	expect(broken).toBeDefined();
	// and it must NOT validate green, which would be false confidence
	const errs = broken?.validate({ anything: true }) ?? [];
	expect(errs.length).toBe(1);
	expect(errs[0].keyword).toBe("offbook:schema-compile-failed");
	const found = reg.diagnostics().filter((d) => d.detail.startsWith("schema-compile-failed:"));
	expect(found.length).toBe(1);
	expect(found[0].severity).toBe("error");
	expect(found[0].source).toBe("t/broken");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/registry/index.test.ts`
Expected: FAIL. `buildRegistry` rejects with a raw Ajv error rather than returning a registry.

If instead the test fails because the document did not parse at all, the payload was caught by the parser's meta-schema rather than by Ajv, and the test is measuring the wrong thing. Re-confirm the shape with:

```bash
bun -e 'import Ajv from "ajv"; const a=new Ajv({strict:false}); try{a.compile({type:"object",properties:{bad:{type:"string",pattern:"["}}});console.log("COMPILED (pick another shape)")}catch(e){console.log("REJECTS:",e.message.slice(0,80))}'
```

Expected: `REJECTS: Invalid regular expression: …`.

- [ ] **Step 3: Wrap the compile**

In `src/registry/index.ts`, replace:

```ts
		const validateFn = ajv.compile(schema);
```

with:

```ts
		// A schema Ajv refuses must never validate GREEN: that is false
		// confidence, the failure mode this tool exists to prevent. The channel
		// still enters the catalog because discovery is a v1 floor that survives
		// weak specs, but every payload on it reports one explicit violation
		// (D-018).
		let validate: (payload: unknown) => SchemaError[];
		try {
			const validateFn = ajv.compile(schema);
			validate = (payload: unknown): SchemaError[] =>
				validateFn(payload) ? [] : ((validateFn.errors ?? []) as SchemaError[]);
		} catch (cause) {
			const reason = (cause as Error).message;
			diagnostics.push({
				kind: "spec-load",
				severity: "error",
				detail: `schema-compile-failed: '${address}' payload schema did not compile, so nothing on this channel is validated: ${reason}`,
				source: address,
			});
			const compileError: SchemaError = {
				instancePath: "",
				schemaPath: "#",
				keyword: "offbook:schema-compile-failed",
				params: {},
				message: `payload schema did not compile: ${reason}`,
			};
			validate = () => [compileError];
		}
```

Then replace the inline `validate` in the `channels.push({ … })` call:

```ts
			validate: (payload: unknown): SchemaError[] =>
				validateFn(payload) ? [] : ((validateFn.errors ?? []) as SchemaError[]),
```

with:

```ts
			validate,
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/registry/index.test.ts`
Expected: printed failure count 0.

Run: `bun test; echo "EXIT=$?"` then `bun run typecheck; echo "EXIT=$?"`
Expected: `EXIT=0` for both.

- [ ] **Step 5: Commit**

```bash
git add src/registry/index.ts src/registry/index.test.ts
git commit -m "fix(registry): contain an uncompilable payload schema (R-038)

ajv.compile() threw out of buildRegistry uncaught, surfacing as a raw Ajv error
from bootProject with no channel named. Wrap it: the channel still enters the
catalog, because discovery is a v1 floor, but every payload reports one explicit
offbook:schema-compile-failed violation rather than validating green, and the
failure is surfaced as a spec-load diagnostic naming the topic."
```

---

### Task 7: Validate every declared message, not just the first

**Files:**
- Modify: `src/registry/index.ts`
- Test: `src/registry/index.test.ts`

**Interfaces:**
- Consumes: `extractPayloadSchema`, `DRAFT_07`.
- Produces: for an operation with more than one message, `Channel.schema` is `{$schema, anyOf: [...]}`.

- [ ] **Step 1: Write the failing test**

```ts
// [utest->R-038]
test("a v2 message.oneOf union validates EITHER variant, not just the first", async () => {
	const spec = `asyncapi: 2.6.0
info: { title: T, version: 1.0.0 }
channels:
  t/union:
    subscribe:
      operationId: s
      message:
        oneOf:
          - payload: { type: object, required: [a], additionalProperties: false, properties: { a: { type: string } } }
          - payload: { type: object, required: [b], additionalProperties: false, properties: { b: { type: number } } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const union = reg.match("t/union")?.channel;
	expect(union?.validate({ a: "x" })).toEqual([]);
	// before the anyOf, variant two was reported as a violation because only
	// messages()[0] was read
	expect(union?.validate({ b: 2 })).toEqual([]);
	// and something matching NEITHER variant is still caught
	expect(union?.validate({ c: true }).length).toBeGreaterThan(0);
});

// [utest->R-038]
test("a single-message operation keeps its schema unwrapped by anyOf", async () => {
	const reg = await registryFor("thermostat.yaml");
	const schema = reg.channels()[0].schema as Record<string, unknown>;
	expect(schema.anyOf).toBeUndefined();
	expect(schema.type).toBe("object");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/registry/index.test.ts`
Expected: the union test FAILS on `union?.validate({ b: 2 })`, which returns errors because only the first message's schema is compiled.

- [ ] **Step 3: Build the anyOf**

In `src/registry/index.ts`, replace:

```ts
		const msg = op.messages().all()[0];
```

with:

```ts
		// An MQTT topic can legitimately carry one of several declared message
		// types (a v2 `message.oneOf` union, or a v3 operation listing several
		// messages). Reading only messages()[0] reported every other variant as a
		// violation. `anyOf` keeps Channel.schema singular, so the faker and
		// /topics are unaffected (D-018).
		const messages = op.messages().all();
		const msg = messages[0];
		const payloadSchemas = messages.map((m) =>
			extractPayloadSchema(m.payload()?.json()),
		);
```

and replace the schema construction:

```ts
		const schema = {
			$schema: DRAFT_07,
			...extractPayloadSchema(msg?.payload()?.json()),
		};
```

with:

```ts
		const schema =
			payloadSchemas.length > 1
				? { $schema: DRAFT_07, anyOf: payloadSchemas }
				: { $schema: DRAFT_07, ...(payloadSchemas[0] ?? {}) };
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/registry/index.test.ts`
Expected: printed failure count 0.

Run: `bun test; echo "EXIT=$?"`
Expected: `EXIT=0`. Watch `src/engine/faker.test.ts` and the R-027 spike test: json-schema-faker must still draw Ajv-valid data. `composition.yaml` already exercises `anyOf` with zero recheck failures, so this path is known good; if a faker test fails, stop and investigate rather than adjusting seeds.

- [ ] **Step 5: Commit**

```bash
git add src/registry/index.ts src/registry/index.test.ts
git commit -m "fix(registry): validate all of an operation's messages as anyOf (R-038)

Only messages()[0] was compiled, so a v2 message.oneOf union or a v3
multi-message operation reported every non-first variant as a contract
violation. anyOf keeps Channel.schema singular, leaving the faker and /topics
untouched."
```

---

### Task 8: MQTT binding integrity

Closes the 2.x unvalidated-binding hole without a converter, and reports what MQTT 3.1.1 cannot honor.

**Files:**
- Create: `fixtures/asyncapi/v2-oldest.yaml`
- Modify: `src/registry/index.ts`
- Test: `src/registry/index.test.ts`

**Interfaces:**
- Consumes: the `diagnostics` array.
- Produces: diagnostics tagged `binding-invalid-value: `, `binding-unknown-key: `, `mqtt5-field-ignored: `. A rejected binding value falls through to the next tier of the existing §2 precedence chain.

- [ ] **Step 1: Create the oldest-major fixture**

Create `fixtures/asyncapi/v2-oldest.yaml`. `qos: 2` differs from the global default (1) and from any per-service default, so the assertion is not vacuous (quality-bar item 1).

```yaml
asyncapi: '2.0.0'
info:
  title: Oldest Supported Major
  version: 1.0.0
  description: >-
    AsyncAPI 2.0.0, the FLOOR of offbook's supported range (D-018). Pins that
    the oldest major still parses, that `publish`/`subscribe` normalize to
    fromClient/toClient, and that a 2.x mqtt OPERATION binding is read (2.x maps
    `mqtt` to an empty schema in its own meta-schema, so nothing validates it
    upstream: offbook checks the values and keys itself).
servers:
  mosquitto:
    url: localhost:1883
    protocol: mqtt
    protocolVersion: '3.1.1'
channels:
  legacy/{deviceId}/telemetry:
    parameters:
      deviceId:
        schema:
          type: string
    subscribe:                     # service publishes ⇒ client receives ⇒ toClient
      operationId: sendTelemetry
      bindings:
        mqtt:
          qos: 2                   # differs from the global default (1): a real assertion
          retain: true
          bindingVersion: '0.1.0'
      message:
        $ref: '#/components/messages/Telemetry'
  legacy/{deviceId}/command:
    parameters:
      deviceId:
        schema:
          type: string
    publish:                       # client publishes ⇒ service receives ⇒ fromClient
      operationId: receiveCommand
      message:
        $ref: '#/components/messages/Command'
components:
  messages:
    Telemetry:
      name: Telemetry
      payload:
        type: object
        required: [deviceId, celsius]
        additionalProperties: false
        properties:
          deviceId:
            type: string
          celsius:
            type: number
    Command:
      name: Command
      payload:
        type: object
        required: [mode]
        additionalProperties: false
        properties:
          mode:
            type: string
            enum: [heat, cool, off]
```

- [ ] **Step 1b: Register the new fixture with the spike tripwire**

`v2-oldest.yaml` joins `fixtures/asyncapi/`, so the R-027 tripwire goes red until it is registered (see the Global Constraints bullet on this coupling; Task 2 hit the same thing with `multi-format.yaml`). Add `"v2-oldest.yaml"` to `SPIKE_FIXTURES` in `scripts/spike-jsf-fidelity.ts`, keeping the list alphabetically sorted, and add a measured `EXPECTED` entry in `test/spikes/jsf-fidelity.test.ts` with a comment citing D-018. Two channels at ten seeds each should give `{ draws: 20, failures: 0 }`.

**Measure, do not assume**, and if `failures` is non-zero, STOP and report rather than adjusting the expectation. Include both files in this task's `git add`.

- [ ] **Step 2: Write the failing tests**

```ts
// [utest->R-039]
test("the oldest supported major parses, inverts direction, and its binding is read", async () => {
	const reg = await registryFor("v2-oldest.yaml");
	const telemetry = reg.match("legacy/d1/telemetry")?.channel;
	const command = reg.match("legacy/d1/command")?.channel;
	// v2 subscribe = messages PRODUCED by the application (the service) ⇒ toClient
	expect(telemetry?.direction).toBe("toClient");
	// v2 publish = messages CONSUMED by the application ⇒ the client sends them
	expect(command?.direction).toBe("fromClient");
	expect(telemetry?.qos).toBe(2);
	expect(telemetry?.retain).toBe(true);
	expect(reg.diagnostics()).toEqual([]);
});

// [utest->R-039]
test("an out-of-range binding qos is rejected and falls through the precedence chain", async () => {
	// 2.x maps `mqtt` to an empty schema, so qos 9 parses clean upstream and
	// would otherwise reach a Channel typed 0 | 1 | 2
	const spec = `asyncapi: 2.6.0
info: { title: T, version: 1.0.0 }
channels:
  t/bad:
    subscribe:
      operationId: s
      bindings:
        mqtt: { qos: 9, retain: "yes" }
      message:
        payload: { type: object, properties: { a: { type: string } } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
		serviceConfig: { repo: "x", specPath: "y", qosDefault: 0, retainDefault: true },
	});
	const ch = reg.match("t/bad")?.channel;
	// falls through to the per-service default (tier 3), NOT clamped and NOT propagated
	expect(ch?.qos).toBe(0);
	expect(ch?.retain).toBe(true);
	const bad = reg.diagnostics().filter((d) => d.detail.startsWith("binding-invalid-value:"));
	expect(bad.length).toBe(2);
	expect(bad.every((d) => d.severity === "warning")).toBe(true);
});

// [utest->R-039]
test("a misspelled binding key is reported against the official key set", async () => {
	const spec = `asyncapi: 2.6.0
info: { title: T, version: 1.0.0 }
channels:
  t/typo:
    subscribe:
      operationId: s
      bindings:
        mqtt: { qos: 1, retian: true }
      message:
        payload: { type: object, properties: { a: { type: string } } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const unknown = reg.diagnostics().filter((d) => d.detail.startsWith("binding-unknown-key:"));
	expect(unknown.length).toBe(1);
	expect(unknown[0].detail).toContain("retian");
});

// [utest->R-039]
test("MQTT-5-only binding fields are reported as unhonored", async () => {
	const spec = `asyncapi: 3.0.0
info: { title: T, version: 1.0.0 }
channels:
  c: { address: t/five, messages: { M: { payload: { type: object, properties: { a: { type: string } } } } } }
operations:
  o:
    action: send
    channel: { $ref: '#/channels/c' }
    bindings: { mqtt: { qos: 1, messageExpiryInterval: 60 } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
	});
	const five = reg.diagnostics().filter((d) => d.detail.startsWith("mqtt5-field-ignored:"));
	expect(five.length).toBe(1);
	expect(five[0].detail).toContain("messageExpiryInterval");
	expect(five[0].severity).toBe("info");
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test src/registry/index.test.ts`
Expected: FAIL. `qos: 9` currently propagates, and no binding diagnostics exist.

- [ ] **Step 4: Implement binding integrity**

In `src/registry/index.ts`, add the import at the top with the other imports:

```ts
import mqttOperationBinding from "@asyncapi/specs/bindings/mqtt/0.2.0/operation.json" with {
	type: "json",
};
```

Add the constants beside `POST_DRAFT07_KEYWORDS`:

```ts
// The legal key set comes from the OFFICIAL binding schema rather than a
// hardcoded list, so it tracks upstream. Only `properties` is read: the schema
// cannot be compiled standalone (it $refs
// http://asyncapi.com/definitions/3.0.0/schema.json, resolvable only inside the
// bundled spec schema), and offbook consumes just qos and retain anyway.
// Validating against 0.2.0 is permissive-correct: its property set is a
// superset of 0.1.0's.
const MQTT_OPERATION_KEYS = new Set(
	Object.keys(
		(mqttOperationBinding as { properties: Record<string, unknown> }).properties,
	),
);

// MQTT 5 only, per the "MQTT Versions" column of the binding spec. offbook is
// MQTT 3.1.1 only, so these can never be honored and saying so beats silence.
const MQTT5_ONLY_KEYS = new Set([
	"messageExpiryInterval",
	"payloadFormatIndicator",
	"correlationData",
	"contentType",
	"responseTopic",
	"sessionExpiryInterval",
	"maximumPacketSize",
]);
```

Replace the typed binding read:

```ts
		const mqtt = op.bindings().get("mqtt")?.value<{
			qos?: 0 | 1 | 2;
			retain?: boolean;
		}>();
```

with an untyped read plus the guards:

```ts
		// Read untyped: 2.x maps `mqtt` to an EMPTY schema in its own
		// meta-schema, so nothing upstream validated these values and a declared
		// type here would be a lie (D-018).
		const mqtt = op.bindings().get("mqtt")?.value<Record<string, unknown>>();
		if (mqtt) {
			const unknownKeys = Object.keys(mqtt).filter(
				(k) => !MQTT_OPERATION_KEYS.has(k),
			);
			if (unknownKeys.length > 0) {
				diagnostics.push({
					kind: "spec-load",
					severity: "warning",
					detail: `binding-unknown-key: '${address}' mqtt operation binding has unknown key(s) ${unknownKeys
						.sort()
						.join(", ")}; the mqtt binding defines ${[...MQTT_OPERATION_KEYS]
						.sort()
						.join(", ")}`,
					source: address,
				});
			}
			const five = Object.keys(mqtt).filter((k) => MQTT5_ONLY_KEYS.has(k));
			if (five.length > 0) {
				diagnostics.push({
					kind: "spec-load",
					severity: "info",
					detail: `mqtt5-field-ignored: '${address}' declares MQTT 5 binding field(s) ${five
						.sort()
						.join(", ")}; offbook speaks MQTT 3.1.1 only, so these are not honored`,
					source: address,
				});
			}
		}
		const rawQos = mqtt?.qos;
		const bindingQos =
			rawQos === 0 || rawQos === 1 || rawQos === 2 ? rawQos : undefined;
		if (rawQos !== undefined && bindingQos === undefined) {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `binding-invalid-value: '${address}' mqtt binding qos is ${JSON.stringify(
					rawQos,
				)}; qos MUST be 0, 1 or 2, so this binding is ignored and the configured default applies`,
				source: address,
			});
		}
		const rawRetain = mqtt?.retain;
		const bindingRetain =
			typeof rawRetain === "boolean" ? rawRetain : undefined;
		if (rawRetain !== undefined && bindingRetain === undefined) {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `binding-invalid-value: '${address}' mqtt binding retain is ${JSON.stringify(
					rawRetain,
				)}; retain MUST be a boolean, so this binding is ignored and the configured default applies`,
				source: address,
			});
		}
```

Then update the precedence chain to consume the guarded values, replacing `mqtt?.qos` and `mqtt?.retain`:

```ts
		const override = opts.serviceConfig?.topicOverrides?.[address];
		const qos =
			bindingQos ?? override?.qos ?? opts.serviceConfig?.qosDefault ?? 1;
		const retain =
			bindingRetain ??
			override?.retain ??
			opts.serviceConfig?.retainDefault ??
			false;
```

- [ ] **Step 5: Run to verify it passes**

Run: `bun test src/registry/index.test.ts`
Expected: printed failure count 0.

If the JSON import fails to typecheck, confirm the resolved path first:

```bash
bun -e 'import s from "@asyncapi/specs/bindings/mqtt/0.2.0/operation.json" with {type:"json"}; console.log(Object.keys(s.properties).join(","))'
```

Expected: `qos,retain,messageExpiryInterval,bindingVersion`.

- [ ] **Step 6: Verify all gates**

Run: `bun test; echo "EXIT=$?"` then `bun run lint && bun run typecheck; echo "EXIT=$?"`
Expected: `EXIT=0` for both. The existing `qos-retain.yaml` and `qos-overrides.yaml` precedence tests must still pass unchanged: valid bindings behave exactly as before.

- [ ] **Step 7: Commit**

```bash
git add src/registry/index.ts src/registry/index.test.ts fixtures/asyncapi/v2-oldest.yaml
git commit -m "fix(registry): guard mqtt binding values and keys (R-039)

AsyncAPI 2.x maps mqtt to an empty schema, so qos: 9 and a misspelled retian
parsed with zero errors and the bad qos reached a Channel typed 0 | 1 | 2. Guard
the two values offbook consumes, falling through the precedence chain on a bad
one, and report unknown keys against the official binding schema's key set plus
MQTT-5-only fields as unhonored. Adds a 2.0.0 fixture pinning the range floor."
```

---

### Task 9: Record the spec version as provenance

**Files:**
- Modify: `src/model/index.ts`, `src/ingestion/index.ts`, `src/cli/boot.ts`, `docs/specs/contracts.md`
- Test: `src/ingestion/index.test.ts`

**Interfaces:**
- Consumes: `readSpecVersion` from Task 1.
- Produces: optional `specVersion?: string` on `ResolvedSpec`, `LockEntry`, and `SpecInfo`; the on-disk lockfile key is `spec-version`.

- [ ] **Step 1: Write the failing test**

Append to `src/ingestion/index.test.ts`, following the file's existing patterns for building a `ResolvedSpec` and asserting lockfile output:

```ts
// [utest->R-037]
test("the lockfile records the AsyncAPI spec version beside the declared version", () => {
	const lock = serializeLockfile({
		lockfileVersion: 1,
		environment: "default",
		resolutionMode: "branch",
		generatedAt: "2026-07-30T00:00:00.000Z",
		services: {
			svc: {
				requestedVersion: "1.0.0",
				resolutionStrategy: "branch",
				resolvedRef: "main",
				resolvedSha: "0".repeat(40),
				specPath: "asyncapi.yaml",
				declaredVersion: "4.2.0",
				specVersion: "3.1.0",
				contentHash: "sha256:abc",
				fetchedAt: "2026-07-30T00:00:00.000Z",
			},
		},
	});
	expect(lock).toContain("spec-version: 3.1.0");
	expect(lock).toContain("declared-version: 4.2.0");
});

// [utest->R-037]
test("spec-version is omitted when the asyncapi field is unreadable", () => {
	const lock = serializeLockfile({
		lockfileVersion: 1,
		environment: "default",
		resolutionMode: "branch",
		generatedAt: "2026-07-30T00:00:00.000Z",
		services: {
			svc: {
				requestedVersion: "1.0.0",
				resolutionStrategy: "branch",
				resolvedRef: "main",
				resolvedSha: "0".repeat(40),
				specPath: "asyncapi.yaml",
				contentHash: "sha256:abc",
				fetchedAt: "2026-07-30T00:00:00.000Z",
			},
		},
	});
	expect(lock).not.toContain("spec-version");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/ingestion/index.test.ts`
Expected: FAIL on the missing `spec-version` line, and a typecheck complaint that `specVersion` is not in `LockEntry`.

- [ ] **Step 3: Add the field to the model**

In `src/model/index.ts`, add to `ResolvedSpec` after `declaredVersion`:

```ts
	specVersion?: string; // the `asyncapi` version — shallow parser-free read (G12); best-effort
```

to `LockEntry` after `declaredVersion`:

```ts
	specVersion?: string; // the `asyncapi` version of the fetched spec
```

and to `SpecInfo` after `declaredVersion`:

```ts
	specVersion?: string; // the `asyncapi` version — which spec major this service is on
```

- [ ] **Step 4: Populate it through ingestion**

In `src/ingestion/index.ts`, add the import:

```ts
import { readSpecVersion } from "#src/model/spec-version.ts";
```

In the resolver's returned `ResolvedSpec` (around line 157, beside `declaredVersion: readDeclaredVersion(content)`):

```ts
				specVersion: readSpecVersion(content),
```

In `toLockEntry` (around line 192, beside `declaredVersion: resolved.declaredVersion`):

```ts
		specVersion: resolved.specVersion,
```

In `serializeLockfile` (around line 215), after the `declared-version` block, keeping the same omit-when-absent shape:

```ts
					...(e.specVersion !== undefined
						? { "spec-version": e.specVersion }
						: {}),
```

- [ ] **Step 5: Carry it onto SpecInfo**

In `src/cli/boot.ts`, in the `infos.push({ … })` call (around line 75), add beside `declaredVersion`:

```ts
				specVersion: spec.specVersion,
```

- [ ] **Step 6: Run to verify it passes**

Run: `bun test src/ingestion/index.test.ts`
Expected: printed failure count 0.

Run: `bun test; echo "EXIT=$?"` then `bun run typecheck; echo "EXIT=$?"`
Expected: `EXIT=0` for both.

- [ ] **Step 7: Document it in the canonical contract**

In `docs/specs/contracts.md`, add `spec-version` to the `specs.lock` per-service key list in §6 (beside `declared-version`, marked optional and best-effort) and `specVersion?: string` to the `SpecInfo` interface in §5. Note that unlike `requestedVersion`, `spec-version` is the AsyncAPI document version, not the service's own `info.version`.

- [ ] **Step 8: Commit**

```bash
git add src/model/index.ts src/ingestion/index.ts src/cli/boot.ts src/ingestion/index.test.ts docs/specs/contracts.md
git commit -m "feat(ingestion): record the AsyncAPI spec version as provenance (R-037)

Read the asyncapi field in the same parser-free pass as info.version and record
it as spec-version in specs.lock and on SpecInfo, so GET /v1/specs answers which
spec major each service is on. doctor deliberately does not report it: its spec
checks are network-free while the spec lives in a remote repo."
```

---

### Task 10: Close out the gates and the adopter docs

**Files:**
- Modify: `REQUIREMENTS.md`, `fixtures/asyncapi/README.md`, `README.md`, `docs/guides/wiring-your-service.md`, `test/gate-validation.test.ts` (confirm the real filename from R-028's TEST trace)
- Test: the R-028 gate file

**Interfaces:**
- Consumes: everything above.
- Produces: `R-037`, `R-038`, `R-039` at `STATUS: tested` with `IMPL`/`TEST` traces.

- [ ] **Step 1: Find the R-028 gate file**

Run: `grep -n -A6 "UID\*\*: R-028" REQUIREMENTS.md`
Expected: prints the `TEST` trace naming the gate file. Use that exact path in the next step.

- [ ] **Step 2: Extend the R-028 gate over the new fixtures**

Read the gate file first and follow its existing structure. It drives fixtures through the composed stack and asserts delivery, the violation log, and wire-level qos/retain. Add `multi-format.yaml` and `v2-oldest.yaml` to the fixture list it iterates, and add one assertion per new fixture proving a known-bad payload is REJECTED end to end (not merely at the unit level), because the false-negative class is what this gate exists to catch.

If the gate hardcodes fixture names in an array, extend that array. If it hardcodes per-fixture expectations, add matching entries. Do not weaken any existing assertion to accommodate the new fixtures.

- [ ] **Step 3: Run the gate**

Run: `bun test; echo "EXIT=$?"`
Expected: `EXIT=0`.

- [ ] **Step 4: Flip the three requirements to tested**

In `REQUIREMENTS.md`, add the traces and change each `STATUS` from `specified` to `tested`:

For `R-037`:
```markdown
**STATUS**: tested
**COVERS**: docs/superpowers/specs/2026-07-30-asyncapi-version-support-design.md
**IMPL**: src/model/spec-version.ts, src/registry/index.ts, src/ingestion/index.ts
**TEST**: src/model/spec-version.test.ts, src/registry/index.test.ts, src/ingestion/index.test.ts
```

For `R-038`:
```markdown
**STATUS**: tested
**COVERS**: docs/superpowers/specs/2026-07-30-asyncapi-version-support-design.md
**IMPL**: src/registry/index.ts
**TEST**: src/registry/index.test.ts
```

For `R-039`:
```markdown
**STATUS**: tested
**COVERS**: docs/superpowers/specs/2026-07-30-asyncapi-version-support-design.md
**IMPL**: src/registry/index.ts
**TEST**: src/registry/index.test.ts
```

- [ ] **Step 5: Verify the doc gate accepts the traces**

Run: `bun scripts/check-docs.ts; echo "EXIT=$?"`
Expected: `EXIT=0`. The checker verifies arrow tags in both directions, so every file named in a `TEST` trace must carry at least one `// [utest->R-###]` for that id, and no tag may reference a missing requirement. If it reports a dangling or missing tag, fix the tag rather than the trace.

- [ ] **Step 6: Update the fixtures README**

In `fixtures/asyncapi/README.md`, add two rows to the table:

```markdown
| `multi-format.yaml` | 3.1.0 | The explicit Multi Format Schema Object payload (`{schemaFormat, schema}`) on **both** a `send` and a `receive` operation — the wrapper the parser returns verbatim, which made the validator accept everything (D-018). Also the newest-supported-major acceptance fixture |
| `v2-oldest.yaml` | 2.0.0 | The **floor** of the supported range: `publish`/`subscribe` inversion plus a 2.x mqtt operation binding at `qos: 2` (2.x validates bindings not at all, so offbook checks them itself) |
```

And add a supported-version statement under the direction-mapping section:

```markdown
## Supported AsyncAPI versions
offbook supports **2.0.0 through 2.6.0, 3.0.0, and 3.1.0** (D-018); 3.1.0 is the recommended authoring target. AsyncAPI 1.x is refused: convert it first. Fixtures should stay within this range, and the range itself is pinned by a test over `SUPPORTED_SPEC_VERSIONS`.
```

- [ ] **Step 7: State the range for adopters**

In `README.md`, near the prerequisites list that mentions git access to the spec repos, add:

```markdown
- AsyncAPI specs at **2.0.0-2.6.0, 3.0.0, or 3.1.0** (3.1.0 recommended). AsyncAPI 1.x is not supported: convert it with `asyncapi convert` first.
```

In `docs/guides/wiring-your-service.md`, add a short subsection covering the same range plus the perspective caveat, which matters more on 2.x than anything else in this plan:

```markdown
## AsyncAPI versions

offbook reads AsyncAPI **2.0.0 through 2.6.0, 3.0.0, and 3.1.0**. 3.1.0 is the recommended target for new specs. A 1.x spec is refused with a message telling you to convert it.

### If your spec is 2.x, check its perspective

AsyncAPI 2.x names operations from the point of view of your service's *counterparties*, which is the opposite of what most people assume:

- `subscribe` means **your service publishes** the message, so offbook treats it as `toClient` and mocks it for your browser app to receive.
- `publish` means **your service consumes** the message, so offbook treats it as `fromClient` and validates what your browser app sends.

That is what the specification says, and it is what the official converter does. But the convention is widely misread, and some generators grew flags (`view=provider`, `inverseOperations=true`) for specs authored the other way around. If every mocked channel points the wrong way, your spec was probably written from the client's perspective. No tool can detect this from the document, so it needs a human read.
```

- [ ] **Step 8: Run the complete gate set**

Run each and confirm `EXIT=0`:

```bash
bun scripts/check-docs.ts; echo "EXIT=$?"
bun run lint; echo "EXIT=$?"
bun run typecheck; echo "EXIT=$?"
bun run demo-app:build; echo "EXIT=$?"
bun test; echo "EXIT=$?"
```

Expected: `EXIT=0` for all five. This is the same set CI runs.

- [ ] **Step 9: Commit**

```bash
git add REQUIREMENTS.md fixtures/asyncapi/README.md README.md docs/guides/wiring-your-service.md test/
git commit -m "docs: declare the AsyncAPI support range and close R-037..R-039

Extend the R-028 validation gate over multi-format.yaml and v2-oldest.yaml so
the false-negative class is covered by a v1 gate, flip the three requirements to
tested with traces, and state the supported range for adopters. The wiring guide
gains the 2.x perspective caveat: a spec authored from the client's point of view
loads with every direction inverted and no tool can detect it."
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: the support contract and preflight to Task 1; `spec-version` provenance to Task 9; the payload boundary's four parts to Tasks 2 (unwrap), 3 (dialect), 5 (mismatch diagnostic), 6 (compile containment), and 7 (multi-message); binding integrity's four parts to Tasks 4 (channel binding) and 8 (value guard, key set, MQTT 5); fixtures to Tasks 2, 3, and 8; tests and the R-028 extension to Task 10; doc and provenance changes to Tasks 1, 3, 4, 9, and 10. The two spec claims that did not survive planning are called out under **Deviations** rather than silently dropped.

**Placeholder scan.** No TBD or TODO. Every code step carries the actual code. Two steps deliberately require reading an existing file before editing (the R-028 gate in Task 10, and `composition.yaml` placement in Task 3) because their internal structure was not read during planning; both give the exact command to discover what is needed and the exact content to add. The `contracts.md` edits describe the replacement text and how to locate the passages, since that file's full prose was not read.

**Type consistency.** `extractPayloadSchema` is introduced in Task 2 and reused in Tasks 3 and 7 under that name. `DRAFT_07` is introduced in Task 3 and reused in Tasks 6 and 7. The `diagnostics` array is introduced in Task 4 and pushed to in Tasks 5, 6, and 8. `bindingQos`/`bindingRetain` replace `mqtt?.qos`/`mqtt?.retain` in the same task that introduces them (Task 8). `specVersion` is the camelCase model field and `spec-version` the kebab-case on-disk key throughout, matching the existing §6 convention. `readSpecVersion`, `isSupportedSpecVersion`, and `SUPPORTED_SPEC_VERSIONS` keep the same names from Task 1 through Tasks 9 and 10.

**Ordering constraint.** Task 1 must land before Task 2, because `multi-format.yaml` declares 3.1.0 and the preflight gate must already accept it. Task 4 must land before Tasks 5, 6, and 8, which push into the diagnostics array it introduces.

**Parse-verified during planning.** Every spec literal in this plan was run through `@asyncapi/parser` 3.6.0 before the plan was committed, because v2 and v3 document structure differs enough that a hand-written fixture is easy to get subtly wrong. Confirmed: both new fixtures parse with zero error-severity diagnostics; `multi-format.yaml` yields two channels (`send` plus `receive`) whose payload JSON really is the `{schemaFormat, schema}` wrapper, so the fixture does reproduce the defect it pins; `v2-oldest.yaml` yields `subscribe` plus `publish` with its mqtt binding read as `{"qos":2,"retain":true}`; and the inline specs for Tasks 4, 5, 6, and 8 all parse. The one shape that did **not** survive verification was Task 6's original `minLength: not-a-number`, which the parser rejects outright; it was replaced with the invalid-regex `pattern: '['` case, and Task 6 carries a warning not to substitute another shape without re-checking.
