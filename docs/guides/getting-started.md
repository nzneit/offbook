# Getting started

You ran the README quickstart and saw the thermostat demo. This guide maps
what you saw onto the pieces you'll use with your own service, then hands
off to [wiring your service](wiring-your-service.md).

## What the demo showed

- `offbook demo --serve` booted a real MQTT broker (ws `:9001`, tcp `:1883`)
  and a control plane (`:9080`) from a bundled AsyncAPI spec plus bundled
  scenario recipes — detached, exactly like `offbook up` (`offbook status`,
  `offbook logs`, `offbook down` all work on it).
- The webapp connected over WebSockets like any client. Retained state
  painted the dashboard before anything was published; publishing
  `command/thermostat-1/set` made scenarios answer on `state/thermostat-1`.
- The break buttons produced contract violations: surfaced in the feed and
  in `offbook validation` — but still delivered. Offbook never blocks a
  message; it surfaces the break loudly. That is deliberate: the production
  broker is payload-agnostic too.

## The same, from the terminal

With the demo still up:

```sh
offbook topics        # every topic: direction, example payload
offbook state         # retained state right now
offbook publish command/thermostat-1/set --example --wait
offbook validation -v # violations, oldest first
```

`offbook topics` is the contract at a glance: "you send" topics are what your
app publishes; "you receive" topics are what the mock emits.

## Your own project

```sh
mkdir my-mock && cd my-mock
offbook init
```

`init` scaffolds `services.yaml`, `environments.yaml`, `scenarios/`, and
`handlers/`. Next: [wiring your service](wiring-your-service.md). Whenever
something misbehaves along the way: `offbook doctor`.
