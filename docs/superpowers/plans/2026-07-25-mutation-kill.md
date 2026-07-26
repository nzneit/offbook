# Mutation-Kill Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the Stryker mutation report over `src/engine` from 112 undetected mutants (88 Survived, 24 NoCoverage) to 0 Survived / 0 NoCoverage, per `docs/superpowers/specs/2026-07-25-mutation-kill-design.md`.

**Architecture:** Four value-ordered buckets, one commit each: (1) cover the NoCoverage paths, (2) pin ordering/tie-break semantics, (3) structural message asserts, (4) residue triage (PRNG reference-oracle tests plus annotated equivalents), then a docs commit (D-011). Tests extend the existing per-module test files; production edits are limited to Stryker disable comments plus two pre-authorized seams (extract/export the two sort comparators) applied only if focused runs prove the behavioral tests insufficient.

**Tech Stack:** Bun test, Stryker (`@hughescr/stryker-bun-runner`), Ajv 2020, json-schema-faker 0.6.2.

## Global Constraints

- Message asserts are structural (load-bearing parts: topic, keyword, `instancePath` fallback, offending spec), never full golden prose. Exception: `canonicalize` output and the `/: keyword` detail format are pinned exactly (they are contract).
- A Stryker disable comment requires a stated reason why the mutant is **unobservable**. "Hard to kill" is not a reason.
- Never gate on single-file `bun test` runs (the per-file coverage floor exits 1 spuriously); always run the full `bun test`.
- Focused mutation runs: `nvm use default` first (puts Node 24 on PATH; Stryker's CLI cannot run under Bun), then `node_modules/.bin/stryker run --mutate 'src/engine/<file>.ts'`. A focused run still executes the full `bun test` per mutant at `concurrency: 1`; the `index.ts` runs are the slow ones (~180 mutants).
- Commits happen only on explicit user go-ahead, one per bucket. Never add Co-Authored-By or any AI-attribution trailer.
- Repo commit style: `engine: ...` for test/code commits, `docs: ...` for the ledger commit.
- All touched test files already carry their arrow-tags (`// [utest->R-###]`); no tag or `REQUIREMENTS.md` edits are needed. `prng.test.ts` is deliberately untagged and stays so.
- Test files use tabs (biome). Mirror the existing helper style in each file.

---

## Bucket 1: cover the 24 NoCoverage paths

### Task 1: Scheduler default reporter and wall-tick guards

**Files:**
- Modify: `src/engine/scheduler.test.ts` (append tests)

**Interfaces:**
- Consumes: `createScheduler(config, onTaskError?)` from `./scheduler.ts`, `loadConfig` from `../config/index.ts`.
- Produces: nothing new; kills `scheduler.ts:33-36` (NoCoverage), `:152`, `:187` (false-variant).

- [ ] **Step 1: Append three tests to `src/engine/scheduler.test.ts`**

```ts
test("default reporter: a throwing task without onTaskError surfaces via console.error and never strands idle()", async () => {
	const s = createScheduler(loadConfig({ seed: 1 })); // no onTaskError arg
	const calls: unknown[][] = [];
	const orig = console.error;
	console.error = (...args: unknown[]) => {
		calls.push(args);
	};
	try {
		s.post(() => {
			throw new Error("task boom");
		});
		await s.idle();
	} finally {
		console.error = orig;
	}
	expect(calls.length).toBe(1);
	expect(calls[0]?.[0]).toBe("[offbook] scheduler task failed:");
	expect((calls[0]?.[1] as Error).message).toBe("task boom");
	expect(s.pending()).toEqual({ scheduled: 0, settled: true });
});

test("startWallTicks is re-entrant-safe: a second call must not add a second interval", async () => {
	const config = loadConfig({ seed: 1, wallClock: true, tickIntervalMs: 20 });
	const s = createScheduler(config);
	let ticks = 0;
	s.startWallTicks(() => {
		ticks++;
	});
	s.startWallTicks(() => {
		ticks += 100; // must be ignored by the tickTimer guard
	});
	const wallStart = Date.now();
	while (ticks < 2 && Date.now() - wallStart < 1000) await Bun.sleep(5);
	s.stopTicks();
	expect(ticks).toBeGreaterThanOrEqual(2);
	expect(ticks).toBeLessThan(100); // the second ticker never fired
});

test("reset() stops a running wall ticker: nothing fires after reset", async () => {
	const config = loadConfig({ seed: 1, wallClock: true, tickIntervalMs: 10 });
	const s = createScheduler(config);
	let ticks = 0;
	s.startWallTicks(() => {
		ticks++;
	});
	const wallStart = Date.now();
	while (ticks < 1 && Date.now() - wallStart < 1000) await Bun.sleep(5);
	s.reset();
	const seen = ticks;
	await Bun.sleep(50);
	expect(ticks).toBeLessThanOrEqual(seen + 1); // tolerance for one already-queued fire; the interval itself is gone
	expect(s.now()).toBe(config.fixedEpoch);
});
```

- [ ] **Step 2: Run the full suite**

Run: `bun test`
Expected: PASS (all files; new tests green on first run — they pin existing behavior).

- [ ] **Step 3: Focused mutation run on scheduler.ts**

Run: `nvm use default` then `node_modules/.bin/stryker run --mutate 'src/engine/scheduler.ts'`
Expected: lines 33, 36, 152 no longer Survived/NoCoverage; 187's false-variant killed. Remaining scheduler survivors (69, 71, 73, 119, 170, 182, 187-true) are Bucket 2/4 business.

### Task 2: Engine wall-tick lifecycle (`startTicks`/`stopTicks`)

**Files:**
- Modify: `src/engine/index.test.ts` (append helpers + tests)

**Interfaces:**
- Consumes: existing `makeChannel`, `makeRegistry` helpers in `index.test.ts`; `createEngine`, `createDispatchRegistry`, `loadConfig`.
- Produces: `buildEngine(overrides?, registry?, seedInstances?)` and `pollUntil(cond)` helpers reused by Tasks 3, 4, 8, 12; kills `index.ts:282-291` cluster and `:287`.

- [ ] **Step 1: Append shared helpers to `src/engine/index.test.ts`** (below the existing `harness` function; later tasks use them too)

```ts
import { hashToInt, mulberry32 } from "./prng.ts";
import type { DispatchRegistry } from "./dispatch.ts";

function buildEngine(
	overrides: Parameters<typeof loadConfig>[0] = {},
	registry: SpecRegistry = makeRegistry(),
	seedInstances?: Record<string, Record<string, string>[]>,
) {
	const config = loadConfig(overrides);
	const emitted: NormalizedMessage[] = [];
	const violations: Omit<Violation, "seq" | "observedAt">[] = [];
	const dispatch = createDispatchRegistry();
	const engine = createEngine({
		config,
		broker: {
			emit: async (m) => {
				emitted.push(m);
			},
		},
		registry: () => registry,
		record: (v) => {
			violations.push(v);
			return { ...v, seq: violations.length, observedAt: "t" } as Violation;
		},
		dispatch,
		seedInstances,
	});
	return { config, engine, emitted, violations, dispatch };
}

async function pollUntil(cond: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!cond() && Date.now() - start < timeoutMs) await Bun.sleep(5);
}
```

(Adjust the import list at the top of the file: `hashToInt`/`mulberry32` from `./prng.ts`, type `DispatchRegistry` from `./dispatch.ts`.)

- [ ] **Step 2: Append the lifecycle tests**

```ts
function tickCounter(d: DispatchRegistry): () => number {
	let ticked = 0;
	d.register(
		"state/{deviceId}",
		() => ({
			tick() {
				ticked++;
			},
		}),
		"h.ts",
	);
	d.instantiate();
	return () => ticked;
}

test("startTicks in passive mode is a no-op even with wallClock on (F10)", async () => {
	const { engine, dispatch } = buildEngine({
		mode: "passive",
		wallClock: true,
		tickIntervalMs: 10,
	});
	const ticks = tickCounter(dispatch);
	engine.startTicks();
	await Bun.sleep(40);
	engine.stopTicks();
	expect(ticks()).toBe(0);
});

test("startTicks without wallClock is a no-op (virtual ticks are driven via tick())", async () => {
	const { engine, dispatch } = buildEngine({ wallClock: false, tickIntervalMs: 10 });
	const ticks = tickCounter(dispatch);
	engine.startTicks();
	await Bun.sleep(40);
	engine.stopTicks();
	expect(ticks()).toBe(0);
});

test("startTicks in autonomous wall mode fires handler ticks on real cadence; stopTicks halts them", async () => {
	const { config, engine, dispatch } = buildEngine({
		wallClock: true,
		tickIntervalMs: 10,
	});
	const ticks = tickCounter(dispatch);
	engine.startTicks();
	await pollUntil(() => ticks() >= 2);
	engine.stopTicks();
	const seen = ticks();
	expect(seen).toBeGreaterThanOrEqual(2);
	await Bun.sleep(40);
	expect(ticks()).toBeLessThanOrEqual(seen + 1); // one already-queued fire tolerated; the interval is gone
	await engine.idle();
	expect(engine.now()).toBeGreaterThanOrEqual(config.fixedEpoch + 2 * config.tickIntervalMs);
});
```

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS.

### Task 3: Tick dispatch loop (precedence order, advancing keyed index)

**Files:**
- Modify: `src/engine/index.test.ts` (append test)

**Interfaces:**
- Consumes: `buildEngine` (Task 2), `hashToInt`/`mulberry32`.
- Produces: kills `index.ts:156-163` cluster (NoCoverage) and reinforces `:277-279`.

- [ ] **Step 1: Append the test**

The third registration (`0-none.ts`, no `tick` method) sorts first and exists to kill the `handler.tick?.(...)` optional-call mutant: without `?.` the loop throws before reaching the counting handlers.

```ts
test("tick() dispatches every handler in precedence order; the tick index advances the keyed streams", async () => {
	const { config, engine, dispatch } = buildEngine({ seed: 7 });
	const calls: [string, number][] = [];
	dispatch.register("state/{deviceId}", () => ({}), "0-none.ts"); // no tick method
	dispatch.register(
		"state/{deviceId}",
		() => ({
			tick(ctx) {
				calls.push(["b-mod", ctx.random()]);
			},
		}),
		"b-mod.ts",
	);
	dispatch.register(
		"state/{deviceId}",
		() => ({
			tick(ctx) {
				calls.push(["a-mod", ctx.random()]);
			},
		}),
		"a-mod.ts",
	);
	dispatch.instantiate();
	engine.tick();
	engine.tick();
	await engine.idle();
	expect(calls.map((c) => c[0])).toEqual(["a-mod", "b-mod", "a-mod", "b-mod"]);
	// exact keyed draws: tick|<idx>|<modulePath>|<order>; a-mod registered third (order 2), b-mod second (order 1)
	const draw = (idx: number, path: string, order: number) =>
		mulberry32(hashToInt(`${config.seed}|ctx|tick|${idx}|${path}|${order}`))();
	expect(calls[0]?.[1]).toBe(draw(0, "a-mod.ts", 2));
	expect(calls[1]?.[1]).toBe(draw(0, "b-mod.ts", 1));
	expect(calls[2]?.[1]).toBe(draw(1, "a-mod.ts", 2));
	expect(calls[3]?.[1]).toBe(draw(1, "b-mod.ts", 1));
});
```

- [ ] **Step 2: Run the full suite**

Run: `bun test`
Expected: PASS. If a `draw(...)` assert fails, the key format drifted from `index.ts`'s `makeCtx`; fix the test's key string to match `index.ts:160`, never the reverse.

### Task 4: initialState-vs-floor branches, loadHandlers delegation, faker getter

**Files:**
- Modify: `src/engine/index.test.ts` (append registries + tests)

**Interfaces:**
- Consumes: `buildEngine`, `makeChannel`, `hashToInt`/`mulberry32`, type `DispatchRegistry`.
- Produces: `permissiveRegistry()` and `brokenRegistry()` helpers; kills `index.ts:177-195` (except the `:195` equivalents, annotated in Task 15), `:212`, `:291`.

- [ ] **Step 1: Append registries and tests**

```ts
function permissiveRegistry(): SpecRegistry {
	const ch = makeChannel("thing/{id}", { type: "object" }, 1, false);
	return {
		match(topic: string) {
			const m = topic.match(/^thing\/([^/]+)$/);
			if (m?.[1]) return { channel: ch, params: { id: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [ch],
	};
}

function brokenRegistry(): SpecRegistry {
	const ch = makeChannel("broken/{id}", { not: {} }, 1, true);
	return {
		match(topic: string) {
			const m = topic.match(/^broken\/([^/]+)$/);
			if (m?.[1]) return { channel: ch, params: { id: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [ch],
	};
}

test("subscribe with a registered initialState handler wins over the L1 floor and draws its keyed stream", async () => {
	const { config, engine, emitted, dispatch } = buildEngine({}, permissiveRegistry());
	let draw = -1;
	dispatch.register(
		"thing/{id}",
		() => ({
			initialState(topic, ctx) {
				draw = ctx.random();
				ctx.publish({ topic, payload: { marker: "authored" } });
			},
		}),
		"h.ts",
	);
	dispatch.instantiate();
	engine.onSubscribe("thing/t1");
	await engine.idle();
	expect(emitted.length).toBe(1);
	expect(emitted[0]?.payload).toEqual({ marker: "authored" }); // authored, not an L1 fake
	expect(draw).toBe(
		mulberry32(hashToInt(`${config.seed}|ctx|subscribe|thing/t1|h.ts|0`))(),
	);
});

test("the L1 floor on an unsatisfiable schema stays empty and surfaces the recheck violation (F5)", async () => {
	const { engine, emitted, violations } = buildEngine({}, brokenRegistry());
	engine.onSubscribe("broken/b1");
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(violations.length).toBe(1);
	expect(violations[0]?.detail).toBe("/: not"); // root instancePath "" falls back to "/"
	expect(violations[0]?.kind).toBe("schema");
	expect(violations[0]?.emitSource).toEqual({ layer: "L1" });
});

test("loadHandlers delegates to the dispatch registry and then instantiates", async () => {
	const calls: string[] = [];
	const stub: DispatchRegistry = {
		register() {},
		loadHandlers: async (dir) => {
			calls.push(`load:${dir}`);
			return ["/x/10-a.ts"];
		},
		instantiate: () => {
			calls.push("instantiate");
		},
		select: () => undefined,
		all: () => [],
	};
	const config = loadConfig({});
	const engine = createEngine({
		config,
		broker: { emit: async () => {} },
		registry: makeRegistry,
		record: (v) => ({ ...v, seq: 1, observedAt: "t" }) as Violation,
		dispatch: stub,
	});
	expect(await engine.loadHandlers("/handlers")).toEqual(["/x/10-a.ts"]);
	expect(calls).toEqual(["load:/handlers", "instantiate"]);
});

test("engine.faker exposes the seeded faker: same channel+params reproduce, output is schema-valid", async () => {
	const { engine } = buildEngine();
	const m = makeRegistry().match("state/d1");
	if (!m) throw new Error("unreachable: fixture registry always matches state/d1");
	const a = await engine.faker(m.channel, m.params);
	const b = await engine.faker(m.channel, m.params);
	expect(b).toEqual(a);
	expect(m.channel.validate(a)).toEqual([]);
});
```

- [ ] **Step 2: Run the full suite**

Run: `bun test`
Expected: PASS.

### Task 5: Bucket 1 verification and commit

- [ ] **Step 1: Focused mutation runs**

Run: `nvm use default` then:
- `node_modules/.bin/stryker run --mutate 'src/engine/index.ts'`
- (scheduler.ts already verified in Task 1 Step 3)

Expected: `index.ts` NoCoverage count drops from 20 to 0; lines 156-160, 180-195 (minus 195), 212, 282-291 report Killed/Timeout. Note any targeted line still surviving; if it is in this bucket's scope, fix the test before committing (use the mutant's replacement text from the report to see what the test missed).

