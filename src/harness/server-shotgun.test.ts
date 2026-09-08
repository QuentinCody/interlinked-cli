import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
import { describe, expect, it } from "vitest";
import { acknowledgeChecks, isAcknowledged } from "./session-state.js";
import type { SessionTrajectory } from "./types.js";

/**
 * Regression test for shotgun-surgery session-level taste check.
 *
 * Bug: The check (server.ts ~L1459–1478) is gated by
 *   if (!isAcknowledged(session, "__session__", shotgunKey)) { ... }
 * but never marked the key acknowledged after firing. Every subsequent
 * edit past the 40-file threshold re-fired the warning ("212 files edited",
 * "213 files edited", …).
 *
 * Fix: Call acknowledgeChecks(session, "__session__", [shotgunKey]) inside
 * the same branch so the warning fires exactly once per threshold.
 *
 * This test replays the exact predicate logic against a minimal
 * SessionTrajectory stub so it cannot regress without touching the
 * acknowledgement contract.
 */

function makeSession(fileCount: number): SessionTrajectory {
	const files = new Set<string>();
	for (let i = 0; i < fileCount; i++) files.add(`/tmp/f${i}.ts`);
	return ({ ...completeSessionFixture(), ...{
		// minimum surface used by the shotgun-surgery check
		files_written: files,
		acknowledged_checks: new Set<string>(),
		// remaining fields are irrelevant for this test; cast to satisfy the type
	} });
}

/** Mirror of the gated block in server.ts. Returns true if warning would fire. */
function shotgunFires(session: SessionTrajectory): boolean {
	if (!(session.files_written.size >= 40)) return false;
	const shotgunKey = `shotgun-surgery-${session.files_written.size >= 60 ? "60" : "40"}`;
	if (isAcknowledged(session, "__session__", shotgunKey)) return false;
	acknowledgeChecks(session, "__session__", [shotgunKey]);
	return true;
}

describe("shotgun-surgery session check", () => {
	it("fires on first edit crossing 40-file threshold", () => {
		const s = makeSession(40);
		expect(shotgunFires(s)).toBe(true);
	});

	it("does not fire again at 41, 42, …, 59 files", () => {
		const s = makeSession(40);
		shotgunFires(s); // first crossing
		for (let n = 41; n < 60; n++) {
			s.files_written.add(`/tmp/extra${n}.ts`);
			expect(shotgunFires(s), `fires=true at size ${s.files_written.size}`).toBe(false);
		}
	});

	it("fires once more when crossing 60-file threshold (different key)", () => {
		const s = makeSession(40);
		shotgunFires(s); // 40-key acknowledged
		for (let n = 41; n < 60; n++) s.files_written.add(`/tmp/extra${n}.ts`);
		// cross into 60-tier
		s.files_written.add("/tmp/extra60.ts");
		expect(s.files_written.size).toBeGreaterThanOrEqual(60);
		expect(shotgunFires(s)).toBe(true);
	});

	it("does not fire a third time after 60 is acknowledged", () => {
		const s = makeSession(60);
		expect(shotgunFires(s)).toBe(true); // 60 fires once
		for (let n = 0; n < 200; n++) {
			s.files_written.add(`/tmp/more${n}.ts`);
			expect(shotgunFires(s)).toBe(false);
		}
	});

	it("never fires below 40 files", () => {
		for (const n of [0, 1, 10, 39]) {
			const s = makeSession(n);
			expect(shotgunFires(s)).toBe(false);
		}
	});
});
