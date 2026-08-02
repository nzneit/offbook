# Per-Channel Initial-State Opt-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `topicOverrides.<address>.initialState: false` in services.yaml declares a reactive-only channel: the L1 proactive floor never publishes there, on any leg, while everything else (ledger, L2/L3, explicit surfaces) is untouched — with four spec-load warnings and a handler-contradiction warn-log making every misconfiguration loud.

**Architecture:** The flag rides the existing per-channel config path end to end: config loader passes it through untyped (it already does — only the type widens), the registry resolves it onto `Channel.initialState` next to `qos`/`retain` and sweeps `topicOverrides` keys for warnings, `mergeRegistries` adds the cross-service disagreement warning, the engine's single emission site (`materializeAndPublish`) gains one early return, the compose root warn-logs flag-vs-L3-handler contradictions at handler load and after every specs refresh, and the control plane exposes `initialState: false` on suppressed `TopicInfo` rows. Contracts §1/§2/§5/§6, design §7a, the wiring guide, R-040, and D-025 are amended in-repo per the doc system.

**Tech Stack:** Bun (runtime + test), TypeScript (`bun run typecheck` = `tsc --noEmit`), Biome (`bun run lint`), `bun scripts/check-docs.ts` (doc gate).

**Spec:** `docs/intake/2026-08-01-initial-state-optout.md` (approved 2026-08-01; moves to `docs/archive/intake/` in Task 10).

## Global Constraints

- Branch: all work lands on `initial-state-optout` (it already carries the intake commit `b5f5e5a`). Do not push unless asked.
- Bun is the only runtime: tests via `bun test`, scripts via `bun scripts/<file>.ts`.
- Full `bun test` is the authoritative gate, judged by **exit code**. A focused run (`bun test <one-file>`) may exit 1 with ZERO test failures because of the per-file coverage floor in `bunfig.toml`; on focused runs trust the printed fail count, gate on full runs only.
- `bun scripts/check-docs.ts` must exit 0 before every commit (it is the pre-commit gate).
- Commit exactly at the plan's commit steps, no others. Never run `git config user.*`. Do NOT add any Co-Authored-By or AI-attribution trailer to commits.
- `docs/specs/contracts.md` wins every interface conflict.
- All four new diagnostics use `kind: "spec-load"` exactly. The `Diagnostic.kind` union and `DiagnosticSummary.byKind` are closed four-value sets (`src/model/index.ts:269-285`); `diagnosticSummary` in `src/control-plane/index.ts` increments `byKind[d.kind]` and would throw on a new kind. Never invent a kind.
- `Channel.initialState` is OPTIONAL (`initialState?: boolean`): absent ⇒ the floor applies; the engine gates on `=== false` only. Never make it required — hand-built `Channel` literals in `src/engine/index.test.ts`, `src/control-plane/index.test.ts`, `test/cli-dispatch.test.ts`, and `src/compose/initial-state.test.ts` (new) omit it.
- Arrow-tag grammar is strict: `// [utest->R-040]` / `// [itest->R-040]` — exactly three digits, no spaces, inside a comment, on its own line directly above the `test(` call (or in the file header block). Malformed and dangling tags fail the gate.
- Statuses stay honest: R-040 is allocated `specified` in Task 1 and flips to `tested` only in Task 10, when every clause of its statement is covered by the named TEST traces.
- TDD per task: write the failing test first, watch it fail, implement, watch it pass.
- Never run `biome migrate`. If `bun run lint -- --write` (or any `--write`) is used, read the diff before trusting it.
- Do not modify the transport-isolation or lint-gate rules; nothing here imports `aedes` outside `src/broker/`.

## File Structure

- Modify: `REQUIREMENTS.md` (R-040 entry), `DECISIONS.md` (D-025), `docs/specs/contracts.md` (§1 `Channel`, §2 G3 policy + reset bullet + back-anchor, §5 `TopicInfo` + `/state` row + tag list, §6 `ServiceConfig`), `docs/specs/design.md` (§7a), `docs/guides/wiring-your-service.md` (new §7)
- Move: `docs/intake/2026-08-01-initial-state-optout.md` → `docs/archive/intake/` (Task 10, same commit as the status flip)
- Modify: `src/model/index.ts` (`Channel`, `ServiceConfig`, `TopicInfo`)
- Modify: `src/config/fixtures/services.yaml` (new `serviceE` entry; `serviceC` untouched)
- Modify: `src/registry/index.ts` (resolution + key sweep + `mergeRegistries` warning)
- Modify: `src/engine/index.ts` (the gate + `handlers()` accessor)
- Modify: `src/compose/index.ts` (contradiction warn-log at start + refresh)
- Modify: `src/cli/boot.ts` (F21 invariant comment only)
- Modify: `src/control-plane/index.ts` (`buildTopicInfo`), `src/cli/index.ts` (`renderTopicList` marker)
- Create: `src/compose/initial-state.test.ts` (contradiction warn-log; isolated because handler files register on the process-global `defaultDispatch`)
- Test modifications: `src/config/index.test.ts`, `src/registry/index.test.ts`, `src/engine/index.test.ts`, `src/control-plane/index.test.ts`, `src/cli/doctor.test.ts`, `test/cli-dispatch.test.ts`

---

### Task 1: Allocate R-040 (`specified`) + the contracts back-anchor

The doc gate rejects arrow tags pointing at a nonexistent UID, so R-040 must exist before any tagged test is committed. Its `COVERS` anchor must resolve at the same commit, so the additive back-anchor lands in `contracts.md` now (doc-system.md §154 explicitly blesses additive `<!-- anchor: ... -->` markers inside frozen contracts).

**Files:**
- Modify: `docs/specs/contracts.md` (one comment line above the §2 G3 bullet, ~line 127)
- Modify: `REQUIREMENTS.md` (insert entry after R-039, before the trailing `<!--` allocation comment at ~line 321)

**Interfaces:**
- Produces: UID `R-040` (STATUS `specified`, COVERS `docs/specs/contracts.md#R-040`) — every later task's test tags point at it.

- [ ] **Step 1: Add the back-anchor to contracts.md**

In `docs/specs/contracts.md`, insert one line ABOVE the G3 bullet. Edit with old_string:

```
- **`onSubscribe` & the initial-state materialization policy (G3).** Retained initial state
```

new_string:

```
<!-- anchor: R-040 -->
- **`onSubscribe` & the initial-state materialization policy (G3).** Retained initial state
```

- [ ] **Step 2: Insert the R-040 entry in REQUIREMENTS.md**

Directly after R-039's statement line (the long sentence starting `` `registry/` guards binding-supplied `qos`/`retain` values ``) and before the `<!--` comment block, insert (one blank line above and below):

```markdown
#### Per-channel initial-state opt-out (reactive-only channels)
**UID**: R-040
**STATUS**: specified
**COVERS**: docs/specs/contracts.md#R-040
`topicOverrides.<address>.initialState: false` (services.yaml) declares a reactive-only channel: the registry resolves the flag onto `Channel.initialState` (no spec-binding tier; only `false` is meaningful), the engine's L1 proactive floor skips the channel on every materialization leg (concrete subscribe, eager startup, `seedInstances`, `reset` republish) while the instance ledger, L2/L3 emissions, wildcard retained replay, and the explicit example surfaces stay untouched; an L3 `initialState` handler still wins, with a compose-root warn-log naming channel and handler re-run after a specs refresh; four `spec-load` warnings (`override-dangling-key`, `initial-state-on-from-client`, `initial-state-non-boolean`, `initial-state-cross-service`) make misconfiguration loud; `GET /v1/topics` exposes `initialState: false` on suppressed channels only.
```

- [ ] **Step 3: Run the doc gate**

Run: `bun scripts/check-docs.ts; echo "exit: $?"`
Expected: `check-docs: ok — 40 requirements, 24 decisions, 1 intake file(s).` and `exit: 0`

- [ ] **Step 4: Commit**

```bash
git add REQUIREMENTS.md docs/specs/contracts.md
git commit -m "docs: allocate R-040 — per-channel initial-state opt-out (specified)"
```

---

### Task 2: Model types + config fixture + loader passthrough test

