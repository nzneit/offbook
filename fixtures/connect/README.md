# fixtures/connect/

The R-007 capture artifact (demo-app.md §6 shape, §9 step 4 destination): the real
browser application's `connect()` profile as offbook's fingerprint surface saw it
during the authoritative spike runs (D-026).

**`real-client.json`** is deliberately sanitized. Deployment-specific values
(`wsUrl`, `path`, `clientIdPattern`) are private and not published: they are
`null` and listed under `redacted`; values that were not recorded during the
runs are `null` and listed under `notCaptured`. A `null` therefore never means
"the client sent nothing" — the one field where absence itself was the finding
is `auth` (no username, no password). The published facts — protocol level 4
(MQTT 3.1.1), ws transport, no auth, QoS 0/1 only with no QoS 2 use, keepalive
30 with a persistent session — are exactly the set the broker is pinned against
in `src/broker/connect-profile.test.ts`, which drives a live ws client from
this file and fails if the fixture and the listener's behavior drift apart.

If the real client's profile ever changes (auth appears, QoS 2 shows up, the
protocol level moves), re-run the capture per demo-app.md §9 and update this
fixture plus the D-026 obligations — do not hand-edit it to make a test pass.
