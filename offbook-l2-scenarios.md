# Offbook — L2 Scenario Authoring Format

*Knows every line. Needs no cast.*

**Companion to:** `offbook-design.md` (canonical decisions/rationale) and `offbook-handoff.md` (sequence). This doc **resolves the open thread in design §10** and **unblocks handoff Step 2.8**. Section refs (e.g. §5) point to the design doc.

**Status:** Decided (worked through as a dialog). Decision log at the end.

**One-line:** L2 is the **authored** behavior layer — declarative YAML scenarios that script request→response (and server-initiated) behavior with seeded timing, sitting between the L1 schema-valid floor and L3 stateful code handlers.

---

## 0. Settled headline

L2 scenarios are **declarative YAML data** — never code. The escape to code is **lateral**: when a scenario needs real logic, you hand that whole topic to an **L3 handler** (which shadows L2 by the §4 first-match-wins precedence). This keeps L2 a low-friction, diffable, load-validatable, hot-reloadable surface and preserves the L2/L3 distinction.

### Canonical example

```yaml
# scenarios/50-thermostat.yaml   (a file is a YAML list of scenarios)

- name: set-temperature-heat
  when:
    topic: command/{deviceId}/set        # {single} = capture; must be a fromClient channel
    payloadMatch: { mode: heat }         # subset equality on the inbound payload
  then:
    - emit:
        topic: state/{{deviceId}}        # {{double}} = substitute; must be a toClient channel
        payload:
          deviceId:  "{{deviceId}}"
          target:    "{{payload.target}}"
          status:    accepted
          updatedAt: "{{now}}"           # virtual seeded clock (not wall-clock)
        delay: 150-300ms                 # seeded jitter, measured from the browser application publish
    - emit:
        topic: state/{{deviceId}}
        payload: { deviceId: "{{deviceId}}", status: heating }
        delay: 1-2s                      # +1–2s after the PREVIOUS emit (relative/cumulative)
        # required fields not listed (e.g. `units`) are seed-faked by L1, then Ajv-rechecked

# server-initiated, on-demand (no `when`) — fired via POST /trigger/device-offline
- name: device-offline
  then:
    - emit:
        topic: state/{{deviceId}}        # deviceId from the trigger body, else seed-faked
        payload: { deviceId: "{{deviceId}}", status: offline }
```

---

## 1. Paradigm (D1)

- L2 = **declarative YAML**; L2 and L3 are **separate layers**, not composed.
- Code escape is **lateral**: write an L3 handler for the topic; it shadows L2 via first-match-wins (§4).
- **Deferred:** inline `handler:` references inside a scenario step (composing code into a declarative flow). Add only if the coarse escape proves too blunt against real scenarios — n=1 discipline (§3, §7).

## 2. Scenario anatomy (D2)

A scenario has three top-level fields:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Globally unique. Used by `POST /trigger/{name}`, the validation log, and reset. |
| `when` | no | Present ⇒ **reactive** (fires on a matching browser application publish). Absent ⇒ **on-demand only**. Either way, the `name` makes it triggerable. |
| `then` | yes | An **ordered list of steps** (≥1). One-shot is the degenerate single-element list. |

- The only step kind in v1 is `emit`. (v2 fault steps are additive — see §6.)
- **Within L2, the first matching scenario wins** (consistent with the L3→L2→L1 first-match-wins, §4).

## 3. File layout & dispatch order (D2)

- **Discovery:** glob `scenarios/**/*.yaml`; each file is a list. Group by service **by convention** (`scenarios/<service>.yaml`), not enforced. Kept independent of the v2 `services.yaml` — authoring behavior ≠ resolving spec versions.
- **Dispatch order (the determinism guarantee):** a total order over all scenarios = **sorted file path (fixed code-unit collation, locale-independent) → in-file declaration order**. On each inbound, walk the ordered list top-to-bottom; first `when` that matches wins. Same input + same files ⇒ same winner on every machine/filesystem/run.
- **Cross-file precedence lever:** numeric filename prefixes, like `conf.d` drop-ins — `00-overrides.yaml` < `50-thermostat.yaml` < `99-fallbacks.yaml`. Within a file, order specific-above-general by hand.
- **Robustness touch 1 — loud overlap warning:** at load, detect when two scenarios' `when` patterns shadow each other and warn (`"thermostat-1-rejects shadows set-temp-ack for command/thermostat-1/set"`), surfaced in `GET /diagnostics` (the static config/load surface — not the runtime `/validation` log; P1.D4). Scenarios disambiguated only by `payloadMatch` are reported as *informational* ("overlap on topic, disambiguated by payload"), not shadows.
- **Robustness touch 2 — stable hot-reload:** reload re-runs the same sort, so precedence never silently reshuffles; dropping in `scenarios/05-foo.yaml` slots into a known position.

## 4. Matching (D3)

`when` only matches messages the **browser application publishes** (`direction: fromClient` in the §5 normalized model).