The loader (`src/config/index.ts`) already spreads unknown keys through verbatim (`return { ...r, name } as ServiceConfig` at line 51), so NO loader code changes — only the types widen and the fixture gains a dedicated entry. Do NOT touch `serviceC` (its `topicOverrides` is exact-`toEqual`-asserted in `src/config/index.test.ts:60-63` and `:122-128`, and `serviceC`'s teaching claim is the qos/retain tiers). Do NOT touch the inline `SERVICES_YAML` constant in `src/config/index.test.ts`.

**Files:**
- Modify: `src/model/index.ts:23-33` (`Channel`), `:93` (`ServiceConfig.topicOverrides`)
- Modify: `src/config/fixtures/services.yaml` (append `serviceE`)
- Test: `src/config/index.test.ts`

**Interfaces:**
- Produces: `Channel.initialState?: boolean` (absent ⇒ floor applies); `ServiceConfig.topicOverrides?: Record<string, { qos?: 0 | 1 | 2; retain?: boolean; initialState?: boolean }>`. Every later task consumes these exact shapes.

- [ ] **Step 1: Write the failing test**

In `src/config/index.test.ts`, after the existing fixture test (~line 128), add:

```ts
// [utest->R-040]
test("loadServices carries topicOverrides.initialState through as a typed boolean (serviceE)", async () => {
	const cfg = await loadServices(`${import.meta.dir}/fixtures/services.yaml`);
	expect(cfg.services.serviceE?.topicOverrides).toEqual({
		"alerts/{deviceId}": { initialState: false },
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/config/index.test.ts`
Expected: 1 fail — `serviceE` is undefined. (Focused-run caveat: judge by the printed fail count, not the exit code.)

- [ ] **Step 3: Widen the types**

In `src/model/index.ts`, edit the `Channel` interface — old_string:

```ts
	qos?: 0 | 1 | 2;
	retain?: boolean;
	title?: string;
```

new_string:

```ts
	qos?: 0 | 1 | 2;
	retain?: boolean;
	// R-040: registry-resolved from topicOverrides.initialState ONLY (no spec-binding
	// tier); absent ⇒ the §2 initial-state floor applies; false ⇒ reactive-only channel
	initialState?: boolean;
	title?: string;
```

Then edit the `ServiceConfig.topicOverrides` line — old_string:

```ts
	topicOverrides?: Record<string, { qos?: 0 | 1 | 2; retain?: boolean }>;
```

new_string:

```ts
	topicOverrides?: Record<
		string,
		{ qos?: 0 | 1 | 2; retain?: boolean; initialState?: boolean }
	>;
```

- [ ] **Step 4: Append serviceE to the fixture**

At the end of `src/config/fixtures/services.yaml` (after the `serviceD` line), append:

```yaml
  serviceE:                                        # reactive-only declaration (R-040)
    repo: org/service-e
    specPath: asyncapi.yaml
    topicOverrides:
      alerts/{deviceId}: { initialState: false }   # the initial-state floor is off on this channel
```

- [ ] **Step 5: Run the config tests + typecheck**

Run: `bun test src/config/index.test.ts`
Expected: 0 fail (the new test passes; the two existing exact-`toEqual` serviceC tests are untouched).
Run: `bun run typecheck; echo "exit: $?"`
Expected: `exit: 0`

- [ ] **Step 6: Doc gate + commit**

Run: `bun scripts/check-docs.ts; echo "exit: $?"` — expected exit 0 (R-040 exists, so the new tag is not dangling).

```bash
git add src/model/index.ts src/config/fixtures/services.yaml src/config/index.test.ts
git commit -m "feat(model,config): topicOverrides.initialState passthrough (R-040)"
```

---

### Task 3: Registry — resolve the flag onto Channel + warnings 1–3

The resolution site is a pure lookup (`src/registry/index.ts:308`); the new key sweep after the channel loop is its loud counterpart. Warnings are one-per-key (never per-operation, so a dual-direction address cannot double-fire), pushed with the exact `binding-invalid-value` idiom: `kind: "spec-load"`, `severity: "warning"`, `detail` = `<tag>: ` + sentence, `source` = the key.

**Files:**
- Modify: `src/registry/index.ts` (resolution ~line 308-326; sweep between the loop's closing `}` ~line 327 and the `// most-specific first` comment ~line 329)
- Test: `src/registry/index.test.ts`

**Interfaces:**
- Consumes: `ServiceConfig.topicOverrides[...].initialState?: boolean`, `Channel.initialState?: boolean` (Task 2).
- Produces: resolved `channel.initialState` (boolean when the override is boolean, else undefined); diagnostics tagged `override-dangling-key:`, `initial-state-non-boolean:`, `initial-state-on-from-client:`.

- [ ] **Step 1: Write the failing tests**

In `src/registry/index.test.ts`, add (near the other R-039 inline-spec tests, ~line 599; `ServiceConfig` and `buildRegistry` are already imported):

```ts
// [utest->R-040]
test("topicOverrides.initialState resolves onto the Channel; absent stays undefined", async () => {
	const spec = `asyncapi: 2.6.0
info: { title: T, version: 1.0.0 }
channels:
  errors/{sessionId}:
    parameters:
      sessionId: { schema: { type: string } }
    subscribe:
      operationId: err
      message:
        payload: { type: object, properties: { msg: { type: string } } }
  state/{sessionId}:
    parameters:
      sessionId: { schema: { type: string } }
    subscribe:
      operationId: st
      message:
        payload: { type: object, properties: { v: { type: string } } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
		serviceConfig: {
			name: "s",
			repo: "x",
			specPath: "y",
			topicOverrides: { "errors/{sessionId}": { initialState: false } },
		},
	});
	expect(reg.match("errors/abc")?.channel.initialState).toBe(false);
	expect(reg.match("state/abc")?.channel.initialState).toBeUndefined();
	expect(reg.diagnostics()).toEqual([]);
});

// [utest->R-040]
test("a dangling topicOverrides key warns once and is otherwise ignored", async () => {
	const spec = `asyncapi: 2.6.0
info: { title: T, version: 1.0.0 }
channels:
  t/real:
    subscribe:
      operationId: s
      message:
        payload: { type: object, properties: { a: { type: string } } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
		serviceConfig: {
			name: "s",
			repo: "x",
			specPath: "y",
			topicOverrides: { "t/nope": { qos: 0, initialState: false } },
		},
	});
	const warns = reg
		.diagnostics()
		.filter((d) => d.detail.startsWith("override-dangling-key:"));
	expect(warns.length).toBe(1);
	expect(warns[0]?.severity).toBe("warning");
	expect(warns[0]?.source).toBe("t/nope");
	// dangling ⇒ ONLY the dangling warning, not the direction/type warnings too
	expect(reg.diagnostics().length).toBe(1);
});

// [utest->R-040]
test("a non-boolean initialState warns and is ignored (the floor applies)", async () => {
	const spec = `asyncapi: 2.6.0
info: { title: T, version: 1.0.0 }
channels:
  t/one:
    subscribe:
      operationId: s
      message:
        payload: { type: object, properties: { a: { type: string } } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
		serviceConfig: {
			name: "s",
			repo: "x",
			specPath: "y",
			topicOverrides: { "t/one": { initialState: "false" } },
		} as unknown as ServiceConfig,
	});
	const warns = reg
		.diagnostics()
		.filter((d) => d.detail.startsWith("initial-state-non-boolean:"));
	expect(warns.length).toBe(1);
	expect(warns[0]?.source).toBe("t/one");
	expect(reg.match("t/one")?.channel.initialState).toBeUndefined();
});

