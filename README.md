# Offbook

[![ci](https://github.com/nzneit/offbook/actions/workflows/ci.yml/badge.svg)](https://github.com/nzneit/offbook/actions/workflows/ci.yml)

Mock your MQTT-over-WebSockets backend from its AsyncAPI specs — so contract
breaks and async bugs surface at dev time, not deploy time.

Offbook boots a real MQTT broker (WebSockets + TCP) that behaves like the
services your app talks to: it replays their retained state, answers commands
with spec-faithful emissions on seeded-deterministic timing, and validates
every message in both directions against the AsyncAPI contracts — surfacing
violations loudly without ever blocking delivery, exactly like the
payload-agnostic broker in production.

## Mental model

```
your app ──── ws://localhost:9001 ────► offbook broker
                                          │ specs in:  services.yaml → your git host (AsyncAPI)
                                          │ behavior:  scenarios/*.yaml (L2 recipes)
                                          ▼
                              violations & state out:
                       `offbook validation` · `offbook state` · demo app
                       control plane (HTTP): localhost:9080
```

Your app connects exactly as it would to the real backend. Offbook plays the
other side of every topic and tells you when either side breaks the contract.

## Prerequisites

- [Bun](https://bun.sh) >= 1.3 (the `engines.bun` floor in `package.json`)
- git access to the host your AsyncAPI spec repos live on
- AsyncAPI specs at **2.0.0-2.6.0, 3.0.0, or 3.1.0** (3.1.0 recommended). AsyncAPI 1.x is not supported: convert it with `asyncapi convert` first.

## Quickstart (zero config)

```sh
git clone <internal-git>/offbook && cd offbook
bun install
bun link        # puts `offbook` on your PATH (once)
```

```sh quickstart
offbook demo --serve
bun run demo-app
```

Open <http://localhost:9090>: a thermostat dashboard driven entirely by a
mocked service. Send a command and watch state chain back. Click **Break the
schema** and watch the violation land in the feed within a second.

Done? Ctrl-C the demo-app, then `offbook down`.

If anything fails: `offbook doctor` — it checks your runtime, dependencies,
config, spec reachability, and ports, and tells you the next step.

## Your own service

```sh
offbook init
# edit services.yaml — point it at your service's AsyncAPI spec repo
offbook up
```

Full walkthrough: [wiring your service](docs/guides/wiring-your-service.md).

## Commands

| lifecycle | verbs |
|-----------|-------|
| run       | `up` · `down` · `status` · `logs` · `demo` |
| observe   | `topics` · `state` · `validation` · `diagnostics` · `check` |
| interact  | `publish` · `scenario` · `scenarios` · `mode` · `reset` |
| maintain  | `init` · `specs` · `doctor` |

`offbook` with no arguments prints full usage with flags.

## Guides

- [Getting started](docs/guides/getting-started.md) — from the demo to your first real spec
- [Wiring your service](docs/guides/wiring-your-service.md) — services.yaml, environments, specs.lock
- [Scenario cookbook](docs/guides/scenario-cookbook.md) — paste-able L2 recipes
- [The daily loop](docs/guides/daily-loop.md) — offbook alongside your dev server and in CI

Contributing, or how this repo itself is organized: [AGENTS.md](AGENTS.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Maintainers

See [MAINTAINERS.md](MAINTAINERS.md). Origin and authorship:
[PROVENANCE.md](PROVENANCE.md).
