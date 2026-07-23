# Offbook — Documentation System (Design)

*Knows every line. Needs no cast.*

**Status:** Standing description of the documentation system. The migration in §6 has been executed (this file now lives in `docs/specs/`); §6 is retained as the historical record of the steps.

**Companion to:** `AGENTS.md` (the entry point this design keeps canonical) and the four specs it reorganizes (`contracts.md`, `design.md`, `build-plan.md`, `l2-scenarios.md`).

---

## 1. Context and problem

Offbook is pre-build (design docs plus test fixtures, no app code yet). The corpus grew to 18 root-level markdown files: four canonical living specs plus a growth ring of process artifacts (four gap-review rounds, six ergonomics handoffs, a decision log, two trackers), held together by a generated `INDEX.md` and per-doc `type`/`status`/`summary` frontmatter that the repo itself flags as temporary scaffold.

Five distinct pains motivated this reorg:

- **(a) Sprawl.** 18 root markdown files, roughly 14 of them dead weight for day-to-day work; every future review round makes it worse, and it gets uglier once `src/` lands.
- **(b) ID chaos.** Seven-plus disposable ID alphabets (G, F, R, S, P, CR, EQ, EI, EC, ER, EO, EH), renumbered every round, no single registry, so "where and why was X decided?" means grepping archive strata.
- **(c) Requirements have no single home.** The actual requirements are smeared across `contracts`, `design`, and `build-plan`, discoverable mainly through fold history; nothing lets you enumerate "all v1 requirements" or check one off as built or tested.
- **(d) Monoliths.** `design.md` and `contracts.md` are each roughly 70KB, held together by fragile `§N` cross-references.
- **(e) Process cost.** The review to handoff to fold to archive loop is heavy ceremony, and the build phase is about to generate a new stream of artifacts (spike results, deviations, review findings) with no designated place to land.

The system must deliver four capabilities, all rated load-bearing by the owner:

1. **Enumerate.** A requirements registry with stable, never-reused IDs and lifecycle states (specified / built / tested), so "are we done?" is a query.
2. **Trace.** Decision and provenance tracing: which dialog or round produced each decision (ADR-like).
3. **Direct.** A single entry point from which an agent knows what to do next.
4. **Absorb.** A standing intake convention so future review rounds do not mint new ad-hoc ID alphabets.

## 2. Decision summary

**Adopt a unified ledger system, homegrown but principled, with a format-compatible binding to StrictDoc as the enterprise exit path.** Concretely: keep the specs as the canonical source of truth (the conflict rule stays intact), add two small plain-markdown ledgers (a requirements registry and a decision ledger), a standing intake convention, and grow the existing doc script into a validator.

The StrictDoc binding is **format-compatible only**: registry entries use StrictDoc's markdown grammar (`**UID**:` meta lines) so that `pip install strictdoc` can emit ReqIF against our own files if the enterprise pitch ever lands, but nothing installs StrictDoc for daily work. The cost is formatting discipline and nothing more.

Alternatives considered and rejected:

- **Adopt MADR-style file-per-ADR plus a docs taxonomy (convention-only).** Rejected: decisions arrive in batches of roughly 25 from dialog rounds, so file-per-decision means 25 boilerplate files per round, and the requirements story stays bolted on.
- **Adopt a git-native tracker (beads, git-bug) or a full RM tool (strictdoc-as-engine, TRLC, Doorstop).** Rejected for daily use: adds a runtime dependency and agent-onboarding cost, diffs opaquely, and is over-machinery for a solo pre-build repo whose artifacts are prose. StrictDoc is retained as a *format target*, not an installed engine.
- **Fully homegrown, ReqIF as a someday script we write ourselves.** Rejected: forfeits the one verified plain-text-to-ReqIF path for no saving, since the format-compatible binding keeps that door open at zero present cost.

## 3. Research provenance

Two verification passes informed this design (this section is itself an instance of the decision-tracing the system is meant to make routine).

