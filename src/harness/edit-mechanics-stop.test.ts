import { makeSession as completeSessionFixture } from "./__tests__/fixtures/evaluator.js";
// Companion tests for edit-mechanics-stop.ts (LG-5 Stop reflection).

import { describe, expect, it } from "vitest";
import { buildEditMechanicsStopNudge } from "./edit-mechanics-stop.js";
import type { EditMechanics, SessionTrajectory } from "./types.js";

function sessionWith(mechanics: Partial<EditMechanics> | undefined): SessionTrajectory {
	// SAFETY: the formatter reads only `edit_mechanics`; other keys are unused.
	const session = ({ ...completeSessionFixture(), ...{} });
	if (mechanics) {
		session.edit_mechanics = {
			doomed: 0,
			rescued: 0,
			stale_reads: 0,
			blind_edits: 0,
			stale_warned: new Set(),
			...mechanics,
		};
	}
	return session;
}

describe("buildEditMechanicsStopNudge", () => {
	it("fires at the doomed threshold with counts", () => {
		const nudge = buildEditMechanicsStopNudge(sessionWith({ doomed: 3, rescued: 2 }));
		expect(nudge).toMatch(/\[interlinked:edit-mechanics\]/);
		expect(nudge).toMatch(/3 edit\(s\) this session were dead on arrival/);
		expect(nudge).toMatch(/2 recovered in one round trip/);
	});

	it("includes stale and blind counts when present", () => {
		const nudge = buildEditMechanicsStopNudge(
			sessionWith({ doomed: 4, stale_reads: 1, blind_edits: 2 }),
		);
		expect(nudge).toMatch(/1 targeted file\(s\) that drifted/);
		expect(nudge).toMatch(/2 anchored on lines never displayed/);
	});

	it("stays silent below the threshold", () => {
		expect(buildEditMechanicsStopNudge(sessionWith({ doomed: 2, rescued: 2 }))).toBeNull();
	});

	it("stays silent with no mechanics recorded at all", () => {
		expect(buildEditMechanicsStopNudge(sessionWith(undefined))).toBeNull();
	});

	it("omits zero-count clauses", () => {
		const nudge = buildEditMechanicsStopNudge(sessionWith({ doomed: 3 }));
		expect(nudge).not.toMatch(/recovered/);
		expect(nudge).not.toMatch(/drifted/);
		expect(nudge).not.toMatch(/never displayed/);
	});
});