// [utest->R-040]
test("initialState:false on an address with no toClient operation warns; a dual-direction address does not", async () => {
	// v2: one channel with BOTH subscribe (toClient) and publish (fromClient)
	// operations = two Channel records sharing the address; plus a publish-only
	// (fromClient-only) channel
	const spec = `asyncapi: 2.6.0
info: { title: T, version: 1.0.0 }
channels:
  duplex/{id}:
    parameters:
      id: { schema: { type: string } }
    subscribe:
      operationId: out
      message:
        payload: { type: object, properties: { a: { type: string } } }
    publish:
      operationId: inbound
      message:
        payload: { type: object, properties: { a: { type: string } } }
  cmd/{id}:
    parameters:
      id: { schema: { type: string } }
    publish:
      operationId: cmd
      message:
        payload: { type: object, properties: { a: { type: string } } }
`;
	const reg = await buildRegistry({
		specText: spec,
		service: "s",
		config: DEFAULT_CONFIG,
		serviceConfig: {
			name: "s",
			repo: "x",
			specPath: "y",
			topicOverrides: {
				"duplex/{id}": { initialState: false },
				"cmd/{id}": { initialState: false },
			},
		},
	});
	const warns = reg
		.diagnostics()
		.filter((d) => d.detail.startsWith("initial-state-on-from-client:"));
	expect(warns.length).toBe(1);
	expect(warns[0]?.source).toBe("cmd/{id}");
	// the toClient record of the dual-direction address carries the flag
	const duplex = reg
		.channels()
		.filter((c) => c.topic === "duplex/{id}");
	expect(duplex.some((c) => c.direction === "toClient" && c.initialState === false)).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test src/registry/index.test.ts`
Expected: 4 fails (`initialState` undefined on the channel; zero diagnostics where warnings are expected). Judge by printed fail count.

- [ ] **Step 3: Implement resolution + sweep**

In `src/registry/index.ts`, edit the resolution/push block — old_string:

```ts
		const retain =
			bindingRetain ??
			override?.retain ??
			opts.serviceConfig?.retainDefault ??
			false;
		channels.push({
			topic: address,
			direction: directionOf(op.action()),
			service: opts.service,
			schema,
			validate,
			qos,
			retain,
```

new_string:

```ts
		const retain =
			bindingRetain ??
			override?.retain ??
			opts.serviceConfig?.retainDefault ??
			false;
		// R-040: initialState rides topicOverrides alone — no binding tier above
		// it, no service default below it; non-boolean values are warned by the
		// post-loop key sweep, so only a real boolean lands on the Channel
		const initialState =
			typeof override?.initialState === "boolean"
				? override.initialState
				: undefined;
		channels.push({
			topic: address,
			direction: directionOf(op.action()),
			service: opts.service,
			schema,
			validate,
			qos,
			retain,
			initialState,
```

Then insert the sweep between the channel loop's closing `}` and the ordering comment — old_string:

```ts
	// most-specific first (fewer params = more literal segments), then declaration order
```

new_string:

```ts
	// R-040: topicOverrides is a pure lookup above, so a mistyped key or value
	// is silent there — this sweep is the loud counterpart (one warning per key,
	// never per operation, so a dual-direction address cannot double-fire)
	for (const [key, value] of Object.entries(
		opts.serviceConfig?.topicOverrides ?? {},
	)) {
		const matching = channels.filter((c) => c.topic === key);
		if (matching.length === 0) {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `override-dangling-key: '${key}' matches no channel address in service '${opts.service}', so this topicOverrides entry is ignored`,
				source: key,
			});
			continue;
		}
		const raw = value.initialState;
		if (raw !== undefined && typeof raw !== "boolean") {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `initial-state-non-boolean: '${key}' topicOverrides initialState is ${JSON.stringify(raw)}; initialState MUST be a boolean, so it is ignored and the floor applies`,
				source: key,
			});
		}
		if (raw === false && !matching.some((c) => c.direction === "toClient")) {
			diagnostics.push({
				kind: "spec-load",
				severity: "warning",
				detail: `initial-state-on-from-client: '${key}' has initialState: false but no toClient operation, and the initial-state floor only runs toClient, so the flag is ignored`,
				source: key,
			});
		}
	}

	// most-specific first (fewer params = more literal segments), then declaration order
```

- [ ] **Step 4: Run to verify green, including the clean-spec guards**

Run: `bun test src/registry/index.test.ts`
Expected: 0 fail. Pay attention to the pre-existing tests `"a clean spec produces no registry diagnostics"` (thermostat.yaml, and the v2-oldest twin) and the serviceC/qos-overrides tests — the sweep must not emit anything for them (no serviceConfig ⇒ zero keys; serviceC's `telemetry/{deviceId}` key matches a channel ⇒ no dangling warning).
Run: `bun run typecheck; echo "exit: $?"` — expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/registry/index.ts src/registry/index.test.ts
git commit -m "feat(registry): resolve initialState onto Channel + the topicOverrides key sweep (R-040)"
```

---

### Task 4: `mergeRegistries` — the cross-service disagreement warning

Exact-address duplicates across services resolve by match order (fewest params first, then services.yaml key order — for identical addresses that is purely key order), so the losing record's flag is silently dead. Surface the disagreement at the only cross-service seam. `mergeRegistries` lives in `src/registry/index.ts` (~line 356); its `diagnostics()` is currently a pure flatMap.

**Files:**
- Modify: `src/registry/index.ts` (`mergeRegistries`)
- Test: `src/registry/index.test.ts`

**Interfaces:**
- Consumes: `Channel.initialState?: boolean` (Task 2), `mergeRegistries(registries: SpecRegistry[])` (existing export).
- Produces: merged-registry diagnostics additionally containing `initial-state-cross-service:`-tagged warnings.

- [ ] **Step 1: Write the failing tests**

In `src/registry/index.test.ts`, add local mini-helpers + tests (the helpers are deliberately local so this file stays self-contained; `mergeRegistries`, `Channel`, `SpecRegistry`, `Diagnostic` are importable from the existing imports — extend the import lists if a name is missing):

```ts
function mergeChan(
	topic: string,
	service: string,
	initialState?: boolean,
): Channel {
	return {
		topic,
		direction: "toClient",
		service,
		schema: {},
		validate: () => [],
		initialState,
	} as unknown as Channel;
}

function mergeReg(diags: Diagnostic[], ...channels: Channel[]): SpecRegistry {
	return {
		diagnostics: () => diags,
		channels: () => channels,
		match: () => undefined,
		matchesFilter: () => false,
	};
}

// [utest->R-040]
test("mergeRegistries warns on an exact-address initialState disagreement, naming the winning service", () => {
	const merged = mergeRegistries([
		mergeReg([], mergeChan("errors/all", "first")),
		mergeReg([], mergeChan("errors/all", "second", false)),
	]);
	const warns = merged
		.diagnostics()
		.filter((d) => d.detail.startsWith("initial-state-cross-service:"));
	expect(warns.length).toBe(1);
	expect(warns[0]?.severity).toBe("warning");
	expect(warns[0]?.source).toBe("errors/all");
	expect(warns[0]?.detail).toContain("'first'"); // the winner (earlier services.yaml key)
});

// [utest->R-040]
test("mergeRegistries: agreement, single-service duplicates, and child diagnostics pass through unwarned", () => {
	const childDiag: Diagnostic = {
		kind: "spec-load",
		severity: "warning",
		detail: "override-dangling-key: 'x' matches no channel address in service 'a', so this topicOverrides entry is ignored",
		source: "x",
	};
	const merged = mergeRegistries([
		mergeReg([childDiag], mergeChan("errors/all", "a", false)),
		mergeReg([], mergeChan("errors/all", "b", false)), // agreement: both false
		mergeReg(
			[],
			mergeChan("dup/one", "c"),
			mergeChan("dup/one", "c"), // same service twice: not cross-service
		),
	]);
	const cross = merged
		.diagnostics()
		.filter((d) => d.detail.startsWith("initial-state-cross-service:"));
	expect(cross).toEqual([]);
	expect(merged.diagnostics()).toContainEqual(childDiag);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test src/registry/index.test.ts`
Expected: first new test fails (0 warnings found). Judge by printed fail count.

- [ ] **Step 3: Implement**

In `mergeRegistries`, edit — old_string:

```ts
export function mergeRegistries(registries: SpecRegistry[]): SpecRegistry {
	const channels = registries.flatMap((r) => [...r.channels()]);
```

new_string:

```ts
export function mergeRegistries(registries: SpecRegistry[]): SpecRegistry {
	const channels = registries.flatMap((r) => [...r.channels()]);
	// R-040: an exact-address duplicate across services resolves by match order
	// (for identical addresses: services.yaml key order), so a disagreeing
	// initialState on the losing record is silently dead — surface it at the
	// only cross-service seam. Parametrized shadowing (a literal address in one
	// service shadowing a flagged {param} address in another) stays a known
	// residual, recorded in D-025.
	const crossService: Diagnostic[] = [];
	const byTopic = new Map<string, Channel[]>();
	for (const c of channels) {
		const group = byTopic.get(c.topic);
		if (group) group.push(c);
		else byTopic.set(c.topic, [c]);
	}
	for (const [topic, group] of byTopic) {
		const services = [...new Set(group.map((c) => c.service))];
		if (services.length < 2) continue;
		const stances = new Set(group.map((c) => c.initialState === false));
		if (stances.size < 2) continue;
		crossService.push({
			kind: "spec-load",
			severity: "warning",
			detail: `initial-state-cross-service: '${topic}' is declared by ${services
				.map((s) => `'${s}'`)
				.join(" and ")} with disagreeing initialState; '${group[0]?.service}' wins the match, so the other declaration is dead`,
			source: topic,
		});
	}
```

and the diagnostics member — old_string:

```ts
		diagnostics: () => registries.flatMap((r) => [...r.diagnostics()]),
```

new_string:

```ts
		diagnostics: () => [
			...registries.flatMap((r) => [...r.diagnostics()]),
			...crossService,
		],
```

If `Diagnostic` is not already imported in `src/registry/index.ts`, add it to the existing `#src/model/index.ts` type import.

- [ ] **Step 4: Run to verify green**

Run: `bun test src/registry/index.test.ts` — expected 0 fail.
Run: `bun test test/cli-dispatch.test.ts` — expected 0 fail (the existing mergeRegistries test's `regOf` returns empty diagnostics and unflagged channels; no new warning fires). Judge both by printed fail count.

- [ ] **Step 5: Commit**

```bash
git add src/registry/index.ts src/registry/index.test.ts
git commit -m "feat(registry): initial-state-cross-service warning at the merge seam (R-040)"
```

---

### Task 5: The engine gate

One early return in `materializeAndPublish` (`src/engine/index.ts:184-212`), AFTER instance recording and AFTER the L3 `initialState` dispatch block, immediately BEFORE the `l1Floor` call. That single placement silences all legs (subscribe, eager startup, `seedInstances`, reset republish — they all funnel here) while the ledger record and L3 handlers stay live.

**Files:**
- Modify: `src/engine/index.ts` (~line 203)
- Test: `src/engine/index.test.ts`

**Interfaces:**
- Consumes: `Channel.initialState?: boolean` (Task 2); test helpers `buildEngine`, `makeChannel`, `stateSchema` (existing in the test file).
- Produces: the gated floor — later tasks (compose, control plane) rely on "flagged channel emits nothing proactively".

- [ ] **Step 1: Write the failing tests**

In `src/engine/index.test.ts`, add a helper next to `makeRegistry()` and four tests:

```ts
// makeRegistry()'s state/{deviceId} channel, but declared reactive-only (R-040)
function flaggedRegistry(): SpecRegistry {
	const state = {
		...makeChannel("state/{deviceId}", stateSchema, 2, true),
		initialState: false,
	};
	return {
		diagnostics: () => [],
		match(topic: string) {
			const m = topic.match(/^state\/([^/]+)$/);
			if (m?.[1]) return { channel: state, params: { deviceId: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [state],
	};
}
```

```ts
// [utest->R-040]
test("subscribe on an initialState:false channel records the instance and emits nothing", async () => {
	const { engine, emitted, violations } = buildEngine({}, flaggedRegistry());
	engine.onSubscribe("state/d7");
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(violations).toEqual([]);
	expect(engine.instances.snapshot()).toEqual({
		instances: [
			{ channelAddress: "state/{deviceId}", params: { deviceId: "d7" } },
		],
	});
});

// [utest->R-040]
test("start(): an initialState:false literal channel is skipped by the eager sweep", async () => {
	const flagged = {
		...makeChannel("plain/topic", stateSchema, 1, true),
		initialState: false,
	};
	const reg: SpecRegistry = {
		diagnostics: () => [],
		match: (topic) =>
			topic === "plain/topic" ? { channel: flagged, params: {} } : undefined,
		matchesFilter: () => false,
		channels: () => [flagged],
	};
	const { engine, emitted } = buildEngine({}, reg);
	engine.start();
	await engine.idle();
	expect(emitted).toEqual([]);
});

// [utest->R-040]
test("start() + reset(): seeded instances on an initialState:false channel land in the ledger but never republish", async () => {
	const { engine, emitted } = buildEngine({}, flaggedRegistry(), {
		"state/{deviceId}": [{ deviceId: "d9" }],
	});
	engine.start();
	await engine.idle();
	expect(engine.instances.snapshot()).toEqual({
		instances: [
			{ channelAddress: "state/{deviceId}", params: { deviceId: "d9" } },
		],
	});
	expect(emitted).toEqual([]);
	engine.reset(undefined);
	await engine.idle();
	expect(emitted).toEqual([]);
});

// [utest->R-040]
test("an L3 initialState handler still runs on an initialState:false channel (handler wins)", async () => {
	const flagged = {
		...makeChannel("thing/{id}", { type: "object" }, 1, false),
		initialState: false,
	};
	const reg: SpecRegistry = {
		diagnostics: () => [],
		match(topic: string) {
			const m = topic.match(/^thing\/([^/]+)$/);
			if (m?.[1]) return { channel: flagged, params: { id: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [flagged],
	};
	const { engine, emitted, dispatch } = buildEngine({}, reg);
	dispatch.register(
		"thing/{id}",
		() => ({
			initialState(topic, ctx) {
				ctx.publish({ topic, payload: { marker: "authored" } });
			},
		}),
		"h.ts",
	);
	dispatch.instantiate();
	engine.onSubscribe("thing/t1");
	await engine.idle();
	expect(emitted.length).toBe(1);
	expect(emitted[0]?.payload).toEqual({ marker: "authored" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test src/engine/index.test.ts`
Expected: 3 fails (the first three tests see an unexpected L1 emission); the handler-wins test already passes (the L3 block precedes the floor today) — it is the regression guard for gate placement. Judge by printed fail count.

- [ ] **Step 3: Implement the gate**

In `src/engine/index.ts`, edit — old_string:

```ts
			// L1 is the proactive floor: keyed per instance params (F7)
			const out = await l1Floor(m.channel, (ch) => faker(ch, m.params));
```

new_string:

```ts
			// R-040: a reactive-only channel declares it has no initial state
			// (topicOverrides initialState: false) — the floor is off on every leg
			// through this function; the ledger record above, L3 initialState
			// handlers, and all L2/L3 emissions stay untouched
			if (m.channel.initialState === false) return;
			// L1 is the proactive floor: keyed per instance params (F7)
			const out = await l1Floor(m.channel, (ch) => faker(ch, m.params));
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/engine/index.test.ts` — expected 0 fail (including every pre-existing floor test: unflagged channels behave identically).

- [ ] **Step 5: Commit**

```bash
git add src/engine/index.ts src/engine/index.test.ts
git commit -m "feat(engine): initialState:false gates the L1 floor at the one emission site (R-040)"
```

---

### Task 6: `engine.handlers()` + the compose contradiction warn-log + refresh re-check

The compose root never holds the dispatch registry (the engine falls back to the `defaultDispatch` singleton), so the engine grows a read-only `handlers()` view over `dispatch.all()`. Compose warn-logs a contradiction (flag says "no initial state", a loaded handler defines one — the handler wins) after handler load in `start()` and again after every `refreshSpecs` registry hot-swap. The warning goes through the injected `log` (offbook.log via serve.ts's sink), matching the house idiom: bare sentence, single-quoted identifiers.

**Files:**
- Modify: `src/engine/index.ts` (returned engine object, next to `loadHandlers`)
- Modify: `src/compose/index.ts` (`start()` after handler load; `refreshSpecs` after the swap)
- Modify: `src/cli/boot.ts` (F21 invariant comment at the `compiled` map, ~line 42)
- Test: `src/engine/index.test.ts`, Create: `src/compose/initial-state.test.ts`

**Interfaces:**
- Consumes: `dispatch.all()` (`src/engine/dispatch.ts:100-107` — `{ handler, registration }[]`, instantiate()-gated, precedence-sorted), `Channel.initialState`, compose's `let registry` + `log`.
- Produces: `engine.handlers(): { pattern: string; modulePath: string; hasInitialState: boolean }[]`; the log line format `` channel '<pattern>' has initialState: false but handler '<modulePath>' defines initialState — the handler wins ``.

- [ ] **Step 1: Write the failing engine unit test**

In `src/engine/index.test.ts`:

```ts
// [utest->R-040]
test("engine.handlers() reports pattern, modulePath and initialState presence in precedence order", () => {
	const { engine, dispatch } = buildEngine();
	dispatch.register("state/{deviceId}", () => ({ initialState() {} }), "a.ts");
	dispatch.register("state/{deviceId}", () => ({ onInbound() {} }), "b.ts");
	dispatch.instantiate();
	expect(engine.handlers()).toEqual([
		{ pattern: "state/{deviceId}", modulePath: "a.ts", hasInitialState: true },
		{ pattern: "state/{deviceId}", modulePath: "b.ts", hasInitialState: false },
	]);
});
```

Run: `bun test src/engine/index.test.ts` — expected: 1 fail (`engine.handlers` is not a function). If TypeScript blocks the test from compiling instead, that is the same red signal.

- [ ] **Step 2: Implement `handlers()`**

In `src/engine/index.ts`, in the returned engine object, directly below the `loadHandlers` member (the block containing `async loadHandlers(dir)`), add:

```ts
		// R-040: read-only view for the compose root's contradiction warn-log —
		// which handlers exist, on which channel pattern, and whether they define
		// initialState (dispatch.all() is instantiate()-gated and precedence-sorted)
		handlers: () =>
			dispatch.all().map(({ handler, registration }) => ({
				pattern: registration.pattern,
				modulePath: registration.modulePath,
				hasInitialState: typeof handler.initialState === "function",
			})),
```

Run: `bun test src/engine/index.test.ts` — expected 0 fail. Run `bun run typecheck; echo "exit: $?"` — if the engine's public type is an explicit interface rather than inferred, add the `handlers` member there with the same shape; expected final exit 0.

- [ ] **Step 3: Write the failing compose test**

Create `src/compose/initial-state.test.ts`. Note: handler files register on the process-global `defaultDispatch` (module import is cached per absolute path), which is exactly why this test lives in its own file with its own unique temp dir and asserts only on its own `logs` array. The handler file imports the dispatch module by ABSOLUTE path (`#src/...` subpath imports do not resolve from a file outside the package root).

```ts
// R-040 — the compose-root contradiction warn-log: an L3 initialState handler
// on an initialState:false channel wins, loudly; re-checked after a specs
// refresh swaps the registry.
// [utest->R-040]
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { type Composed, compose } from "#src/compose/index.ts";
import { loadConfig } from "#src/config/index.ts";
import type { Channel, SpecRegistry } from "#src/model/index.ts";

const servers: Composed[] = [];
afterEach(async () => {
	while (servers.length) await servers.pop()?.stop();
});

function chan(topic: string, initialState?: boolean): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile({
		type: "object",
	});
	return {
		topic,
		direction: "toClient",
		service: "t",
		schema: { type: "object" },
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos: 1,
		retain: false,
		initialState,
	};
}

function regOf(...channels: Channel[]): SpecRegistry {
	return {
		diagnostics: () => [],
		channels: () => channels,
		match: (topic) => {
			const c = channels.find((ch) => ch.topic === topic);
			return c ? { channel: c, params: {} } : undefined;
		},
		matchesFilter: () => false,
	};
}

test("contradiction warn-log: fires for a flagged channel's initialState handler, stays silent otherwise, re-checks on refresh", async () => {
	const dir = mkdtempSync(join(tmpdir(), "offbook-r040-handlers-"));
	const dispatchPath = new URL("../engine/dispatch.ts", import.meta.url)
		.pathname;
	writeFileSync(
		join(dir, "10-quiet.ts"),
		[
			`import { register } from "${dispatchPath}";`,
			`register("alerts/off", () => ({ initialState() {} }));`,
			`register("alerts/on", () => ({ initialState() {} }));`,
			"",
		].join("\n"),
	);
	const logs: string[] = [];
	const server = await compose({
		config: loadConfig({
			brokerWsPort: 18120,
			brokerTcpPort: 12920,
			controlPlanePort: 18920,
		}),
		registry: regOf(chan("alerts/off"), chan("alerts/on")), // unflagged at boot
		handlersDir: dir,
		resolveSpecs: async () => ({
			registry: regOf(chan("alerts/off", false), chan("alerts/on")),
			specs: [],
		}),
		log: (l) => logs.push(l),
	});
	servers.push(server);
	await server.start();
	// boot registry is unflagged: no contradiction line
	expect(logs.filter((l) => l.includes("the handler wins"))).toEqual([]);
	// refresh swaps in the flagged registry: the re-check fires exactly once,
	// naming the flagged channel and the handler file — never the unflagged one
	await server.app.request("/v1/specs/refresh", { method: "POST" });
	const lines = logs.filter((l) => l.includes("the handler wins"));
	expect(lines.length).toBe(1);
	expect(lines[0]).toContain("'alerts/off'");
	expect(lines[0]).toContain("10-quiet.ts");
	expect(lines[0]).toContain("initialState: false");
	expect(lines.some((l) => l.includes("'alerts/on'"))).toBe(false);
});
```

Run: `bun test src/compose/initial-state.test.ts`
Expected: 1 fail — no warn line appears after refresh. (Focused-run caveat: the per-file coverage floor may force exit 1 even when this later passes; judge by the printed fail count.)

- [ ] **Step 4: Implement the compose check + boot comment**

In `src/compose/index.ts`, after the engine/runtime creation block (below the `if (parts.scenariosDir !== undefined) runtime = createScenarioRuntime({...})` statement), add:

```ts
	// R-040: config says "no initial state", the handler says otherwise — the
	// handler wins (L3 stays most-specific on every path); surface the
	// contradiction, never silently prefer either side. Pure over
	// (loaded handlers × current registry): re-run after every registry swap.
	const warnInitialStateContradictions = () => {
		for (const h of engine.handlers()) {
			if (!h.hasInitialState) continue;
			const flagged = registry
				.channels()
				.some(
					(c) =>
						c.topic === h.pattern &&
						c.direction === "toClient" &&
						c.initialState === false,
				);
			if (flagged)
				log(
					`channel '${h.pattern}' has initialState: false but handler '${h.modulePath}' defines initialState — the handler wins`,
				);
		}
	};
```

In `start()`, edit — old_string (exact: three tabs on the `if`, four on the `await`):

```ts
			if (parts.handlersDir !== undefined)
				await engine.loadHandlers(parts.handlersDir);
```

new_string appends the call after the conditional:

```ts
			if (parts.handlersDir !== undefined)
				await engine.loadHandlers(parts.handlersDir);
			warnInitialStateContradictions();
```

(The call is unconditional — with no handlers loaded, `handlers()` is empty and it is a no-op.)

In `refreshSpecs`, edit — old_string:

```ts
			const next = await parts.resolveSpecs();
			registry = next.registry; // hot-swap; F19 lazy dispatch survives it
			specs = next.specs;
			return specs;
```

new_string:

```ts
			const next = await parts.resolveSpecs();
			registry = next.registry; // hot-swap; F19 lazy dispatch survives it
			specs = next.specs;
			warnInitialStateContradictions(); // R-040: the flag set may have changed
			return specs;
```

In `src/cli/boot.ts`, edit the cache comment — old_string:

```ts
	// per-service compiled registries keyed by content-hash (the F21 skip)
```

new_string:

```ts
	// per-service compiled registries keyed by content-hash (the F21 skip).
	// R-040 invariant: the key deliberately omits ServiceConfig — safe because
	// `services` is read once at boot and immutable in-process; if services.yaml
	// ever becomes re-readable mid-process, this key must grow a config
	// fingerprint or a stale Channel.initialState is served for an unchanged spec.
```

- [ ] **Step 5: Run to verify green**

Run: `bun test src/compose/initial-state.test.ts` — expected 0 printed fails.
Run: `bun run typecheck; echo "exit: $?"` — expected exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/index.ts src/engine/index.test.ts src/compose/index.ts src/compose/initial-state.test.ts src/cli/boot.ts
git commit -m "feat(compose,engine): flag-vs-handler contradiction warn-log, re-checked on refresh (R-040)"
```

---

### Task 7: Observability — `TopicInfo.initialState`, CLI marker, retained-residue pin, doctor tolerance

`buildTopicInfo` (`src/control-plane/index.ts:94-117`) sets every field unconditionally; `undefined` serializes as absent, so `initialState: c.initialState === false ? false : undefined` gives the "present only when suppressed" contract for free, and the `?schema=false` rest-spread (`:159`) keeps it automatically. The retained-residue semantics (intake §"Retained residue and reset") is pinned here at the composed-stack level.

**Files:**
- Modify: `src/model/index.ts` (`TopicInfo`), `src/control-plane/index.ts` (`buildTopicInfo`), `src/cli/index.ts` (`renderTopicList`)
- Test: `src/control-plane/index.test.ts`, `test/cli-dispatch.test.ts`, `src/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `Channel.initialState`, control-plane test helpers `boot(n)` / `makeChannel(topic, direction, schema)` / `fakeRegistry(channels)` (existing in `src/control-plane/index.test.ts`), doctor test helpers `projectWith` / `ctxWith` / `byName` / `GOOD_REPO_ROOT` (existing in `src/cli/doctor.test.ts`).
- Produces: `TopicInfo.initialState?: false`; the human `offbook topics` marker `[no initial state]`.

- [ ] **Step 1: Write the failing control-plane tests**

In `src/control-plane/index.test.ts` (next-free `boot(n)` numbers: 20 and 21):

```ts
// [itest->R-040]
test("GET /v1/topics: initialState:false is exposed only on suppressed channels and survives ?schema=false", async () => {
	const flagged = {
		...makeChannel("quiet/errors", "toClient", { type: "object" }),
		initialState: false,
	};
	const normal = makeChannel("loud/state", "toClient", { type: "object" });
	const { req } = await boot(20, {
		registry: fakeRegistry([flagged, normal]),
		scenarios: false,
	});
	const full = (await (await req("/v1/topics")).json()) as {
		topics: Array<Record<string, unknown>>;
	};
	const quiet = full.topics.find((t) => t.topic === "quiet/errors");
	const loud = full.topics.find((t) => t.topic === "loud/state");
	expect(quiet?.initialState).toBe(false);
	expect(loud !== undefined && "initialState" in loud).toBe(false);
	const slim = (await (await req("/v1/topics?schema=false")).json()) as {
		topics: Array<Record<string, unknown>>;
	};
	expect(
		slim.topics.find((t) => t.topic === "quiet/errors")?.initialState,
	).toBe(false);
});

// [itest->R-040]
test("retained residue on an initialState:false channel survives reset and stays in /state", async () => {
	const flagged = {
		...makeChannel("quiet/errors", "toClient", { type: "object" }),
		initialState: false,
	};
	const { server, req, post } = await boot(21, {
		registry: fakeRegistry([flagged]),
		scenarios: false,
	});
	await post("/v1/publish", {
		topic: "quiet/errors",
		payload: { level: "warn" },
		retain: true,
	});
	await server.engine.idle();
	await post("/v1/reset", {});
	await server.engine.idle();
	const state = (await (await req("/v1/state")).json()) as {
		state: Array<{ topic: string; payload: unknown }>;
	};
	const entry = state.state.find((e) => e.topic === "quiet/errors");
	expect(entry?.payload).toEqual({ level: "warn" }); // NOT overwritten by a floor republish
});
```

- [ ] **Step 2: Write the failing CLI + doctor tests**

In `test/cli-dispatch.test.ts` (`renderTopicList` and `TopicInfo` are exported from `#src/cli/index.ts` / `#src/model/index.ts`; extend the imports if needed):

```ts
// [utest->R-040]
test("renderTopicList marks initialState:false channels in both views", () => {
	const t: TopicInfo = {
		topic: "alerts/x",
		direction: "toClient",
		service: "s",
		schema: {},
		initialState: false,
	};
	expect(renderTopicList([t])).toContain("[no initial state]");
	expect(renderTopicList([t], { compact: true })).toContain(
		"[no initial state]",
	);
	const plain: TopicInfo = {
		topic: "state/x",
		direction: "toClient",
		service: "s",
		schema: {},
	};
	expect(renderTopicList([plain])).not.toContain("[no initial state]");
});
```

In `src/cli/doctor.test.ts` (after the existing `project:` tests, ~line 142):

```ts
// [utest->R-040]
test("project: a services.yaml carrying topicOverrides.initialState parses clean", async () => {
	const dir = projectWith({
		"services.yaml":
			"services:\n  svc:\n    repo: org/svc\n    specPath: asyncapi.yaml\n    topicOverrides:\n      'errors/{id}': { initialState: false }\n",
	});
	const report = await runDoctor(
		ctxWith({ repoRoot: GOOD_REPO_ROOT, projectDir: dir }),
	);
	expect(byName(report, "project").status).toBe("pass");
});
```

- [ ] **Step 3: Run to verify the red set**

Run: `bun test src/control-plane/index.test.ts test/cli-dispatch.test.ts src/cli/doctor.test.ts`
Expected printed fails: the `/v1/topics` test (no `initialState` field yet — the TS build may also flag `t.initialState` until Step 4's type lands, same red signal), the renderTopicList test, and possibly the residue test if the floor overwrites (it should NOT — the Task 5 gate already skips the republish; if this test fails, STOP and diagnose before proceeding). The doctor test passes already (the loader ignores unknown keys) — it is the tolerance pin, not a change driver.

- [ ] **Step 4: Implement**

In `src/model/index.ts`, edit `TopicInfo` — old_string:

```ts
	qos?: 0 | 1 | 2;
	retain?: boolean;
}
```

(if this two-line tail is not unique, include the preceding `example?: unknown;` line in old_string) new_string:

```ts
	qos?: 0 | 1 | 2;
	retain?: boolean;
	// R-040: present ONLY when the channel declares initialState: false; absent
	// otherwise. Survives ?schema=false (that view drops `schema` alone).
	initialState?: false;
}
```

In `src/control-plane/index.ts`, edit `buildTopicInfo`'s push — old_string:

```ts
			qos: c.qos,
			retain: c.retain,
		});
```

new_string:

```ts
			qos: c.qos,
			retain: c.retain,
			// R-040: only-when-suppressed — undefined serializes as absent
			initialState: c.initialState === false ? (false as const) : undefined,
		});
```

In `src/cli/index.ts`, edit `renderTopicList` — old_string:

```ts
	if (opts.compact)
		return topics
			.map((t) => `${t.topic}  [${phraseDirection(t.direction)}]  ${t.service}`)
			.join("\n");
	return topics
		.map((t) => {
			const lines = [`${t.topic}  [${phraseDirection(t.direction)}]`];
```

new_string:

```ts
	// R-040: the human views carry the reactive-only marker; --json shows the
	// TopicInfo field itself
	const quietMark = (t: TopicInfo) =>
		t.initialState === false ? "  [no initial state]" : "";
	if (opts.compact)
		return topics
			.map(
				(t) =>
					`${t.topic}  [${phraseDirection(t.direction)}]  ${t.service}${quietMark(t)}`,
			)
			.join("\n");
	return topics
		.map((t) => {
			const lines = [
				`${t.topic}  [${phraseDirection(t.direction)}]${quietMark(t)}`,
			];
```

- [ ] **Step 5: Run to verify green**

Run: `bun test src/control-plane/index.test.ts test/cli-dispatch.test.ts src/cli/doctor.test.ts` — expected 0 printed fails across all three.
Run: `bun run typecheck; echo "exit: $?"` — expected exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/model/index.ts src/control-plane/index.ts src/control-plane/index.test.ts src/cli/index.ts test/cli-dispatch.test.ts src/cli/doctor.test.ts
git commit -m "feat(control-plane,cli): expose initialState:false on /v1/topics + the topics views; pin residue + doctor tolerance (R-040)"
```

---

### Task 8: Contracts + design amendments

Every edit below quotes the current text verbatim as old_string (source: current working tree; the §2 region was double-read — if any old_string fails to match, re-read the surrounding lines and re-anchor, never paraphrase-edit). `contracts.md` is canonical: these amendments make the shipped types legal.

**Files:**
- Modify: `docs/specs/contracts.md` (§1, §2 ×3, §5 ×3, §6), `docs/specs/design.md` (§7a ×2)

- [ ] **Step 1: §1 — `Channel` gains the field**

old_string:

```
  retain?: boolean;     // RESOLVED by the registry per the §2 precedence chain (G13)
```

new_string:

```
  retain?: boolean;     // RESOLVED by the registry per the §2 precedence chain (G13)
  initialState?: boolean; // RESOLVED by the registry from topicOverrides.initialState ONLY (no spec-binding tier; R-040/D-025) — absent ⇒ true (the §2 initial-state floor applies); false ⇒ reactive-only channel: the floor is OFF, everything else (§2 ledger, L2/L3, explicit surfaces) untouched
```

(If the exact inline spacing of the `retain?` line differs, copy it verbatim from the file first.)

- [ ] **Step 2: §2 — the G3 policy: five → six rules, the new bullet, the reset caveat**

Edit 1 — old_string: `the single owner of all five rules in this policy` → new_string: `the single owner of all six rules in this policy`

Edit 2 — insert the new bullet AFTER the `seedInstances` bullet (the line beginning `  - Optional **\`seedInstances\`**` and ending `(so onboarding isn't a blank UI).`) and BEFORE the `  - **\`reset\`**` bullet:

```
  - **`initialState: false`** — a `topicOverrides` declaration (§6) marking a **reactive-only** channel (error/notification topics: nothing to materialize): the engine still records instances per the rules above but **never publishes the L1 floor** on any leg of this policy (eager startup, concrete subscribe, `seedInstances`, `reset` republish). An L3 `initialState` handler still runs (most-specific wins), with the contradiction warn-logged. The flag gates **engine emissions only** — it neither blocks Aedes' native retained delivery nor scrubs retained residue (R-040/D-025).
```

Edit 3 — the reset bullet's tail, old_string:

```
so post-`reset` `/state` is deterministic **by construction**, not empty.
```

new_string:

```
so post-`reset` `/state` is deterministic **by construction**, not empty. (On a channel with `initialState: false` the republish is skipped, so retained residue there — an L2/L3/`/publish` retained payload — persists as-is across `reset`; R-040.)
```

- [ ] **Step 3: §5 — `TopicInfo`, the `/state` row, the tag list**

Edit 1 — `TopicInfo`, old_string:

```
interface TopicInfo { topic: string; direction: Direction; service: string;
  title?: string; description?: string; schema: object; example?: unknown; qos?: 0|1|2; retain?: boolean; }
```

new_string:

```
interface TopicInfo { topic: string; direction: Direction; service: string;
  title?: string; description?: string; schema: object; example?: unknown; qos?: 0|1|2; retain?: boolean;
  initialState?: false; }  // present ONLY when the channel declares initialState: false (§2/§6, R-040) — absent otherwise; survives ?schema=false (that view drops `schema` alone)
```

Edit 2 — the `/state` row, old_string:

```
| `GET /v1/state` | `{ state: StateEntry[] }` | lean, **concrete** topics; `?topic=` prefix filter |
```

new_string:

```
| `GET /v1/state` | `{ state: StateEntry[] }` | lean, **concrete** topics; `?topic=` prefix filter; reports Aedes' store as-is — on an `initialState: false` channel (§2) retained residue can persist across `reset` (R-040) |
```

Edit 3 — the tag enumeration, old_string:

```
//   a stable tag prefix on `detail` (the tag, then `: `, then the sentence): 'binding-on-channel',
//   'binding-invalid-value', 'binding-unknown-key', 'mqtt5-field-ignored', 'dialect-mismatch', 'schema-compile-failed'.
```

new_string:

```
//   a stable tag prefix on `detail` (the tag, then `: `, then the sentence): 'binding-on-channel',
//   'binding-invalid-value', 'binding-unknown-key', 'mqtt5-field-ignored', 'dialect-mismatch', 'schema-compile-failed',
//   'override-dangling-key', 'initial-state-on-from-client', 'initial-state-non-boolean',
//   'initial-state-cross-service' (the last four: the R-040 topicOverrides sweep + the cross-service merge check).
```

- [ ] **Step 4: §6 — `ServiceConfig.topicOverrides`**

old_string:

```
  topicOverrides?: Record<string, { qos?: 0 | 1 | 2; retain?: boolean }>;  // per-topic override — tier 2 (above the per-service default, below the spec binding); key = channel address, matched by STRING-EQUALITY against channel.topic (the {param} form) — not routed through SpecRegistry.match, not concrete topics (F14)
```

new_string:

```
  topicOverrides?: Record<string, { qos?: 0 | 1 | 2; retain?: boolean; initialState?: boolean }>;  // per-topic override — qos/retain are tier 2 (above the per-service default, below the spec binding); initialState rides the SAME map but has NO other tier (no binding above, no service default below; only `false` is meaningful — §2, R-040/D-025); key = channel address, matched by STRING-EQUALITY against channel.topic (the {param} form) — not routed through SpecRegistry.match, not concrete topics (F14)
```

- [ ] **Step 5: design.md §7a — qualify "always on" + the rationale sub-bullet**

Edit 1 — old_string:

```
- **(a · §7a) Initial state on connect — always on.** The engine
```

new_string:

```
- **(a · §7a) Initial state on connect — always on (with a per-channel opt-out, below).** The engine
```

Edit 2 — insert AFTER the `seedInstances` sub-bullet (the one beginning `  - **Optional \`seedInstances\`**` and ending `even before any subscribe or command.`) and BEFORE the `  - **\`reset\`**` sub-bullet:

```
  - **Reactive-only opt-out (`initialState: false`, R-040/D-025)**: error/notification-style `toClient` channels carry no initial state — a synthetic draw there can corrupt a stateful client, and against a real broker a subscriber to a non-retained topic hears nothing until the service publishes. "Always on" deliberately trades that fidelity for a populated first render; `topicOverrides.<address>.initialState: false` (`contracts.md` §6) restores per-channel silence where the trade is wrong. The materialization ledger and L2/L3 behavior are untouched; an L3 `initialState` handler still wins, warn-logged.
```

- [ ] **Step 6: Gate + commit**

Run: `bun scripts/check-docs.ts; echo "exit: $?"` — expected exit 0 (the `#R-040` anchor still resolves; no links changed).

```bash
git add docs/specs/contracts.md docs/specs/design.md
git commit -m "docs(specs): contracts §1/§2/§5/§6 + design §7a — initialState: false (R-040)"
```

---

### Task 9: The wiring guide section

`docs/guides/wiring-your-service.md` owns services.yaml in the adopter docs (there is no generic cookbook for config; `scenario-cookbook.md` is L2-only and its ` ```yaml scenario ` fences are EXECUTED by the cookbook gate — do not put this there). A plain ` ```yaml ` fence is inert to all doc gates except the link checker. Hard-wrap prose at ~72 columns like the rest of the guide.

**Files:**
- Modify: `docs/guides/wiring-your-service.md` (new `## 7.` section after `## 6. Make it answer: scenarios`)

- [ ] **Step 1: Append the section**

At the end of the file (after the `## 6.` section's closing line), append:

````markdown

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
- The flag is read at `offbook up`; `offbook specs update` does not
  re-read services.yaml, so change it with a restart.
````

- [ ] **Step 2: Gate + commit**

Run: `bun scripts/check-docs.ts; echo "exit: $?"` — expected exit 0 (the link gate scans guides; this section adds no links).
Run: `bun test test/guides-cookbook.test.ts test/readme-quickstart.test.ts` — expected 0 printed fails (nothing tagged `yaml scenario` / `sh quickstart` was touched).

```bash
git add docs/guides/wiring-your-service.md
git commit -m "docs(guides): wiring §7 — reactive-only channels (R-040)"
```

---

### Task 10: D-025, R-040 → tested, resolve + archive the intake, full gates

The intake checker hard-fails a `resolved` item still living in `docs/intake/`, so the status flip and the `git mv` MUST land in the same commit (house precedent: commit `c60115b`).

**Files:**
- Modify: `DECISIONS.md` (append D-025), `REQUIREMENTS.md` (R-040 STATUS/IMPL/TEST)
- Move+modify: `docs/intake/2026-08-01-initial-state-optout.md` → `docs/archive/intake/2026-08-01-initial-state-optout.md`

- [ ] **Step 1: Append D-025 to DECISIONS.md**

```markdown

### D-025: Per-channel initial-state opt-out — `topicOverrides.<address>.initialState: false`
**Date**: 2026-08-01
**What**: `ServiceConfig.topicOverrides` values grow `initialState?: boolean` (absent ⇒ true; only `false` is meaningful). The registry resolves it onto `Channel.initialState` (no spec-binding tier — the override is the field's only author), and the engine's proactive floor (`materializeAndPublish`) returns before the L1 draw when `initialState === false`, silencing every materialization leg (eager startup, concrete subscribe, `seedInstances`, `reset` republish) while the instance ledger, L2/L3 emissions, wildcard retained replay, and the explicit example surfaces (`GET /v1/topics` examples, `POST /v1/publish {example:true}`) stay untouched. An L3 `initialState` handler still wins, with a compose-root warn-log naming channel + handler, re-run after `POST /v1/specs/refresh`. Four `spec-load` warnings make misconfiguration loud: `override-dangling-key`, `initial-state-on-from-client` (address-scoped — a dual-direction address must not warn), `initial-state-non-boolean` (warn + ignore), `initial-state-cross-service` (exact-address duplicates at the merge seam). `TopicInfo.initialState?: false` appears only when suppressed; the CLI topics views carry a `[no initial state]` marker.
**Why**: Reactive-only channels (error/notification topics) have no initial state; the always-on floor emits a synthetic draw on subscribe that can drive a stateful client into a bad state — behavior a real broker (silent on subscribe for non-retained topics) would never produce. The opt-out keeps the zero-config floor as the default: a retain-keyed "faithful" default was rejected because `retain` resolves `false` at the bottom of the §2 chain, so it would silence nearly every channel out of the box. Adjacent prior art: D-009 declined a tick-varying L1 draw partly because churn "would immediately demand a quiet-toggle" — this is that toggle, per channel, for the subscribe-leg floor D-009 ratified.
**Mitigations / notes**: Retained residue is deliberately out of the flag's reach: an L2/L3/`/publish` retained payload on a flagged channel survives `reset` un-overwritten (contracts §2/§5 caveats; the wiring guide recommends `retain: false` there). The flag is boot-time-only like all of `topicOverrides` (`specs update` re-resolves from the boot-time ServiceConfig and never re-reads services.yaml; changing the flag takes a restart). The F21 compiled-registry cache key omits ServiceConfig — safe while services.yaml is read once per process; the invariant is commented at the cache site (`src/cli/boot.ts`). Parametrized cross-service shadowing (a literal address in one service shadowing a flagged `{param}` address in another) stays a known residual — the merge warning covers exact duplicates only.
**Consequences for earlier entries**: none changed — D-008 (drop-and-surface) and D-009 (no tick leg) stand untouched; this narrows where the floor runs, not how it draws or fails.
**Obligations**: if services.yaml ever becomes re-readable mid-process, grow the F21 cache key with a ServiceConfig fingerprint (see the `src/cli/boot.ts` comment).
**From**: docs/archive/intake/2026-08-01-initial-state-optout.md (design dialog + 4-lens adversarial review, 2026-08-01).
**Folds into**: docs/specs/contracts.md §1/§2/§5/§6, docs/specs/design.md §7a, docs/guides/wiring-your-service.md, REQUIREMENTS.md (R-040), src/model/index.ts, src/config/fixtures/services.yaml, src/registry/index.ts, src/engine/index.ts, src/compose/index.ts, src/control-plane/index.ts, src/cli/index.ts, src/cli/boot.ts
```

- [ ] **Step 2: Flip R-040 to tested with traces**

In `REQUIREMENTS.md`, edit the R-040 entry — old_string:

```
**STATUS**: specified
**COVERS**: docs/specs/contracts.md#R-040
```

new_string:

```
**STATUS**: tested
**COVERS**: docs/specs/contracts.md#R-040
**IMPL**: src/model/index.ts, src/registry/index.ts, src/engine/index.ts, src/compose/index.ts, src/control-plane/index.ts, src/cli/index.ts
**TEST**: src/config/index.test.ts, src/registry/index.test.ts, src/engine/index.test.ts, src/compose/initial-state.test.ts, src/control-plane/index.test.ts, src/cli/doctor.test.ts, test/cli-dispatch.test.ts
```

Every TEST file listed must contain an `R-040` arrow tag by now (Tasks 2–7 added them); the checker verifies both directions.

- [ ] **Step 3: Resolve + archive the intake item (one commit)**

In `docs/intake/2026-08-01-initial-state-optout.md`:
1. Flip `**Status**: open` → `**Status**: resolved`.
2. Under the `**Owner**:` line, add a blank line then: `Resolved 2026-08-01: allocated R-040 + D-025 in the implementation PR; contracts §1/§2/§5/§6 + design §7a amended, wiring guide §7 added.`
3. Make the allocation tails concrete: replace each `→ allocates D-025 with the implementation PR` with `→ allocated D-025`, and each `→ folds into D-025` with `→ folded into D-025`. In the "Doc impact" bullet replace `allocated with the implementation PR, which also resolves and archives this item` with `allocated (D-025, R-040)`.
4. Fix the doctor citation: replace `` `src/cli/doctor.ts:180-219` `` with `` the `project` check, `src/cli/doctor.ts:109-145` ``.
5. Move it:

```bash
git mv docs/intake/2026-08-01-initial-state-optout.md docs/archive/intake/2026-08-01-initial-state-optout.md
```

- [ ] **Step 4: Full gates, by exit code**

```bash
bun scripts/check-docs.ts; echo "check-docs: $?"
bun run lint; echo "lint: $?"
bun run typecheck; echo "typecheck: $?"
bun test; echo "test: $?"
```

Expected: all four echo `0`. `check-docs` should report 40 requirements, 25 decisions, 0 intake file(s). If `bun test` exits non-zero, read the failures — do not rationalize a non-zero exit as the coverage floor on a FULL run.

- [ ] **Step 5: Commit**

```bash
git add DECISIONS.md REQUIREMENTS.md docs/archive/intake/2026-08-01-initial-state-optout.md
git commit -m "docs: D-025 — per-channel initial-state opt-out; resolve initial-state intake (R-040 tested)"
```

---

## Deviations from the intake spec (deliberate, record-keeping)

- The intake's test plan says "fixture update (`src/config/fixtures/services.yaml`)": implemented as a NEW `serviceE` entry rather than editing `serviceC`, because `serviceC`'s override object is exact-`toEqual`-asserted in two tests and its fixture claim (the qos/retain tiers, with `alerts/{deviceId}` deliberately absent from `topicOverrides`) must stay clean per the fixture quality bar.
- The intake cites doctor at `src/cli/doctor.ts:180-219`; the services.yaml validator is actually the `project` check at `:109-145` — corrected in the archived item (Task 10). Doctor can only ever *tolerate* the key offline (it never sees specs, so dangling-key surfacing is impossible there); tolerance is pinned by test.
- The §c contradiction warning also re-runs on `POST /v1/specs/refresh` (the intake requires this) and recurs naturally on `up --watch` respawns; there is no separate in-process handler-reload trigger to build.
- Post-plan fix (toClient scoping): resolution is restricted to **toClient records only** — a fromClient record never carries `Channel.initialState` (the floor never runs there, so the field would be dead weight and a false signal), and `mergeRegistries` correspondingly groups only toClient records when hunting disagreements. Contracts §1, D-025, and R-040 carry the qualifier; the plan's Task 2/Task 3 code predates it.
- Post-plan fix (cross-service winner): Task 3's warning named `group[0]?.service` as the match winner, but `group` holds only toClient records — when a same-address **fromClient** record precedes them in merge order it wins the match instead, the engine floor never runs on that address, and every initialState declaration is dead. The warning now resolves the true winner (first same-topic record in flatMap order, any direction) and states which case applies.