**Pass 1 (landscape sweep, adversarially verified).** The 2025 to 2026 tooling market splits into two halves that solve different problems: mature docs-as-code RM engines (StrictDoc, OpenFastTrace, TRLC/LOBSTER) that provide standing registries, and agent-era spec-workflow tools (GitHub Spec Kit, OpenSpec, Kiro) that provide per-change intake. Verified findings that shaped the design:

- **"Emit ReqIF later from plain text" is real and demonstrated by exactly one tool.** StrictDoc documents bidirectional SDoc/ReqIF CLI flows today, including enterprise-targeting options (a Polarion XHTML flag). Every other surveyed candidate documents no ReqIF at all. Caveat from StrictDoc's own docs: round-tripping is tool-specific, and enterprise-side import acceptance was not verified.
- **StrictDoc parses plain markdown with `**UID**:` meta lines** (experimental since 2026 Q1), so a registry can be ordinary markdown with zero tool dependency today and still be ingestible later. Because the reader is explicitly experimental, our own checker stays the daily driver and the grammar binding is best-effort insurance, not a hard dependency.
- **Derive built/tested from trace links, never hand-assert them** (the discipline worth stealing from OpenFastTrace, whose tool otherwise drops out for having no ReqIF path).

**Pass 2 (the four arXiv-taxonomy entrants, per-tool).** BMAD Method, GSD, Spec Kitty, and Reversa were each evaluated against the constraint set. All four came back **workflow/intake-class or reverse-engineering, none a standing registry, none with ReqIF**, and none displaces this design. The decision-relevant finding is the convergence: every agent-era tool (these four plus Kiro and OpenSpec) independently reinvents the same parts, a requirements file with IDs, status lanes, a decision/provenance store, and a traceability matrix, while sharing one identical gap: IDs are scoped to a feature, mission, or milestone and reset. None provides a durable cross-cutting registry, because that category optimizes per-change delivery, not standing governance. The market validates every component of this design while confirming that the one thing Offbook specifically needs is the thing those tools deliberately do not build.

## 4. The system (target state)

### 4.1 Core principle: two permanent ID namespaces

Every past ID alphabet existed because each review round invented a permanent-looking scheme for what were really ephemeral working items. That is the root cause of both the ID chaos (pain b) and the fold ceremony (pain e).

**The system has exactly two permanent ID namespaces: `R-###` (requirements) and `D-###` (decisions). Everything else is ephemeral by design and graduates to an R- or D- ID only when it resolves.** A review round no longer mints an alphabet; it drops an intake file whose open questions carry throwaway local handles, and resolving each one allocates the next R- or D- number from a global counter. No new alphabet can appear again, because the act of creating one is replaced by pulling the next number.

### 4.2 Directory layout (pain a)

```
AGENTS.md                 # entry point — stays at root (CLAUDE.md symlink stays)
REQUIREMENTS.md           # the registry  — capability 1
DECISIONS.md              # the ledger    — capability 2
docs/
  specs/
    contracts.md          # frozen authority (conflict rule intact)
    design.md
    build-plan.md
    l2-scenarios.md
  intake/
    _TEMPLATE.md
    2026-07-10-<topic>.md # open review rounds land here
  archive/
    intake/               # resolved intake files, intact
    decision-logs/        # the old G/F/S/P/EQ… strata, intact, never renumbered
fixtures/                 # unchanged
scripts/check-docs.ts     # the checker (rewritten docs-index.ts)
```

Root drops from 18 markdown files to four (AGENTS plus the two ledgers plus this design until it migrates). The `offbook-` filename prefix drops once the path disambiguates. The directory tree now *is* the taxonomy, so per-doc `type`/`status` frontmatter is retired.

The two ledgers (`REQUIREMENTS.md`, `DECISIONS.md`) live at repo root for high visibility, the same reasoning that puts README and CHANGELOG at root. The sprawl being cured was the process docs, not two spine files.

### 4.3 REQUIREMENTS.md, the registry (capability 1, pain c)

One entry per requirement, in StrictDoc-compatible markdown:

```markdown
#### Seeded determinism via Mulberry32
**UID**: R-014
**STATUS**: specified
**COVERS**: docs/specs/design.md#62-scheduler
The engine's scheduler produces identical event ordering for a given seed.
```

