# Engine Chain (R-010 → R-012 → R-013 → R-014) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/engine/`'s deterministic scheduler core, L3 dispatch, emit-completion choke-point, and reset, flipping R-010/R-012/R-013/R-014 to `tested`, plus the two carried-forward spike-tripwire hardenings.

**Architecture:** Everything is fixed by frozen contracts.md §3/§4 (clock model G5, run-to-completion G23 spanning `await faker()` per D-003, keyed seeding F7, `register`/Handler types G11, `resolveEmit` F13, `emitSource` stamping G10, drop-and-surface F5 with **no keyed fallback per D-008**). The engine stops at its own boundary: `createEngine({config, broker, registry, record})` takes injectable seams (broker = structural `{emit}` type, registry = a thunk for F19 hot-swap survival, record = a function, so `engine/` imports only `model/` + its own files + `registry/` types); the control-plane rewire (F11, `/publish` through `resolveEmit`) is R-017's work and is NOT done here. The L2 runner slot is an explicit seam for R-016.

**Tech Stack:** Bun, TypeScript, `bun:test`, json-schema-faker 0.6.2 (already wrapped in `src/engine/faker.ts` — untouched except a hash-function extraction).

## Global Constraints

- `bun scripts/check-docs.ts` AND `bun test` must both pass before **every** commit. Also run `bunx tsc --noEmit` before each commit (the repo is tsc-clean).
- Commit messages follow repo style (`area: summary`); **no Co-Authored-By or AI-attribution trailers**; never run `git config`. Branch: `main`, commit directly.
- Transport isolation: no file in `src/engine/` may import `aedes`, `mqtt`, or `src/broker/` (even type-only — the broker arrives by injection as a structural type).
- Statuses stay honest: flip an R-### only in the task that makes every clause of its statement covered by the named TEST trace; if a clause turns out uncovered, stop and report.
- TDD per task: write the failing test first, watch it fail, implement, watch it pass.
- Contracts.md wins every interface conflict. The types consumed here (verbatim from `src/model/index.ts`): `Config` (fields `seed`, `fixedEpoch`, `tickIntervalMs`, `wallClock`, `mode`), `NormalizedMessage`, `InboundEvent`, `Channel`, `SpecRegistry`, `HandlerFactory`/`Handler`/`HandlerContext`, `EmitSource`, `Violation`, `Faker`.

---

### Task 1: Spike-tripwire hardening (carried-forward Minors 3+4)

**Files:**
- Modify: `test/spikes/jsf-fidelity.test.ts`

**Interfaces:**
- Consumes: `measureFixture(fixture, seeds)` returning `{ fixture, draws, failures, byChannel }`, `SPIKE_FIXTURES` — both from `scripts/spike-jsf-fidelity.ts`.
- Produces: nothing downstream; closes the two final-review carry-forwards.

- [ ] **Step 1: Rewrite the tripwire to pin draws and the fixture list**

Replace the test file's pinning section (keep the imports and header comment) so it reads:

```ts
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
	measureFixture,
	SPIKE_FIXTURES,
} from "../../scripts/spike-jsf-fidelity.ts";

// R-027 tripwire: pins the measured per-fixture recheck-failure counts so a
// JSF/schema regression is loud, not silent. Update EXPECTED only with a
// re-measurement + a D-### note (the D-008 verdict rests on these).
// Pins { draws, failures } per fixture (not failures alone) so a fixture that
// silently parsed to zero channels cannot vacuously pass as 0/0.
const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);
const EXPECTED: Record<string, { draws: number; failures: number }> = {
	"composition.yaml": { draws: 20, failures: 0 },
	"external-ref.yaml": { draws: 10, failures: 0 },
	"qos-overrides.yaml": { draws: 20, failures: 0 },
	"qos-retain.yaml": { draws: 10, failures: 0 },
	"thermostat.yaml": { draws: 20, failures: 0 },
	"v2-pubsub.yaml": { draws: 20, failures: 0 },
};

test("SPIKE_FIXTURES covers exactly the fixtures/asyncapi/*.yaml directory listing", () => {
	const onDisk = readdirSync(`${import.meta.dir}/../../fixtures/asyncapi`)
		.filter((f) => f.endsWith(".yaml"))
		.sort();
	expect([...SPIKE_FIXTURES].sort()).toEqual(onDisk);
});

test("JSF recheck-failure rates match the D-008 measurement", async () => {
	const measured: Record<string, { draws: number; failures: number }> = {};
	for (const fixture of SPIKE_FIXTURES) {
		const r = await measureFixture(fixture, SEEDS);
		measured[fixture] = { draws: r.draws, failures: r.failures };
	}
	expect(measured).toEqual(EXPECTED);
});
```

(The draws values are channels × 10 seeds; channel counts per fixture were verified in the Task 5 final review: composition 2, external-ref 1, qos-overrides 2, qos-retain 1, thermostat 2, v2-pubsub 2.)

- [ ] **Step 2: Run it**

Run: `bun test test/spikes/jsf-fidelity.test.ts`
Expected: 2 pass, 0 fail. If a `draws` value differs, the fixture's channel count assumption was wrong — read the actual value from the failure diff, verify it against the fixture YAML's channel count by hand, and correct EXPECTED (report the discrepancy).

- [ ] **Step 3: Gates + commit**

Run: `bun scripts/check-docs.ts && bunx tsc --noEmit && bun test` — all green (test count grows by 1: 102).

```bash
git add test/spikes/jsf-fidelity.test.ts
git commit -m "test: harden JSF tripwire — pin per-fixture draws; fixture list = dir listing"
```

---

### Task 2: `prng.ts` — F7 primitives (extraction, no behavior change)

**Files:**
- Create: `src/engine/prng.ts`
- Modify: `src/engine/faker.ts` (delete its local `hashToInt`, import from `./prng.ts`)
- Test: `src/engine/prng.test.ts`

**Interfaces:**
- Produces: `hashToInt(s: string): number` (FNV-1a, uint32) and `mulberry32(seed: number): () => number` (returns floats in [0,1)). Tasks 3/5/6 import both.

- [ ] **Step 1: Write the failing test**

Create `src/engine/prng.test.ts`:

```ts
import { expect, test } from "bun:test";
import { hashToInt, mulberry32 } from "./prng.ts";

test("hashToInt is stable, uint32, and input-sensitive", () => {
	expect(hashToInt("abc")).toBe(hashToInt("abc"));
	const h = hashToInt("42|state/{deviceId}|");
	expect(Number.isInteger(h)).toBe(true);
	expect(h).toBeGreaterThanOrEqual(0);
	expect(h).toBeLessThanOrEqual(0xffffffff);
	expect(hashToInt("a")).not.toBe(hashToInt("b"));
});

test("mulberry32 streams are deterministic per seed and diverge across seeds", () => {
	const a1 = mulberry32(7);
	const a2 = mulberry32(7);
	const b = mulberry32(8);
	const s1 = [a1(), a1(), a1()];
	const s2 = [a2(), a2(), a2()];
	const s3 = [b(), b(), b()];
	expect(s1).toEqual(s2);
	expect(s1).not.toEqual(s3);
	for (const v of s1) {
		expect(v).toBeGreaterThanOrEqual(0);
		expect(v).toBeLessThan(1);
	}
});
```

- [ ] **Step 2: Run it — fails (module missing)**

Run: `bun test src/engine/prng.test.ts` — Expected: FAIL, cannot resolve `./prng.ts`.

- [ ] **Step 3: Implement**

Create `src/engine/prng.ts`:

```ts
// Seeded PRNG primitives (F7). One hash implementation serves the faker's JSF
// seed key, ranged-delay keys (R-013), and per-invocation ctx.random() streams
// (R-012) — never a long-lived module-global cursor.

// stable string -> uint32 (FNV-1a)
export function hashToInt(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// Mulberry32 — the project-pinned PRNG (AGENTS.md); floats in [0, 1)
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
```

In `src/engine/faker.ts`: delete the local `hashToInt` function (lines 5–14, the comment included) and add `import { hashToInt } from "./prng.ts";` after the existing imports. Keep the `// stable string -> uint32` knowledge in prng.ts only. Nothing else changes; the R4 comment about JSF's native seed stays where it is (on the usage).

