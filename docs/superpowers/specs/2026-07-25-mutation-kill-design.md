# Mutation-kill campaign for `src/engine` (2026-07-25)

Design for driving the Stryker mutation report over `src/engine` to a clean state:
every undetected mutant either killed by a test or annotated with a stated
equivalence reason, so that on any future manual run "survivor = news".

## Baseline

Full `bun run mutate` as of 2026-07-25 (`reports/mutation/mutation.html`,
gitignored): 461 mutants, 349 detected (347 killed, 2 timeout), score 75.7%.
Undetected: 88 Survived plus 24 NoCoverage.

The full per-mutant inventory (112 entries, parsed out of the report's embedded
JSON) is the implementation plan's checklist source; the buckets below cite
representative anchors, not the exhaustive list.

| File | Killed | Survived | NoCoverage | Timeout |
| --- | --- | --- | --- | --- |
| `src/engine/dispatch.ts` | 42 | 12 | 0 | 0 |
| `src/engine/faker.ts` | 26 | 15 | 2 | 0 |
| `src/engine/index.ts` | 124 | 34 | 20 | 0 |
| `src/engine/instances.ts` | 14 | 1 | 0 | 0 |
| `src/engine/prng.ts` | 7 | 3 | 0 | 1 |
| `src/engine/resolve-emit.ts` | 43 | 8 | 0 | 0 |
| `src/engine/scheduler.ts` | 91 | 15 | 2 | 1 |

## Decisions (from the design dialog)

1. **Target: clean report.** Kill every mutant that reflects a real test gap;
   annotate the provably equivalent residue with targeted Stryker disable
   comments carrying a reason. Done means the next full run shows 0 Survived and
   0 NoCoverage (annotated mutants report as Ignored; Timeout counts as
   detected).
2. **Message text is asserted structurally, not exactly.** Tests pin the
   load-bearing parts of violation/error messages (topic, Ajv keyword,
   `instancePath` fallback, offending spec string), never full golden strings.
   Exception: `canonicalize` output is pinned exactly because that string is the
   shared F7 instance identity (faker seed key and ledger key), i.e. contract.
3. **Tests-first; seams only as escape hatch.** Production code changes are
   limited to Stryker disable comments, unless a mutant is unkillable or a test
   would be flaky without a seam; any such seam is called out explicitly in the
   implementation plan before it is built.
4. **Execution order is bucket-by-bucket by value** (coverage gaps, then
   ordering semantics, then message asserts, then residue triage), not
   file-by-file.
5. **`prng.ts` mutants die by golden-value tests.** Seeded reproducibility is a
   product property (F7): if a constant changes, every recorded seed's timeline
   silently changes, and golden values are what catch that.

## Bucket 1: close the 24 NoCoverage paths

All tests extend existing per-module test files.

- **Wall-tick lifecycle** (`index.ts:282-291` guard `mode === "passive" ||
  !wallClock`; `scheduler.ts:151-166`): engine tests with `wallClock: true` and
  `tickIntervalMs` 5-10ms real time. Cases: passive mode makes `startTicks()` a
  no-op; active plus wallClock fires handler ticks (assert count >= 2, loose
  bound against flake); active without wallClock is a no-op; double
  `startWallTicks` does not double-tick (`scheduler.ts:152`); `stopTicks` and
  `reset` stop the interval (`scheduler.ts:187` false-mutant).
- **Tick dispatch loop** (`index.ts:156-163`): two registered handlers, two
  `tick()` calls; assert both handlers tick in precedence order and that the
  invocation key advances. The `tickIndex--` mutant dies by asserting the exact
  seeded `ctx.random()` value expected for the `tick|1|...` key, computed from
  the pinned PRNG in the test.
- **initialState vs L1 floor** (`index.ts:177-195`): subscribe on a toClient
  channel with a registered `initialState` handler (handler wins, no L1
  emission); without a handler (L1 floor publishes); with an always-invalid
  schema such as `{not: {}}` (floor stays empty, violation recorded, kills the
  `index.ts:191` branch).
- **Scheduler default error reporter** (`scheduler.ts:31-37`): construct without
  `onTaskError`, post a throwing task, capture `console.error`, assert the
  `[offbook] scheduler task failed:` prefix appears and `idle()` still settles.
- **`loadHandlers` delegation** (`index.ts:212-216`): stub `DispatchRegistry`,
  assert path passthrough and that `instantiate()` is called.