### Topic pattern + parameter binding
- `{param}` — matches exactly one level **and captures** it (a "named `+`"); available to templating as `{{param}}`. Verbatim the AsyncAPI channel-address form, so authors copy channels straight from the spec.
- `+` — matches one level, no capture.
- `#` — matches one-or-more trailing levels, no capture; **must be terminal** (MQTT rule, enforced at load).
- Algorithm: split on `/`, level-by-level — literals must equal, `{param}` binds, `+` matches any one, `#` swallows the rest.

### Payload predicate — `payloadMatch` (subset equality)
- A scenario matches iff topic matches **and** every field in `payloadMatch` deep-equals the corresponding inbound field. Dotted paths allowed (`"status.code": 2`). Extra inbound fields are ignored. **No operators** (`gt`/regex/ranges) — those are the L3 signal.
- Order payload-discriminated scenarios above the topic-only fallback:

```yaml
- name: set-heat
  when: { topic: command/{deviceId}/set, payloadMatch: { mode: heat } }
  then: [ { emit: { topic: state/{{deviceId}}, payload: { status: heating } } } ]
- name: set-generic-ack          # fallback for any other mode
  when: { topic: command/{deviceId}/set }
  then: [ { emit: { topic: state/{{deviceId}}, payload: { status: accepted } } } ]
```

## 5. Templating & the L2↔L3 boundary (D4)

### Brace convention
- **`{param}` (single)** — capture, on the **match side** only (`when.topic`).
- **`{{…}}` (double)** — substitution, on the **emit side** (the `emit.topic` *and* payload values).

### Vocabulary (closed — no conditionals, arithmetic, or loops)
- `{{param}}` — a captured topic param.
- `{{payload.<path>}}` — an inbound payload field (dotted path).
- A **closed helper set**, all deterministic/seeded:
  - `{{uuid}}` — seeded deterministic UUID (run seed + counter), not random v4.
  - `{{seq}}` — monotonic per-scenario counter.
  - `{{now}}` — the **logical seeded clock** (`offbook-contracts.md` §3): `now()` = `fixedEpoch + Σ(seeded delays)`, *not* wall-clock (a real `Date.now()` would break replayability). It advances by the **full** seeded delay of each step even though, in the default scheduler, the emit is delivered on the next event-loop task rather than after real wall time elapses (contracts §3, design §6).

### Auto-fill
The author templates **only the causal fields**; omitted required schema fields are **seed-faked by L1** and the whole payload is **Ajv-rechecked before emit** (§4). Scenarios stay minimal and spec-valid by construction.

### The boundary (write this into reviews)
> L2 templating shapes **data only**: substitute captured params, inbound payload fields, and seeded helpers into a payload skeleton; omitted required fields are seed-faked by L1 and Ajv-rechecked before emit. The moment a response needs a **conditional, computation, loop, memory across messages, or external state**, that is the **L3 boundary** — by design.

## 6. Timing (D5)

- **`delay` is a per-step property.** Syntax: constant `<n><unit>` (`150ms`, `2s`) or ranged `<min>-<max><unit>` (`150-300ms`). **Unit required** (`ms` | `s`); no bare numbers. Omitted ⇒ `0` (immediate). A constant is the degenerate zero-width range.
- **Multi-step timing is relative/cumulative:** each step's delay is measured from the **previous emit**, so step N's absolute time = sum of delays 1..N. Natural "wait, emit, wait, emit" scripting.
- **Seeded, order-independent draws:** each ranged delay = `mulberry32(hash(runSeed + scenarioName + stepIndex))` — the same Mulberry32 PRNG as L1 (§4), keyed by a stable identity (not a shared stream cursor). Same run seed ⇒ byte-identical timings; independent of evaluation order; steps independent. This makes §6's headline real: "reproduce the bug where the ack lands after the timeout" is a repeatable fixture.
- **A resolved delay advances the logical clock, not wall time (default scheduler).** The drawn `delayMs` is added to the logical `now()` (`offbook-contracts.md` §3) and the emit is delivered on the **next event-loop task** — enough to force the client's async code to suspend/resume (design §6) without CI paying the real seconds. Real wall delay is an **opt-in interactive mode** for human-perceptible timing, never the CI/replay path.
- **v2 (deferred, additive on the step model):** adversarial timing — `duplicate`, `reorder`, `drop`, `redeliver` — are added as more step properties, no restructuring (§6).

## 7. Author-time validation (D6)

**Two-tier:**

