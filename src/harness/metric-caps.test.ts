import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	coverageGoalFor,
	crapThresholdFor,
	DEFAULT_COVERAGE_GOAL,
	DEFAULT_CRAP_THRESHOLD,
	DEFAULT_MAX_CYCLOMATIC,
	DEFAULT_MAX_FUNCTION_TOKENS,
	DEFAULT_MAX_LINES,
	DEFAULT_MIN_COVERAGE,
	describeMetricForAgent,
	formatMetricDefaultRow,
	loadMetricCaps,
	METRIC_CAPS_REL,
	METRIC_DEFS,
	maxCyclomaticFor,
	maxFunctionTokensFor,
	maxLinesOverride,
	metricDef,
	minCoverageFor,
	resetMetricCapsCache,
	resolveMetricCaps,
} from "./metric-caps.js";

function writeCaps(cwd: string, obj: unknown): void {
	writeFileSync(join(cwd, METRIC_CAPS_REL), JSON.stringify(obj), "utf8");
}

describe("metric-caps", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "metric-caps-"));
		mkdirSync(join(cwd, ".interlinked"), { recursive: true });
		resetMetricCapsCache();
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		resetMetricCapsCache();
	});

	it("ships the documented default constants", () => {
		expect(DEFAULT_MAX_LINES).toBe(500);
		expect(DEFAULT_MAX_FUNCTION_TOKENS).toBe(500);
		expect(DEFAULT_MAX_CYCLOMATIC).toBe(25);
		expect(DEFAULT_CRAP_THRESHOLD).toBe(30);
		expect(DEFAULT_MIN_COVERAGE).toBe(0);
		// The goal is ambition-by-default (operator 2026-08-17); the FLOOR above
		// stays 0 (off) so the goal can never brick a brownfield repo.
		expect(DEFAULT_COVERAGE_GOAL).toBe(100);
	});

	it("coverageGoalFor: default 100, valid override honored, out-of-scale dropped", () => {
		expect(coverageGoalFor(cwd)).toBe(100);
		writeCaps(cwd, { coverage_goal: 85 });
		resetMetricCapsCache();
		expect(coverageGoalFor(cwd)).toBe(85);
		writeCaps(cwd, { coverage_goal: 0 });
		resetMetricCapsCache();
		expect(coverageGoalFor(cwd)).toBe(100); // 0 is not a goal — falls to default
		writeCaps(cwd, { coverage_goal: 140 });
		resetMetricCapsCache();
		expect(coverageGoalFor(cwd)).toBe(100); // beyond the scale's ceiling — dropped
	});

	it("exposes exactly the six metrics with complete glossary metadata", () => {
		expect(METRIC_DEFS.map((d) => d.key)).toEqual([
			"lines",
			"function-tokens",
			"cyclomatic",
			"cognitive",
			"crap",
			"coverage",
		]);
		for (const d of METRIC_DEFS) {
			expect(d.definition.length).toBeGreaterThan(40);
			expect(d.howToConfigure).toContain("interlinked caps set");
			expect(d.fixHint.length).toBeGreaterThan(10);
			expect(["lower", "higher"]).toContain(d.stricter);
		}
	});

	it("accepts only integer function-token caps in the fixed 1..500 range", () => {
		for (const value of [0, -1, 500.5, 501, Number.POSITIVE_INFINITY]) {
			writeCaps(cwd, { max_function_tokens: value });
			resetMetricCapsCache();
			expect(loadMetricCaps(cwd).max_function_tokens).toBeUndefined();
		}
		writeCaps(cwd, { max_function_tokens: 500 });
		resetMetricCapsCache();
		expect(loadMetricCaps(cwd).max_function_tokens).toBe(500);
	});

	it("metricDef returns the entry and throws on an unknown key", () => {
		expect(metricDef("cyclomatic").configKey).toBe("max_cyclomatic");
		// @ts-expect-error — exercising the runtime guard with a bad key
		expect(() => metricDef("nope")).toThrow(/unknown metric/);
	});

	it("loadMetricCaps returns {} when no file is present", () => {
		expect(loadMetricCaps(cwd)).toEqual({});
	});

	it("loadMetricCaps parses present, positive overrides and drops invalid ones", () => {
		writeCaps(cwd, { max_cyclomatic: 15, crap_threshold: 0, min_coverage: 0, max_lines: -5 });
		const o = loadMetricCaps(cwd);
		expect(o.max_cyclomatic).toBe(15);
		expect(o.crap_threshold).toBeUndefined(); // 0 is not a valid positive cap
		expect(o.max_lines).toBeUndefined(); // negative dropped
		expect(o.min_coverage).toBe(0); // a 0 floor IS valid (>= 0)
	});

	it("loadMetricCaps fails soft on malformed JSON", () => {
		writeFileSync(join(cwd, METRIC_CAPS_REL), "{not json", "utf8");
		expect(loadMetricCaps(cwd)).toEqual({});
	});

	it("loadMetricCaps reflects an edit (mtime-aware cache)", () => {
		writeCaps(cwd, { max_cyclomatic: 20 });
		expect(loadMetricCaps(cwd).max_cyclomatic).toBe(20);
		// Overwrite with a newer mtime; the cache must not serve the stale value.
		const future = Date.now() / 1000 + 5;
		writeCaps(cwd, { max_cyclomatic: 12 });
		const fs = require("node:fs") as typeof import("node:fs");
		fs.utimesSync(join(cwd, METRIC_CAPS_REL), future, future);
		expect(loadMetricCaps(cwd).max_cyclomatic).toBe(12);
	});

	it("resolveMetricCaps reports precedence: override → legacy → default", () => {
		writeCaps(cwd, { max_cyclomatic: 15 });
		const r = resolveMetricCaps(cwd, { crap_threshold: 22, max_lines: 600 });
		expect(r.max_cyclomatic).toEqual({ value: 15, source: "metric-caps.json" });
		expect(r.crap_threshold).toEqual({ value: 22, source: "legacy-config" });
		expect(r.max_lines).toEqual({ value: 600, source: "legacy-config" });
		expect(r.max_function_tokens).toEqual({ value: 500, source: "default" });
		expect(r.min_coverage).toEqual({ value: 0, source: "default" });
	});

	it("per-metric resolvers honor overrides then fall back", () => {
		expect(maxCyclomaticFor(cwd)).toBe(25);
		expect(maxFunctionTokensFor(cwd)).toBe(500);
		expect(crapThresholdFor(cwd)).toBe(30);
		expect(crapThresholdFor(cwd, 22)).toBe(22); // legacy honored
		expect(minCoverageFor(cwd)).toBe(0);
		expect(maxLinesOverride(cwd)).toBeUndefined();

		writeCaps(cwd, { max_cyclomatic: 15, max_function_tokens: 400, crap_threshold: 20, min_coverage: 90, max_lines: 500 });
		resetMetricCapsCache();
		expect(maxCyclomaticFor(cwd)).toBe(15);
		expect(maxFunctionTokensFor(cwd)).toBe(400);
		expect(crapThresholdFor(cwd, 22)).toBe(20); // override beats legacy
		expect(minCoverageFor(cwd)).toBe(90);
		expect(maxLinesOverride(cwd)).toBe(500);
	});

	it("describeMetricForAgent is self-contained: definition + config path + fix", () => {
		const msg = describeMetricForAgent("cyclomatic", 15);
		expect(msg).toContain("cyclomatic");
		expect(msg).toContain("15");
		expect(msg).toContain("interlinked caps set cyclomatic");
		expect(msg.toLowerCase()).toContain("fix:");
	});
});

