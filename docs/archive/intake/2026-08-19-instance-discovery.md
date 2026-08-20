# 2026-08-19: Instance discovery — manage a running offbook from any directory (intake)
**Status**: resolved
**Owner**: nzneit

Source: docs/superpowers/specs/2026-08-18-instance-discovery-design.md (rev 3 —
brainstorm + adversarial verify + 35-mode DFMEA + ergonomics critique). Closes the
archived open finding "the undocumented cwd premise"
(docs/archive/intake/2026-08-12-first-light-acceptance-fixes.md, Addendum) and the
runner-up "cwd/run-dir note in daily-loop.md (F1)"
(docs/archive/intake/2026-08-07-embedding-onboarding-review.md).

## a — server identity: launch token, host rule, GET /v1/server
Pid equality is not identity (four severity-9 DFMEA findings share that root). A
per-launch 128-bit token + os.hostname() land in the runfile and boot file; a new
/v1/server read echoes them; readiness = identity; pidAlive treats EPERM as alive.
→ Resolution: build per the spec → allocates R-044, D-032

## b — machine-local registry + shared resolver + verb policy
Pointer files (pointers, not state) under ${OFFBOOK_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/offbook}/instances/,
one guarded-mutation rule at five sites, the 10-row instance state table, the
3-stage containment tiebreak, in-band naming (M16), the refusal tables and the
0/1/2 exit-code contract, the M2–M22 message catalog.
→ Resolution: build per the spec → allocates R-045, D-032

## c — `offbook up [dir]`
Optional positional; projectDir = resolve(cwd, dir); default runDir
<projectDir>/.offbook; M2 preflight before any write; EI2 checks projectDir.
→ Resolution: build per the spec → allocates R-046

## d — derived-docs sweep
Guides + README + adoption.md §9/§10 + the onboarding skill drop the cwd premise
for management verbs; the two-sentence user model lands in daily-loop; the §10
attribution/refusal wordings are superseded; grep-driven, hit list recorded in D-032.
→ Resolution: sweep per the spec → allocates R-047

## e — scope trims (documented limitations → fast-follow stubs)
Case-alias file-identity dedupe; moved-directory naming; richer version-skew
handling; the optional TTY-only picker.
→ Resolution: deferred stubs → allocates R-048, R-049, R-050, R-051
