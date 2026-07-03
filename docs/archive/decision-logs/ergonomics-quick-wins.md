# Offbook — Ergonomics Quick Wins (Handoff)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (the **canonical** frozen interfaces — the conflict rule applies: if any other doc disagrees on an interface/API detail, the contract wins and the other doc is the bug), `offbook-design.md` (§9 usage moments), `offbook-l2-scenarios.md`. **Sibling handoffs (the larger, isolated areas from the same review):** `offbook-ergonomics-init-scaffold.md`, `offbook-ergonomics-ci-quiescence.md`, `offbook-ergonomics-cli-rendering.md`, `offbook-ergonomics-server-observability.md`, `offbook-ergonomics-l3-hot-reload.md`.

**Status:** **Resolved** (2026-06-30) — all 7 items decided in dialog and folded into the canonical docs (`offbook-contracts.md` §4/§5, `offbook-design.md` §7/§9, `offbook-l2-scenarios.md` §5/§7, `offbook-build-plan.md` Tier 4). See the **Decision log** for what was taken — including the three places the decision **overrode this doc's printed recommendation** (EQ1 default exit code, EQ3 label noun, EQ6 humanization boundary) and the EQ4 verb fix (`scenario`, not `trigger`). Originally 7 quick-to-resolve items from the end-user ergonomics review (2026-06-29), each a small localized spec/CLI change sharpening the human-facing edges of moments 1–4.

**Why this exists.** The machine-facing surfaces (CI loop, error codes, determinism) are strong; the human-facing edges have small, cheap gaps that are far cheaper to close now (as spec) than after the acceptance tests freeze them. These are the ones with no real design fork — adopt the resolution and move on.

**How to use this doc.**
1. Pick an item. Each is self-contained.
2. Make the **Decision owed** (most are "none — mechanical"). A **Recommended resolution** is given; adopt or override.
3. Resolve it in the **Owner** doc (the conflict rule means `offbook-contracts.md` wins; fix the others to match).
4. Verify against **Acceptance** (self-checkable).
5. Tick the `Status` box and add a row to the **Decision log**.

> **Line numbers are anchors as-of the working tree at HEAD `cadd8a0` (2026-06-29) and drift once edits land.** Anchor by stable reference (`§N` / type name / heading); treat line numbers as hints.

---

## Summary

| ID | Item | Tier | Owner / Lands in | Blocks? |
|---|---|---|---|---|
| EQ1 | `offbook publish` to a typo'd topic soft-succeeds — no immediate CLI warning | 1 | contracts §5 · cli/ | — |
| EQ5 | Parametrized `toClient` channels render blank with no diagnostic pointing to the fix | 1 | contracts §5 · engine/ · design §7a | — |
| EQ4 | CLI has no specified way to pass an explicit `payload` / `params` | 2 | design §9 · cli/ | — |
| EQ6 | `Violation.detail` not contracted as human-readable (only Ajv `errors[]` are) | 2 | contracts §4 | — |
| EQ2 | `environments.yaml` versions are silently unhonored in v1 — warning doesn't say so | 3 | contracts §6 · design §7 | — |
| EQ3 | Human discovery surface exposes raw `toClient`/`fromClient` wire vocab | 3 | cli/ · design §9 | — |
| EQ7 | `{param}`/`{{param}}` mismatch produces a generic, non-teaching load error | 3 | l2 §5/§7 · scenarios/ | — |

---

## Tier 1 — visible-behavior sharp edges (moments 1 & 4)

