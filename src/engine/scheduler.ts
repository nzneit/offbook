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
	epoch: number;
}

// The seeded timeline order: dueAt, then insertion seq. Exported for direct
// unit testing (mutation-kill: engine sort internals hide tie-break defects).
export function timelineOrder(
	a: { dueAt: number; seq: number },
	b: { dueAt: number; seq: number },
): number {
	return a.dueAt - b.dueAt || a.seq - b.seq;
}

export function createScheduler(
	config: Config,
	onTaskError?: (err: unknown) => void,
): Scheduler {
	const reportTaskError =
		onTaskError ??
		((err: unknown) => {
			// tier-3 surfacing (contracts §4): a task failure is surfaced-not-silent,
			// and it must never strand the queue or deadlock idle()
			console.error("[offbook] scheduler task failed:", err);
		});
	let logicalNow = config.fixedEpoch;
	let insertionSeq = 0;
	let inFlight = 0; // every accepted task, from enqueue until run() settles (D-003 span)
	let pumping = false;
	let epoch = 0; // bumped by reset(); guards a mid-flight task's stale finally from double-decrementing inFlight
	const immediate: { run: Task; epoch: number }[] = []; // arrival-ordered external events (G23: inbound by meta.seq assignment)
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
				let entry = immediate.shift();
				// Stryker disable next-line ConditionalExpression,EqualityOperator: popping an empty timeline is harmless — sort is a no-op and shift() yields undefined, guarded by `if (next)` below
				if (!entry && timeline.length > 0) {
					// pop the earliest (dueAt, insertionSeq) — the seeded timeline order
					timeline.sort(timelineOrder);
					const next = timeline.shift();
					// Stryker disable next-line ConditionalExpression: shift() on a length-guarded timeline is always defined
					if (next) {
						logicalNow = Math.max(logicalNow, next.dueAt);
						entry = next;
					}
				}
				if (!entry) break;
				const entryEpoch = entry.epoch;
				try {
					// run-to-completion: this await spans the task's own awaits
					// (incl. `await faker()`), so no other task interleaves (G23/D-003)
					await entry.run();
				} catch (err) {
					// a throwing task must not escape as an unhandled rejection: that
					// would strand every queued task and deadlock idle() (review #1)
					reportTaskError(err);
				} finally {
					// queued tasks are discarded; a mid-flight task finishes but its
					// finally skips the decrement (stale epoch) — reset() already
					// accounted for it
					if (entryEpoch === epoch) inFlight--;
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
			immediate.push({ run, epoch });
			void pump();
		},

		scheduleEmit(delayMs, run) {
			inFlight++;
			if (config.wallClock) {
				// wall-paced interactive path (CR6): real elapsed wall time, and the
				// logical clock still advances by the delay when it fires (G5)
				const myEpoch = epoch;
				const dueAt = logicalNow + delayMs;
				const timer = setTimeout(() => {
					// timers are cleared on reset(), so this is belt-and-braces
					// Stryker disable next-line ConditionalExpression: reset() bumps epoch and clears every wall timer in the same synchronous block, so a stale callback can never fire
					if (myEpoch !== epoch) return;
					wallTimers.delete(timer);
					logicalNow = Math.max(logicalNow, dueAt);
					immediate.push({ run, epoch: myEpoch });
					void pump();
				}, delayMs);
				wallTimers.add(timer);
			} else {
				timeline.push({
					dueAt: logicalNow + delayMs,
					seq: insertionSeq++,
					run,
					epoch,
				});
				void pump();
			}
		},

		advanceTick(onTick) {
			// fast-virtual tick (wallClock:false domain): advance the clock by the
			// full interval with no wall delay; caller (engine) gates on mode
			inFlight++;
			immediate.push({
				run: async () => {
					logicalNow += config.tickIntervalMs;
					await onTick();
				},
				epoch,
			});
			void pump();
		},

		startWallTicks(onTick) {
			if (tickTimer) return;
			// unlike scheduleEmit's wall path, the interval itself is not pending
			// work — each FIRED tick is (inFlight++ at fire time), so idle()
			// doesn't hang on a running ticker
			tickTimer = setInterval(() => {
				inFlight++;
				immediate.push({
					run: async () => {
						logicalNow += config.tickIntervalMs;
						await onTick();
					},
					epoch,
				});
				void pump();
			}, config.tickIntervalMs);
		},

		stopTicks() {
			// Stryker disable next-line ConditionalExpression: clearInterval(undefined) is a harmless no-op
			if (tickTimer) clearInterval(tickTimer);
			tickTimer = undefined;
		},

		pending: () => ({ scheduled: inFlight, settled: inFlight === 0 }),

		idle() {
			if (inFlight === 0 && !pumping) return Promise.resolve();
			return new Promise((resolve) => waiters.push(resolve));
		},

		reset() {
			// Stryker disable next-line UpdateOperator: epoch is an identity token; any never-reused value works, direction is irrelevant
			epoch++; // invalidates any task already dequeued and mid-flight in pump()
			immediate.length = 0;
			timeline.length = 0;
			for (const t of wallTimers) clearTimeout(t);
			wallTimers.clear();
			// Stryker disable next-line ConditionalExpression: clearInterval(undefined) is a harmless no-op; the stop-on-reset behavior itself is test-pinned
			if (tickTimer) clearInterval(tickTimer);
			tickTimer = undefined;
			logicalNow = config.fixedEpoch;
			insertionSeq = 0;
			inFlight = 0; // cleared tasks never run; wallClock binding itself is untouched (G5)
			settleCheck();
		},
	};
}