- **`get faker`** (`index.ts:291-293`): one call through `engine.faker` against
  a channel.

## Bucket 2: pin ordering and tie-break semantics (~15 mutants)

- **`dispatch.ts` precedence** (`dispatch.ts:38-44`): distinct module paths sort
  by code unit, including a case where `localeCompare` would disagree (for
  example `"B.ts"` vs `"a.ts"`) to pin the cross-machine determinism the
  comment promises; equal path falls to registration order (kills the `<=`/`>=`
  equality mutants and `a.order + b.order`); `all()` returns the full sorted
  sequence (kills the `dispatch.ts:94` sort/map removals); `select()` before
  `instantiate()` returns `undefined` (kills `dispatch.ts:89`).
- **`loadHandlers` module stamping** (`dispatch.ts:56-70`): real temp-dir load
  with two handler modules; each registration carries its own module path; after
  the load a direct `register()` gets `""` again (kills the `finally` block and
  `dispatch.ts:36` sentinel mutants).
- **Scheduler timeline order** (`scheduler.ts:69-77`): same-`dueAt` emissions
  keep insertion order; a later-inserted but earlier-due emission runs first
  (kills the comparator `||` to `&&` and both `-` to `+` mutants plus sort
  removal); with both queues populated in one synchronous turn, the immediate
  queue drains ahead of a zero-delay timeline entry (kills the `!entry &&`
  condition-to-`true` mutant, which would drop an immediate task and hang
  `idle()`).
- **Passive tick guard** (`index.ts:277-279`): passive `tick()` does nothing
  (no handler tick, `now()` unchanged); active `tick()` advances.
- **Inbound without a matching handler** (`index.ts:257-267`): an inbound event
  on a topic with no registration (or before `instantiate()`) must not throw
  (kills the `sel?.`/`onInbound?.` optional-chaining mutants at
  `index.ts:261`).

## Bucket 3: structural message asserts (~28 mutants)

- **Validation-error formatting, both sites** (`faker.ts:78-88`,
  `index.ts:126-139`): drive one root-level schema failure (empty
  `instancePath`, assert the `/` fallback appears) and one nested failure
  (assert `/x` plus the Ajv keyword). The two-case pair is what kills the
  `||`/optional-chaining mutants, not just the `""` literals. Also assert
  `violation.topic`, `violation.channel`, and `emitSource` stamping.
- **Unknown-topic mock emit** (`index.ts:93-113`): emit to an unmatched topic;
  assert the violation (kind, topic, detail contains `unknown-topic`) and that
  the message is still delivered at qos 1, retain false. A delayed variant
  asserts delivery at logical time equal to the delay (kills the
  `partial.delayMs && 0` mutant at `index.ts:104`).
- **`parseDelay` errors and draw** (`resolve-emit.ts:26-42`): malformed spec
  message contains the offending spec and the expected-grammar hint; `"5-3ms"`
  yields the min>max message; `"5-5ms"` does not throw (kills `max <= min`);
  a `"1-2s"` draw lands in [1000, 2000] (kills `* unit` to `/ unit`, which
  would trip the min>max throw); a key chosen so the draw lands in the upper
  half pins the inclusive-range arithmetic (kills `max - min - 1`).
- **`resolveEmit` guard errors** (`resolve-emit.ts:51-60`): both-delays error
  and missing-delayKey error, asserted structurally.
- **`canonicalize`** (`faker.ts:9-15`): exact asserts, `""` for absent params
  and `"a=1&b=2"` for `{b: "2", a: "1"}` (order, `=`, `&` all pinned).
- **Faker seed key and rejection path** (`faker.ts:34-41`, `faker.ts:66-73`):
  different topic or params produce different draws while same inputs
  reproduce (kills the seed-key `""` mutant); a throwing faker yields a
  violation whose detail starts with `faker rejected:` and contains the
  original message.
- **Materialization-rule ledger asserts** (`index.ts:119-121`, `177`): exact
  ledger-snapshot asserts, not just membership. A non-parametrized mock emit
  must leave the ledger empty (kills the `index.ts:119` condition-to-true
  mutant, which materializes an empty-params entry); a concrete parametrized
  subscribe must record exactly its instance (kills `index.ts:177` to false).
  An L2 delay-string emission through `engine.publish` asserts the emission
  lands at the exact seeded logical time (kills the `{...config, seed}` to
  `{}` mutant at `index.ts:121`, which would shift the keyed draw).