### EQ1 — `offbook publish` to an unknown topic looks like success
- **Where:** `offbook-contracts.md` §5 `POST /v1/publish` row (line ~304: "unknown topic → raw publish + flag"; result `202 { topic, direction, injected, sinceSeq }`); `offbook-design.md` §9 (`offbook publish`, line ~297).
- **Problem:** on an unknown topic the action returns `202` with no machine-flag that the topic matched no channel (direction can't be inferred), and the violation lands in `/validation` — which a human running `offbook publish` is not watching. A mistyped topic therefore "succeeds" silently.
- **If unaddressed:** typos in the daily-driver "hand-drive the UI" path produce a 202 and no UI change; the dev waits for an effect that never comes and can't tell why.
- **Decision owed:** how to signal unknown-topic in the response — add `matched: boolean`, or widen `direction` to `Direction | null`. *Recommend `matched: boolean`* (explicit; doesn't overload `direction`).
- **Recommended resolution:**
  ```ts
  // contracts §5 — /publish result
  202 { topic, direction: Direction | null, matched: boolean, injected, sinceSeq }
  // direction is null exactly when matched === false (no channel to infer from)
  ```
  `cli/`: print `⚠ no channel matches 'state/thermostat' — published raw (will be flagged in /validation)` when `matched === false`; nonzero exit under a `--strict` flag.
- **Acceptance:** the `/publish` contract test asserts `{ matched:false, direction:null }` for an unknown topic and `{ matched:true }` for a known one; `offbook publish <unknown> --payload '{}'` prints the warning.
- **Status:** ☑ **resolved** (2026-06-30) — adopted `matched: boolean` + `direction: Direction|null` (`null ⟺ matched===false`, normative, scoped to the `/publish` response); an unmatched publish re-enters `onInbound` as `origin:client` and raises `unknown-topic`. **CLI default = exit nonzero, `--force` to allow** (overrides this doc's warn-then-`--strict` default). Folded → contracts §5, design §9, build-plan Tier 4.

### EQ5 — parametrized `toClient` channels render blank, with nothing pointing at the fix
- **Where:** `offbook-contracts.md` §2 materialization (parametrized = lazy, lines ~118–119), `seedInstances` (§6, line ~331), `Diagnostic.kind` union (§5, line ~276); `offbook-design.md` §7a (lines ~180–182), §9 moment-1 failure mode "blank UI and a dev who can't tell what's broken" (line ~280).
- **Problem:** non-parametrized `toClient` channels publish initial state eagerly; parametrized ones (`state/{deviceId}`) materialize lazily on first concrete subscribe/command. The only way to pre-populate them is `seedInstances` — a config field the onboarding dev must already know exists. Nothing surfaces that channels are empty or how to fill them.
- **If unaddressed:** the default first run for any spec with device-style channels is a partially blank UI — exactly moment-1's named failure mode — with no breadcrumb.
- **Decision owed:** surface as a `Diagnostic` — add a dedicated `kind` (filterable) vs reuse `spec-load`+info. *Recommend a dedicated `'uninstantiated'` info kind.*
- **Recommended resolution:** at startup the engine emits, per parametrized `toClient` channel with zero materialized instances, an info `Diagnostic`: `"state/{deviceId} (serviceC): no instances yet — subscribe to a concrete topic, send a matching command, or add seedInstances to render it"`. Extend the union + `DiagnosticSummary.byKind`:
  ```ts
  kind: 'scenario-load' | 'overlap' | 'spec-load' | 'uninstantiated';
  ```
- **Acceptance:** booting against a spec whose only `toClient` channel is parametrized, with no `seedInstances`, yields a `GET /diagnostics` entry of kind `uninstantiated` naming the channel; adding a `seedInstances` entry for it removes the diagnostic.
- **Relates to:** `offbook-ergonomics-init-scaffold.md` EI2 (first-run orientation).
- **Status:** ☑ **resolved** (2026-06-30) — added `Diagnostic.kind: 'uninstantiated'` (info) + a 4th `DiagnosticSummary.byKind` key; the channel **address rides `source?`** (Diagnostic has no `channel` field), the teaching sentence in `detail`; counted from the engine's `InstanceRegistry` ledger, **not** async `getState()`. Folded → contracts §5.

---

## Tier 2 — daily-driver friction (moment 2)

### EQ4 — no specified way to pass an explicit payload / params on the CLI
- **Where:** `offbook-design.md` §9 (`offbook publish <topic> [--example]`, line ~297); `offbook-contracts.md` §5 `/publish` (`payload` XOR `example`, line ~304) and `/trigger/{name}` (`{ params?, payload? }`, line ~305); build-plan Tier 4 (line ~87).
- **Problem:** only `--example` is specified. The contract's `/publish` takes an explicit `payload`, and `/trigger` takes `params` + `payload`, but the CLI has no input path for them — and raw JSON on a shell is painful to quote.
- **If unaddressed:** the "hand-drive the UI" affordance is either unbuildable from the current command spec or forces error-prone inline JSON quoting every time.
- **Decision owed:** which input forms to support. *Recommend all of:* `--payload <json>`, `--payload-file <path>`, stdin (`--payload -`), and repeatable `--param k=v` for `trigger` captures (ergonomic shorthand over nested JSON).
- **Recommended resolution:**
  ```
  offbook publish <topic> [--example] [--payload <json> | --payload-file <path> | --payload -] [--qos N] [--retain]
  offbook trigger <name>  [--param k=v]... [--payload <json> | --payload-file <path> | --payload -]
  ```
  `--example` and `--payload*` are mutually exclusive — the CLI rejects both locally, mirroring the contract's `example-and-payload` 400.
- **Acceptance:** `echo '{"mode":"heat"}' | offbook publish command/t1/set --payload -` injects that payload; `offbook scenario set-temp --param deviceId=t1` binds `{{deviceId}}`; passing both `--example` and `--payload` exits nonzero without hitting the server.
- **Status:** ☑ **resolved** (2026-06-30) — adopted all input forms (`--payload`/`--payload-file`/stdin `-`/repeatable `--param k=v`); `--example`/`--payload*` mutually exclusive; **bare `offbook publish <topic>` defaults to `--example`**. Verb stays **`offbook scenario`** (not `trigger` — CLI verbs are decoupled from endpoint names; corrects this doc's earlier `offbook trigger` wording). Folded → design §9, build-plan Tier 4.

### EQ6 — `Violation.detail` is not contracted as human-readable
- **Where:** `offbook-contracts.md` §4 `Violation.detail` (line ~239) + `errors?: SchemaError[]` (line ~243); `SchemaError = Omit<ErrorObject,'data'|'schema'>` (line ~227).
- **Problem:** `errors[]` is Ajv-shaped (`instancePath`/`schemaPath`/`keyword`/`params`) — correct for CI, cryptic for a human. The contract doesn't require `detail` to be a humanized rendering of the failure, so it could ship as a bare `"schema validation failed"`.
- **If unaddressed:** `offbook validation` is unreadable to a person without parsing Ajv objects (the debugging moment), feeding design §5's "trains devs to ignore the tool" risk.
- **Decision owed:** none — mechanical (tighten the contract note on `detail`).
- **Recommended resolution:** spec that for `kind: 'schema'`, `detail` is a one-line humanized rendering of the primary `SchemaError` — e.g. `payload.target: must be number (got "22")` — derived from `errors[0]` (instancePath + a human form of the keyword). The full `errors[]` stay machine-facing.
- **Acceptance:** a schema violation's `detail` contains the offending instance path and a plain-language expectation (assertable: `detail` includes the `instancePath` and the keyword's human form), not a generic constant.
- **Relates to:** `offbook-ergonomics-cli-rendering.md` ER2 (CLI formats `errors[]`).
- **Status:** ☑ **resolved** (2026-06-30) — chose **(b): keep `detail` terse + stable** (a derived `<instancePath>: <keyword>`, safe inside the F9 projection) and humanize in the **CLI/ER2** from `errors[]`+`payload`, *not* in `detail` itself (overrides this doc's "humanize `detail`" rec — evolving prose would weld into the determinism baseline). The `(got "22")` value comes from `Violation.payload`@instancePath, since `SchemaError` `Omit`s Ajv's `data`. Folded → contracts §4; render half is ER2.

---

## Tier 3 — wording / polish

### EQ2 — `environments.yaml` versions are silently unhonored; the warning doesn't say so
- **Where:** `offbook-contracts.md` §6 `environments.yaml` (lines ~373–378), `LockEntry.requestedVersion` "recorded, UNHONORED in v1" (lines ~397, ~410); `offbook-design.md` §7 "never lie about its own fidelity" (line ~255).
- **Problem:** v1 records `requested-version` but fetches branch tips. A dev who sets `serviceA: 1.4.7` and sees `main` fetched gets no explicit statement that requested versions are intentionally ignored in v1.
- **If unaddressed:** "I pinned 1.4.7 — why did it fetch main?" confusion, eroding the honesty the design prizes.
- **Decision owed:** none — mechanical (wording of the existing branch warning).
- **Recommended resolution:** the §7 honesty warning explicitly names this, e.g.: `version pinning unavailable in v1: requested versions in environments.yaml are RECORDED but NOT honored; fetching branch tips (serviceA→main, serviceB→dev).` Capture this required content in contracts §6 / design §7.
- **Acceptance:** `offbook up` in branch mode emits a warning containing both "recorded" and "not honored" (or equivalent) and naming each service's branch; a string assertion on the warning passes.
- **Status:** ☑ **resolved** (2026-06-30) — the notice is carried CI-assertably on `GET /v1/specs.warnings?` in branch mode (suppressed under `pinned`/`--frozen`), and the design §7 honesty string was corrected (it falsely said "branch `main` for all services"; serviceB→dev). Folded → contracts §5, design §7.

### EQ3 — human discovery surface exposes raw `toClient` / `fromClient`
- **Where:** `offbook-design.md` §9 discoverability (line ~289 — itself glosses the vocab as "browser-receives vs browser-sends"); `offbook-contracts.md` §5 `TopicInfo.direction` + `?direction=` filter (lines ~264, ~272).
- **Problem:** the human-facing `offbook topics`/`state` output and CLI filters surface the wire vocab directly, which the design keeps having to re-translate.
- **If unaddressed:** every reader mentally translates `toClient`→"I receive"; the make-or-break discovery feature is slightly harder than it needs to be.
- **Decision owed:** the human label wording. *Recommend* `toClient → "→ app receives"`, `fromClient → "← app sends"` in default output; keep the wire vocab in `--json` and as the API filter value (frozen).
- **Recommended resolution:** `cli/` maps `direction` to human labels in `offbook topics`/`state`; `--json` keeps raw `toClient`/`fromClient`. Keep `?direction=toClient|fromClient` as the API filter; accept `--receives` / `--sends` as CLI sugar.
- **Acceptance:** `offbook topics` default (non-`--json`) output contains no literal `toClient`/`fromClient` token; `offbook topics --receives` filters to `toClient` channels; `--json` still carries the wire vocab.
- **Relates to:** `offbook-ergonomics-cli-rendering.md` ER1.
- **Status:** ☑ **resolved** (2026-06-30) — chose **"client receives / client sends"** (frozen-vocab-consistent; maps 1:1 to `toClient`/`fromClient`) over this doc's "app receives/sends". Declared **surface-wide** (incl. the `direction` field CR4 added to `/publish`); `--json`/`?direction=` keep wire vocab; dropped the `offbook state` half (`StateEntry` has no `direction`). Renderer + `--receives`/`--sends` are ER1. Folded → design §9.

### EQ7 — `{param}` vs `{{param}}` mismatch yields a generic, non-teaching error
- **Where:** `offbook-l2-scenarios.md` §5 brace convention (lines ~102–106); §7 reference-resolvability check ("`{{param}}` must be captured by `when.topic`", line ~136).
- **Problem:** single-`{param}`-capture vs double-`{{param}}`-substitute is an inherent foot-gun. The load-time check exists, but its *message* isn't specified to explain the distinction — so the most common authoring mistake produces a bare "unknown param".
- **If unaddressed:** authors hit the single/double-brace trap repeatedly with no teaching feedback.
- **Decision owed:** none — mechanical (message wording).
- **Recommended resolution:** when a `{{param}}` is uncaptured, the `scenario-load` diagnostic explains the convention: `emit references {{deviceId}} but when.topic 'command/set' captures no {deviceId} — use single braces {deviceId} on when.topic to capture, double {{deviceId}} on emit to substitute`.
- **Acceptance:** a scenario with an uncaptured `{{deviceId}}` produces a `/diagnostics` `scenario-load` entry whose detail names both the missing capture and the single-vs-double convention.
- **Status:** ☑ **resolved** (2026-06-30) — chose **(a): reject a single-`{param}` on an emit field at load** with a teaching `scenario-load` diagnostic (it would otherwise exact-match the channel address and silently emit a literal-braced topic). Forced correction: the resolvability message names **both** param sources (`when.topic` capture **or** the trigger `params` body) so it stays true for `when`-less scenarios like `device-offline`. Folded → l2-scenarios §5/§7.

---

## Cross-cutting note

EQ1, EQ4, EQ6 are the three a `cli/` author should do together (they all shape `publish`/`validation` command behavior). EQ6 is the contract half of validation readability; its CLI half is ER2 in `offbook-ergonomics-cli-rendering.md` — do EQ6 first so ER2 has a humanized `detail` to lead with. EQ3 pairs with ER1 (same direction-label decision). EQ2 and EQ7 are pure string/wording edits with no dependency.

## Decision log

*(Append one row per resolved item: ID · decision taken · file(s) patched · resolver · date.)*

| ID | Decision taken | File(s) patched | Resolver | Date |
|---|---|---|---|---|
| EQ1 | `/publish` → `202 { topic, direction: Direction\|null, matched, injected, sinceSeq }` (`null ⟺ !matched`, scoped to the response); unmatched publish re-enters `onInbound` as `origin:client` + raises `unknown-topic`. CLI exits nonzero by default, `--force` to allow (override of the doc's `--strict` default) | offbook-contracts.md §5; offbook-design.md §9; offbook-build-plan.md Tier 4 | CodeReviewJoe | 2026-06-30 |
| EQ2 | Version-not-honored notice carried on `GET /v1/specs.warnings?` (branch mode; suppressed pinned/`--frozen`); corrected the false design §7 "branch `main` for all services" string (serviceB→dev) | offbook-contracts.md §5; offbook-design.md §7 | CodeReviewJoe | 2026-06-30 |
| EQ3 | Human direction labels = **"client receives / client sends"** (frozen-vocab-consistent), declared surface-wide incl. the `/publish` `direction` field; `--json`/`?direction=` keep wire vocab; `offbook state` half dropped | offbook-design.md §9 (renderer → ER1) | CodeReviewJoe | 2026-06-30 |
| EQ4 | CLI input forms `--payload`/`--payload-file`/stdin `-`/repeatable `--param k=v`; `--example` ⊕ `--payload*`; bare `publish` defaults to `--example`; verb stays **`offbook scenario`** (not `trigger`) | offbook-design.md §9; offbook-build-plan.md Tier 4 | CodeReviewJoe | 2026-06-30 |
| EQ5 | `Diagnostic.kind: 'uninstantiated'` (info) + 4th `byKind` key; channel address in `source?`, teaching in `detail`; counted from the `InstanceRegistry` ledger (not async `getState()`) | offbook-contracts.md §5 | CodeReviewJoe | 2026-06-30 |
| EQ6 | (b) `detail` stays terse + stable (`<instancePath>: <keyword>`, in the F9 projection); humanization lives in the CLI/ER2 from `errors[]`+`payload`; `(got X)` read from `Violation.payload`@instancePath | offbook-contracts.md §4 (render → ER2) | CodeReviewJoe | 2026-06-30 |
| EQ7 | (a) reject a single-`{param}` on an emit field at load with a teaching `scenario-load` diagnostic; resolvability message names both param sources (`when.topic` or trigger `params`) | offbook-l2-scenarios.md §5/§7 | CodeReviewJoe | 2026-06-30 |
