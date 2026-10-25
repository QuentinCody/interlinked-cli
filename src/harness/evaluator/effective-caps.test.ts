import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_LINES } from "../large-file-policy.js";
import { DEFAULT_MAX_CYCLOMATIC } from "../metric-caps.js";
import {
	detectLargeFilesCap,
	detectMetricCaps,
	detectSkippedCap,
	detectUntestedFloor,
	effectiveLargeFilesCap,
	effectiveSkipCap,
	legacyLineCap,
	waterLineRoot,
} from "./effective-caps.js";

const CAPS = "/repo/.interlinked/metric-caps.json";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repoWithLargeFiles(text: string): string {
	const root = mkdtempSync(join(tmpdir(), "effective-caps-"));
	dirs.push(root);
	mkdirSync(join(root, ".interlinked"));
	writeFileSync(join(root, ".interlinked", "large-files-baseline.json"), text);
	return root;
}

describe("waterLineRoot", () => {
	it("P1: takes the prefix before /.interlinked/ of an absolute path", () => {
		expect(waterLineRoot("/repo/.interlinked/metric-caps.json")).toBe("/repo");
		expect(waterLineRoot("\\repo\\.interlinked\\metric-caps.json")).toBe("/repo");
	});

	it("P2: resolves a root-relative path against the fallback root", () => {
		expect(waterLineRoot(".interlinked/metric-caps.json", "/repo")).toBe("/repo");
		expect(waterLineRoot("sub/.interlinked/metric-caps.json", "/repo")).toBe("/repo/sub");
	});

	it("N1: has no root for a relative path without a fallback", () => {
		expect(waterLineRoot(".interlinked/metric-caps.json")).toBeNull();
		expect(waterLineRoot("metric-caps.json")).toBeNull();
	});
});

describe("legacyLineCap", () => {
	it("P1: uses the large-files baseline cap when it is valid", () => {
		expect(legacyLineCap(repoWithLargeFiles('{"version":1,"max_lines":800,"files":{}}'))).toBe(800);
	});

	it("N1: falls back to the shipped default for no root, no file, or an invalid file", () => {
		expect(legacyLineCap(null)).toBe(DEFAULT_MAX_LINES);
		expect(legacyLineCap("/nonexistent-effective-caps-root")).toBe(DEFAULT_MAX_LINES);
		expect(legacyLineCap(repoWithLargeFiles("{nope"))).toBe(DEFAULT_MAX_LINES);
		expect(legacyLineCap(repoWithLargeFiles('{"max_lines":"800"}'))).toBe(DEFAULT_MAX_LINES);
	});
});

describe("detectMetricCaps", () => {
	it("P1: a removed cap whose default is looser is a loosening, and the message says why", () => {
		const found = detectMetricCaps(CAPS, { max_cyclomatic: 16 }, {}, DEFAULT_MAX_LINES);
		expect(found.map((f) => f.rule)).toEqual(["max_cyclomatic"]);
		expect(found[0]?.before).toBe(16);
		expect(found[0]?.after).toBe(DEFAULT_MAX_CYCLOMATIC);
		expect(found[0]?.message).toContain("max_cyclomatic removed");
	});

	it("P2: max_lines falls back to the legacy line cap the caller supplies", () => {
		expect(detectMetricCaps(CAPS, { max_lines: 500 }, {}, 800).map((f) => f.rule)).toEqual(["max_lines"]);
	});

	it("N1: the same removal is not a loosening when the fallback is equal", () => {
		expect(detectMetricCaps(CAPS, { max_lines: 500 }, {}, 500)).toEqual([]);
	});
});

describe("large-files / untested-files / skipped-tests caps", () => {
	it("P1: a large-files cap dropped from the document falls back to the default", () => {
		expect(effectiveLargeFilesCap({ files: {} })).toBe(DEFAULT_MAX_LINES);
		expect(detectLargeFilesCap("f", { max_lines: 400 }, { files: {} }).map((f) => f.rule)).toEqual(["max_lines"]);
	});

	it("P2: an untested-files floor set to a string falls back to the lower default", () => {
		expect(detectUntestedFloor("f", { min_coverage_pct: 80 }, { min_coverage_pct: "80" }).map((f) => f.rule)).toEqual(["min_coverage_pct"]);
	});

	it("N1: a skip cap that becomes invalid falls back to zero, which is tighter", () => {
		expect(effectiveSkipCap({ version: 1 })).toBe(0);
		expect(detectSkippedCap("f", { version: 1, max_skipped: 3, files: {} }, { version: 1, files: {} })).toEqual([]);
	});
});
