# 2026-08-12: First-light acceptance-test executability (intake)
**Status**: resolved (design approved in-session 2026-08-12; lands as a follow-up commit on `feat/skill-improvement`)
**Owner**: the `feat/skill-improvement` follow-up commit

**Companion to:** `docs/specs/adoption.md` §10 (canonical for the connects surface), `docs/guides/wiring-your-service.md` (first-light paragraph), `skills/offbook-onboard/SKILL.md` steps 4/6 (derived: contracts > guides > skill), and the 2026-08-12 adversarial review round of commit `bffa6c1` (this file records the fixes for confirmed findings 1 and 2 only; findings 3–6 and the critic's gaps are out of scope here and have no record yet).

**Scope:** the two confirmed skill-branch findings from the 2026-08-12 adversarial review of `bffa6c1`: (1) step 6 claims bare `topics` "silently falls back" to the bundled demo spec, but the fallback is loud (it prints the "(no running offbook — showing the bundled demo spec…)" note that adoption.md §10 explicitly preserves; only the `--json` path refuses); (2) the rewritten acceptance test ("the `last` clientId is the app's") is not executable as written: `status` keeps a single last-wins connect record, no step establishes the app's clientId, and there is no remediation branch when `last` shows a foreign id.

## a — wording: how to correct "silently falls back"
Bare `topics` without a live server prints the fallback note before the demo listing (`src/cli/index.ts`, `cmdTopics`); canon already describes both paths correctly, so this is a skill-only correction.
→ Resolution: replace "silently falls back to the bundled demo spec" with the accurate "falls back to the bundled demo spec behind a printed note"; the `--json` refusal rationale stays. No allocation.

## b — shape: what makes the connect-fingerprint acceptance test executable
Options considered: identity-first (capture the app's clientId up front; unexecutable for the common generated-id case), log-first (make `offbook.log` the acceptance surface; abandons the surface adoption.md §10 designates), delta-first (read the `clients:` count before starting the app, watch it increment after, remediate via the log).
→ Resolution: delta-first. Step 6: note the `clients:` count, start the app, re-run `offbook status`; the count incrementing with `last` timestamped at app start is the signal. Step 4 additionally notes the app's clientId when the same `mqtt.connect` call that carries the broker URL sets one (bonus identification only; generated ids change per boot). Ambiguity (count jumped by more than one, or `last` shows an unrecognized id) remediates via `offbook logs`: every `[offbook] <time> ws-connect {…}` line after the last boot line is a connect, not just the last one. The zero-new-connects branch is unchanged (app "works" with no connect landing means the real backend: revisit step 4). No allocation.

## c — placement: where the refined criterion lives
The skill is derived; a refinement living only in the skill is one maintainer "simplification" away from deletion (the same drift class as the §9 `~`-expansion gap, which is out of scope here).
→ Resolution: `docs/specs/adoption.md` §10 gains one sentence after the clients-line description stating the delta form and the log fallback (rationale: the line deliberately carries only the last id). The wiring guide's first-light paragraph gains the adopter-facing counterpart (note the count before starting the app; `offbook logs` when the last id isn't yours). No interface changes, so no `D-###` allocation.

## Planned edits
1. `skills/offbook-onboard/SKILL.md` step 4: half-line, note the configured clientId while extracting the broker URL.
2. `skills/offbook-onboard/SKILL.md` step 6: corrected `--json` rationale (fork a); delta acceptance check plus the `offbook logs` remediation branch (fork b).
3. `docs/specs/adoption.md` §10: one sentence (fork c).
4. `docs/guides/wiring-your-service.md` first-light paragraph: one sentence (fork c).

## Acceptance
- `bun scripts/check-docs.ts` exit 0 (the verb gate sees the new `offbook logs` mention; `logs` is a real verb).
- Full `bun test` exit 0.
- One live walk of the rewritten step 6 in a scratch project (init → up → connect a client → delta check → violation demo): the 2026-08-12 review round's completeness critic flagged that step 6 has never been executed end-to-end, and this change rewrites it.
- Lands as a follow-up commit on `feat/skill-improvement` (branch already pushed: new commit, no force-push).
