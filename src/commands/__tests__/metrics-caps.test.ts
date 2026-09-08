// ===========================================
// metricsCommand — gate thresholds come from the resolved caps (G4)
// ===========================================
// The metrics report once HARD-CODED CRAP >= 30 and cyclomatic > 25 in both its
// labels and its gate counts, while the write/commit gates resolve those caps
// from `.interlinked/metric-caps.json` (`crapThresholdFor` / `maxCyclomaticFor`).
// In a repo with tightened caps the report therefore showed STALE numbers that
// disagreed with what the gates enforce. This suite pins the fix: with a real
// metric-caps.json the labels AND the cyclomatic gate count reflect the
// configured caps; with no override file they fall back to the shipped 30/25.
//
// Real-fs, end-to-end: a real `src/` tree + a real metric-caps.json drive the
// real `metric-caps.ts` resolver (the one the gates use). `resetMetricCapsCache`
// clears the module's mtime cache between writes so each override is picked up.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMetricCapsCache } from "../../harness/metric-caps.js";
import { parseWire, wireNumber, wireObject } from "../../lib/value-validation.js";
import { metricsCommand } from "../metrics.js";

let tmp: string;
let logged: string;
let logSpy: ReturnType<typeof vi.spyOn>;

/** A single function whose cyclomatic complexity lands between the two test
 *  caps (10 and 25): "bad" under a cap of 10, only "review" under the default
 *  cap of 25. Twelve `if` branches + the implicit entry path. */
const BRANCHY_SRC = `export function branchy(a: number, b: number, c: number): number {
	let x = 0;
	if (a > 0) x += 1;
	if (b > 0) x += 1;
	if (c > 0) x += 1;
	if (a > b) x += 1;
	if (b > c) x += 1;
	if (a > c) x += 1;
	if (a === b) x += 1;
	if (b === c) x += 1;
	if (a === c) x += 1;
	if (a < 0) x += 1;
	if (b < 0) x += 1;
	if (c < 0) x += 1;
	return x;
}
`;

function writeCaps(overrides: Record<string, number>): void {
	mkdirSync(join(tmp, ".interlinked"), { recursive: true });
	writeFileSync(
		join(tmp, ".interlinked", "metric-caps.json"),
		JSON.stringify({ version: 1, ...overrides }),
	);
	// The resolver memoizes by mtime; clear it so the just-written file is read.
	resetMetricCapsCache();
}

interface JsonReport {
	caps: { crap: number; cyclomatic: number; cyclomaticReview: number; minCoveragePct: number; functionTokens: number };
	scope: { functions: number };
	gates: {
		functionsCyclomaticReview: number;
		functionsCyclomaticBad: number;
		functionsOverCrap: number;
	};
}
function lastJson(): JsonReport {
	return parseWire(JSON.parse(logged), wireObject<JsonReport>({
		caps: wireObject({ crap: wireNumber, cyclomatic: wireNumber, cyclomaticReview: wireNumber, minCoveragePct: wireNumber, functionTokens: wireNumber }),
		scope: wireObject({ functions: wireNumber }),
		gates: wireObject({ functionsCyclomaticReview: wireNumber, functionsCyclomaticBad: wireNumber, functionsOverCrap: wireNumber }),
	}), "metrics report");
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "metrics-caps-"));
	mkdirSync(join(tmp, "src"), { recursive: true });
	writeFileSync(join(tmp, "src", "branchy.ts"), BRANCHY_SRC);
	// A companion test so the file isn't flagged missing-companion (irrelevant
	// noise for these assertions).
	mkdirSync(join(tmp, "src", "__tests__"), { recursive: true });
	writeFileSync(join(tmp, "src", "branchy.test.ts"), "// companion\n");
	resetMetricCapsCache();
	logged = "";
	logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logged += `${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`;
	});
});

afterEach(() => {
	logSpy.mockRestore();
	resetMetricCapsCache();
	rmSync(tmp, { recursive: true, force: true });
});