- [ ] **Step 2: Full suite + doc gate**

Run: `bun test` then `bun scripts/check-docs.ts`
Expected: both green.

- [ ] **Step 3: Commit (on user go-ahead)**

```bash
git add src/engine/scheduler.test.ts src/engine/index.test.ts
git commit -m "engine: mutation-kill bucket 1 — cover wall-ticks, tick loop, initial-state branches, default reporter"
```

---

## Bucket 2: pin ordering and tie-break semantics

### Task 6: Scheduler timeline ordering

**Files:**
- Modify: `src/engine/scheduler.test.ts` (append tests)
- Modify (contingency only): `src/engine/scheduler.ts:71`

**Interfaces:**
- Consumes: `createScheduler`, `loadConfig`.
- Produces (contingency): `export function timelineOrder(a: { dueAt: number; seq: number }, b: { dueAt: number; seq: number }): number` in `scheduler.ts`.

- [ ] **Step 1: Append the behavioral tests**

```ts
test("timeline pops by dueAt: a later-scheduled earlier-due emission runs first and now() lands on the max", async () => {
	const config = loadConfig({ seed: 1 });
	const s = createScheduler(config);
	const order: string[] = [];
	s.scheduleEmit(200, () => {
		order.push("late");
	});
	s.scheduleEmit(100, () => {
		order.push("early");
	});
	await s.idle();
	expect(order).toEqual(["early", "late"]);
	expect(s.now()).toBe(config.fixedEpoch + 200);
});

test("same-dueAt emissions keep schedule order (insertion tiebreak, three-way)", async () => {
	const s = createScheduler(loadConfig({ seed: 1 }));
	const order: string[] = [];
	for (const label of ["a", "b", "c"]) {
		s.scheduleEmit(100, () => {
			order.push(label);
		});
	}
	await s.idle();
	expect(order).toEqual(["a", "b", "c"]);
});
```

