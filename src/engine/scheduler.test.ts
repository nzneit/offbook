import { expect, test } from "bun:test";
import { loadConfig } from "#src/config/index.ts";
import { hashToInt, mulberry32 } from "./prng.ts";
import { createScheduler, timelineOrder } from "./scheduler.ts";

// [utest->R-010]

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
	s.advanceTick(() => {
		ticksAt.push(s.now());
	});
	s.advanceTick(() => {
		ticksAt.push(s.now());
	});
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

test("reset during an in-flight task cannot drive pending() negative or deadlock idle() (epoch guard)", async () => {
	const s = createScheduler(loadConfig({ seed: 1 }));
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let started: () => void = () => {};
	const running = new Promise<void>((r) => {
		started = r;
	});
	s.post(async () => {
		started();
		await gate;
	});
	await running; // the task is genuinely mid-flight, not merely queued
	s.reset();
	release();
	await Bun.sleep(10); // let the stale task's finally run
	expect(s.pending()).toEqual({ scheduled: 0, settled: true });
	// the scheduler still works after the stale completion: no -1, no deadlock
	let ran = false;
	s.post(() => {
		ran = true;
	});
	await s.idle();
	expect(ran).toBe(true);
});

test("wall-paced ticks: startWallTicks fires on real cadence, advances now() per tick, stopTicks halts (CR6)", async () => {
	const config = loadConfig({ seed: 1, wallClock: true, tickIntervalMs: 20 });
	const s = createScheduler(config);
	const ticksAt: number[] = [];
	const wallStart = Date.now();
	s.startWallTicks(() => {
		ticksAt.push(s.now());
	});
	while (ticksAt.length < 2 && Date.now() - wallStart < 1000) {
		await Bun.sleep(5);
	}
	s.stopTicks();
	const count = ticksAt.length;
	expect(count).toBeGreaterThanOrEqual(2);
	expect(Date.now() - wallStart).toBeGreaterThanOrEqual(30); // ~2×20ms, coalescing-tolerant
	expect(ticksAt[0]).toBe(config.fixedEpoch + config.tickIntervalMs);
	expect(ticksAt[1]).toBe(config.fixedEpoch + 2 * config.tickIntervalMs);
	await Bun.sleep(50);
	expect(ticksAt.length).toBe(count); // nothing fires after stopTicks
	await s.idle();
});

test("a throwing task is surfaced and does not strand the queue or deadlock idle()", async () => {
	const errors: unknown[] = [];
	const s = createScheduler(loadConfig({ seed: 1 }), (err) => {
		errors.push(err);
	});
	const ran: string[] = [];
	s.post(async () => {
		throw new Error("broker.emit rejected");
	});
	s.post(() => {
		ran.push("after-throw");
	});
	s.scheduleEmit(10, () => {
		ran.push("emit");
	});
	await s.idle();
	expect(ran).toEqual(["after-throw", "emit"]);
	expect(errors.length).toBe(1);
	expect((errors[0] as Error).message).toBe("broker.emit rejected");
	expect(s.pending()).toEqual({ scheduled: 0, settled: true });
});

test("wall-paced overlapping delays stamp the same logical times as virtual mode (no double-count)", async () => {
	const config = loadConfig({ seed: 1, wallClock: true });
	const s = createScheduler(config);
	const at: number[] = [];
	s.scheduleEmit(40, () => {
		at.push(s.now());
	});
	s.scheduleEmit(40, () => {
		at.push(s.now());
	});
	await s.idle();
	expect(at).toEqual([config.fixedEpoch + 40, config.fixedEpoch + 40]);
	s.stopTicks();
});

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

test("timelineOrder: dueAt dominates; insertion seq breaks ties, in both directions", () => {
	expect(
		timelineOrder({ dueAt: 1, seq: 9 }, { dueAt: 2, seq: 0 }),
	).toBeLessThan(0);
	expect(
		timelineOrder({ dueAt: 2, seq: 0 }, { dueAt: 1, seq: 9 }),
	).toBeGreaterThan(0);
	expect(
		timelineOrder({ dueAt: 5, seq: 1 }, { dueAt: 5, seq: 2 }),
	).toBeLessThan(0);
	expect(
		timelineOrder({ dueAt: 5, seq: 2 }, { dueAt: 5, seq: 1 }),
	).toBeGreaterThan(0);
	expect(timelineOrder({ dueAt: 5, seq: 3 }, { dueAt: 5, seq: 3 })).toBe(0);
});
