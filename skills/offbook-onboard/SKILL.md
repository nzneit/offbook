---
name: offbook-onboard
description: Embed offbook (the MQTT-over-WebSockets mock) into this app repo — scaffold the mock project, wire the AsyncAPI spec repos, point the app at the mock, and verify first light. Use when asked to onboard, set up, or embed offbook, to mock the MQTT/AsyncAPI backend, or when onboarding stalls (doctor reports skill drift, `offbook up` hits a port conflict, the app connects zero times).
---

# Onboarding offbook into this app repo

You are embedding offbook — a local dev tool that mocks this app's
MQTT-over-WebSockets backend from AsyncAPI specs — into the current repo.

**Authority chain: contracts > guides > this skill.** The offbook checkout's
`docs/specs/contracts.md` and `docs/guides/` are canonical; if this skill
disagrees with them, this skill is wrong — follow the guide and say so.

**Locating the offbook docs:** read `.installed-from` in this skill's
directory. Its `sourcePath` may start with `~` — expand that to the home
directory before testing the path (a literal check on the `~` string
false-negatives). If the expanded path exists on this machine, the guides
are at `<sourcePath>/docs/guides/`. Otherwise its `originUrl` is the clone URL
(clone it, or hand the URL to the human). If neither helps, ask a teammate
for the offbook clone URL — never guess a host.

Work conversationally: one question at a time, show diffs before applying
them, and run the named verification after every step.

## Never

- **Never guess a git host or clone URL.** An invented host is at best a
  dead end and at worst sends internal repo paths outside the org — ask
  the human or a teammate.
- **Never edit app source without approval.** Show the full diff and get
  a yes first: the app must default to the real backend, and a silent
  edit here can quietly repoint every developer's build.
- **Never `offbook skill install --force` before the human reviews the
  drift listing.** Local edits are drift; a clean-replace destroys
  anything not yet upstreamed.

## The journey

1. **Preflight.** Run `offbook doctor`. If `offbook` is not on PATH, follow
   the install steps in the offbook checkout's README (clone, `bun install`,
   `bun link`), then re-run. Fix anything doctor flags before continuing.
2. **Interview.** For each backend service to mock, ask where its AsyncAPI
   spec lives: git host base URL, repo (slug, full URL, or absolute path),
   path to the spec file inside the repo, branch. One service at a time.
3. **Scaffold + wire.** Run `offbook init mock/`. Fill `mock/services.yaml`
   from the interview answers — the file's own comments document every
   field. After each edit run `offbook doctor mock/` until it reports ok
   (shape is checked locally; specs-reachable confirms each repo resolves).
4. **Point the app at the mock.** Find the hardcoded broker URL in the app
   source. Extract it behind a build-time env var per "Point your app at
   offbook" in the wiring guide (`wiring-your-service.md`); real backend
   stays the default; `ws://localhost:9001` goes in `.env.development`.
   Show the human the full diff and get approval BEFORE applying it.
5. **Package scripts.** Add to the app's package.json, mirroring the
   daily-loop guide (`daily-loop.md`):
   `"mock:up": "cd mock && offbook up"`, `"mock:down": "cd mock && offbook down"`.
6. **First light.** `cd mock && offbook up`. Confirm ingestion with
   `offbook topics --json` — keep the `--json`: it refuses if no server is
   running here (bare `topics` silently falls back to the bundled demo
   spec), and that refusal means `up` failed; read its output. Start the
   app. **The acceptance test: the app's connect fingerprint appears** —
   the `clients:` line of `offbook status` shows a connect whose `last`
   clientId is the app's. Check the id, not just a nonzero count: any
   stray MQTT client also counts a connect. Zero connects while the app
   works means the app is still on the real backend: revisit step 4.
   Then run `offbook validation --watch` and show the human a violation
   landing: publish a clean example (`offbook publish <topic> --example`
   on a toClient topic), then copy that topic's `example:` line from
   `offbook topics`, break one required field (delete it or wrong-type
   it), and send it with `offbook publish <topic> --payload '<json>'` — a
   violation line appears in the `--watch` terminal.
7. **CI (offer, optional).** The daily-loop guide's CI recipe: `offbook up
   --ci`, run the app's integration tests, `offbook check`, `offbook down`.

## Refusals you may hit

- `offbook doctor` warns the installed skill differs from the bundled one:
  run `offbook skill install` (no `--force`) from the repo root and show the
  human the drift listing it prints. Local edits are drift — upstream
  anything worth keeping, then re-run with `offbook skill install --force`
  only once the human approves the clean-replace.
- `offbook up` reports the control port owned by an offbook in another
  directory: the error says "another offbook owns the control port `<n>`;
  also busy: `<other labels>` — `offbook down` in that project's directory
  frees the control port; check the others separately if they persist".
