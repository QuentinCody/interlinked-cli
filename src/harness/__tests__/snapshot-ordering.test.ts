// Regression test for the "snapshot written before post-event mutations"
// bug flagged in the Plan 08 review.
//
// Background: the live-snapshot durability path used to write the snapshot
// immediately after `sessions.recordEvent(event)` inside `processEvent`. But
// PostToolUse handlers and SkillEnter handlers mutate session state AFTER
// `recordEvent` — `tdd_cycles`, `assertion_counts`, `active_skills`, etc.
// On a daemon restart between two events those post-event mutations were
// lost even though the snapshot durability path was meant to preserve them.
//
// The fix moved the snapshot write to a try/finally in `evaluateEventLine`,
// so it fires AFTER `processEvent` returns (or throws). This test enforces
// that ordering by reading the source — running the actual daemon to check
// timing would be heavy and flaky compared to a structural assertion.
//
// NOTE: `processEvent` / `evaluateEventLine` were extracted from `server.ts`
// into the `createEventLoop` factory in `server-event-loop.ts` during the
// per-file line-cap decomposition — this test reads them from their new home.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EVENT_LOOP_TS = readFileSync(
	join(process.cwd(), "src", "harness", "server-event-loop.ts"),
	"utf-8",
);

describe("processEvent snapshot ordering (Plan 08 review fix)", () => {
	it("does NOT write the snapshot directly after recordEvent in processEvent", () => {
		// The bug shape: `sessions.recordEvent(event)` followed within ~10
		// lines by `writeLiveSnapshot(CWD, ...)`. Sliding-window check on
		// the source. If a future refactor reintroduces the early write,
		// this assertion catches it.
		const recordIdx = EVENT_LOOP_TS.indexOf("sessions.recordEvent(event);");
		expect(recordIdx).toBeGreaterThan(0);

		// Window: 600 chars after recordEvent — comfortably past any plausible
		// "early durability" placement.
		const window = EVENT_LOOP_TS.slice(recordIdx, recordIdx + 600);
		expect(window).not.toContain("writeLiveSnapshot");
	});

	it("writes the snapshot inside evaluateEventLine's finally block", () => {
		// The INVARIANT is that the durability write happens in a `finally`, so a
		// throw in `processEvent` still persists the session state it mutated.
		//
		// This used to assert the literal call `writeLiveSnapshot(CWD,
		// sessionIdForSnap, snap)` appeared after `} finally {`. That pinned the
		// call SITE rather than the property: when the write was extracted into
		// `persistEventSnapshot` (verbatim, same try/catch scope, same fail-open
		// contract) the assertion went red while the guarantee was untouched —
		// a test that fails on a safe refactor and would still pass if someone
		// moved the call OUT of the finally into a differently-named helper.
		//
		// Now assert the shape that actually matters: the finally clause invokes
		// the persistence path, and that path is what performs the write.
		const fnIdx = EVENT_LOOP_TS.indexOf("async function evaluateEventLine(");
		expect(fnIdx).toBeGreaterThan(0);

		const fnSlice = EVENT_LOOP_TS.slice(fnIdx, fnIdx + 4000);
		const finallyIdx = fnSlice.indexOf("} finally {");
		expect(finallyIdx).toBeGreaterThan(0);

		// The finally must call the persistence path, not merely mention it.
		const afterFinally = fnSlice.slice(finallyIdx);
		expect(afterFinally).toContain("persistEventSnapshot(");

		// …and that path must be the thing that actually writes the snapshot.
		const persistIdx = EVENT_LOOP_TS.indexOf("function persistEventSnapshot(");
		expect(persistIdx).toBeGreaterThan(0);
		expect(EVENT_LOOP_TS.slice(persistIdx, persistIdx + 2000)).toContain("writeLiveSnapshot(");
	});

	it("captures session_id before the try/finally so the finally has it on throw", () => {
		// If a future refactor moves session_id parsing inside the try, an
		// exception in processEvent leaves the finally with no session id and
		// silently skips the snapshot. Lock the ordering.
		const fnIdx = EVENT_LOOP_TS.indexOf("async function evaluateEventLine(");
		const fnSlice = EVENT_LOOP_TS.slice(fnIdx, fnIdx + 4000);
		// The capture was inlined as `sessionIdForSnap = parsed.session_id` until
		// the 2026-09-03 cognitive-15 flattening moved the parse into
		// `readEventLineSnapshotKeys` and destructured its result. The ORDERING
		// invariant is unchanged — and the pin must keep failing if a future
		// refactor moves the destructuring inside the try — so anchor on the
		// binding itself rather than on one particular parse expression.
		const sessionIdAssignIdx = fnSlice.indexOf("sessionId: sessionIdForSnap");
		// The processEvent call sits inside the try that the finally guards; assert
		// the session_id was captured before it. Anchor on the `const decision =`
		// assignment rather than the exact call expression — the replay clock
		// wraps processEvent in a conditional (runWithClock) and the pin must
		// survive that shape while still locking the ordering.
		const processEventCallIdx = fnSlice.indexOf("const decision =");

		expect(sessionIdAssignIdx).toBeGreaterThan(0);
		expect(processEventCallIdx).toBeGreaterThan(sessionIdAssignIdx);
	});
});