- **`**UID**`** is the load-bearing token: StrictDoc parses it, and the checker enforces its uniqueness and never-reuse.
- The registry is an **index into the specs, not a competing source of truth.** The conflict rule survives: the one-line body is a summary, and `COVERS` anchors to the spec section that holds the normative text (`contracts.md` remains canonical on any interface detail).
- **Lifecycle:** `specified` and `deferred` (v2 punt) are asserted; **`built` and `tested` are validated by `scripts/check-docs.ts`** — a hand-set `built`/`tested` STATUS must be backed by an `IMPL`/`TEST` trace or the checker errors. A requirement becomes `built` only when an implementation trace exists and `tested` only when a covering test exists. Pre-build, everything sits at `specified` and the registry already earns its keep as the single enumerable home; as the build lands, "are we done?" becomes a checker query.
- **Never-reuse enforcement:** entries are never deleted. A withdrawn requirement gets `STATUS: retired` and stays in place, so its ID is visibly consumed. The checker reads the max allocated ID plus the retired set to allocate the next number.

### 4.4 DECISIONS.md, the ledger (capability 2, pain b)

Append-only, MADR vocabulary, `D-###` never reused:

```markdown
### D-042: Defer --frozen/F17 to v2
**Date**: 2026-06-30
**What**: `--frozen` and F17 deferred to v2; DST engine stays in v1.
**Why**: <one line>
**From**: docs/archive/intake/2026-06-30-pm-gap-p5.md  (was "P5")
**Folds into**: docs/specs/design.md §11, docs/specs/build-plan.md §M0
```

The ledger starts fresh at D-001 **going forward**. The roughly 120 historical items are **not** back-filled (that back-fill is exactly the heavy migration that makes reorgs die). The old decision-logs move to `docs/archive/decision-logs/` intact, keeping their original G/F/S/P IDs as a frozen historical record. Historical provenance is "it is F7 in archive"; forward provenance is the ledger. A forward decision that must cite a historical one maps that single item to a D- ID on demand, with no bulk rewrite.

### 4.5 intake/, the standing convention (capability 4, pain e)

Every future review round, spike result, or deviation is one dated file created from `docs/intake/_TEMPLATE.md`, with open questions carrying ephemeral local handles (`a`, `b`, `c`). Resolving an item: allocate its permanent R- and D- IDs, append to the registry and ledger, flip the file's status to resolved, and move it to `docs/archive/intake/`. This replaces the entire review to handoff to fold to archive ceremony with one loop that has no per-round vocabulary.

Template shape:

```markdown
# 2026-07-10: <topic> (intake)
**Status**: open
**Owner**: <who owes the decision>

## a — <question>
<context, options, recommendation>
→ Resolution: <decision> → allocates D-### / R-###
```

### 4.6 AGENTS.md, the entry point (capability 3)

`AGENTS.md` stays the single entry point. Its doc-map section is rewritten to point at the new tree and to name `REQUIREMENTS.md` as the answer to "what needs building and is it done." The thin `offbook-handoff.md` ("what to build, in order") folds into that: the registry, sorted by lifecycle, is the work list now, and AGENTS.md carries the current frontier pointer. The hard-constraints and vocabulary sections stay as they are, with path references updated.

### 4.7 check-docs.ts, the checker (pain e)

`scripts/docs-index.ts` stops being teardown scaffolding and becomes `scripts/check-docs.ts`, a real validator run in CI and as an optional pre-commit hook. It is run as `bun scripts/check-docs.ts` (no flag) and exits nonzero on any problem; that invocation is the gate. It validates:

- **Unique R- and D- IDs**, with a retired-IDs guard that enforces never-reuse.
- **Every `COVERS` anchor resolves** to a live spec section (this is what makes the fragile `§N` web safe to evolve).
- **Every `built`/`tested` STATUS matches reality:** no requirement claims `built`/`tested` without the corresponding implementation/test trace.
- **Bidirectional arrow-tag traceability:** forward, every `TEST` file listed on a `tested` requirement must contain a matching `[utest|itest|stest->R-###]` comment tag; reverse, every `*.test.ts` under `src/`, `test/`, and `scripts/` is swept, and malformed, dangling, or retired-target tags are errors.
- **Every open intake file is well-formed** against the template.

