---
type: handoff
status: open
summary: Human-readable offbook topics / validation output (ER1–ER2).
folds-into: [offbook-design]
---

# Offbook — Human-Readable CLI Rendering (Handoff)

*Knows every line. Needs no cast.*

**Companion to:** `offbook-contracts.md` (**canonical** — conflict rule: the contract wins; fix other docs to match), `offbook-design.md` (§9 discoverability + moment-3). **Originating review:** end-user ergonomics pass (2026-06-29). **Sibling handoffs:** `offbook-ergonomics-quick-wins.md` (EQ3 + EQ6 feed these), and the other `offbook-ergonomics-*.md` area docs.

**Status:** **Open** — 2 items. Both land entirely in `cli/` rendering (no contract change) and share one approach: render a compact human view by default, `--json` for the raw payload. One PR.

**Why this exists.** `offbook topics` is what `offbook-design.md` §9 (line ~287) calls "the make-or-break for daily use" — yet `GET /topics` returns a raw bundled JSON Schema per topic (`offbook-contracts.md` §5, `TopicInfo.schema: object`, line ~272), and `GET /validation` returns Ajv-shaped `SchemaError[]` (§4, line ~227). The build-plan CLI acceptance only checks that commands "hit the right endpoint and render the response" (line ~87) — which would pass on an unreadable dump. The flagship discovery surface and the debugging surface both need their human presentation designed before that acceptance freezes.

**How to use this doc.**
1. Pick an item.
2. Make the **Decision owed** (rendering shape); adopt or override.
3. Resolve in `cli/`.
4. Verify against **Acceptance**.
5. Tick `Status` and add a **Decision log** row.

> **Line numbers are anchors as-of the working tree at HEAD `cadd8a0` (2026-06-29) and drift once edits land.** Anchor by `§N` / heading; line numbers are hints.

---

## Summary

| ID | Item | Tier | Owner / Lands in | Blocks? |
|---|---|---|---|---|
| ER1 | `offbook topics` would dump raw JSON Schema — the make-or-break feature is unreadable | 1 | cli/ | — |
| ER2 | `offbook validation` would dump raw Ajv error objects | 2 | cli/ | — |

---

## Tier 1 — the discovery surface

### ER1 — `offbook topics` has no human-readable rendering designed
- **Where:** `offbook-design.md` §9 discoverability (lines ~287–289, "make-or-break"); `offbook-contracts.md` §5 `GET /v1/topics` + `TopicInfo` (lines ~264, ~272–273, `schema: object`, `example?`, `direction`, `service`, `qos`, `retain`); build-plan Tier 4 (line ~87).
- **Problem:** the endpoint returns a fully-bundled JSON Schema per topic. A CLI that prints that is *worse* than grepping the constants it's meant to replace. The compact human view — fields + types + required-ness, the seeded `example`, direction, service, qos/retain — is undesigned, and the only acceptance ("renders the response") won't catch a raw dump.
- **If unaddressed:** the headline value proposition ("if the mock answers 'what can I talk to and how' better than grepping, devs use it as living documentation") fails at the presentation layer.
- **Decision owed:** the default shape — compact per-topic field list, a table, or a tree; and whether the seeded `example` shows by default. *Recommend* a list grouped by service, with a human direction label (EQ3, **resolved** → "client receives" / "client sends"), a flattened field summary, and the example; `--json` for the raw `TopicInfo[]`, `--schema` to inline the full schema.
- **Recommended resolution (render sketch — adopt or override):**
  ```
  serviceC
    command/{deviceId}/set   ← client sends      qos1
      deviceId: string (req) · mode: "heat"|"cool" (req) · target: number
      example  { deviceId: "thermostat-1", mode: "heat", target: 21 }
    state/{deviceId}         → client receives   qos0  retain
      deviceId: string (req) · status: string (req) · updatedAt: string
      example  { deviceId: "thermostat-1", status: "heating", updatedAt: "…" }

  offbook topics --json     # the unmodified TopicInfo[]
  offbook topics --schema   # inline the full bundled JSON Schema
  offbook topics --service serviceC | --receives | --sends   # filters (map to ?service=/?direction=)
  ```
- **Acceptance:** `offbook topics` default output contains no JSON-Schema fragment (`grep` for `"type":` returns nothing), lists each topic's fields with required-ness, shows the seeded example, and reads in receives/sends terms; `offbook topics --json` round-trips the API `TopicInfo[]` byte-for-byte.
- **Relates to:** `offbook-ergonomics-quick-wins.md` EQ3 (direction labels).
- **Status:** ☐ open

---

## Tier 2 — the debugging surface

### ER2 — `offbook validation` has no human rendering of violations
- **Where:** `offbook-contracts.md` §4 `Violation` (lines ~231–244), `errors: SchemaError[]` = Ajv `ErrorObject` minus two fields (line ~227); `offbook-design.md` §9 moment-3 (debugging), §5 false-positive/"trains devs to ignore the tool" risk.
- **Problem:** violations carry Ajv `ErrorObject`s (`instancePath`/`schemaPath`/`keyword`/`params`). The CLI render of `offbook validation` isn't specified to format them, so the default is a wall of raw Ajv objects.
- **If unaddressed:** the debugging moment's primary surface is unreadable; devs ignore it — the precise failure design §5 warns is fatal to the tool.
- **Decision owed:** the per-violation default — a one-line summary (using the humanized `detail`, EQ6) with `-v`/`--errors` to expand. *Recommend that.*
- **Recommended resolution:**
  ```
  offbook validation          # one line per violation:
                              #   seq · origin · kind · topic · detail
                              #   footer: summary (errors/warnings, byOrigin, oldestSeq)
  offbook validation -v       # + expanded errors[] (instancePath → message) and a payload excerpt
  offbook validation --json   # raw { violations: Violation[]; summary } (maps to GET /validation)
  offbook validation --since <seq> --origin client --kind schema   # map to the query params
  ```
  The headline of each line is `detail` (EQ6 makes that humanized); `errors[]` only appear under `-v`/`--json`.
- **Acceptance:** `offbook validation` prints one human line per violation with the topic and a plain-language reason and no raw Ajv object; `-v` expands `errors[]`; `--json` matches the `GET /v1/validation` body; the footer shows the `summary` counts.
- **Relates to:** `offbook-ergonomics-quick-wins.md` EQ6 (humanized `detail`); `offbook-ergonomics-server-observability.md` EO3 (`--watch`).
- **Status:** ☐ open

---

## Cross-cutting note

ER1 and ER2 share rendering helpers (compact value formatting, the `--json` escape convention, the direction label) — do them together. Sequence EQ6 (humanized `detail`) before ER2 so the one-line render has a real headline. EO3 (`--watch`) reuses ER2's per-violation renderer for live tailing — keep the renderer a reusable function, not inline in the command.

## Decision log

*(Append one row per resolved item: ID · decision taken · file(s) patched · resolver · date.)*

| ID | Decision taken | File(s) patched | Resolver | Date |
|---|---|---|---|---|
| | | | | |
