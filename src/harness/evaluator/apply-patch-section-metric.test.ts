import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplyPatchSection } from "../apply-patch-content.js";
import type { FileGrandfather } from "../function-complexity-baseline.js";
import { processApplyPatchSection } from "./apply-patch-section-metric.js";
import type { MetricAnalyzer, MetricGateSpec, NamedMetricEntry } from "./per-function-metric-gate.js";

interface Entry extends NamedMetricEntry {
	name: string;
	value: number;
}

/** Analyzer that just counts non-empty lines as the "metric" per function name
 *  `fn0`, `fn1`, … so before/after entries are trivially controllable. */
function makeAnalyzer(compute: (content: string, filePath: string) => Entry[] | null): MetricAnalyzer<Entry> {
	return { compute, language: "test" };
}

function makeSpec(overrides: Partial<MetricGateSpec<Entry>> = {}): MetricGateSpec<Entry> {
	return {
		label: "test-metric",
		unitAdj: "test",
		unitPlural: "points",
		limitPhrase: "test cap",
		advice: "Decompose it.",
		anonName: "(anonymous)",
		slewTolerance: 2,
		metricOf: (e) => e.value,
		selectAnalyzer: () => makeAnalyzer(() => []),
		capFor: () => 20,
		...overrides,
	};
}

function makeGf(overrides: Partial<FileGrandfather> = {}): FileGrandfather {
	return { byName: new Map(), pooled: [], total: 0, cap: 20, ...overrides };
}

/** A no-op stand-in for `metricViolations` the caller would otherwise pass —
 *  each test supplies its own to control the branch under test without
 *  depending on the real (much larger) implementation. */
type ComputeViolations = Parameters<typeof processApplyPatchSection<Entry>>[5];

describe("processApplyPatchSection", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "apply-patch-section-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function section(overrides: Partial<ApplyPatchSection> = {}): ApplyPatchSection {
		return {
			path: "src/foo.ts",
			op: "update",
			body: [],
			...overrides,
		};
	}

	// — positive (must fire): "skip" outcomes —

	it("P1: returns skip when the spec has no analyzer for the section's path", () => {
		const spec = makeSpec({ selectAnalyzer: () => null });
		const computeViolations: ComputeViolations = () => {
			throw new Error("must not be called");
		};
		const result = processApplyPatchSection(spec, section(), dir, 20, undefined, computeViolations);
		expect(result).toBe("skip");
	});

	it("P2: returns skip when reconstruction can't confidently produce after-content", () => {
		// An update section whose hunk context isn't found in the (empty)
		// before-content fails to reconstruct, so reconstructAfterContent
		// returns null.
		const spec = makeSpec();
		const computeViolations: ComputeViolations = () => {
			throw new Error("must not be called");
		};
		const result = processApplyPatchSection(
			spec,
			section({ op: "update", body: ["@@", " nonexistent line"] }),
			dir,
			20,
			undefined,
			computeViolations,
		);
		expect(result).toBe("skip");
	});

	it("P3: returns skip when the reconstructed file is not cappable (test file)", () => {
		const spec = makeSpec();
		const computeViolations: ComputeViolations = () => {
			throw new Error("must not be called");
		};
		const result = processApplyPatchSection(
			spec,
			section({ path: "src/foo.test.ts", op: "add", body: ["+const x = 1;"] }),
			dir,
			20,
			undefined,
			computeViolations,
		);
		expect(result).toBe("skip");
	});

	// — negative (must not fire "skip"): real outcomes flow through —

	it("N1: returns fail-open when computeViolations reports the analyzer unavailable (null)", () => {
		const spec = makeSpec();
		const computeViolations: ComputeViolations = () => null;
		const result = processApplyPatchSection(
			spec,
			section({ op: "add", body: ["+const x = 1;"] }),
			dir,
			20,
			undefined,
			computeViolations,
		);
		expect(result).toBe("fail-open");
	});

	it("N2: returns the violation items and grandfather record on a normal add", () => {
		const gf = makeGf({ total: 3 });
		const spec = makeSpec({ grandfatherFor: () => gf });
		const computeViolations: ComputeViolations = (_spec, before, after) => {
			expect(before).toBe("");
			expect(after).toBe("const x = 1;");
			return ["fn0: 25 > 20"];
		};
		const result = processApplyPatchSection(
			spec,
			section({ op: "add", body: ["+const x = 1;"] }),
			dir,
			20,
			undefined,
			computeViolations,
		);
		expect(result).toEqual({ items: ["fn0: 25 > 20"], gf });
	});

	it("N3: reads before-content from fromPath for a moved section", () => {
		const srcAbs = join(dir, "old.ts");
		writeFileSync(srcAbs, "const y = 2;\n");
		const spec = makeSpec();
		let seenBefore: string | undefined;
		const computeViolations: ComputeViolations = (_spec, before) => {
			seenBefore = before;
			return [];
		};
		const result = processApplyPatchSection(
			spec,
			section({
				path: "new.ts",
				fromPath: "old.ts",
				op: "update",
				body: ["@@", " const y = 2;"],
			}),
			dir,
			20,
			undefined,
			computeViolations,
		);
		expect(seenBefore).toBe("const y = 2;\n");
		expect(existsSync(join(dir, "new.ts"))).toBe(false);
		expect(result).toEqual({ items: [], gf: null });
	});
});
