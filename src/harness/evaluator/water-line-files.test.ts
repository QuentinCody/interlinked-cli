// The water-line file list is the single source of truth every ratchet guard
// reads. Before this module existed the list was retyped in five places and
// three of them disagreed (the replay state archive silently omitted
// mutation-manifest / skipped-tests / check-evidence, so a restore replayed a
// PARTIAL water-line state). These tests pin the canonical set and every
// derived view, so a future edit cannot re-open that drift.

import { describe, expect, it } from "vitest";
import {
	WATER_LINE_BASENAMES,
	WATER_LINE_FILES,
	WATER_LINE_PATHS,
	WATER_LINE_RE,
	isWaterLinePath,
	waterLineStem,
} from "./water-line-files.js";

describe("WATER_LINE_FILES — the canonical guard set", () => {
	it("pins the exact ten stems, in order", () => {
		expect([...WATER_LINE_FILES]).toEqual([
			"coverage-baseline",
			"coverage-edit-baseline",
			"mutation-baseline",
			"mutation-manifest",
			"large-files-baseline",
			"untested-files-baseline",
			"metric-caps",
			"skipped-tests-baseline",
			"check-evidence-baseline",
			"function-complexity-baseline",
		]);
	});

	it("P4: the per-function complexity ledger is a water-line (bash + effect arms cover it)", () => {
		expect(waterLineStem("/repo/.interlinked/function-complexity-baseline.json")).toBe(
			"function-complexity-baseline",
		);
	});

	it("N4: the ledger's .previous snapshot is NOT a water-line", () => {
		expect(waterLineStem("/repo/.interlinked/function-complexity-baseline.previous.json")).toBeNull();
	});

	it("has no duplicate entries", () => {
		expect(new Set(WATER_LINE_FILES).size).toBe(WATER_LINE_FILES.length);
	});
});

describe("derived views stay in lockstep with the stems", () => {
	it("basenames are the stems plus .json, same order", () => {
		expect([...WATER_LINE_BASENAMES]).toEqual(WATER_LINE_FILES.map((s) => `${s}.json`));
	});

	it("paths are the basenames under .interlinked/, same order", () => {
		expect([...WATER_LINE_PATHS]).toEqual(WATER_LINE_BASENAMES.map((b) => `.interlinked/${b}`));
	});

	it("the regex matches every canonical path and captures its stem", () => {
		for (const stem of WATER_LINE_FILES) {
			const m = WATER_LINE_RE.exec(`/repo/.interlinked/${stem}.json`);
			expect(m?.[1]).toBe(stem);
		}
	});
});

describe("waterLineStem / isWaterLinePath — positive (must match)", () => {
	it("P1: matches an absolute path", () => {
		expect(waterLineStem("/repo/.interlinked/metric-caps.json")).toBe("metric-caps");
		expect(isWaterLinePath("/repo/.interlinked/metric-caps.json")).toBe(true);
	});

	it("P2: matches a repo-relative path with no leading slash", () => {
		expect(waterLineStem(".interlinked/coverage-baseline.json")).toBe("coverage-baseline");
	});

	it("P3: normalizes Windows separators", () => {
		expect(waterLineStem("C:\\repo\\.interlinked\\mutation-manifest.json")).toBe(
			"mutation-manifest",
		);
	});
});

describe("waterLineStem / isWaterLinePath — negative (must not match)", () => {
	it("N1: rejects a same-named file outside .interlinked/", () => {
		expect(waterLineStem("/repo/docs/metric-caps.json")).toBeNull();
		expect(isWaterLinePath("/repo/docs/metric-caps.json")).toBe(false);
	});

	it("N2: rejects a substring/suffix near-miss", () => {
		expect(waterLineStem("/repo/.interlinked/my-metric-caps.json")).toBeNull();
		expect(waterLineStem("/repo/.interlinked/metric-caps.json.bak")).toBeNull();
	});

	it("N3: rejects another .interlinked/ file that is not a water-line", () => {
		expect(waterLineStem("/repo/.interlinked/config.json")).toBeNull();
		expect(isWaterLinePath("/repo/.interlinked/suite-baseline.json")).toBe(false);
	});
});
