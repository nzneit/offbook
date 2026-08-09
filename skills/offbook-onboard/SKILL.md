---
name: offbook-onboard
description: Embed offbook (the MQTT-over-WebSockets mock) into this app repo — scaffold the mock project, wire the AsyncAPI spec repos, point the app at the mock, and verify first light.
---

# Onboarding offbook into this app repo

You are embedding offbook — a local dev tool that mocks this app's
MQTT-over-WebSockets backend from AsyncAPI specs — into the current repo.

**Authority chain: contracts > guides > this skill.** The offbook checkout's
`docs/specs/contracts.md` and `docs/guides/` are canonical; if this skill
disagrees with them, this skill is wrong — follow the guide and say so.

**Locating the offbook docs:** read `.installed-from` in this skill's
directory. If its `sourcePath` exists on this machine, the guides are at
`<sourcePath>/docs/guides/`. Otherwise its `originUrl` is the clone URL
(clone it, or hand the URL to the human). If neither helps, ask a teammate
for the offbook clone URL — never guess a host.

Work conversationally: one question at a time, show diffs before applying
them, and run the named verification after every step.

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
   source. Extract it behind a build-time env var per the wiring guide's
   "Point your app at offbook" section (real backend stays the default;
   `ws://localhost:9001` goes in `.env.development`). Show the human the
   full diff and get approval BEFORE applying it.
5. **Package scripts.** Add to the app's package.json, mirroring the
   daily-loop guide:
   `"mock:up": "cd mock && offbook up"`, `"mock:down": "cd mock && offbook down"`.
6. **First light.** `cd mock && offbook up`. Confirm ingestion with
   `offbook topics --json` (it refuses if no server is running here — that
   refusal means `up` failed; read its output). Start the app. **The
   acceptance test: the app's connect fingerprint appears** — `offbook
   status` shows a nonzero `clients:` count. Zero connects while the app
   works means the app is still on the real backend: revisit step 4. Then
   run `offbook validation --watch` and show the human a violation landing
   (e.g. `offbook publish <a-toClient-topic> --example` then break a field).
7. **CI (offer, optional).** The daily-loop guide's CI recipe: `offbook up
   --ci`, run the app's integration tests, `offbook check`, `offbook down`.

## Refusals you may hit

- `offbook doctor` warns the installed skill differs from the bundled one:
  run `offbook skill install --force` from the repo root to refresh it.
- `offbook up` reports ports owned by an offbook in another directory:
  run `offbook down` in that directory (likely the demo), or pass
  `--ws-port`/`--ctrl-port`.
