# 2026-07-26: canonicalize param-escaping F7 identity nit (intake)
**Status**: resolved
**Owner**: nzneit

## a — Should `canonicalize` (src/engine/faker.ts) escape `&`/`=` in param values, or is documenting the limitation enough for v1?
`canonicalize` joins params as `k=v&k=v` (sorted by key, `Object.keys(params).sort().map((k) => \`${k}=${params[k]}\`).join("&")`) without escaping `&` or `=`, both of which are legal characters inside an MQTT topic-level value. Distinct param maps can therefore collide into one joined string, e.g. `{a:"x&b=y", b:"z"}` and `{a:"x", b:"y&b=z"}` both canonicalize to `"a=x&b=y&b=z"`. Because this is the shared F7 instance identity, the collision lands on both consumers that key off it: `faker.ts`'s seed string (`` `${config.seed}|${channel.topic}|${canonicalize(instanceParams)}` ``) and `instances.ts`'s InstanceRegistry ledger key (`` `${channelAddress}|${canonicalize(params)}` ``). Within the current design the collision is self-consistent — both sides conflate the two distinct param maps identically, so there is no divergence between what gets seeded and what gets materialized/ledgered — making this a latent nit rather than a live bug. Options: (1) escape `&`/`=` (and the escape character itself) when building the canonicalize key, closing the collision; (2) leave as-is and document the limitation (accepted collision risk for param values containing `&`/`=`) in contracts.md or design.md.
→ Resolution: **escape** — `canonicalize` now percent-encodes both keys and values (`encodeURIComponent`) before the sorted join, closing the collision for both consumers → allocates D-012.

Source: mutation-campaign final review, 2026-07-26.