describe("formatMetricDefaultRow — positive/negative (goal-vs-cap display)", () => {
	// test-contract: bug — coverage must read as a GOAL the ratchets climb toward
	// (default 100), never as a bound: "coverage 0 %" read as "capped at zero"
	// (operator 2026-08-16) and "≥/≤" phrasing reads as a gate (operator 2026-08-17)
	it("P: maxima render with ≤ and coverage renders as the goal-100 sentence with the adopt floor", () => {
		const byKey = new Map(METRIC_DEFS.map((d) => [d.key, formatMetricDefaultRow(d)]));
		expect(byKey.get("lines")).toContain("≤ 500 lines");
		expect(byKey.get("coverage")).toContain("goal 100 %");
		expect(byKey.get("coverage")).toContain("adopt seeds today's %");
		expect(byKey.get("coverage")).not.toContain("≥");
		expect(byKey.get("coverage")).not.toContain("≤");
	});

	// test-contract: boundary — an explicit goal of 0 means "goal off, ratchet only", never a zero bound
	it("N: a zero higher-is-stricter value renders the goal-off sentence, not a bound", () => {
		const coverage =
			METRIC_DEFS.find((d) => d.key === "coverage") ??
			(() => {
				throw new Error("coverage def missing from METRIC_DEFS");
			})();
		const row = formatMetricDefaultRow({ ...coverage, defaultValue: 0 });
		expect(row).toContain("goal off");
		expect(row).not.toContain("≥");
	});
});
