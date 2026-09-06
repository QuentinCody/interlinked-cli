import { describe, expect, it } from "vitest";
import { PROJECTION_ROWS, omittingRow, row, write } from "./gen-shadow-corpus-rows.mjs";

/** The rows are DATA the generator turns into fixtures, so the generator's own
 *  run is where a wrong expectation is caught. What it cannot catch is a row
 *  that quietly stops existing — a deleted id regenerates a smaller corpus and
 *  every remaining row still agrees. These cases pin the table's shape and the
 *  ids the fourth review's findings are pinned by. */
describe("PROJECTION_ROWS — positive (must hold)", () => {
	it("P1: every row id is unique", () => {
		const ids = PROJECTION_ROWS.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("P2: no row lists the same path as both touched and omitted", () => {
		for (const item of PROJECTION_ROWS) {
			expect(item.omits.filter((path) => item.touches.includes(path))).toEqual([]);
		}
	});

	it("P3: the hunk-placement rows finding 2 is pinned by are all present", () => {
		const ids = new Set(PROJECTION_ROWS.map((item) => item.id));
		for (const id of [
			"apply-patch-update-two-hunks",
			"apply-patch-update-dependent-hunks-reject",
			"apply-patch-update-reversed-hunks-reject",
			"apply-patch-update-overlapping-hunks-reject",
			"apply-patch-update-anchor-before-cursor-rejects",
			"apply-patch-update-cursor-disambiguates",
			"apply-patch-update-pure-insertion-at-eof",
			"apply-patch-update-pure-insertion-ignores-anchor",
		]) {
			expect(ids).toContain(id);
		}
	});

	it("P4: the move rows finding 3 is pinned by are all present", () => {
		const ids = new Set(PROJECTION_ROWS.map((item) => item.id));
		for (const id of [
			"apply-patch-move-executable-destination-is-100644",
			"apply-patch-move-onto-existing-keeps-destination-mode",
			"apply-patch-move-under-source-rejects",
			"apply-patch-move-onto-self-rejects",
		]) {
			expect(ids).toContain(id);
		}
	});

	it("P5: omittingRow records the omitted path and leaves the touched list alone", () => {
		const built = omittingRow("src/new.ts", row("id", "note", "reviewed", write("src/new.ts", "x\n"), ["src/a.ts"]));
		expect({ omits: built.omits, touches: built.touches }).toEqual({ omits: ["src/new.ts"], touches: ["src/a.ts"] });
	});
});

describe("PROJECTION_ROWS — negative (must reject)", () => {
	it("N1: omittingRow refuses a path the row also touches — omitted and looked-at are opposites", () => {
		expect(() => omittingRow("src/a.ts", row("id", "note", "reviewed", write("src/a.ts", "x\n"), ["src/a.ts"]))).toThrow(
			"cannot be both touched and omitted",
		);
	});
});
