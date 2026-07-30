# Scenario cookbook

L2 scenarios make the mock *react*: files of YAML recipes in `scenarios/`,
loaded in sorted-filename order. This page is task-oriented; the format's
canonical reference is [`docs/specs/l2-scenarios.md`](../specs/l2-scenarios.md)
— if this page ever disagrees with it, this page is wrong.

The two-brace rule: single braces **capture** (`{deviceId}` in `when.topic`
binds the value), double braces **substitute** (`{{deviceId}}` writes it
back out). Delays like `50-80ms` draw from the run's seed: deterministic
per seed, never wall-clock-random.

All recipes below are written against the bundled demo spec's topics
(`state/{deviceId}`, `command/{deviceId}/set`) so they read realistically and
load clean against the cookbook gate. `offbook demo --serve` boots its own
bundled scenarios and never reads a project's `scenarios/`, though — to
actually run one of these: `offbook init`, drop the file in `scenarios/`,
then `offbook up`. Swap in your own topics and payload fields once you do.

## Ack a command

Answer any `command/{deviceId}/set` with an `accepted` state echoing the
requested target:

```yaml scenario
- name: ack-set
  when:
    topic: command/{deviceId}/set
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: accepted
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 50-80ms
```

`{{payload.target}}` reaches into the inbound message; `{{now}}` is the
seeded logical clock (a number).

## Chain state changes

`payloadMatch` narrows the trigger (subset equality, no operators); multiple
`emit` steps chain with independent delays — accepted first, then heating:

```yaml scenario
- name: chain-heat
  when:
    topic: command/{deviceId}/set
    payloadMatch: { mode: heat }
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: accepted
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 100-250ms
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: heating
          target: "{{payload.target}}"
          units: C
          updatedAt: "{{now}}"
        delay: 400-900ms
```

## A scripted moment, on demand

No `when` means nothing triggers it automatically — you fire it by name
while watching your UI (`{{deviceId}}` binds from `--param`). Loaded from
your own project's `scenarios/` (see above):

```yaml scenario
- name: device-offline
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: offline
          target: 20
          units: C
          updatedAt: "{{now}}"
```

```sh
offbook scenario device-offline --param deviceId=thermostat-1
```

## Deterministic changing values

`{{seq}}` counts per scenario (1, 2, 3, …) and `{{uuid}}` derives from the
run seed — reproducible across runs with the same seed:

```yaml scenario
- name: drifting-target
  when:
    topic: command/{deviceId}/set
    payloadMatch: { mode: cool }
  then:
    - emit:
        topic: state/{{deviceId}}
        payload:
          deviceId: "{{deviceId}}"
          status: cooling
          target: "{{seq}}"
          units: C
          updatedAt: "{{now}}"
        delay: 100-250ms
```

## Checking your work

- `offbook scenarios` — what loaded (and from which file)
- `offbook diagnostics` — load problems, param-resolvability errors
- `offbook doctor` — includes a well-formedness pass over `scenarios/`
- fire it: `offbook publish command/thermostat-1/set --payload '{"mode":"heat","target":23}' --wait`