describe("metricsCommand — caps drive the JSON report (G4)", () => {
	it("defaults to the shipped caps (CRAP 30, cyclomatic 25) when no override file exists", async () => {
		await metricsCommand({ cwd: tmp, json: true });
		const r = lastJson();
		expect(r.caps).toEqual({
			crap: 30,
			cyclomatic: 25,
			cyclomaticReview: 15,
			minCoveragePct: 60,
			functionTokens: 500,
		});
		// branchy (cyclomatic ~13) is comfortably UNDER the default bad cap of 25
		// and under the default review lower bound of 15 — neither bad nor review.
		expect(r.scope.functions).toBeGreaterThanOrEqual(1);
		expect(r.gates.functionsCyclomaticBad).toBe(0);
		expect(r.gates.functionsCyclomaticReview).toBe(0);
	});

	it("reflects a tightened metric-caps.json (cyclomatic 10, crap 15) in caps + counts", async () => {
		writeCaps({ max_cyclomatic: 10, crap_threshold: 15 });
		await metricsCommand({ cwd: tmp, json: true });
		const r = lastJson();
		expect(r.caps).toEqual({
			crap: 15,
			cyclomatic: 10,
			cyclomaticReview: 15,
			minCoveragePct: 60,
			functionTokens: 500,
		});
		// branchy is now OVER the tightened cyclomatic cap of 10 → "bad", not review.
		expect(r.gates.functionsCyclomaticBad).toBe(1);
		// The review band is (15, 10] — empty when the bad cap drops below the
		// review lower bound — so nothing classifies as review.
		expect(r.gates.functionsCyclomaticReview).toBe(0);
	});

	it("honors a cyclomatic-only override (crap falls back to the default 30)", async () => {
		writeCaps({ max_cyclomatic: 10 });
		await metricsCommand({ cwd: tmp, json: true });
		const r = lastJson();
		expect(r.caps.cyclomatic).toBe(10);
		expect(r.caps.crap).toBe(30); // unset → shipped default
		expect(r.gates.functionsCyclomaticBad).toBe(1);
	});

	it("honors a crap-only override (cyclomatic falls back to the default 25)", async () => {
		writeCaps({ crap_threshold: 15 });
		await metricsCommand({ cwd: tmp, json: true });
		const r = lastJson();
		expect(r.caps.crap).toBe(15);
		expect(r.caps.cyclomatic).toBe(25);
		expect(r.gates.functionsCyclomaticBad).toBe(0); // 25 default unchanged
	});
});

describe("metricsCommand — caps drive the rendered labels (G4)", () => {
	it("short mode prints CRAP≥30 / cyc>25 with the shipped defaults", async () => {
		await metricsCommand({ cwd: tmp, short: true });
		expect(logged).toContain("CRAP≥30:");
		expect(logged).toContain("cyc>25:");
	});

	it("short mode prints the configured thresholds, not the hard-coded 30/25", async () => {
		writeCaps({ max_cyclomatic: 10, crap_threshold: 15 });
		await metricsCommand({ cwd: tmp, short: true });
		expect(logged).toContain("CRAP≥15:");
		expect(logged).toContain("cyc>10:");
		expect(logged).not.toContain("CRAP≥30:");
		expect(logged).not.toContain("cyc>25:");
	});

	it("normal mode labels the gates with the configured caps (CRAP ≥ 15, cyclomatic > 10)", async () => {
		writeCaps({ max_cyclomatic: 10, crap_threshold: 15 });
		await metricsCommand({ cwd: tmp });
		expect(logged).toContain("CRAP ≥ 15");
		expect(logged).toContain("cyclomatic > 10");
		// review band is (15, 10] → label reads "cyclomatic 16–10" (edges from caps).
		expect(logged).toContain("cyclomatic 16–10");
		expect(logged).not.toContain("CRAP ≥ 30");
		expect(logged).not.toContain("cyclomatic > 25");
	});

	it("normal mode keeps the default labels (CRAP ≥ 30, cyclomatic > 25, 16–25) when uncustomized", async () => {
		await metricsCommand({ cwd: tmp });
		expect(logged).toContain("CRAP ≥ 30");
		expect(logged).toContain("cyclomatic > 25");
		expect(logged).toContain("cyclomatic 16–25");
	});
});
