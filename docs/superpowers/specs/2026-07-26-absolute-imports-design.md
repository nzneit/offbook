# Absolute imports for internal project files — design

**Date**: 2026-07-26
**Status**: approved (brainstorm dialog, 2026-07-26)

## Motivation

Two goals, both user-stated:

1. **Refactor safety**: moving an importing file must not break that file's own imports. Relative specifiers encode the importer's location; absolute specifiers do not.
2. **Readability / consistency**: one uniform import style across `src/`, `test/`, `scripts/`, and `bin/`, replacing the mix of `../model/index.ts`, `../src/engine/faker.ts`, and `../../scripts/spike-jsf-fidelity.ts`.

Explicit caveat: absolute imports make the *importing* file's location irrelevant. Moving an *imported* file still requires rewriting its importers; the win there is that every importer uses one identical, exactly-greppable specifier string.

## Decision: `package.json` subpath imports

Add to `package.json`:

```json
"imports": {
	"#src/*": "./src/*",
	"#scripts/*": "./scripts/*"
}
```

No other config changes. `tsconfig.json` already resolves these (`moduleResolution: "bundler"` honors `resolvePackageJsonImports` by default) and `allowImportingTsExtensions` keeps the repo's explicit `.ts` extensions working. Biome, bunfig, and Stryker configs are untouched.

### Alternatives considered

- **tsconfig `paths` (`@/*`)**: rejected. It is a compiler-config convention, not a platform standard; anything that does not read tsconfig silently fails to resolve it, and it couples runtime module resolution to a TypeScript config file. Subpath imports are resolved by spec in every Node-compatible resolver this repo uses (Bun runtime, `bun test`, tsc, and the Stryker sandbox, where `#` specifiers resolve against the sandbox's copied `package.json`, which is exactly what mutation testing needs).
- **Keep relative imports**: rejected. Zero cost, but delivers neither stated goal.

## Convention

- Any import that **reaches upward** (anything that would need `../`) uses the alias: `#src/model/index.ts`, `#scripts/spike-jsf-fidelity.ts`.
- **Same-directory and downward** imports stay relative: `./scheduler.ts`, `./check-docs.ts`, `./sub/helper.ts`.
- Applies uniformly to `src/`, `test/`, `scripts/`, and `bin/offbook` (inside the package, so `#src/cli/index.ts` resolves there too).
- Explicit `.ts` extensions remain, as everywhere else in the repo.

## Migration

Mechanical rewrite of the 54 existing parent-relative import lines (count as of 2026-07-26; re-grep at implementation time):

- `src/**`: `from "../<mod>/…"` → `from "#src/<mod>/…"`
- `test/**`: `from "../src/…"` / `from "../../src/…"` → `from "#src/…"`; `from "../../scripts/…"` → `from "#scripts/…"`
- `bin/offbook`: `from "../src/cli/index.ts"` → `from "#src/cli/index.ts"`

Then `bunx biome check --write .` to settle import ordering. No behavior change anywhere; no file moves.

## Guardrail

New `test/import-style.test.ts`, in the style of `test/transport-isolation.test.ts`: walk `src/`, `test/`, `scripts/`, and `bin/`, and assert no file (all `.ts` files plus `bin/offbook`) contains a parent-relative import (`from "../`). Same-directory `./` imports remain allowed. This makes the convention a cheap grep-based gate rather than a social rule, consistent with how this repo enforces transport isolation.

No arrow-tag: the guardrail is repo convention, not the trace of an `R-###` requirement.

## Docs and ledger

- **`DECISIONS.md`**: append **D-013** (next free id; verify with `bun scripts/check-docs.ts`) recording: What (subpath imports via `package.json` `imports`, `#src/*` and `#scripts/*`, cross-directory alias / same-directory relative convention, grep gate), Why (spec-guaranteed resolution across Bun, tsc, and the Stryker sandbox vs tsconfig-path coupling), From (this design dialog), Folds into (AGENTS.md working notes).
- **`AGENTS.md`**: one working-notes line stating the convention (cross-directory imports use `#src/…`/`#scripts/…`; same-directory stays relative; enforced by `test/import-style.test.ts`).
- **Spec sweep**: check `docs/specs/build-plan.md` (and other `docs/specs/` files) for code examples showing relative internal imports; update any found to the new style, per the repo's decision-sweep discipline.

## Verification

1. Full `bun test` (the per-file coverage gate is authoritative only on full runs).
2. `bun run lint`.
3. `bunx tsc --noEmit`.
4. `bun scripts/check-docs.ts` (D-013 well-formedness).
5. One manual, focused Stryker run (`nvm use default` first, for the Node >= 20 host) to prove `#` resolution inside the `.stryker-tmp` sandbox, the one resolver a normal test run cannot exercise. Mutation testing stays manual and non-gating (D-010/D-011 policy unchanged).

## Non-goals

- No per-module public-API aliases (`#model` → `src/model/index.ts`); a possible later refinement, not now.
- No tsconfig `paths`, ever, alongside this: one alias system only.
- No change to intra-directory import style, file layout, or the transport-isolation rules (the Biome `noRestrictedImports` rule and grep test match the `aedes` specifier string, which is unaffected by internal aliases).