- [ ] **Step 2: Run the full suite, then a focused run**

Run: `bun test` (PASS), then `nvm use default` and `node_modules/.bin/stryker run --mutate 'src/engine/scheduler.ts'`
Expected: line 71's `||`-to-`&&`, `dueAt +`, sort-removal, and arrow-to-undefined mutants report Killed. The `a.seq + b.seq` mutant and possibly the comparator-body `true` mutant may still survive: whether a constant-positive comparator reorders a pre-sorted array depends on the JS engine's sort internals, which no behavioral test can pin portably.

- [ ] **Step 3 (contingency, expected to be needed): extract the comparator**

If Step 2 leaves comparator mutants surviving, apply this seam (pre-authorized by the spec):

In `src/engine/scheduler.ts`, above `createScheduler`:

```ts
// The seeded timeline order: dueAt, then insertion seq. Exported for direct
// unit testing (mutation-kill: engine sort internals hide tie-break defects).
export function timelineOrder(
	a: { dueAt: number; seq: number },
	b: { dueAt: number; seq: number },
): number {
	return a.dueAt - b.dueAt || a.seq - b.seq;
}
```

Replace line 71's `timeline.sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);` with `timeline.sort(timelineOrder);`.

Append to `scheduler.test.ts` (add `timelineOrder` to the import from `./scheduler.ts`):

```ts
test("timelineOrder: dueAt dominates; insertion seq breaks ties, in both directions", () => {
	expect(timelineOrder({ dueAt: 1, seq: 9 }, { dueAt: 2, seq: 0 })).toBeLessThan(0);
	expect(timelineOrder({ dueAt: 2, seq: 0 }, { dueAt: 1, seq: 9 })).toBeGreaterThan(0);
	expect(timelineOrder({ dueAt: 5, seq: 1 }, { dueAt: 5, seq: 2 })).toBeLessThan(0);
	expect(timelineOrder({ dueAt: 5, seq: 2 }, { dueAt: 5, seq: 1 })).toBeGreaterThan(0);
	expect(timelineOrder({ dueAt: 5, seq: 3 }, { dueAt: 5, seq: 3 })).toBe(0);
});
```

- [ ] **Step 4: Re-verify**

