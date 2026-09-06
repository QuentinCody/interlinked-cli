// Companion coverage for the legacy (pre-functionTokenMetrics) function-token
// distribution and hotspot renderers. `functionTokenDistributionLines` and
// `functionTokenHotspotLines` each prefer `r.functionTokenMetrics` when present
// (covered by metrics.test.ts through the real command path) but fall back to
// the flat `r.distributions.functionTokens` / `r.tokenHotspots` shape when it
// is absent. No current production caller of `interlinked metrics` ever
// produces a report with functionTokenMetrics unset and the legacy fields
// set, so these tests build that shape directly and drive it through the
// public `renderNormal` entry point, matching the mutation-kill sibling
// file's `baseReport` fixture style.
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../lib/formatter.js";
import { type MetricsReport, renderNormal } from "./metrics-renderers.js";

function baseReport(overrides: Partial<MetricsReport> = {}): MetricsReport {
	return {
		scope: {
			files: 10,
			functions: 20,
			coverageAvailable: true,
			coverageSource: "istanbul",
			astComplexityAvailable: true,
		},
		caps: {
			crap: 30,
			cyclomatic: 25,
			cyclomaticReview: 15,
			minCoveragePct: 80,
		},
		gates: {
			functionsOverCrap: 0,
			functionsCyclomaticReview: 0,
			functionsCyclomaticBad: 0,
			filesMissingCompanion: 0,
			filesNoCoverage: 0,
		},
		distributions: {
			cyclomatic: {},
			crap: {},
		},
		hotspots: [],
		missingCompanion: [],
		files: [],
		...overrides,
	};
}

describe("functionTokenDistributionLines legacy fallback (via renderNormal)", () => {
	// test-contract: public-api — with functionTokenMetrics unset, the legacy
	// distribution header and one padded "bucket count" line per entry render.
	it("renders the legacy function-token distribution header and per-bucket lines", () => {
		const r = baseReport({
			distributions: { cyclomatic: {}, crap: {}, functionTokens: { "0-50": 3, "51-100": 1 } },
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain("Function-token distribution (interlinked-code-v2)");
		expect(out).toContain(`    ${"0-50".padEnd(10)} 3`);
		expect(out).toContain(`    ${"51-100".padEnd(10)} 1`);
	});

	// test-contract: boundary — functionTokenMetrics absent AND distributions.functionTokens
	// absent must render neither the legacy nor the summary section at all.
	it("omits the function-token distribution section entirely when no token data exists", () => {
		const out = stripAnsi(renderNormal(baseReport()));
		expect(out).not.toContain("function-token distribution");
		expect(out).not.toContain("Function-token distribution");
	});
});

describe("functionTokenHotspotLines legacy fallback (via renderNormal)", () => {
	// test-contract: public-api — with functionTokenMetrics unset, the legacy
	// hotspot header names the real count and each hotspot line reports its
	// token count (right-padded to 6) plus file:line::name.
	it("renders the legacy function-token hotspot header and per-hotspot line", () => {
		const r = baseReport({
			tokenHotspots: [
				{ file: "src/big.ts", name: "bigFn", line: 42, cyclomatic: 3, coveragePct: 60, crap: 5, canonicalTokens: 812 },
			],
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain("Top 1 function-token hotspots");
		expect(out).toContain(`${String(812).padStart(6)} tokens  src/big.ts:42::bigFn`);
	});

	// test-contract: boundary — a hotspot with canonicalTokens undefined must render
	// "0" (nullish-coalesce fallback), not the literal string "undefined".
	it("renders 0 tokens for a hotspot whose canonicalTokens is undefined", () => {
		const r = baseReport({
			tokenHotspots: [{ file: "src/small.ts", name: "smallFn", line: 7, cyclomatic: 1, coveragePct: 100, crap: 1 }],
		});
		const out = stripAnsi(renderNormal(r));
		expect(out).toContain(`${"0".padStart(6)} tokens  src/small.ts:7::smallFn`);
		expect(out).not.toContain("undefined tokens");
	});

	// test-contract: boundary — functionTokenMetrics absent AND tokenHotspots absent
	// must render neither the legacy nor the summary hotspot section at all.
	it("omits the function-token hotspot section entirely when no token hotspot data exists", () => {
		const out = stripAnsi(renderNormal(baseReport()));
		expect(out).not.toContain("function-token hotspots");
	});
});
