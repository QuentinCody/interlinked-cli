import { describe, expect, it } from "vitest";
import { formatSessionReworkNudge, MIN_EDITS_FOR_NUDGE, REWORK_RATIO_FLOOR } from "./session-rework.js";

// Census fault: `summary.ratio < REWORK_RATIO_FLOOR` → `<=` survived the
// companion test (docs/reviews/kill-proof-census-harness.md).
describe("formatSessionReworkNudge — ratio floor boundary", () => {
	// test-contract: boundary — a session whose rework ratio equals the floor exactly is nudged
	it("nudges at exactly the rework floor", () => {
		const total = MIN_EDITS_FOR_NUDGE;
		const revisited = total * REWORK_RATIO_FLOOR;
		const line = formatSessionReworkNudge({ totalEdits: total, revisitedEdits: revisited, ratio: revisited / total, topFiles: [{ file: "a.ts", revisits: revisited, edits: total }] });
		expect(line).toContain(`${revisited}/${total} edits (25%)`);
	});
});
