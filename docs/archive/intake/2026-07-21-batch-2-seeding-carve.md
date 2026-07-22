# 2026-07-21: batch-2+ seeding carve (intake)
**Status**: resolved
**Owner**: nzneit

Resolved 2026-07-21: allocated R-010..R-031 + D-007 in the seeding commit.

Post-M0 state: Tier 0/1 modules are `tested` (R-001..R-005, R-009), M0 is `tested` (R-008), and only the two empirical spikes (R-006/R-007) remain `specified` from batch 1. D-002 deferred the batch-2+ registry pass to post-prototype enrichment; this intake executes that deferral. The shape recorded in the REQUIREMENTS.md trailing comment is taken as the baseline; forks b and c below refine it.

## a — Seed the full batch-2+ now, or only the tier-2 slice?
Full pass answers "what's left for v1" completely and keeps id allocation to one pass; tier-2-only matches the R-009 incremental precedent but re-opens the carve discussion at tiers 3 and 4.
→ Resolution: **full pass**, 22 entries in one allocation → allocates R-010..R-031.

## b — Where does the engine's deterministic scheduler live in the carve?
The D-002 shape split engine/ by layer (L1 floor, L3 dispatch, emit-completion, reset), but none of those four owns the substrate they run on: the single virtual-clock event loop awaiting `broker.emit`, the Mulberry32 seeding, and the wall-paced interactive path (CR6). The §4 determinism gate entry is meant to be thin and cross-referencing, so it needs a module entry to point at.
→ Resolution: **a fifth engine entry, "deterministic scheduler core"** (R-010); the determinism gate entry (R-029) cross-references it → recorded in D-007.

## c — Control-plane: one entry or two?
The D-002 shape left this open ("endpoints + envelope, plus the CI settlement flow if split"). The EC1 settlement flow (`reset → publish → GET /pending?wait → /validation?sinceSeq=`, returning only at `scheduled:0, settled:true`) leans on engine scheduler semantics and lands later than the plain endpoint contract tests.
→ Resolution: **split into two entries** (R-017 endpoints + envelope + F11 injection; R-018 CI settlement flow), so the endpoints entry can go `tested` without being held hostage by the settlement choreography → recorded in D-007.

## d — Status policy: pre-reconcile entries whose M0 slices already have tests?
M0 built real, tested slivers under several entries (L1 faker floor, validation ring buffer, three endpoints). Flipping statuses inside the seeding pass front-loads trace verification into a mechanical commit and risks shipping an overclaimed status.
→ Resolution: **seed all 22 entries `specified`**; reconciliation is the first tier-2 working step, per the batch-1 precedent (seed, then "reconcile R-001 + R-003" as its own commit). No new D-### (procedural, consistent with existing practice).

## e — The allocation (ids ordered by build-plan tier: 2 → 3 → 4 → spikes → gate)