Run: `bun test`, then the focused scheduler run again.
Expected: all line-71 comparator mutants Killed. Remaining scheduler survivors are exactly the Task 15 annotation list (69, 73, 119, 170, 182, 187-true).

### Task 7: Dispatch precedence and module-path stamping

**Files:**
- Modify: `src/engine/dispatch.test.ts` (append tests)
- Modify (contingency only): `src/engine/dispatch.ts:38-44`

**Interfaces:**
- Consumes: `createDispatchRegistry`, `defaultDispatch`, `stubRegistry` (already in the test file), `Registration` type.
- Produces (contingency): `export function precedence(a: Registration, b: Registration): number` in `dispatch.ts` (moved out of the closure; it reads only its arguments).

- [ ] **Step 1: Append the behavioral tests**

```ts
test("all() returns the full precedence sequence: sorted module path, then registration order within a module", () => {
	const d = createDispatchRegistry();
	d.register("p", () => ({}), "z.ts"); // order 0
	d.register("p", () => ({}), "a.ts"); // order 1
	d.register("p", () => ({}), "m.ts"); // order 2
	d.register("p", () => ({}), "a.ts"); // order 3
	d.register("p", () => ({}), "z.ts"); // order 4
	d.instantiate();
	expect(
		d.all().map((x) => [x.registration.modulePath, x.registration.order]),
	).toEqual([
		["a.ts", 1],
		["a.ts", 3],
		["m.ts", 2],
		["z.ts", 0],
		["z.ts", 4],
	]);
});

test("select before instantiate() returns undefined, never a registration without an instance", () => {
	const d = createDispatchRegistry();
	d.register("command/{deviceId}/set", () => ({}), "m.ts");
	expect(d.select("command/x/set", stubRegistry)).toBeUndefined();
});

test("a fresh registry stamps direct registrations with the '' sentinel, which wins precedence by code unit", () => {
	const d = createDispatchRegistry();
	d.register("command/{deviceId}/set", () => ({}), "z.ts");
	d.register("command/{deviceId}/set", () => ({})); // no modulePath: the sentinel
	d.instantiate();
	const sel = d.select("command/x/set", stubRegistry);
	expect(sel?.registration.modulePath).toBe("");
});

test("after loadHandlers, importingPath resets: a direct register() gets the '' sentinel again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "offbook-handlers-reset-"));
	const dispatchPath = join(import.meta.dir, "dispatch.ts");
	writeFileSync(
		join(dir, "mod.ts"),
		`import { register } from ${JSON.stringify(dispatchPath)};
register("task7/{x}", () => ({}));`,
	);
	await defaultDispatch.loadHandlers(dir);
	defaultDispatch.register("task7/{x}", () => ({}));
	defaultDispatch.instantiate();
	const paths = defaultDispatch
		.all()
		.filter((x) => x.registration.pattern === "task7/{x}")
		.map((x) => x.registration.modulePath);
	expect(paths.length).toBe(2);
	expect(paths[0]).toBe(""); // sentinel sorts first and is exactly ""
	expect(paths[1]?.endsWith("mod.ts")).toBe(true);
});
```

(Uses the `mkdtempSync`/`writeFileSync`/`tmpdir`/`join` imports already present in `dispatch.test.ts`. The unique `task7/{x}` pattern keeps the process-singleton `defaultDispatch` clean of cross-test interference.)

- [ ] **Step 2: Run the full suite, then a focused run**

Run: `bun test` (PASS), then `nvm use default` and `node_modules/.bin/stryker run --mutate 'src/engine/dispatch.ts'`
Expected: lines 36, 65, 66, 89, 94, and the `>`-to-`false` / `<`-to-`false` conditional mutants Killed. The equality mutants (`>=`, `<=`) and `a.order + b.order` may survive for the same sort-internals reason as Task 6.

- [ ] **Step 3 (contingency, expected to be needed): export the comparator**

Move `precedence` out of the `createDispatchRegistry` closure (it captures nothing) and export it, keeping the code-unit comment:

```ts
// code-unit comparison, NOT localeCompare: precedence must be identical
// across machines/ICU builds and consistent with loadHandlers' path sort.
// Exported for direct unit testing (mutation-kill: engine sort internals
// hide tie-break defects behind stable-sort no-swaps).
export function precedence(a: Registration, b: Registration): number {
	if (a.modulePath < b.modulePath) return -1;
	if (a.modulePath > b.modulePath) return 1;
	return a.order - b.order;
}
```

Append to `dispatch.test.ts` (add `precedence` and type `Registration` to the imports from `./dispatch.ts`):

```ts
function reg(modulePath: string, order: number): Registration {
	return { pattern: "p", factory: () => ({}), modulePath, order };
}

test("precedence: module path dominates by code unit; registration order breaks ties, both directions", () => {
	expect(precedence(reg("a.ts", 9), reg("z.ts", 0))).toBeLessThan(0);
	expect(precedence(reg("z.ts", 0), reg("a.ts", 9))).toBeGreaterThan(0);
	expect(precedence(reg("m.ts", 1), reg("m.ts", 2))).toBeLessThan(0);
	expect(precedence(reg("m.ts", 2), reg("m.ts", 1))).toBeGreaterThan(0);
	expect(precedence(reg("B.ts", 0), reg("a.ts", 0))).toBeLessThan(0); // code units, not locale
});
```

- [ ] **Step 4: Re-verify**

Run: `bun test`, then the focused dispatch run again.
Expected: all comparator mutants Killed; the only dispatch survivor left is line 87 (Task 15 annotation).

### Task 8: Passive guard detail and inbound-dispatch guards

**Files:**
- Modify: `src/engine/index.test.ts` (append tests)

**Interfaces:**
- Consumes: `buildEngine` (Task 2).
- Produces: kills `index.ts:261` (both optional-chain mutants), `:277-279`, and the wildcard-level mutant at `:58`.

- [ ] **Step 1: Append the tests**