- [ ] **Step 4: Run tests**

Run: `bun test src/engine/` — Expected: prng 2 pass + faker 5 pass (unchanged behavior: same hash, same seeds, same outputs).

- [ ] **Step 5: Gates + commit**

Run: `bun scripts/check-docs.ts && bunx tsc --noEmit && bun test` — green (104 tests).

```bash
git add src/engine/prng.ts src/engine/prng.test.ts src/engine/faker.ts
git commit -m "engine: extract prng.ts (FNV-1a hash + Mulberry32) — shared F7 primitives"
```

---

### Task 3: `scheduler.ts` — deterministic scheduler core (R-010 → tested)

**Files:**
- Create: `src/engine/scheduler.ts`
- Test: `src/engine/scheduler.test.ts`
- Modify: `REQUIREMENTS.md` (R-010 entry only)

**Interfaces:**
- Consumes: `Config` from model; nothing engine-internal.
- Produces (Tasks 6–7 build on these exact signatures):

```ts
export type Task = () => void | Promise<void>;
export interface Scheduler {
	now(): number;                                   // logical clock (G5)
	post(run: Task): void;                           // arrival-ordered external event (inbound/subscribe)
	scheduleEmit(delayMs: number, run: Task): void;  // seeded-timeline emission
	advanceTick(onTick: Task): void;                 // one virtual tick: now += tickIntervalMs, then onTick (fast-virtual)
	startWallTicks(onTick: Task): void;              // wall-paced setInterval ticks (wallClock mode); no-op if already started
	stopTicks(): void;
	pending(): { scheduled: number; settled: boolean };
	idle(): Promise<void>;                           // resolves when settled (test/R-018 consumer)
	reset(): void;                                   // drain queues, re-epoch clock; wallClock binding untouched (G5)
}
export function createScheduler(config: Config): Scheduler;
```

Semantics (all from contracts §3): run-to-completion — one task runs (including across its own `await`s, the D-003 span) before the next dequeues; virtual mode (`wallClock:false`) delivers each emission on the next task after ONE event-loop yield while advancing `now()` by the full delay; emissions order by `(dueAt, insertionSeq)`; the immediate (arrival-order) queue always drains before the timeline; wall mode (`wallClock:true`) uses real `setTimeout(delayMs)` and still advances logical `now()` by the delay when it fires; `pending().scheduled` counts every posted/scheduled task from enqueue until its run completes (so an in-flight `await faker()` inside a task is counted — D-003).

- [ ] **Step 1: Write the failing tests**

Create `src/engine/scheduler.test.ts`:

```ts
import { expect, test } from "bun:test";
import { loadConfig } from "../config/index.ts";
import { hashToInt, mulberry32 } from "./prng.ts";
import { createScheduler } from "./scheduler.ts";

// Records (label, logicalTime) tuples — the emission-stream projection the
// determinism assertions compare.
async function runScript(seed: number): Promise<[string, number][]> {
	const config = loadConfig({ seed });
	const s = createScheduler(config);
	const out: [string, number][] = [];
	// three emissions with seeded ranged delays keyed per-emission (F7-style
	// keying — the real keying lives in resolveEmit, Task 5; here the point is
	// that the scheduler's ordering is a pure function of the drawn delays)
	for (const key of ["a", "b", "c"]) {
		const draw = mulberry32(hashToInt(`${config.seed}|${key}`))();
		const delayMs = 100 + Math.floor(draw * 200); // 100-300ms virtual
		s.scheduleEmit(delayMs, () => {
			out.push([key, s.now()]);
		});
	}
	await s.idle();
	return out;
}

test("virtual mode: same seed ⇒ identical order and logical timings; different seed diverges", async () => {
	const r1 = await runScript(7);
	const r2 = await runScript(7);
	expect(r1).toEqual(r2);
	expect(r1.length).toBe(3);
	// anti-vacuity: across a batch of seeds the (order, timings) tuple varies
	const alts = await Promise.all([1, 2, 3, 42, 99].map((s) => runScript(s)));
	const distinct = new Set([r1, ...alts].map((r) => JSON.stringify(r)));
	expect(distinct.size).toBeGreaterThan(1);
});

test("virtual mode advances now() by the full delay with no wall time", async () => {
	const config = loadConfig({ seed: 1 });
	const s = createScheduler(config);
	const wallStart = Date.now();
	let at = 0;
	s.scheduleEmit(300, () => {
		at = s.now();
	});
	await s.idle();
	expect(at).toBe(config.fixedEpoch + 300); // full logical advance
	expect(Date.now() - wallStart).toBeLessThan(200); // …but no real 300ms wait
});

test("run-to-completion spans awaits: an async task's internal await does not let a later task interleave (G23/D-003)", async () => {
	const s = createScheduler(loadConfig({ seed: 1 }));
	const order: string[] = [];
	s.post(async () => {
		order.push("first:start");
		await new Promise((r) => setTimeout(r, 20)); // the await-faker() stand-in
		order.push("first:end");
	});
	s.post(() => {
		order.push("second");
	});
	await s.idle();
	expect(order).toEqual(["first:start", "first:end", "second"]);
});

test("immediate (arrival-order) queue drains before the virtual timeline", async () => {
	const s = createScheduler(loadConfig({ seed: 1 }));
	const order: string[] = [];
	s.scheduleEmit(0, () => {
		order.push("emit");
	});
	s.post(() => {
		order.push("inbound");
	});
	await s.idle();
	expect(order).toEqual(["inbound", "emit"]);
});

test("pending() counts a task from enqueue until completion, including across its awaits", async () => {
	const s = createScheduler(loadConfig({ seed: 1 }));
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	s.post(async () => {
		await gate;
	});
	expect(s.pending()).toEqual({ scheduled: 1, settled: false });
	release();
	await s.idle();
	expect(s.pending()).toEqual({ scheduled: 0, settled: true });
});

test("advanceTick moves the virtual clock by tickIntervalMs per tick with no wall delay", async () => {
	const config = loadConfig({ seed: 1, tickIntervalMs: 1000 });
	const s = createScheduler(config);
	const ticksAt: number[] = [];
	s.advanceTick(() => ticksAt.push(s.now()));
	s.advanceTick(() => ticksAt.push(s.now()));
	await s.idle();
	expect(ticksAt).toEqual([config.fixedEpoch + 1000, config.fixedEpoch + 2000]);
});

test("wall-paced mode: scheduleEmit waits real wall time and still stamps logical now()", async () => {
	const config = loadConfig({ seed: 1, wallClock: true });
	const s = createScheduler(config);
	const wallStart = Date.now();
	let at = 0;
	s.scheduleEmit(60, () => {
		at = s.now();
	});
	await s.idle();
	expect(Date.now() - wallStart).toBeGreaterThanOrEqual(50); // real wait (5ms tolerance under timer coalescing)
	expect(at).toBe(config.fixedEpoch + 60); // logical stamp still advances
	s.stopTicks();
});

test("reset drains queues and re-epochs the clock", async () => {
	const config = loadConfig({ seed: 1 });
	const s = createScheduler(config);
	const out: string[] = [];
	s.scheduleEmit(500, () => {
		out.push("stale");
	});
	s.reset();
	await s.idle();
	expect(out).toEqual([]); // the stale emission never fires
	expect(s.now()).toBe(config.fixedEpoch);
	expect(s.pending()).toEqual({ scheduled: 0, settled: true });
});
```

- [ ] **Step 2: Run — fails (module missing)**

Run: `bun test src/engine/scheduler.test.ts` — Expected: FAIL, cannot resolve `./scheduler.ts`.

- [ ] **Step 3: Implement**

Create `src/engine/scheduler.ts`:

```ts
// R-010 — the deterministic scheduler core (contracts §3, G5/G23/F7/D-003).
// Owns the virtual clock and the single event loop. `broker.emit` stays
// publish-now; ALL delay/ordering semantics live here, never in transport.
import type { Config } from "../model/index.ts";

export type Task = () => void | Promise<void>;

export interface Scheduler {
	now(): number;
	post(run: Task): void;
	scheduleEmit(delayMs: number, run: Task): void;
	advanceTick(onTick: Task): void;
	startWallTicks(onTick: Task): void;
	stopTicks(): void;
	pending(): { scheduled: number; settled: boolean };
	idle(): Promise<void>;
	reset(): void;
}

interface TimelineEntry {
	dueAt: number;
	seq: number; // insertion tiebreak — two same-dueAt emissions keep schedule order
	run: Task;
}

export function createScheduler(config: Config): Scheduler {
	let logicalNow = config.fixedEpoch;
	let insertionSeq = 0;
	let inFlight = 0; // every accepted task, from enqueue until run() settles (D-003 span)
	let pumping = false;
	const immediate: Task[] = []; // arrival-ordered external events (G23: inbound by meta.seq assignment)
	const timeline: TimelineEntry[] = []; // seeded emission timeline
	const wallTimers = new Set<ReturnType<typeof setTimeout>>();
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let waiters: (() => void)[] = [];

	function settleCheck(): void {
		if (inFlight === 0 && !pumping) {
			const w = waiters;
			waiters = [];
			for (const resolve of w) resolve();
		}
	}

	async function pump(): Promise<void> {
		if (pumping) return;
		pumping = true;
		try {
			for (;;) {
				// the single async-forcing yield (G5) sits BEFORE selection: nothing
				// runs synchronously inside the scheduling call, and any task that
				// arrived in the same synchronous turn is enqueued before the next
				// pick — so the immediate (arrival-order) queue reliably drains ahead
				// of the timeline even for a zero-delay emission
				await Promise.resolve();
				let run = immediate.shift();
				if (!run && timeline.length > 0) {
					// pop the earliest (dueAt, insertionSeq) — the seeded timeline order
					timeline.sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
					const next = timeline.shift();
					if (next) {
						logicalNow = Math.max(logicalNow, next.dueAt);
						run = next.run;
					}
				}
				if (!run) break;
				try {
					// run-to-completion: this await spans the task's own awaits
					// (incl. `await faker()`), so no other task interleaves (G23/D-003)
					await run();
				} finally {
					inFlight--;
				}
			}
		} finally {
			pumping = false;
			settleCheck();
		}
	}

	return {
		now: () => logicalNow,

		post(run) {
			inFlight++;
			immediate.push(run);
			void pump();
		},

		scheduleEmit(delayMs, run) {
			inFlight++;
			if (config.wallClock) {
				// wall-paced interactive path (CR6): real elapsed wall time, and the
				// logical clock still advances by the delay when it fires (G5)
				const timer = setTimeout(() => {
					wallTimers.delete(timer);
					logicalNow += delayMs;
					immediate.push(run);
					void pump();
				}, delayMs);
				wallTimers.add(timer);
			} else {
				timeline.push({ dueAt: logicalNow + delayMs, seq: insertionSeq++, run });
				void pump();
			}
		},

		advanceTick(onTick) {
			// fast-virtual tick (wallClock:false domain): advance the clock by the
			// full interval with no wall delay; caller (engine) gates on mode
			inFlight++;
			immediate.push(async () => {
				logicalNow += config.tickIntervalMs;
				await onTick();
			});
			void pump();
		},

		startWallTicks(onTick) {
			if (tickTimer) return;
			tickTimer = setInterval(() => {
				inFlight++;
				immediate.push(async () => {
					logicalNow += config.tickIntervalMs;
					await onTick();
				});
				void pump();
			}, config.tickIntervalMs);
		},

		stopTicks() {
			if (tickTimer) clearInterval(tickTimer);
			tickTimer = undefined;
		},

		pending: () => ({ scheduled: inFlight, settled: inFlight === 0 }),

		idle() {
			if (inFlight === 0 && !pumping) return Promise.resolve();
			return new Promise((resolve) => waiters.push(resolve));
		},

		reset() {
			immediate.length = 0;
			timeline.length = 0;
			for (const t of wallTimers) clearTimeout(t);
			wallTimers.clear();
			if (tickTimer) clearInterval(tickTimer);
			tickTimer = undefined;
			logicalNow = config.fixedEpoch;
			insertionSeq = 0;
			inFlight = 0; // cleared tasks never run; wallClock binding itself is untouched (G5)
			settleCheck();
		},
	};
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/engine/scheduler.test.ts` — Expected: 8 pass. The wall-paced test is the only one consuming real time (~60ms).

- [ ] **Step 5: Flip R-010**

In `REQUIREMENTS.md`, R-010: `**STATUS**: specified` → `**STATUS**: tested`; insert after COVERS:

```markdown
**IMPL**: src/engine/scheduler.ts, src/engine/prng.ts
**TEST**: src/engine/scheduler.test.ts
```

- [ ] **Step 6: Gates + commit**

Run: `bun scripts/check-docs.ts && bunx tsc --noEmit && bun test` — green.

```bash
git add src/engine/scheduler.ts src/engine/scheduler.test.ts REQUIREMENTS.md
git commit -m "engine: deterministic scheduler core — virtual clock, G23 run-to-completion, wall path (R-010 → tested)"
```

---

### Task 4: `dispatch.ts` — L3 registration + discovery + precedence (R-012 → tested)

**Files:**
- Create: `src/engine/dispatch.ts`
- Test: `src/engine/dispatch.test.ts`
- Modify: `REQUIREMENTS.md` (R-012 entry only)

**Interfaces:**
- Consumes: `HandlerFactory`, `Handler`, `SpecRegistry` from model.
- Produces (Task 6 builds on these exact signatures):

```ts
export interface Registration { pattern: string; factory: HandlerFactory; modulePath: string; order: number }
export interface DispatchRegistry {
	register(pattern: string, factory: HandlerFactory, modulePath?: string): void;
	loadHandlers(dir: string): Promise<string[]>;   // glob handlers/**/*.ts, sorted, import each (G11)
	instantiate(): void;                            // (re-)create every handler from its factory — the reset hook
	select(topic: string, registry: SpecRegistry):
		{ handler: Handler; registration: Registration; params: Record<string, string> } | undefined;
	all(): { handler: Handler; registration: Registration }[];   // tick fan-out order = precedence order
}
export function createDispatchRegistry(): DispatchRegistry;
export const defaultDispatch: DispatchRegistry;                 // the process singleton
export function register(pattern: string, factory: HandlerFactory): void;  // contracts §3 free function → defaultDispatch
```