- **Load-time (static, fail fast):**
  - *Skeleton schema check* — substitute each `{{…}}` with a type-appropriate / L1-faked stand-in and run Ajv; wrong-typed literals, unknown fields, structurally impossible payloads fail now.
  - *Topic/direction check* — `when.topic` must match a `fromClient` channel and `emit.topic` a `toClient` channel in some consumed spec (§5 normalized direction). A `when` on a toClient topic is a direction error.
  - *Reference resolvability* — `{{param}}` must be captured by `when.topic`; `{{payload.x}}` checked against the inbound channel schema; unknown helpers rejected (closed set).
  - *Structural* — name uniqueness (§2 Scenario anatomy), terminal `#` (§4 Matching), delay syntax (§6 Timing). *(Named §N here = this doc's own sections, not the design doc.)*
- **Emit-time (runtime backstop):** the §4 L1 Ajv recheck of the *actual* produced payload — catches anything load-time couldn't (e.g. an inbound value that pushed a templated field off-spec).

**Failure handling — lenient-but-loud in dev, strict in CI** (mirrors the §7/§9 emission-mode split): a broken scenario is **skipped loudly** (logged + surfaced in `GET /diagnostics` — the static config/load surface, *not* the runtime `/validation` log; P1.D4 — and not loaded) so one typo doesn't blank the UI (onboarding, §9 moment 1). A **strict mode** fails fast on any scenario error for CI.

## 8. Loading, hot-reload & control plane (D7)

- **Loading:** glob → sorted load (§3) → load-time validation (§7) → build the ordered scenario table.
- **Hot-reload (dev affordance, `autonomous` mode only):** watch the tree; on change re-glob/re-sort/re-validate and **atomically swap** the table; surface what changed + any new errors loudly. **Swaps definitions only — does not reset runtime state** (counters/virtual clock continue); returning to t0 is `reset`.
- **`passive` mode freezes the scenario set:** mirroring the way `passive` fires no autonomous ticks (`offbook-contracts.md` §5), `passive` loads the scenario set **once at startup with no watcher** — hot-reload is disabled. So editing a scenario file between `reset` and an assertion cannot change the matched scenario; the dispatch table is as deterministic across a CI window as the emission stream. Hot-reload is therefore a dev-only affordance.
- **Trigger:** `POST /trigger/{name}` fires a named scenario on demand (§9 debugging moment). Optional request body supplies params/inbound payload for a reactive scenario fired by hand — params are **nested** under `params` (canonical, per `offbook-contracts.md` §5): `{ "params": { "deviceId": "t1" }, "payload": { … } }`. Each `params` entry binds the scenario's `{{param}}` captures (here `{{deviceId}}`); anything omitted is seed-faked.
- **Reset:** `POST /reset` returns to known state — re-seed PRNGs to the run seed, reset counters + virtual clock, republish retained initial state, halt autonomous emission. The CI `reset → publish → wait → assert → teardown` primitive (§9 moment 4).
- **Seeding:** the run seed is startup config; `reset` re-seeds to that same seed (reproducible); the control plane can set a fresh seed for a new deterministic run. L1 (§4), ranged delays (§6), and helpers (§5) all draw from it.

---

## 9. Scenario field reference (the contract seed for P1)

```
Scenario:
  name: string                    # REQUIRED, globally unique
  when:                           # OPTIONAL — absent ⇒ on-demand-only
    topic: string                 #   REQUIRED if `when` present — {param} captures + MQTT +/#
    payloadMatch:                 #   OPTIONAL — subset equality
      <dotted.path>: <value>      #     all listed pairs must deep-equal; extra inbound fields ignored
  then:                           # REQUIRED — ordered list, ≥1 step
    - emit:                       #   the only step kind in v1
        topic: string             #     {{substitution}}; must resolve to a toClient channel
        payload: object | scalar  #     {{substitution}}; omitted required fields seed-faked
        delay: string             #     OPTIONAL; "<n>ms|s" or "<min>-<max>ms|s"; default 0
```

Feeds P1 (`offbook-contracts.md`): the parsed/normalized scenario type, the `/trigger` + `/reset` request/response shapes, and the validation-result shape.

---

## 10. Decision log

| # | Decision |
|---|---|
| D1 | Declarative YAML; L2/L3 separate layers; lateral code escape; inline `handler:` composition deferred |
| D2 | `name`/`when?`/`then[]` shape; glob `scenarios/**/*.yaml`; sorted-path→in-file dispatch order; numeric-prefix precedence; loud overlap warning; stable hot-reload |
| D3 | `{param}` capture + MQTT `+`/`#`; `payloadMatch` subset equality (dotted paths, no operators); `when` matches fromClient |
| D4 | Pure substitution + closed seeded helpers (`{{uuid}}`/`{{seq}}`/virtual `{{now}}`); omitted fields seed-faked + Ajv-rechecked; `{single}`-capture / `{{double}}`-substitute; L2↔L3 boundary = logic ⇒ L3 |
| D5 | Per-step `delay` (`ms`/`s`, ranged); relative/cumulative multi-step; Mulberry32 keyed by `runSeed+scenario+stepIndex`; v2 fault steps additive |
| D6 | Two-tier validation (load-time static + emit-time Ajv recheck); lenient-loud dev / strict CI |
| D7 | Glob→sort→validate load; hot-reload swaps definitions only; `POST /trigger/{name}` (+optional body); `POST /reset` re-seeds & restores known state |