```ts
test("tick() in autonomous mode advances the clock and ticks handlers; in passive mode neither happens", async () => {
	const active = buildEngine({ seed: 1 });
	const activeTicks = tickCounter(active.dispatch);
	active.engine.tick();
	await active.engine.idle();
	expect(activeTicks()).toBe(1);
	expect(active.engine.now()).toBe(active.config.fixedEpoch + active.config.tickIntervalMs);

	const passive = buildEngine({ seed: 1, mode: "passive" });
	const passiveTicks = tickCounter(passive.dispatch);
	passive.engine.tick();
	await passive.engine.idle();
	expect(passiveTicks()).toBe(0);
	expect(passive.engine.now()).toBe(passive.config.fixedEpoch);
});

test("inbound with no registration, or a handler without onInbound, is a silent no-op, never a crash", async () => {
	const errors: unknown[][] = [];
	const orig = console.error;
	console.error = (...a: unknown[]) => {
		errors.push(a);
	};
	try {
		const bare = buildEngine(); // no registrations at all
		bare.engine.onInbound({
			message: { topic: "state/d1", payload: { status: "ok" } },
			meta: { clientId: "c", seq: 1, receivedAt: 0 },
		});
		await bare.engine.idle();

		const tickOnly = buildEngine(); // matched registration, but no onInbound method
		tickOnly.dispatch.register("state/{deviceId}", () => ({ tick() {} }), "h.ts");
		tickOnly.dispatch.instantiate();
		tickOnly.engine.onInbound({
			message: { topic: "state/d1", payload: { status: "ok" } },
			meta: { clientId: "c", seq: 1, receivedAt: 0 },
		});
		await tickOnly.engine.idle();

		expect(bare.emitted).toEqual([]);
		expect(tickOnly.emitted).toEqual([]);
	} finally {
		console.error = orig;
	}
	expect(errors).toEqual([]); // neither path threw inside the scheduler task
});

test("a '+' inside a topic level is not a wildcard: the subscribe materializes (level-exact detection)", async () => {
	const { engine, emitted } = buildEngine();
	engine.onSubscribe("state/x+y");
	await engine.idle();
	expect(emitted.length).toBe(1);
	expect(engine.instances.snapshot()).toEqual({
		instances: [{ channelAddress: "state/{deviceId}", params: { deviceId: "x+y" } }],
	});
});
```