- **seedInstances** (`index.ts:222-247`): one resolvable entry materializes into
  the ledger and republishes initial state; one junk entry surfaces a violation
  whose detail contains the address and the JSON params (kills `index.ts:230-239`);
  exact snapshot assert on the ledger set kills the `length >= 0` mutant at
  `index.ts:243`.

## Bucket 4: residue triage (kill-first, annotate the argued rest)

- **Golden-value kills** (`prng.ts`): pin exact `hashToInt` and `mulberry32`
  outputs by comparing against an independent inline copy of each pinned
  algorithm in the test (a reference oracle over a broad input corpus, rather
  than hardcoded constants). The `i <= s.length` mutant performs one extra
  multiply on the NaN-as-0 char code and changes the hash, so the oracle
  catches it alongside the constant/arithmetic mutants.
- **Annotate as equivalent**, each with `// Stryker disable next-line
  <Mutator>: <reason>`:
  - `dispatch.ts:87` condition-to-false: the fall-through reaches the same
    `undefined` via the `!handler` check.
  - `scheduler.ts:69` `timeline.length >= 0`: sorting and shifting an empty
    timeline yields `undefined`, guarded at `if (next)`.
  - `scheduler.ts:73` `if (next)` to `true`: `shift()` on a length-guarded
    timeline cannot return `undefined`.
  - `scheduler.ts:119` epoch guard to false: belt-and-braces; `reset()` always
    clears wall timers before bumping epoch, so a stale callback cannot fire.
  - `scheduler.ts:170`/`187` `if (tickTimer)` to `true`:
    `clearInterval(undefined)` is a harmless no-op.
  - `scheduler.ts:182` `epoch--`: epoch is an identity token; only uniqueness
    across resets matters, not direction.
  - `instances.ts:18` has-guard to false: re-setting an identical value under
    the same key preserves Map insertion order; `snapshot()` copies, so nothing
    is observable.
- **Attempt, may end annotated** (`faker.ts:23-26`): `alwaysFakeOptionals` is
  killable with an optional-property schema asserted present in the draw;
  `failOnInvalidTypes` may be unobservable with our fixtures. If annotated, the
  reason must say why no fixture can observe the flip.

The rule for every annotation: it needs a stated reason why the mutant is
**unobservable**. "Hard to kill" is not a reason; such mutants stay visible.

## Doc-system integration

- All new tests extend the existing tagged test files: `scheduler.test.ts`
  (`[utest->R-010]`), `faker.test.ts` (R-011), `dispatch.test.ts` (R-012),
  `resolve-emit.test.ts` and `index.test.ts` (R-013), `reset.test.ts` (R-014),
  `instances.test.ts` (R-032). No new test files, so no `REQUIREMENTS.md`
  TEST-list edits.
- `prng.test.ts` is untagged and in no TEST trace; the golden-value tests keep
  it that way (the checker only requires tags for files a `tested` requirement
  lists).
- One new ledger entry **D-011** records this policy: clean-report
  kill-or-annotate, structural message asserts, annotation requires an
  unobservability reason, plus the final score. D-010 is the latest entry as of
  this design.
- `bun scripts/check-docs.ts` runs before every commit, as usual.

## Verification loop

- Per bucket: full `bun test` (never gate on single-file runs; the per-file
  coverage floor makes them exit 1 spuriously) plus a focused Stryker pass over
  the touched files via a `--mutate` override.
- Stryker needs Node >= 20 on PATH to host its CLI; `nvm use default` puts
  Node 24 on PATH (the runner plugin still drives `bun test`).
- Final gate: one full `bun run mutate` showing 0 Survived and 0 NoCoverage.
  Annotated mutants report as Ignored; Timeout counts as detected. The
  regenerated HTML stays local (`reports/` is gitignored); the final score is
  recorded in D-011.
- Wall-timer tests keep intervals at 5-10ms with loose count assertions, well
  under Stryker's 20s mutant timeout.

## Commit shape

One commit per bucket (four total), each leaving `bun test` and
`bun scripts/check-docs.ts` green, plus a final docs commit for D-011 and any
annotation sweep. Commits happen only on explicit go-ahead, per the working
notes.

## Out of scope

- Mutation coverage beyond `src/engine` (the Stryker `mutate` glob is
  unchanged).
- Making mutation testing a gate (it stays manual, per AGENTS.md).
- Refactors not required to kill a mutant (the faker/index formatting
  duplication stays unless a mutant forces the issue).