Precedence (G11): `select` resolves the topic through `registry.match` (lazy, F19 — the *current* registry decides the channel, so most-specific-beats-`{param}` is the matcher's rule, not re-implemented here); among registrations whose `pattern` equals the matched channel's address, the winner is sorted `modulePath` then registration `order`. `loadHandlers` imports files in sorted-path order and stamps each registration with its module path; a `register` call outside `loadHandlers` (tests, inline registration) stamps `modulePath: ""` unless given explicitly.

- [ ] **Step 1: Write the failing tests**

Create `src/engine/dispatch.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Handler, SpecRegistry } from "../model/index.ts";
import { createDispatchRegistry, defaultDispatch } from "./dispatch.ts";

// A minimal SpecRegistry stub: two channels, one literal and one {param}, the
// literal winning the shared concrete topic — the matcher's most-specific rule
// (the real matcher behavior is R-004-tested in registry/; dispatch only
// delegates to it, so a stub keeps this test transport- and parser-free).
const stubRegistry: SpecRegistry = {
	match(topic: string) {
		const mk = (address: string, params: Record<string, string>) => ({
			channel: {
				topic: address,
				direction: "fromClient" as const,
				service: "t",
				schema: {},
				validate: () => [],
			},
			params,
		});
		if (topic === "command/special/set") return mk("command/special/set", {});
		const m = topic.match(/^command\/([^/]+)\/set$/);
		if (m?.[1]) return mk("command/{deviceId}/set", { deviceId: m[1] });
		return undefined;
	},
	matchesFilter: () => false,
	channels: () => [],
};

function handlerTagged(tag: string, log: string[]): () => Handler {
	return () => ({
		onInbound() {
			log.push(tag);
		},
	});
}

test("select routes through registry.match: literal channel beats {param} for the same topic", () => {
	const d = createDispatchRegistry();
	const log: string[] = [];
	d.register("command/{deviceId}/set", handlerTagged("param", log), "a.ts");
	d.register("command/special/set", handlerTagged("literal", log), "b.ts");
	d.instantiate();
	expect(d.select("command/special/set", stubRegistry)?.registration.pattern).toBe(
		"command/special/set",
	);
	const generic = d.select("command/thermostat-1/set", stubRegistry);
	expect(generic?.registration.pattern).toBe("command/{deviceId}/set");
	expect(generic?.params).toEqual({ deviceId: "thermostat-1" });
});

test("same-channel overlap resolves by sorted module path, independent of registration order", () => {
	const winners: string[] = [];
	for (const reversed of [false, true]) {
		const d = createDispatchRegistry();
		const log: string[] = [];
		const regs: [string, string][] = [
			["z-module.ts", "Z"],
			["a-module.ts", "A"],
		];
		if (reversed) regs.reverse();
		for (const [path, tag] of regs)
			d.register("command/{deviceId}/set", handlerTagged(tag, log), path);
		d.instantiate();
		const sel = d.select("command/x/set", stubRegistry);
		expect(sel).toBeDefined();
		winners.push(sel?.registration.modulePath ?? "?");
	}
	// same winner both times: sorted module path, not import/registration order
	expect(winners).toEqual(["a-module.ts", "a-module.ts"]);
});

test("same module path falls back to registration order", () => {
	const d = createDispatchRegistry();
	const log: string[] = [];
	d.register("command/{deviceId}/set", handlerTagged("first", log), "m.ts");
	d.register("command/{deviceId}/set", handlerTagged("second", log), "m.ts");
	d.instantiate();
	const sel = d.select("command/x/set", stubRegistry);
	sel?.handler.onInbound?.(
		{ message: { topic: "command/x/set", payload: {} }, meta: { clientId: "c", seq: 1, receivedAt: 0 } },
		{ publish: () => {}, random: () => 0, now: () => 0 },
	);
	expect(log).toEqual(["first"]);
});

test("instantiate() re-creates handler instances from factories (fresh state each call)", () => {
	const d = createDispatchRegistry();
	let built = 0;
	d.register("command/{deviceId}/set", () => {
		built++;
		return {};
	});
	d.instantiate();
	d.instantiate();
	expect(built).toBe(2);
	expect(d.all().length).toBe(1);
});

test("select returns undefined for a topic no current channel matches (lazy F19: unresolvable pattern simply never fires)", () => {
	const d = createDispatchRegistry();
	d.register("no/such/{channel}", () => ({}));
	d.instantiate();
	expect(d.select("unrelated/topic", stubRegistry)).toBeUndefined();
});

test("loadHandlers globs, imports in sorted-path order, and stamps module paths", async () => {
	const dir = mkdtempSync(join(tmpdir(), "offbook-handlers-"));
	const dispatchPath = join(import.meta.dir, "dispatch.ts");
	// two handler modules registering on the same pattern; sorted path ⇒ 10-a wins
	writeFileSync(
		join(dir, "10-a.ts"),
		`import { register } from ${JSON.stringify(dispatchPath)};
register("command/{deviceId}/set", () => ({}));`,
	);
	writeFileSync(
		join(dir, "20-b.ts"),
		`import { register } from ${JSON.stringify(dispatchPath)};
register("command/{deviceId}/set", () => ({}));`,
	);
	const paths = await defaultDispatch.loadHandlers(dir);
	expect(paths.map((p) => p.split("/").pop())).toEqual(["10-a.ts", "20-b.ts"]);
	defaultDispatch.instantiate();
	const sel = defaultDispatch.select("command/d1/set", stubRegistry);
	expect(sel?.registration.modulePath.endsWith("10-a.ts")).toBe(true);
});
```

- [ ] **Step 2: Run — fails (module missing)**

Run: `bun test src/engine/dispatch.test.ts` — Expected: FAIL, cannot resolve `./dispatch.ts`.

- [ ] **Step 3: Implement**

Create `src/engine/dispatch.ts`:

```ts
// R-012 — L3 registration, discovery, and dispatch precedence (contracts §3,
// G11/F19/G1). Patterns are AsyncAPI channel addresses with {param} captures,
// resolved AT DISPATCH by the registry's own matcher — never an MQTT filter,
// never resolved at import time (a handler needs no specs loaded to register,
// and a spec hot-swap never leaves it bound to a stale channel set).
import type { Handler, HandlerFactory, SpecRegistry } from "../model/index.ts";

export interface Registration {
	pattern: string;
	factory: HandlerFactory;
	modulePath: string;
	order: number;
}

export interface DispatchRegistry {
	register(pattern: string, factory: HandlerFactory, modulePath?: string): void;
	loadHandlers(dir: string): Promise<string[]>;
	instantiate(): void;
	select(
		topic: string,
		registry: SpecRegistry,
	):
		| { handler: Handler; registration: Registration; params: Record<string, string> }
		| undefined;
	all(): { handler: Handler; registration: Registration }[];
}

export function createDispatchRegistry(): DispatchRegistry {
	const registrations: Registration[] = [];
	const instances = new Map<Registration, Handler>();
	let order = 0;
	let importingPath = ""; // set around each loadHandlers import; "" = direct registration

	function precedence(a: Registration, b: Registration): number {
		return a.modulePath.localeCompare(b.modulePath) || a.order - b.order;
	}

	return {
		register(pattern, factory, modulePath) {
			registrations.push({
				pattern,
				factory,
				modulePath: modulePath ?? importingPath,
				order: order++,
			});
		},

		async loadHandlers(dir) {
			const glob = new Bun.Glob("**/*.ts");
			const paths = (
				await Array.fromAsync(glob.scan({ cwd: dir, absolute: true }))
			).sort();
			for (const p of paths) {
				importingPath = p;
				try {
					await import(p);
				} finally {
					importingPath = "";
				}
			}
			return paths;
		},

		instantiate() {
			instances.clear();
			for (const r of registrations) instances.set(r, r.factory());
		},

		select(topic, registry) {
			const m = registry.match(topic);
			if (!m) return undefined;
			// the matcher already applied most-specific-beats-{param} in choosing
			// the channel; among registrations on that channel: sorted module path,
			// then registration order (G11)
			const candidates = registrations
				.filter((r) => r.pattern === m.channel.topic)
				.sort(precedence);
			const winner = candidates[0];
			if (!winner) return undefined;
			const handler = instances.get(winner);
			if (!handler) return undefined; // instantiate() not yet called
			return { handler, registration: winner, params: m.params };
		},

		all() {
			return [...registrations]
				.sort(precedence)
				.map((r) => ({ handler: instances.get(r), registration: r }))
				.filter((x): x is { handler: Handler; registration: Registration } =>
					Boolean(x.handler),
				);
		},
	};
}

// The process singleton behind the contracts §3 free function. User handler
// modules import { register } and call it at module top level (G11).
export const defaultDispatch: DispatchRegistry = createDispatchRegistry();

export function register(pattern: string, factory: HandlerFactory): void {
	defaultDispatch.register(pattern, factory);
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/engine/dispatch.test.ts` — Expected: 6 pass.

- [ ] **Step 5: Flip R-012**

In `REQUIREMENTS.md`, R-012: STATUS → `tested`; insert after COVERS:

```markdown
**IMPL**: src/engine/dispatch.ts
**TEST**: src/engine/dispatch.test.ts
```

- [ ] **Step 6: Gates + commit**

Run: `bun scripts/check-docs.ts && bunx tsc --noEmit && bun test` — green.

```bash
git add src/engine/dispatch.ts src/engine/dispatch.test.ts REQUIREMENTS.md
git commit -m "engine: L3 dispatch — glob discovery, lazy match-at-dispatch, G11 precedence (R-012 → tested)"
```

---

### Task 5: `resolve-emit.ts` — the F13 choke-point (code only; R-013 flips in Task 6)

**Files:**
- Create: `src/engine/resolve-emit.ts`
- Test: `src/engine/resolve-emit.test.ts`

**Interfaces:**
- Consumes: `Channel`, `Config`, `NormalizedMessage` from model; `hashToInt`/`mulberry32` from `./prng.ts`.
- Produces (Task 6 builds on these exact signatures):

```ts
export interface EmitPartial extends Partial<NormalizedMessage> { topic: string; delay?: string }
export interface DelayKey { scenarioName: string; stepIndex: number }
export function parseDelay(spec: string, config: Config, key: DelayKey): number;
export function resolveEmit(partial: EmitPartial, channel: Channel, config: Config, delayKey?: DelayKey): NormalizedMessage;
```

Semantics (contracts §3, F13/F7/CR7): `qos = partial.qos ?? channel.qos ?? 1`; `retain = partial.retain ?? channel.retain ?? false`; `delayMs` comes from `partial.delayMs`, or from `parseDelay` when a `delay` string is present; both set at once throws (no silent precedence). Delay grammar `"<n>ms|s"` or `"<min>-<max>ms|s"`; a ranged delay draws once from `mulberry32(hashToInt(`${config.seed}|delay|${scenarioName}|${stepIndex}`))` and lands on an integer in `[min, max]` inclusive. A `delay` string without a `delayKey` throws (only the L2 runner produces delay strings and it always has the key; malformed grammar also throws — R-016's author-time validation catches both before dispatch, skipped-loud per its own statement).

- [ ] **Step 1: Write the failing tests**

Create `src/engine/resolve-emit.test.ts`:

```ts
import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "../config/index.ts";
import type { Channel } from "../model/index.ts";
import { parseDelay, resolveEmit } from "./resolve-emit.ts";

function channel(overrides: Partial<Channel> = {}): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile({});
	return {
		topic: "state/{deviceId}",
		direction: "toClient",
		service: "demo",
		schema: {},
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos: 2,
		retain: true,
		...overrides,
	};
}

const key = { scenarioName: "warm-up", stepIndex: 0 };

test("F13: an authored {topic, payload} fills qos/retain from the channel — never undefined", () => {
	const out = resolveEmit({ topic: "state/d1", payload: { a: 1 } }, channel(), loadConfig(), key);
	expect(out).toEqual({ topic: "state/d1", payload: { a: 1 }, qos: 2, retain: true, delayMs: 0 });
});

test("F13: an explicit qos/retain wins over the channel binding", () => {
	const out = resolveEmit(
		{ topic: "state/d1", payload: {}, qos: 0, retain: false },
		channel(),
		loadConfig(),
	);
	expect(out.qos).toBe(0);
	expect(out.retain).toBe(false);
});

test("F13: a channel with no binding falls back to qos 1 / retain false", () => {
	const out = resolveEmit(
		{ topic: "state/d1", payload: {} },
		channel({ qos: undefined, retain: undefined }),
		loadConfig(),
	);
	expect(out.qos).toBe(1);
	expect(out.retain).toBe(false);
});

test("delay: fixed forms parse exactly; s converts to ms", () => {
	const config = loadConfig();
	expect(parseDelay("150ms", config, key)).toBe(150);
	expect(parseDelay("2s", config, key)).toBe(2000);
});

test("delay: ranged draw is finite, in [min,max], keyed by (scenarioName, stepIndex), and seed-causal (F7)", () => {
	const config = loadConfig({ seed: 7 });
	const d1 = parseDelay("150-300ms", config, key);
	expect(Number.isFinite(d1)).toBe(true);
	expect(d1).toBeGreaterThanOrEqual(150);
	expect(d1).toBeLessThanOrEqual(300);
	// same key + seed ⇒ same draw
	expect(parseDelay("150-300ms", config, key)).toBe(d1);
	// key and seed are both causal: across other steps/seeds the draw varies
	const variants = [
		parseDelay("150-300ms", config, { scenarioName: "warm-up", stepIndex: 1 }),
		parseDelay("150-300ms", config, { scenarioName: "other", stepIndex: 0 }),
		parseDelay("150-300ms", loadConfig({ seed: 8 }), key),
	];
	expect(new Set([d1, ...variants]).size).toBeGreaterThan(1);
});

test("delay flows through resolveEmit into delayMs", () => {
	const config = loadConfig({ seed: 7 });
	const out = resolveEmit(
		{ topic: "state/d1", payload: {}, delay: "150-300ms" },
		channel(),
		config,
		key,
	);
	expect(out.delayMs).toBe(parseDelay("150-300ms", config, key));
});

test("a delay string without a delayKey, and malformed grammar, both throw", () => {
	const config = loadConfig();
	expect(() =>
		resolveEmit({ topic: "t", payload: {}, delay: "10ms" }, channel(), config),
	).toThrow();
	expect(() => parseDelay("fast", config, key)).toThrow();
	expect(() => parseDelay("300-150ms", config, key)).toThrow(); // inverted range
});
```

- [ ] **Step 2: Run — fails (module missing)**

Run: `bun test src/engine/resolve-emit.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/engine/resolve-emit.ts`:

```ts
// R-013 — the single emit-completion choke-point (contracts §3, F13/F7/CR7).
// Every engine emission passes through resolveEmit before broker.emit, so an
// authored {topic, payload} always reaches the broker at the channel-resolved
// qos/retain (never undefined — Aedes must never fall back to QoS 0 by
// accident) and every L2 ranged delay is a keyed, reproducible draw.
import type { Channel, Config, NormalizedMessage } from "../model/index.ts";
import { hashToInt, mulberry32 } from "./prng.ts";

export interface EmitPartial extends Partial<NormalizedMessage> {
	topic: string;
	delay?: string; // l2 §6 grammar; only the L2 runner produces this
}

export interface DelayKey {
	scenarioName: string;
	stepIndex: number;
}

const DELAY_RE = /^(\d+)(?:-(\d+))?(ms|s)$/;

export function parseDelay(spec: string, config: Config, key: DelayKey): number {
	const m = spec.match(DELAY_RE);
	if (!m) throw new Error(`malformed delay "${spec}" (expected "<n>ms|s" or "<min>-<max>ms|s")`);
	const unit = m[3] === "s" ? 1000 : 1;
	const min = Number(m[1]) * unit;
	if (m[2] === undefined) return min;
	const max = Number(m[2]) * unit;
	if (max < min) throw new Error(`malformed delay "${spec}" (min > max)`);
	// one keyed draw (F7): reproducible per (seed, scenarioName, stepIndex),
	// never a shared cursor
	const draw = mulberry32(
		hashToInt(`${config.seed}|delay|${key.scenarioName}|${key.stepIndex}`),
	)();
	return min + Math.floor(draw * (max - min + 1));
}

export function resolveEmit(
	partial: EmitPartial,
	channel: Channel,
	config: Config,
	delayKey?: DelayKey,
): NormalizedMessage {
	let delayMs = partial.delayMs ?? 0;
	if (partial.delay !== undefined) {
		if (!delayKey)
			throw new Error("a delay string requires a scenario delayKey (L2-only field)");
		delayMs = parseDelay(partial.delay, config, delayKey);
	}
	return {
		topic: partial.topic,
		payload: partial.payload,
		qos: partial.qos ?? channel.qos ?? 1, // explicit wins, channel fills, spec default last (F13/CR7)
		retain: partial.retain ?? channel.retain ?? false,
		delayMs,
	};
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/engine/resolve-emit.test.ts` — Expected: 7 pass.

- [ ] **Step 5: Gates + commit** (no REQUIREMENTS.md change — R-013's stamping clause lands in Task 6)

Run: `bun scripts/check-docs.ts && bunx tsc --noEmit && bun test` — green.

```bash
git add src/engine/resolve-emit.ts src/engine/resolve-emit.test.ts
git commit -m "engine: resolveEmit choke-point — F13 qos/retain fill + F7 keyed ranged delays"
```

---

### Task 6: `index.ts` — createEngine: emit path, G10 stamping, trigger paths (R-013 → tested)

**Files:**
- Create: `src/engine/index.ts`
- Test: `src/engine/index.test.ts`
- Modify: `REQUIREMENTS.md` (R-013 entry only)

**Interfaces:**
- Consumes: everything Tasks 2–5 produced, plus `createFaker`/`l1Floor` from `./faker.ts`.
- Produces:

```ts
export interface EngineDeps {
	config: Config;
	broker: { emit(message: NormalizedMessage): Promise<void> };   // structural — NOT the broker/ import (transport isolation)
	registry: () => SpecRegistry;                                   // thunk: always the CURRENT registry (F19)
	record: (v: Omit<Violation, "seq" | "observedAt">) => Violation; // validation-log seam
	dispatch?: DispatchRegistry;                                     // default: defaultDispatch
}
export interface Engine {
	loadHandlers(dir: string): Promise<string[]>;
	onInbound(event: InboundEvent): void;     // reactive: L3 (L2 seam empty until R-016)
	onSubscribe(topic: string): void;         // proactive: L3 initialState, else L1 floor
	tick(): void;                             // one virtual tick (autonomous only; no-op in passive)
	startTicks(): void; stopTicks(): void;    // wall-paced ticks (autonomous + wallClock only)
	publish(partial: EmitPartial, source: EmitSource, delayKey?: DelayKey): void; // scheduler-routed emit
	faker: Faker;                             // the one keyed faker — R-017 injects this into control-plane later
	now(): number;
	pending(): { scheduled: number; settled: boolean };
	idle(): Promise<void>;
	reset(seed?: number): void;               // Task 7's subject
}
export function createEngine(deps: EngineDeps): Engine;
```

Emit path (the R-013 stamping clause, G10/F5): `publish(partial, source, delayKey?)` matches `partial.topic` against the current registry; **matched** → `resolveEmit` → `scheduler.scheduleEmit(delayMs, task)` where the task Ajv-rechecks the payload — invalid drops the emit and `record`s a `mock` violation stamped with `source` (F5, no re-draw per D-008), valid `await broker.emit({...msg, delayMs: undefined})`; **unmatched** → `record` a `mock` `unknown-topic` violation stamped with `source` AND still emit at `qos 1, retain false` (observe-and-surface applies to mock traffic symmetrically: surfaced loudly, never blocked — flag this behavior in the entry statement? No: it is within R-013's "stamped" clause scope and mirrors the client-side unknown-topic path; note it in code comments). Handler ctx: `publish` routes here with `{ layer: 'L3' }`; `random()` = `mulberry32(hashToInt(`${seed}|ctx|${invocationKey}`))` where `invocationKey` is `inbound|${meta.seq}|${modulePath}|${order}`, `subscribe|${topic}|…`, or `tick|${tickIndex}|…` (F7(ii): a fresh per-invocation stream, no module-global cursor); `now()` = `scheduler.now()`. Proactive subscribe: `registry().match(topic)` → L3 `initialState` if a handler matches, else `l1Floor(channel, faker)` with the matched params → valid payload publishes `{topic, payload}` through the same emit path with `{ layer: 'L1' }`; floor violation `record`s as-is (already `L1`-stamped by `l1Floor`). Passive mode: `tick()`/`startTicks()` are no-ops when `config.mode === 'passive'` (F10).

- [ ] **Step 1: Write the failing tests**

Create `src/engine/index.test.ts`:

```ts
import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { loadConfig } from "../config/index.ts";
import type {
	Channel,
	NormalizedMessage,
	SpecRegistry,
	Violation,
} from "../model/index.ts";
import { createDispatchRegistry } from "./dispatch.ts";
import { createEngine } from "./index.ts";

const stateSchema = {
	type: "object",
	required: ["status"],
	additionalProperties: false,
	properties: { status: { type: "string", enum: ["ok", "warn"] } },
};

function makeChannel(topic: string, schema: object, qos: 0 | 1 | 2, retain: boolean): Channel {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
	return {
		topic,
		direction: "toClient",
		service: "t",
		schema,
		validate: (p) => (v(p) ? [] : (v.errors ?? [])),
		qos,
		retain,
	};
}

// one toClient state channel with {param}; match captures the id
function makeRegistry(): SpecRegistry {
	const state = makeChannel("state/{deviceId}", stateSchema, 2, true);
	return {
		match(topic: string) {
			const m = topic.match(/^state\/([^/]+)$/);
			if (m?.[1]) return { channel: state, params: { deviceId: m[1] } };
			return undefined;
		},
		matchesFilter: () => false,
		channels: () => [state],
	};
}

function harness(seed = 1) {
	const config = loadConfig({ seed });
	const emitted: NormalizedMessage[] = [];
	const violations: Omit<Violation, "seq" | "observedAt">[] = [];
	let seq = 0;
	const engine = createEngine({
		config,
		broker: {
			emit: async (m) => {
				emitted.push(m);
			},
		},
		registry: makeRegistry,
		record: (v) => {
			violations.push(v);
			return { ...v, seq: ++seq, observedAt: "t" } as Violation;
		},
		dispatch: createDispatchRegistry(),
	});
	return { config, engine, emitted, violations };
}

test("R-013: an authored {topic, payload} reaches broker.emit with channel-resolved qos/retain — never undefined", async () => {
	const { engine, emitted } = harness();
	engine.publish({ topic: "state/d1", payload: { status: "ok" } }, { layer: "L3" });
	await engine.idle();
	expect(emitted).toEqual([
		{ topic: "state/d1", payload: { status: "ok" }, qos: 2, retain: true, delayMs: undefined },
	]);
});

test("R-013/G10: an off-spec L2-sourced emit drops (F5) and surfaces a mock violation stamped with scenarioName/stepIndex", async () => {
	const { engine, emitted, violations } = harness();
	engine.publish(
		{ topic: "state/d1", payload: { status: "BOGUS" } },
		{ layer: "L2", scenarioName: "warm-up", stepIndex: 2 },
	);
	await engine.idle();
	expect(emitted).toEqual([]); // dropped, never emitted (F5; no re-draw per D-008)
	expect(violations.length).toBe(1);
	const v = violations[0];
	expect(v?.origin).toBe("mock");
	expect(v?.kind).toBe("schema");
	expect(v?.emitSource).toEqual({ layer: "L2", scenarioName: "warm-up", stepIndex: 2 });
	expect(v?.errors?.[0]?.keyword).toBe("enum");
});

test("R-013: an L2 ranged delay flows keyed through the choke-point and advances logical now() finitely", async () => {
	const { config, engine, emitted } = harness(7);
	const before = engine.now();
	engine.publish(
		{ topic: "state/d1", payload: { status: "ok" }, delay: "150-300ms" },
		{ layer: "L2", scenarioName: "warm-up", stepIndex: 0 },
		{ scenarioName: "warm-up", stepIndex: 0 },
	);
	await engine.idle();
	expect(emitted.length).toBe(1);
	const advanced = engine.now() - before;
	expect(Number.isFinite(advanced)).toBe(true);
	expect(advanced).toBeGreaterThanOrEqual(150);
	expect(advanced).toBeLessThanOrEqual(300);
	expect(before).toBe(config.fixedEpoch);
});

test("unmatched mock topic: surfaced as unknown-topic (stamped) AND still emitted at defaults — observe-and-surface", async () => {
	const { engine, emitted, violations } = harness();
	engine.publish({ topic: "no/such/topic", payload: { a: 1 } }, { layer: "L3" });
	await engine.idle();
	expect(emitted).toEqual([
		{ topic: "no/such/topic", payload: { a: 1 }, qos: 1, retain: false, delayMs: undefined },
	]);
	expect(violations[0]?.kind).toBe("unknown-topic");
	expect(violations[0]?.origin).toBe("mock");
	expect(violations[0]?.emitSource).toEqual({ layer: "L3" });
});

test("reactive path: inbound dispatches the matched L3 handler; ctx.publish is stamped L3; ctx.random is per-invocation deterministic", async () => {
	const draws: number[][] = [];
	for (let run = 0; run < 2; run++) {
		const config = loadConfig({ seed: 7 });
		const emitted: NormalizedMessage[] = [];
		const d = createDispatchRegistry();
		const engine = createEngine({
			config,
			broker: {
				emit: async (m) => {
					emitted.push(m);
				},
			},
			registry: makeRegistry,
			record: (v) => ({ ...v, seq: 1, observedAt: "t" }) as Violation,
			dispatch: d,
		});
		const seen: number[] = [];
		d.register(
			"state/{deviceId}",
			() => ({
				onInbound(_event, ctx) {
					seen.push(ctx.random(), ctx.random());
					ctx.publish({ topic: "state/replayed", payload: { status: "ok" } });
				},
			}),
			"h.ts",
		);
		d.instantiate();
		engine.onInbound({
			message: { topic: "state/d1", payload: { status: "warn" } },
			meta: { clientId: "c1", seq: 1, receivedAt: 0 },
		});
		await engine.idle();
		expect(emitted.length).toBe(1);
		expect(emitted[0]?.topic).toBe("state/replayed");
		expect(emitted[0]?.qos).toBe(2); // ctx.publish rode the choke-point (channel-resolved)
		draws.push(seen);
	}
	expect(draws[0]).toEqual(draws[1]); // per-invocation stream reproducible across runs (F7)
});

test("proactive path: subscribe with no L3 handler falls to the L1 floor and emits a valid retained payload", async () => {
	const { engine, emitted, violations } = harness();
	engine.onSubscribe("state/d7");
	await engine.idle();
	expect(violations).toEqual([]);
	expect(emitted.length).toBe(1);
	expect(emitted[0]?.topic).toBe("state/d7");
	expect(emitted[0]?.retain).toBe(true);
	expect(["ok", "warn"]).toContain((emitted[0]?.payload as { status: string }).status);
});

test("passive mode fires no ticks (F10)", async () => {
	const config = loadConfig({ seed: 1, mode: "passive" });
	const emitted: NormalizedMessage[] = [];
	const d = createDispatchRegistry();
	const engine = createEngine({
		config,
		broker: { emit: async (m) => { emitted.push(m); } },
		registry: makeRegistry,
		record: (v) => ({ ...v, seq: 1, observedAt: "t" }) as Violation,
		dispatch: d,
	});
	let ticked = 0;
	d.register("state/{deviceId}", () => ({ tick() { ticked++; } }), "h.ts");
	d.instantiate();
	engine.tick();
	await engine.idle();
	expect(ticked).toBe(0);
});
```

- [ ] **Step 2: Run — fails (module missing)**

Run: `bun test src/engine/index.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/engine/index.ts`:

```ts
// The engine composition (contracts §3): trigger paths (reactive L3→[L2 seam],
// proactive L3→L1, tick L3), the emit path (resolveEmit → pre-emit Ajv recheck
// → drop-and-surface F5 / broker.emit), and G10 emitSource stamping. The
// broker arrives as a structural {emit} — engine/ never imports broker/
// (transport isolation); the registry arrives as a thunk (F19 hot-swap); the
// validation log arrives as a record function (composition-root seam, F11).
import type {
	Config,
	EmitSource,
	Faker,
	InboundEvent,
	NormalizedMessage,
	SpecRegistry,
	Violation,
} from "../model/index.ts";
import { type DispatchRegistry, defaultDispatch } from "./dispatch.ts";
import { createFaker, l1Floor } from "./faker.ts";
import { hashToInt, mulberry32 } from "./prng.ts";
import { type DelayKey, type EmitPartial, resolveEmit } from "./resolve-emit.ts";
import { createScheduler } from "./scheduler.ts";

export type { DelayKey, EmitPartial };

export interface EngineDeps {
	config: Config;
	broker: { emit(message: NormalizedMessage): Promise<void> };
	registry: () => SpecRegistry;
	record: (v: Omit<Violation, "seq" | "observedAt">) => Violation;
	dispatch?: DispatchRegistry;
}

export interface Engine {
	loadHandlers(dir: string): Promise<string[]>;
	onInbound(event: InboundEvent): void;
	onSubscribe(topic: string): void;
	tick(): void;
	startTicks(): void;
	stopTicks(): void;
	publish(partial: EmitPartial, source: EmitSource, delayKey?: DelayKey): void;
	faker: Faker;
	now(): number;
	pending(): { scheduled: number; settled: boolean };
	idle(): Promise<void>;
	reset(seed?: number): void;
}

export function createEngine(deps: EngineDeps): Engine {
	const { config, broker, registry, record } = deps;
	const dispatch = deps.dispatch ?? defaultDispatch;
	const scheduler = createScheduler(config);
	let seed = config.seed;
	let faker = createFaker(config);
	let tickIndex = 0;

	function stampViolation(
		v: Omit<Violation, "seq" | "observedAt" | "emitSource">,
		source: EmitSource,
	): void {
		record({ ...v, emitSource: source });
	}

	// the one emit path — everything mock passes through here (G10/F5/F13)
	function publish(partial: EmitPartial, source: EmitSource, delayKey?: DelayKey): void {
		const m = registry().match(partial.topic);
		if (!m) {
			// surfaced loudly AND still delivered — observe-and-surface applies to
			// mock traffic symmetrically; defaults qos 1 / retain false (no channel
			// to resolve against)
			stampViolation(
				{
					origin: "mock",
					kind: "unknown-topic",
					severity: "error",
					topic: partial.topic,
					detail: "unknown-topic: mock emit matches no channel",
					payload: partial.payload,
				},
				source,
			);
			scheduler.scheduleEmit(partial.delayMs ?? 0, async () => {
				await broker.emit({
					topic: partial.topic,
					payload: partial.payload,
					qos: partial.qos ?? 1,
					retain: partial.retain ?? false,
					delayMs: undefined,
				});
			});
			return;
		}
		const channel = m.channel;
		const msg = resolveEmit(partial, channel, { ...config, seed }, delayKey);
		scheduler.scheduleEmit(msg.delayMs ?? 0, async () => {
			const errors = channel.validate(msg.payload);
			if (errors.length > 0) {
				// F5 drop-and-surface; no keyed re-draw (D-008)
				const first = errors[0];
				stampViolation(
					{
						origin: "mock",
						kind: "schema",
						severity: "error",
						topic: msg.topic,
						channel: channel.topic,
						detail: `${first?.instancePath || "/"}: ${first?.keyword ?? "unknown"}`,
						payload: msg.payload,
						errors,
					},
					source,
				);
				return;
			}
			await broker.emit({ ...msg, delayMs: undefined });
		});
	}

	function makeCtx(invocationKey: string) {
		const rand = mulberry32(hashToInt(`${seed}|ctx|${invocationKey}`));
		return {
			publish: (msg: Partial<NormalizedMessage> & { topic: string }) =>
				publish(msg, { layer: "L3" as const }),
			random: () => rand(),
			now: () => scheduler.now(),
		};
	}

	function dispatchTick(): void {
		const idx = tickIndex++;
		for (const { handler, registration } of dispatch.all()) {
			handler.tick?.(
				makeCtx(`tick|${idx}|${registration.modulePath}|${registration.order}`),
			);
		}
	}

	return {
		async loadHandlers(dir) {
			const paths = await dispatch.loadHandlers(dir);
			dispatch.instantiate();
			return paths;
		},

		onInbound(event) {
			scheduler.post(() => {
				const sel = dispatch.select(event.message.topic, registry());
				// L3 → [L2 seam: the scenario runner slots in here, R-016] ; no L1 on
				// the reactive path (contracts §3 trigger table)
				sel?.handler.onInbound?.(
					event,
					makeCtx(
						`inbound|${event.meta.seq}|${sel.registration.modulePath}|${sel.registration.order}`,
					),
				);
			});
		},

		onSubscribe(topic) {
			scheduler.post(async () => {
				const reg = registry();
				const m = reg.match(topic);
				if (!m) return;
				const sel = dispatch.select(topic, reg);
				if (sel?.handler.initialState) {
					sel.handler.initialState(
						topic,
						makeCtx(
							`subscribe|${topic}|${sel.registration.modulePath}|${sel.registration.order}`,
						),
					);
					return;
				}
				// L1 is the proactive floor: keyed per instance params (F7)
				const out = await l1Floor(m.channel, (ch) => faker(ch, m.params));
				if ("violation" in out) {
					record(out.violation); // already L1-stamped by l1Floor
					return; // floor stays empty on failure (F5, D-008)
				}
				publish({ topic, payload: out.payload }, { layer: "L1" });
			});
		},

		tick() {
			if (config.mode === "passive") return; // F10: passive fires no ticks
			scheduler.advanceTick(dispatchTick);
		},

		startTicks() {
			if (config.mode === "passive" || !config.wallClock) return;
			scheduler.startWallTicks(dispatchTick);
		},

		stopTicks: () => scheduler.stopTicks(),

		publish,

		get faker() {
			return faker;
		},

		now: () => scheduler.now(),
		pending: () => scheduler.pending(),
		idle: () => scheduler.idle(),

		reset(newSeed) {
			scheduler.reset();
			if (newSeed !== undefined) seed = newSeed;
			faker = createFaker({ ...config, seed });
			tickIndex = 0;
			dispatch.instantiate(); // fresh L3 instances — factories, not reused state
		},
	};
}
```

Note: `l1Floor(m.channel, (ch) => faker(ch, m.params))` adapts the instance-params call mode through `l1Floor`'s `Faker`-shaped parameter; `engine.faker` itself stays the two-mode canonical function (§3).

- [ ] **Step 4: Run tests**

Run: `bun test src/engine/index.test.ts` — Expected: 7 pass. Then `bun test src/engine/` — everything green together.

- [ ] **Step 5: Flip R-013**

In `REQUIREMENTS.md`, R-013: STATUS → `tested`; insert after COVERS:

```markdown
**IMPL**: src/engine/resolve-emit.ts, src/engine/index.ts
**TEST**: src/engine/resolve-emit.test.ts, src/engine/index.test.ts
```

- [ ] **Step 6: Gates + commit**

Run: `bun scripts/check-docs.ts && bunx tsc --noEmit && bun test` — green.

```bash
git add src/engine/index.ts src/engine/index.test.ts REQUIREMENTS.md
git commit -m "engine: createEngine — emit path w/ G10 stamping + trigger paths (R-013 → tested)"
```

---

### Task 7: reset + end-to-end determinism (R-014 → tested)

**Files:**
- Test: `src/engine/reset.test.ts` (new; `reset()` itself landed in Task 6's `index.ts`)
- Modify: `REQUIREMENTS.md` (R-014 entry only)

**Interfaces:**
- Consumes: the full Task 6 `Engine` surface.

- [ ] **Step 1: Write the failing-or-proving tests**

Create `src/engine/reset.test.ts`:

```ts
import { expect, test } from "bun:test";
import { loadConfig } from "../config/index.ts";
import type { NormalizedMessage, SpecRegistry, Violation } from "../model/index.ts";
import Ajv2020 from "ajv/dist/2020";
import { createDispatchRegistry } from "./dispatch.ts";
import { createEngine } from "./index.ts";

const schema = {
	type: "object",
	required: ["n"],
	additionalProperties: false,
	properties: { n: { type: "number" } },
};

function makeRegistry(): SpecRegistry {
	const v = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
	const ch = {
		topic: "state/{id}",
		direction: "toClient" as const,
		service: "t",
		schema,
		validate: (p: unknown) => (v(p) ? [] : (v.errors ?? [])),
		qos: 1 as const,
		retain: true,
	};
	return {
		match: (topic: string) => {
			const m = topic.match(/^state\/([^/]+)$/);
			return m?.[1] ? { channel: ch, params: { id: m[1] } } : undefined;
		},
		matchesFilter: () => false,
		channels: () => [ch],
	};
}

// A stateful handler + a scripted run: reset must clear handler state (fresh
// factory instance), re-seed ctx streams, and re-epoch the clock, so the same
// script replays byte-identically.
function build(seed: number) {
	const config = loadConfig({ seed });
	const emitted: [string, unknown, number][] = [];
	const d = createDispatchRegistry();
	const engine = createEngine({
		config,
		broker: {
			emit: async (m: NormalizedMessage) => {
				emitted.push([m.topic, m.payload, engine.now()]);
			},
		},
		registry: makeRegistry,
		record: (v) => ({ ...v, seq: 1, observedAt: "t" }) as Violation,
		dispatch: d,
	});
	let counter = 0; // factory-scoped: a re-instantiated handler starts fresh
	d.register("state/{id}", () => {
		counter = 0;
		return {
			onInbound(_event, ctx) {
				counter++;
				ctx.publish({
					topic: "state/replay",
					payload: { n: counter + ctx.random() },
				});
			},
		};
	}, "h.ts");
	d.instantiate();
	return { engine, emitted };
}

async function script(engine: ReturnType<typeof build>["engine"]): Promise<void> {
	engine.onInbound({
		message: { topic: "state/a", payload: { n: 1 } },
		meta: { clientId: "c", seq: 1, receivedAt: 0 },
	});
	engine.onInbound({
		message: { topic: "state/b", payload: { n: 2 } },
		meta: { clientId: "c", seq: 2, receivedAt: 0 },
	});
	await engine.idle();
}

test("R-014: reset + same seed replays the same script to a byte-identical emission stream", async () => {
	const { engine, emitted } = build(7);
	await script(engine);
	const first = JSON.stringify(emitted);
	expect(emitted.length).toBe(2);

	emitted.length = 0;
	engine.reset();
	await script(engine);
	expect(JSON.stringify(emitted)).toBe(first); // handler state, ctx streams, clock all restored
});

test("R-014: reset(newSeed) re-keys the PRNGs — the same script diverges", async () => {
	const { engine, emitted } = build(7);
	await script(engine);
	const first = JSON.stringify(emitted);

	emitted.length = 0;
	engine.reset(8);
	await script(engine);
	expect(JSON.stringify(emitted)).not.toBe(first);
});

test("R-014: reset clears pending scheduled work and re-epochs now()", async () => {
	const { engine, emitted } = build(1);
	engine.publish(
		{ topic: "state/x", payload: { n: 1 }, delay: "500ms" },
		{ layer: "L2", scenarioName: "s", stepIndex: 0 },
		{ scenarioName: "s", stepIndex: 0 },
	);
	engine.reset();
	await engine.idle();
	expect(emitted).toEqual([]); // the in-flight step never fires post-reset
	expect(engine.pending()).toEqual({ scheduled: 0, settled: true });
	expect(engine.now()).toBe(loadConfig({ seed: 1 }).fixedEpoch);
});

test("R-014: reset re-instantiates factories — handler instance state does not survive", async () => {
	const { engine, emitted } = build(7);
	await script(engine); // counter reached 2
	engine.reset();
	engine.onInbound({
		message: { topic: "state/a", payload: { n: 1 } },
		meta: { clientId: "c", seq: 1, receivedAt: 0 },
	});
	await engine.idle();
	const last = emitted.at(-1);
	// a surviving instance would emit n ≈ 3.x; a fresh one emits n ≈ 1.x
	expect((last?.[1] as { n: number }).n).toBeLessThan(2);
});
```

- [ ] **Step 2: Run**

Run: `bun test src/engine/reset.test.ts`
Expected: 4 pass (reset() shipped in Task 6; these tests prove the R-014 statement). If any fails, that is a real reset defect in Task 6's implementation — fix `index.ts`/`scheduler.ts` (likely spots: stale scheduler queues, faker not re-keyed, `dispatch.instantiate()` missing) and re-run; do not weaken assertions.

- [ ] **Step 3: Flip R-014**

In `REQUIREMENTS.md`, R-014: STATUS → `tested`; insert after COVERS:

```markdown
**IMPL**: src/engine/index.ts, src/engine/scheduler.ts
**TEST**: src/engine/reset.test.ts
```

- [ ] **Step 4: Gates + commit**

Run: `bun scripts/check-docs.ts && bunx tsc --noEmit && bun test` — green.

```bash
git add src/engine/reset.test.ts REQUIREMENTS.md
git commit -m "engine: reset — replay-identical restore, re-seed, re-instantiate (R-014 → tested)"
```

---

### Task 8: Final verification + handoff state (controller-run, no commit)

- [ ] **Step 1:** `bun scripts/check-docs.ts && bunx tsc --noEmit && bun test` — checker ok (31 requirements, 8 decisions), suite green.
- [ ] **Step 2:** Confirm statuses: R-010, R-012, R-013, R-014 all `tested`; tier-2 is now fully `tested` (R-010..R-015).
- [ ] **Step 3:** Handoff notes for the next round: R-016 (scenarios/L2 runner) slots into `onInbound`'s marked seam and `publish`'s `delayKey` plumbing; R-017 injects `engine.faker`/`engine.publish` into the control-plane (F11, discharging D-004's obligation) and routes `/publish` through `resolveEmit`; R-018 consumes `engine.pending()`/`idle()`; R-029 (determinism gate) builds on the R-010/R-014 tests over the F9 projection via `up --ci`.