(`tickCounter` is defined in Task 2's code. If Task 2 placed it inside a test, hoist it to file scope; the code block in Task 2 already shows it at file scope.)

- [ ] **Step 2: Run the full suite**

Run: `bun test`
Expected: PASS.

### Task 9: Bucket 2 verification and commit

- [ ] **Step 1: Focused runs on the three touched sources**

Run: `nvm use default`, then `node_modules/.bin/stryker run --mutate 'src/engine/scheduler.ts'`, `--mutate 'src/engine/dispatch.ts'`, `--mutate 'src/engine/index.ts'` (three runs).
Expected: only the Task 15 annotation list and Bucket 3/4 targets remain undetected in these files.

- [ ] **Step 2: Full suite + doc gate**

Run: `bun test` then `bun scripts/check-docs.ts`
Expected: both green.

- [ ] **Step 3: Commit (on user go-ahead)**

```bash
git add src/engine/scheduler.test.ts src/engine/dispatch.test.ts src/engine/index.test.ts src/engine/scheduler.ts src/engine/dispatch.ts
git commit -m "engine: mutation-kill bucket 2 — pin timeline and precedence tie-breaks, dispatch guards"
```

(Drop the two `.ts` source files from `git add` if their contingency steps turned out unnecessary.)

---

## Bucket 3: structural message asserts

### Task 10: resolve-emit messages and boundary arithmetic

**Files:**
- Modify: `src/engine/resolve-emit.test.ts` (append tests)

**Interfaces:**
- Consumes: `parseDelay`, `resolveEmit`, the file's existing `channel()` helper and `key` const.
- Produces: kills `resolve-emit.ts:27, 29, 34, 35, 41, 54, 58`.

- [ ] **Step 1: Append the tests**

```ts
test("parseDelay errors name the offending spec and which rule broke", () => {
	const config = loadConfig({ seed: 7 });
	expect(() => parseDelay("soon", config, key)).toThrow(/malformed delay "soon"/);
	expect(() => parseDelay("soon", config, key)).toThrow(/<min>-<max>ms\|s/);
	expect(() => parseDelay("5-3ms", config, key)).toThrow(/malformed delay "5-3ms"/);
	expect(() => parseDelay("5-3ms", config, key)).toThrow(/min > max/);
});

test("degenerate range 'n-nms' is valid and returns exactly n (inclusive-range arithmetic)", () => {
	expect(parseDelay("5-5ms", loadConfig({ seed: 7 }), key)).toBe(5);
});

test("ranged seconds convert before the bounds check: '1-2s' draws in [1000, 2000]", () => {
	const d = parseDelay("1-2s", loadConfig({ seed: 7 }), key);
	expect(d).toBeGreaterThanOrEqual(1000);
	expect(d).toBeLessThanOrEqual(2000);
});

test("resolveEmit guard errors say which contract broke", () => {
	expect(() =>
		resolveEmit(
			{ topic: "t", payload: {}, delay: "10ms", delayMs: 5 },
			channel(),
			loadConfig(),
			key,
		),
	).toThrow(/both delay and delayMs/);
	expect(() =>
		resolveEmit({ topic: "t", payload: {}, delay: "10ms" }, channel(), loadConfig()),
	).toThrow(/requires a scenario delayKey/);
});
```

Why these kill: the `5-5ms` case turns `max - min + 1` into `floor(draw * -1) = -1` (returns 4, not 5) under the `- 1` mutant and throws under the `max <= min` mutant; `1-2s` under the `/ unit` mutant computes `max = 0.002 < min` and throws; the message regexes catch the `""`/backtick literals and the guard-removal TypeError.

- [ ] **Step 2: Run the full suite**

Run: `bun test`
Expected: PASS. If the `5-5ms` assert sees 4, the mutant arithmetic is in the shipped code, which would be a real bug: stop and report instead of adjusting the test.

### Task 11: faker messages, canonicalize, seed key, JSF options

**Files:**
- Modify: `src/engine/faker.test.ts` (append helpers + tests)

**Interfaces:**
- Consumes: `createFaker`, `l1Floor`, `canonicalize` (add to the import from `./faker.ts`), `loadConfig`, types `Channel`/`SchemaError`.
- Produces: kills `faker.ts:10, 14, 23, 24, 51, 68, 71, 83` (minus the two OptionalChaining equivalents, Task 15); attempts `:25`.

- [ ] **Step 1: Append helpers and tests**

```ts
function rawChannel(
	topic: string,
	schema: object,
	validate: Channel["validate"] = () => [],
): Channel {
	return { topic, direction: "toClient", service: "t", schema, validate, qos: 1, retain: false };
}

const schemaError = (instancePath: string, keyword: string): SchemaError => ({
	instancePath,
	keyword,
	schemaPath: "#",
	params: {},
});

test("canonicalize is the exact F7 identity string: '' for absent/empty, sorted k=v&k=v otherwise", () => {
	expect(canonicalize(undefined)).toBe("");
	expect(canonicalize({})).toBe("");
	expect(canonicalize({ b: "2", a: "1" })).toBe("a=1&b=2");
});

test("the faker seed key is (config.seed, channel address, canonical params): each axis shifts the draw", async () => {
	const intSchema = { type: "integer", minimum: 0, maximum: 1_000_000 };
	const faker = createFaker(loadConfig({ seed: 7 }));
	const base = await faker(rawChannel("a/{id}", intSchema), { id: "1" });
	expect(await faker(rawChannel("a/{id}", intSchema), { id: "1" })).toEqual(base);
	expect(await faker(rawChannel("b/{id}", intSchema), { id: "1" })).not.toEqual(base);
	expect(await faker(rawChannel("a/{id}", intSchema), { id: "2" })).not.toEqual(base);
	expect(
		await createFaker(loadConfig({ seed: 8 }))(rawChannel("a/{id}", intSchema), { id: "1" }),
	).not.toEqual(base);
});

test("l1Floor formats the recheck detail from the first error: root '' falls back to '/', nested path verbatim", async () => {
	const root = await l1Floor(
		rawChannel("t/{x}", { type: "object" }, () => [schemaError("", "not")]),
		async () => ({}),
	);
	expect("violation" in root).toBe(true);
	if ("violation" in root) {
		expect(root.violation.detail).toBe("/: not");
		expect(root.violation.topic).toBe("t/{x}");
		expect(root.violation.channel).toBe("t/{x}");
		expect(root.violation.errors).toEqual([schemaError("", "not")]);
		expect(root.violation.payload).toEqual({});
	}
	const nested = await l1Floor(
		rawChannel("t/{x}", { type: "object" }, () => [schemaError("/x", "maximum")]),
		async () => ({}),
	);
	if ("violation" in nested) expect(nested.violation.detail).toBe("/x: maximum");
});

test("a rejecting faker surfaces 'faker rejected: <original message>'", async () => {
	const out = await l1Floor(rawChannel("t/{x}", { type: "object" }), async () => {
		throw new Error("nope");
	});
	expect("violation" in out).toBe(true);
	if ("violation" in out) expect(out.violation.detail).toBe("faker rejected: nope");
});

test("alwaysFakeOptionals: every optional property is present in the draw", async () => {
	const props: Record<string, object> = {};
	for (const k of ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"])
		props[k] = { type: "integer" };
	const faker = createFaker(loadConfig({ seed: 7 }));
	const out = await faker(
		rawChannel("o/{id}", {
			type: "object",
			properties: props,
			required: [],
			additionalProperties: false,
		}),
	);
	expect(Object.keys(out as object).sort()).toEqual([
		"p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8",
	]);
});

test("failOnInvalidTypes stays off: an unknown schema type must not reject the draw", async () => {
	const faker = createFaker(loadConfig({ seed: 7 }));
	const outcome = await faker(rawChannel("f/{id}", { type: "file" })).then(
		() => "resolved",
		(e) => `threw: ${e}`,
	);
	expect(outcome).toBe("resolved");
});
```

- [ ] **Step 2: Run the full suite**

Run: `bun test`
Expected: PASS. If the `failOnInvalidTypes` test fails on the ORIGINAL code (JSF rejecting `type: "file"` even with the flag off), delete that test and instead annotate `faker.ts:25` in Task 15 with: flag unobservable, JSF 0.6.2 rejects unknown types regardless.

- [ ] **Step 3: Focused run**

Run: `nvm use default` then `node_modules/.bin/stryker run --mutate 'src/engine/faker.ts'`
Expected: only `faker.ts:83`'s two OptionalChaining mutants (and possibly `:25` per Step 2) remain, for Task 15.

### Task 12: Engine emit-path details, ledger exactness, seedInstances

**Files:**
- Modify: `src/engine/index.test.ts` (append tests; extend two existing tests' asserts)

**Interfaces:**
- Consumes: `buildEngine`, `permissiveRegistry` (Task 4), `makeChannel`, `hashToInt`/`mulberry32`.
- Produces: kills `index.ts:58, 97, 99, 104, 119, 121, 131, 134` (minus OptionalChaining equivalents), `:150, 152, 177, 204, 230-243`.

- [ ] **Step 1: Extend two existing tests with detail asserts**

In `"unmatched mock topic: surfaced as unknown-topic ..."` (index.test.ts:132), append after the existing asserts:

```ts
	expect(violations[0]?.detail).toBe("unknown-topic: mock emit matches no channel");
	expect(violations[0]?.topic).toBe("no/such/topic");
	expect(violations[0]?.payload).toEqual({ a: 1 });
```

In `"R-013/G10: an off-spec L2-sourced emit drops ..."` (index.test.ts:94), append:

```ts
	expect(v?.detail).toBe("/status: enum"); // nested instancePath verbatim, Ajv keyword
	expect(v?.topic).toBe("state/d1");
	expect(v?.channel).toBe("state/{deviceId}");
```

- [ ] **Step 2: Append the new tests**

```ts
function literalRegistry(): SpecRegistry {
	const ch = makeChannel("plain/topic", { type: "object" }, 1, false);
	return {
		match: (topic: string) =>
			topic === "plain/topic" ? { channel: ch, params: {} } : undefined,
		matchesFilter: () => false,
		channels: () => [ch],
	};
}

test("a wrong-typed mock payload surfaces the root-path fallback in the detail", async () => {
	const { engine, violations } = buildEngine();
	engine.publish({ topic: "state/d1", payload: 42 }, { layer: "L3" });
	await engine.idle();
	expect(violations[0]?.detail).toBe("/: type");
	expect(violations[0]?.channel).toBe("state/{deviceId}");
	expect(violations[0]?.topic).toBe("state/d1");
});

test("a delayed unknown-topic emit still schedules at its delay (the ?? 0 fallback is nullish, not falsy)", async () => {
	const { config, engine, emitted } = buildEngine();
	engine.publish({ topic: "no/such/topic", payload: { a: 1 }, delayMs: 120 }, { layer: "L3" });
	await engine.idle();
	expect(emitted.length).toBe(1);
	expect(engine.now()).toBe(config.fixedEpoch + 120);
});

test("an L2 ranged delay advances now() by the exact keyed draw (config.seed reaches the choke-point intact)", async () => {
	const { config, engine, emitted } = buildEngine({ seed: 7 });
	const key = { scenarioName: "warm-up", stepIndex: 3 };
	engine.publish(
		{ topic: "state/d1", payload: { status: "ok" }, delay: "150-300ms" },
		{ layer: "L2", ...key },
		key,
	);
	await engine.idle();
	const draw = mulberry32(hashToInt(`${config.seed}|delay|warm-up|3`))();
	expect(emitted.length).toBe(1);
	expect(engine.now()).toBe(config.fixedEpoch + 150 + Math.floor(draw * 151));
});

test("ctx.publish stamps L3 and ctx.now() reads the logical clock", async () => {
	const { config, engine, violations, dispatch } = buildEngine();
	let sawNow = -1;
	dispatch.register(
		"state/{deviceId}",
		() => ({
			onInbound(_e, ctx) {
				sawNow = ctx.now();
				ctx.publish({ topic: "state/d1", payload: { status: "BOGUS" } }); // off-spec on purpose
			},
		}),
		"h.ts",
	);
	dispatch.instantiate();
	engine.onInbound({
		message: { topic: "state/d1", payload: { status: "ok" } },
		meta: { clientId: "c", seq: 1, receivedAt: 0 },
	});
	await engine.idle();
	expect(sawNow).toBe(config.fixedEpoch);
	expect(violations[0]?.emitSource).toEqual({ layer: "L3" });
	expect(violations[0]?.detail).toBe("/status: enum");
});

test("materialization rule (ii) is exact: a parametrized mock emit records its instance, nothing else", async () => {
	const { engine } = buildEngine();
	engine.publish({ topic: "state/d4", payload: { status: "ok" } }, { layer: "L3" });
	await engine.idle();
	expect(engine.instances.snapshot()).toEqual({
		instances: [{ channelAddress: "state/{deviceId}", params: { deviceId: "d4" } }],
	});
});

test("a non-parametrized mock emit never invents a ledger instance", async () => {
	const { engine, emitted } = buildEngine({}, literalRegistry());
	engine.publish({ topic: "plain/topic", payload: {} }, { layer: "L3" });
	await engine.idle();
	expect(emitted.length).toBe(1);
	expect(engine.instances.snapshot()).toEqual({ instances: [] });
});

test("a concrete parametrized subscribe records exactly its instance in the ledger", async () => {
	const { engine } = buildEngine();
	engine.onSubscribe("state/d5");
	await engine.idle();
	expect(engine.instances.snapshot()).toEqual({
		instances: [{ channelAddress: "state/{deviceId}", params: { deviceId: "d5" } }],
	});
});

test("start() with no seeds: a {param} address is never eagerly republished as a literal topic", async () => {
	const { engine, emitted } = buildEngine();
	engine.start();
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(engine.instances.snapshot()).toEqual({ instances: [] });
});

test("start(): a resolvable parametrized seed entry lands in the ledger and republishes its initial state", async () => {
	const { engine, emitted } = buildEngine({}, makeRegistry(), {
		"state/{deviceId}": [{ deviceId: "d9" }],
	});
	engine.start();
	await engine.idle();
	expect(engine.instances.snapshot()).toEqual({
		instances: [{ channelAddress: "state/{deviceId}", params: { deviceId: "d9" } }],
	});
	expect(emitted.length).toBe(1);
	expect(emitted[0]?.topic).toBe("state/d9");
});

test("start(): a resolvable non-parametrized seed entry does not invent a ledger instance", async () => {
	const { engine, emitted } = buildEngine({}, literalRegistry(), {
		"plain/topic": [{}],
	});
	engine.start();
	await engine.idle();
	expect(engine.instances.snapshot()).toEqual({ instances: [] });
	expect(emitted.length).toBe(1); // the eager loop's own initial state, exactly once
});

test("start(): a junk seed entry surfaces loudly with address and params in the detail, and is skipped", async () => {
	const { engine, emitted, violations } = buildEngine({}, makeRegistry(), {
		"junk/{x}": [{ x: "1" }],
	});
	engine.start();
	await engine.idle();
	expect(emitted).toEqual([]);
	expect(engine.instances.snapshot()).toEqual({ instances: [] });
	expect(violations.length).toBe(1);
	const v = violations[0];
	expect(v?.kind).toBe("unknown-topic");
	expect(v?.topic).toBe("junk/1");
	expect(v?.emitSource).toEqual({ layer: "L1" });
	expect(v?.detail).toContain("seedInstances: 'junk/{x}'");
	expect(v?.detail).toContain('{"x":"1"}');
	expect(v?.detail).toContain("does not resolve to a toClient channel instance");
});
```

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: PASS.

### Task 13: Bucket 3 verification and commit

- [ ] **Step 1: Focused runs**

Run: `nvm use default`, then `node_modules/.bin/stryker run --mutate 'src/engine/resolve-emit.ts'`, `--mutate 'src/engine/faker.ts'`, `--mutate 'src/engine/index.ts'`.
Expected: remaining undetected mutants across these files are exactly the Task 15 annotation list.

- [ ] **Step 2: Full suite + doc gate**

Run: `bun test` then `bun scripts/check-docs.ts`
Expected: both green.

- [ ] **Step 3: Commit (on user go-ahead)**

```bash
git add src/engine/resolve-emit.test.ts src/engine/faker.test.ts src/engine/index.test.ts
git commit -m "engine: mutation-kill bucket 3 — structural violation/error message asserts, ledger exactness"
```

---

## Bucket 4: residue (reference-oracle kills + annotated equivalents)

### Task 14: PRNG reference-oracle tests

**Files:**
- Modify: `src/engine/prng.test.ts` (append tests)

**Interfaces:**
- Consumes: `hashToInt`, `mulberry32`.
- Produces: kills `prng.ts:8, 19, 21`. No literal golden constants: each test carries an independent inline copy of the pinned algorithm as oracle; a mutant changes `prng.ts`, never the copy. Anyone intentionally changing the algorithm must consciously update the copy, which is the F7 guard working as designed.

- [ ] **Step 1: Append the tests** (this file stays untagged; it is in no `TEST` trace)

```ts
test("hashToInt matches the FNV-1a reference bit-for-bit over a corpus (pinned algorithm, F7)", () => {
	const reference = (s: string): number => {
		let h = 2166136261;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return h >>> 0;
	};
	const corpus = [
		"",
		"a",
		"abc",
		"42|state/{deviceId}|",
		"7|ctx|tick|0|h.ts|0",
		"7|delay|warm-up|3",
		"😀🚀",
		" ￿",
	];
	for (let i = 0; i < 500; i++) corpus.push(`k${i}|${i * 31}`);
	for (const s of corpus) expect(hashToInt(s)).toBe(reference(s));
});

test("mulberry32 matches the reference stream for many seeds (pinned algorithm, F7)", () => {
	const reference = (seed: number): (() => number) => {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	};
	for (const seed of [0, 1, 2, 0xffffffff, 123456789, hashToInt("offbook")]) {
		const ours = mulberry32(seed);
		const ref = reference(seed);
		for (let i = 0; i < 20; i++) expect(ours()).toBe(ref());
	}
});
```

- [ ] **Step 2: Run the full suite, then a focused run**

Run: `bun test` (PASS), then `nvm use default` and `node_modules/.bin/stryker run --mutate 'src/engine/prng.ts'`
Expected: 0 Survived, 0 NoCoverage in `prng.ts`.

### Task 15: Annotation sweep (argued equivalents only)

**Files:**
- Modify: `src/engine/dispatch.ts`, `src/engine/scheduler.ts`, `src/engine/instances.ts`, `src/engine/index.ts`, `src/engine/faker.ts`

**Interfaces:**
- Consumes: the focused-run results from Tasks 5/9/13; every annotation below must correspond to a mutant still undetected there. If a listed mutant was already killed by the new tests, skip its annotation. If an unlisted mutant still survives, do NOT annotate it; kill it or stop and report.

- [ ] **Step 1: Add the disable comments** (each on its own line, directly above the target line; mutator-specific so sibling mutants on the same line stay live)

`src/engine/dispatch.ts` (above the `if (!winner) return undefined;` line in `select`):

```ts
				// Stryker disable next-line ConditionalExpression: with no winner, instances.get(undefined) is undefined and the !handler guard below returns the same undefined
```

`src/engine/scheduler.ts` (above `if (!entry && timeline.length > 0) {`):

```ts
				// Stryker disable next-line ConditionalExpression,EqualityOperator: popping an empty timeline is harmless — sort is a no-op and shift() yields undefined, guarded by `if (next)` below
```

(above `if (next) {`):

```ts
					// Stryker disable next-line ConditionalExpression: shift() on a length-guarded timeline is always defined
```

(above `if (myEpoch !== epoch) return;`):

```ts
					// Stryker disable next-line ConditionalExpression: belt-and-braces only; reset() clears wall timers before bumping epoch, so a stale fire is unreachable
```

(above `if (tickTimer) clearInterval(tickTimer);` in `stopTicks`):

```ts
			// Stryker disable next-line ConditionalExpression: clearInterval(undefined) is a harmless no-op
```

(above `epoch++;` in `reset`):

```ts
			// Stryker disable next-line UpdateOperator: epoch is an identity token; any never-reused value works, direction is irrelevant
```

(above `if (tickTimer) clearInterval(tickTimer);` in `reset`; the false-variant stays pinned by Task 1's reset-stops-ticker test):

```ts
			// Stryker disable next-line ConditionalExpression: clearInterval(undefined) is a harmless no-op; the stop-on-reset behavior itself is test-pinned
```

`src/engine/instances.ts` (above `if (instances.has(key)) return;`):

```ts
		// Stryker disable next-line ConditionalExpression: re-setting an identical value under the same key preserves Map insertion order and snapshot() copies, so nothing is observable
```

`src/engine/index.ts` (above the `detail: \`${first?.instancePath || "/"}: ...\`` line in `publish`):

```ts
						// Stryker disable next-line OptionalChaining: errors[0] is defined under the length > 0 guard; the ?. exists only for noUncheckedIndexedAccess
```

(above `publish({ topic, payload: out.payload }, { layer: "L1" });` in `materializeAndPublish`):

```ts
			// Stryker disable next-line ObjectLiteral,StringLiteral: the floor payload was already Ajv-rechecked by l1Floor with the same validate, so this source stamp can only surface via a violation that is unreachable here
```

`src/engine/faker.ts` (above the `` `${first?.instancePath || "/"}: ...` `` line in `l1Floor`):

```ts
				// Stryker disable next-line OptionalChaining: errors[0] is defined under the length check; the ?. exists only for noUncheckedIndexedAccess
```

Plus, only if Task 11 Step 2 hit the JSF-rejects-anyway case, above `failOnInvalidTypes: false,`:

```ts
			// Stryker disable next-line BooleanLiteral: unobservable — json-schema-faker 0.6.2 rejects unknown types regardless of this flag
```

- [ ] **Step 2: Verify the annotations compile and the suite is green**

Run: `bun test`
Expected: PASS (comments change no behavior).

### Task 16: Final full mutation run

- [ ] **Step 1: Full run**

Run: `nvm use default` then `bun run mutate`
Expected: **0 Survived, 0 NoCoverage**. Annotated mutants report as Ignored; Timeout counts as detected. Record the final score for D-011.

- [ ] **Step 2: If anything still survives**

For each straggler: read its replacement in the report, write the killing test in the owning module's test file (following this plan's patterns), or, if it meets the unobservability bar, annotate with a reason. Re-run the focused file, then repeat Step 1. Do not commit with unexplained survivors.

- [ ] **Step 3: Commit (on user go-ahead)**

```bash
git add src/engine/prng.test.ts src/engine/dispatch.ts src/engine/scheduler.ts src/engine/instances.ts src/engine/index.ts src/engine/faker.ts
git commit -m "engine: mutation-kill bucket 4 — prng reference oracles, annotate argued equivalents"
```

---

## Docs

### Task 17: D-011 ledger entry and working note

**Files:**
- Modify: `DECISIONS.md` (append after D-010)
- Modify: `AGENTS.md` (working notes)

- [ ] **Step 1: Append the D-011 entry** (match the D-010 format exactly; fill `<score>` with Task 16's number)

```markdown
### D-011: Mutation residue policy — clean report via kill-or-annotate
**Date**: 2026-07-25
**What**: The `src/engine` mutation report is kept clean: every undetected mutant is either killed by a test or carries a mutator-specific `// Stryker disable next-line <Mutator>: <reason>` comment whose reason argues unobservability ("hard to kill" does not qualify). Violation/error message text is asserted structurally (load-bearing parts, never full golden prose), with two pinned exceptions that are contract: `canonicalize` output (the shared F7 instance identity) and the `<instancePath|/>: <keyword>` detail format. `prng.ts` is guarded by reference-oracle tests (an inline copy of the pinned algorithm as expected value). Final score after the campaign: <score> (0 Survived, 0 NoCoverage; annotated mutants report as Ignored).
**Why**: Mutation runs are manual with no baseline diffing (D-010), so residue makes every future run a re-triage; a clean report makes "survivor = news" the reading. Structural message asserts keep wording editable while pinning the diagnostic content that "observe and surface loudly" promises. Two comparator seams (`timelineOrder` in scheduler, `precedence` in dispatch, both exported pure functions) were pre-authorized because JS engine sort internals hide tie-break defects from behavioral tests.
**From**: docs/superpowers/specs/2026-07-25-mutation-kill-design.md (brainstorm dialog, 2026-07-25)
**Folds into**: src/engine/*.test.ts, Stryker disable comments in src/engine/{dispatch,scheduler,instances,index,faker}.ts, AGENTS.md working notes
```

(Adjust the seam sentence to name only the seams actually applied in Tasks 6/7.)

- [ ] **Step 2: Add the working note to AGENTS.md** (in the "Working notes" list, after the existing `bun run mutate` note)

```markdown
- **`nvm use default` puts a Node 24 on PATH** for `bun run mutate` / focused `stryker run` invocations.
```

- [ ] **Step 3: Gate and commit (on user go-ahead)**

Run: `bun scripts/check-docs.ts` then `bun test`
Expected: both green (D-011 is contiguous after D-010).

```bash
git add DECISIONS.md AGENTS.md
git commit -m "docs: D-011 — mutation residue policy (clean report, kill-or-annotate)"
```