Optionally it can emit a one-line dashboard (counts by lifecycle state) as a generated summary, but that is a nicety, not core.

### 4.8 Anchor mechanism (and why it makes pain d tractable)

`COVERS` uses a `path#heading` reference, checker-verified to resolve. Where a spec section needs a guaranteed-stable target (especially inside frozen `contracts.md`), an explicit additive back-anchor (`<!-- anchor: R-014 -->`) may be added; this changes no normative content and does not touch the interface freeze. Bidirectional anchoring (the spec carries a matching `<!-- anchor: R-### -->` marker) is the hardening option that also makes a future monolith split safe: split the file, update anchors, and let the checker prove nothing broke.

## 5. Explicitly out of scope now

- **Splitting the roughly 70KB monoliths (pain d).** That is a separate, riskier effort, and one of the two docs is frozen. This design does not do it. Instead it installs the enabling precondition: once requirements are anchored, a later split is a mechanical, checker-verified operation, and adopting `R-###` references in place of fragile `design §N` cross-references de-fragilizes the web incrementally for free.
- **Back-filling the roughly 120 historical decisions.** Archived intact instead. The ledger is authoritative from its creation date forward.

## 6. Migration plan (sequenced)

*This migration has been executed; the steps below are retained as the historical record (they name pre-move filenames deliberately).*

The target state is mechanical to reach except for one content task (step 5, seeding). The following order keeps the repo valid at each step.

1. **Retire the frontmatter and INDEX scaffold.** Run `bun scripts/docs-index.ts --teardown` (strips every frontmatter block, deletes `INDEX.md`). Keep `scripts/` (it will be rewritten, not removed).
2. **Create the tree.** `docs/specs/`, `docs/intake/`, `docs/archive/intake/`, `docs/archive/decision-logs/`.
3. **Move and rename the four specs** into `docs/specs/` (dropping the `offbook-` prefix). Update `AGENTS.md`'s doc-map and internal cross-references. Moving the frozen `contracts.md` changes its location, not its content; the freeze is on the interface content and is unaffected.
4. **Archive the strata.** Move the five decision-logs (`contracts-decisions`, `build-gaps` 1 to 4), the six ergonomics handoffs, and `prework` into `docs/archive/decision-logs/`, intact.
5. **Create and seed the ledgers.** `DECISIONS.md` starts at D-001 with a note pointing historical provenance at the archive. `REQUIREMENTS.md` is seeded from the existing specs (see section 7); this is the one substantial task and is staged, acceptance-criteria first. The single currently-open item (P1, the two empirical spikes, from `build-gaps-4`) becomes the first live intake file or its first registry/decision entries.
6. **Write the intake template** at `docs/intake/_TEMPLATE.md`.
7. **Rewrite the checker** as `scripts/check-docs.ts` per section 4.7, and wire `--check` into CI and pre-commit.
8. **Fold `offbook-handoff.md`** into `AGENTS.md` plus the registry, then archive it. Update the "Work tracking" line in `AGENTS.md` to describe the standing system rather than the retired scaffold.

## 7. The one real cost: seeding the registry

Populating `REQUIREMENTS.md` from the existing specs is genuine work, not mechanical. The build-plan's per-module acceptance criteria are the richest and most build-relevant seed source and are done first; the contract obligations, the design decisions in `§1` to `§12`, and the hard constraints in `AGENTS.md` follow. Each entry is an atomic one-sentence statement, a `COVERS` anchor into the owning spec, and an initial `specified` state. This seeding belongs in the implementation plan, done incrementally, and is deliberately not attempted during this design.

## 8. Coverage check

Pains: (a) tree plus archive; (b) two-namespace principle plus intact-archive strata; (c) the registry; (d) deferred but enabled, plus incremental de-fragilization; (e) the intake loop plus scaffold retirement. Capabilities: 1 the registry, 2 the ledger plus preserved archive, 3 the AGENTS.md entry point, 4 the intake convention.
