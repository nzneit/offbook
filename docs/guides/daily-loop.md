# The daily loop

Offbook earns its keep when it is simply *there* every time you develop —
not a tool you remember to reach for.

## Alongside your dev server

Keep the mock project in your app repo (say `mock/`), and add scripts next
to your dev entry:

```json
{
	"scripts": {
		"mock:up": "offbook up mock",
		"mock:down": "offbook down"
	}
}
```

`offbook up` is detached: run `mock:up` once in the morning; your app then
connects to `ws://localhost:9001` whenever it starts. `offbook status` tells
you what's running and on which ports.

Management verbs find the running offbook anywhere on this machine; if more
than one is running, offbook lists them and asks you to pick with
`--run-dir`. `--run-dir` and `--ctrl-port` always pin exactly.

(Instances started before this offbook build stay invisible to machine-wide
discovery until restarted, or managed once from their own directory;
`offbook doctor` notes them.)

## While developing

- `offbook validation --watch` in a spare terminal: every contract break —
  yours or the spec's — lands there the moment it happens.
- `offbook publish <topic> --example` fakes any backend emission on demand;
  `offbook scenario <name>` fires a scripted moment (device offline, error
  burst) while you watch your UI.
- `offbook reset` returns to the seeded baseline when state drifts.

## In CI

`offbook check` exits nonzero iff the client broke the contract since the
last reset — the dev-time gate, promoted:

```sh
offbook up --ci        # passive mode: no autonomous emissions
# ... run your app's integration tests against ws://localhost:9001 ...
offbook check          # fails the job on client contract breaks
offbook down
```

Scripts and CI that must pin one instance pass `--run-dir mock/.offbook` on
every verb: pinned addressing always means that one instance, on every
offbook build, and never another. Gate on the exit code (and, under `--json`,
the refusal envelope's `error.code`) rather than on refusal wording, which
can change between builds.

## When something is off

`offbook doctor` first — runtime, deps, config, spec reachability, ports,
stale state. Then `offbook diagnostics` for scenario/spec load issues, and
`offbook logs -f` to watch the server live.