| UID | Entry | COVERS | Statement must cover |
|---|---|---|---|
| R-010 | engine/ deterministic scheduler core | `#tier-2` | virtual-clock event loop awaiting `broker.emit`, Mulberry32 seeding, wallClock interactive path (CR6) |
| R-011 | engine/ L1 faker floor | `#tier-2` | seeded JSF + Ajv-recheck; F5 drop-and-surface as a `mock` violation, never silent |
| R-012 | engine/ L3 dispatch | `#tier-2` | glob handler discovery, `register(pattern, factory)`, G1 precedence, winner stable across runs and file reordering |
| R-013 | engine/ emit-completion | `#tier-2` | single `resolveEmit(partial, channel)` choke-point: channel-resolved qos/retain (F13), ranged-delay parse keyed by `(scenarioName, stepIndex)` (F7), `emitSource` stamping (G10) |
| R-014 | engine/ reset | `#tier-2` | restore known state + re-seed + re-instantiate L3 |
| R-015 | validation/ full bar | `#tier-2` | `Violation` kinds (`schema`/`decode`/`direction`), `client`/`mock` origin, bounded ring buffer (FIFO eviction, process-monotonic `seq`, `summary.oldestSeq`), delivery never blocked |
| R-016 | scenarios/ (L2) | `#tier-3` | glob+sorted-path dispatch table, `{param}` matcher + `payloadMatch`, `{{…}}` templating + seeded helpers + L1 autofill, author-time validation → `/diagnostics`, skipped-loud vs strict-fatal, hot-reload |
| R-017 | control-plane/ endpoints + envelope | `#tier-3` | every `/v1/*` per contracts §5 with a contract test, error envelope, capabilities by injection (F11), `/topics` example byte-equal to `/publish {example:true}`, explicit qos/retain override + divergence warn |
| R-018 | control-plane/ CI settlement flow | `#tier-3` | EC1: `/pending?wait` returns only at `scheduled:0, settled:true`, reports nonzero `scheduled` mid-chain in wall-paced mode, `?sinceSeq=` slice, no poll loop |
| R-019 | cli/ dispatch backbone | `#tier-4` | command→endpoint routing for the full verb set, runfile resolution, response rendering plumbing |
| R-020 | cli/ publish + scenario input | `#tier-4` | `--example`/`--payload`/`--payload-file`/`--payload -` mutually exclusive, bare = `--example`, nonzero on unmatched topic unless `--force` (EQ1), repeatable `--param k=v` (EQ4) |
| R-021 | cli/ topics + validation rendering | `#tier-4` | ER1 (no raw schema fragment, fields + required-ness + seeded example, flatten `allOf`/mark `oneOf`·`anyOf`, filters, `--json` round-trip) + ER2/EQ6 (distinct-collapse `×N` lines, composed headline, summary footer, `-v`, `--json` parity) |
| R-022 | cli/ up boot profiles + ports | `#tier-4` | interactive vs `--ci` profile co-sets, `--strict` independent, port preflight + overrides, double-start refusal, stale-runfile reclaim, idempotent `down`, connect-target print (P7) |
| R-023 | cli/ status + check | `#tier-4` | `status` scoreboard (`summary.distinct.client`, diagnostics counts, connect target, spec age; nonzero when down), `check` nonzero iff client breaks since last reset (P8), `up --seed`/`reset --seed` set/echo |
| R-024 | cli/ watch modes | `#tier-4` | `up --watch` autonomous-only, off in `passive` (EH1); `validation`/`diagnostics` `--watch` poll `?sinceSeq=` within one interval (EO1–EO4) |
| R-025 | cli/ init | `#tier-4` | scaffold-when-absent, re-run refuses nonzero, never scaffolds `specs.lock`, `init && <set gitHost> && up` reaches a running server, L1-floor orientation banner suppressed once a scenario/handler loads (EI1–EI2) |
| R-026 | spike: mqtt-pattern parity (F6/R2) | `#spikes` | `{p}`→`+p` rewrite reproduces AsyncAPI single-segment capture exactly; `+`/`#` semantics incl. `#` matching zero trailing levels; go/no-go artifact |
| R-027 | spike: json-schema-faker fidelity (F8) | `#spikes` | JSF 0.6.2 vs every fixture's bundled schema; per-fixture Ajv-recheck failure rate; decides whether F5 needs the keyed-fallback re-draw |
| R-028 | gate: §5 validation correctness | `#v1-gate` | thin; registry + validation green against `external-ref`, `qos-retain`, `qos-overrides`; cross-references R-004/R-015 |
| R-029 | gate: determinism | `#v1-gate` | thin; same seed ⇒ identical stream/timings/violation order over the F9 projection, booted `passive` via `up --ci` (F10); cross-references R-010 |
| R-030 | gate: transport isolation | `#v1-gate` | thin; the `aedes`-import lint rule passes repo-wide |
| R-031 | gate: observe-and-surface | `#v1-gate` | thin; no validation path ever blocks delivery; cross-references R-015 |

→ Resolution: allocate as tabled → allocates R-010..R-031.

## f — Mechanics of the seeding commit
Entry format per doc-system §4.3, house style per R-009 (qualifier tags like F13/G10 stay in the sentence). All entries `specified`, no IMPL/TEST lines. build-plan.md gains four additive anchor comments: `tier-2`, `tier-3`, `tier-4` on their §3 headings and `v1-gate` on §4. contracts.md and AGENTS.md are untouched (case-by-case anchors only, none needed by these 22). The REQUIREMENTS.md trailing comment is rewritten to only what remains: contracts/AGENTS anchor markers case-by-case, design.md §1–12 rationale case-by-case, next id = max + 1. D-007 records forks b and c. Gate: `bun scripts/check-docs.ts` green; one doc-only commit; this intake file moves to `docs/archive/intake/` in that commit.
→ Resolution: as stated → allocates D-007.

## g — Tier-2 work sequence after seeding
1. **Reconcile**: R-011 (`src/engine/faker.ts` + test exist), R-015 (ring buffer tested; verify decode/direction clauses have real coverage before flipping), R-026 (check whether R-004's registry tests already constitute the parity go/no-go). Flip only what is honestly covered, adding the missing sliver where close.
2. **Run R-027 early**: cheap (fixtures local), and its outcome decides whether R-011's drop-and-surface needs the F5 keyed-fallback before CI leans on L1.
3. **Build the engine chain in dependency order**: R-010 → R-012 → R-013 → R-014, each a working commit flipping status with traces.
4. Gates (R-028..R-031) and tiers 3/4 stay `specified` for later enrichment rounds.
→ Resolution: sequence adopted (procedural; no allocation).
