# Wiring your service

Goal: `offbook up` boots a mock of **your** service from its AsyncAPI spec.
Prerequisite: `offbook init` ran in your project directory
([getting started](getting-started.md)).

## 1. Point services.yaml at the spec

```yaml
gitHost: https://git.example.com   # base URL for org/name repo slugs
services:
  my-service:
    repo: org/my-service   # slug (resolved against gitHost), full URL, or absolute path
    specPath: asyncapi.yaml
    branch: main
```

- `repo` — where the spec lives. Three forms: an `org/name` slug (joined to
  `gitHost`), a full git URL, or an absolute local path (handy for trying a
  spec you have checked out).
- `specPath` — the AsyncAPI document's path inside that repo.
- `branch` — v1 fetches branch tips (`main` if omitted).

Multiple services merge into one mock: add one entry per service.

## 2. AsyncAPI versions

offbook reads AsyncAPI **2.0.0 through 2.6.0, 3.0.0, and 3.1.0**. 3.1.0 is the recommended target for new specs. A 1.x spec is refused with a message telling you to convert it.

### If your spec is 2.x, check its perspective

AsyncAPI 2.x names operations from the point of view of your service's *counterparties*, which is the opposite of what most people assume:

- `subscribe` means **your service publishes** the message, so offbook treats it as `toClient` and mocks it for your browser app to receive.
- `publish` means **your service consumes** the message, so offbook treats it as `fromClient` and validates what your browser app sends.

That is what the specification says, and it is what the official converter does. But the convention is widely misread, and some generators grew flags (`view=provider`, `inverseOperations=true`) for specs authored the other way around. If every mocked channel points the wrong way, your spec was probably written from the client's perspective. No tool can detect this from the document, so it needs a human read.

## 3. environments.yaml (optional in v1)

```yaml
environments:
  default: {}
```

v1 records requested versions per environment but fetches branch tips; leave
it scaffolded as-is unless you already know you need it.

## 4. First `offbook up`

```sh
offbook up
offbook topics
```

`up` fetches each spec at its branch tip, records exactly what it fetched
(commit SHA + content hash) to `specs.lock`, compiles the merged contract,
and boots. `offbook topics` shows what got ingested — check the directions
("client sends" / "client receives") match your mental model before going
further.

A fetch failure aborts `up` (no half-booted mock). The error names the
service; `offbook doctor` checks all repos' reachability in one pass.

## 5. Keeping specs fresh

```sh
offbook specs          # provenance: what was fetched, when, which SHA
offbook specs update   # re-resolve branch tips + hot-swap the running mock
```

## 6. Make it answer: scenarios

An ingested spec gives you topics, retained state, and validation. To make
the mock *react* (ack commands, chain state changes), add L2 scenarios:
[scenario cookbook](scenario-cookbook.md).

## 7. Reactive-only channels

Some `toClient` channels carry events, not state: error topics,
notifications. Offbook's default floor publishes a schema-valid example
when such a channel is subscribed (so UIs render populated), but a
synthetic error can drive a stateful client into a bad state. Declare
those channels reactive-only and the floor stays off:

```yaml
services:
  my-service:
    repo: org/my-service
    specPath: asyncapi.yaml
    topicOverrides:
      "errors/{sessionId}": { initialState: false }
```

- The channel stays silent until a scenario, a handler, or `offbook
  publish` emits to it; validation is unaffected, and `offbook topics`
  marks it (`GET /v1/topics` carries `initialState: false`).
- Typos are loud: a key matching no channel address, a non-boolean
  value, or a flag on a channel with no `toClient` operation each
  surface in `offbook diagnostics`.
- A handler that defines `initialState` on a flagged channel wins — the
  contradiction is warn-logged, not silent.
- Prefer `retain: false` on flagged channels: a retained payload
  published there survives `offbook reset` (nothing overwrites it).
- On a flagged parametrized channel, the "no instances yet" diagnostic
  clears when an instance materializes even though nothing renders —
  the `initialState: false` field on `offbook topics` is the breadcrumb
  for "why is this channel quiet".
- The flag is read at `offbook up`; `offbook specs update` does not
  re-read services.yaml, so change it with a restart.
