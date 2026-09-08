import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	type DeadCodeCandidate,
	formatDeadCodeFindings,
	isSupermodelCliAvailable,
	parseDeadCodeJson,
	runSupermodelDeadCode,
} from "../supermodel-analyses.js";

// A representative `supermodel dead-code --output json` payload, matching
// the api.DeadCodeResult schema in
// reference-repos/supermodel-cli/internal/api/types.go.
const SAMPLE_JSON = JSON.stringify({
	metadata: {
		totalDeclarations: 412,
		deadCodeCandidates: 2,
		analysisMethod: "call-graph-reachability",
	},
	deadCodeCandidates: [
		{
			file: "src/legacy/util.ts",
			name: "formatLegacy",
			line: 88,
			type: "function",
			confidence: "high",
			reason: "no callers; not an entry point",
		},
		{
			file: "src/api/old.ts",
			name: "oldHandler",
			line: 12,
			type: "function",
			confidence: "low",
			reason: "only reachable from a test file",
		},
	],
	aliveCode: [],
	entryPoints: [],
});

describe("parseDeadCodeJson", () => {
	it("parses a well-formed dead-code result", () => {
		const result = parseDeadCodeJson(SAMPLE_JSON);
		expect(result).not.toBeNull();
		expect(result!.totalDeclarations).toBe(412);
		expect(result!.candidates).toHaveLength(2);
		expect(result!.candidates[0]).toEqual({
			file: "src/legacy/util.ts",
			name: "formatLegacy",
			line: 88,
			confidence: "high",
			reason: "no callers; not an entry point",
		});
	});

	it("returns null on empty input", () => {
		expect(parseDeadCodeJson("")).toBeNull();
		expect(parseDeadCodeJson("   ")).toBeNull();
	});

	it("returns null on invalid JSON", () => {
		expect(parseDeadCodeJson("{not json")).toBeNull();
	});

	it("returns null on a non-object payload", () => {
		expect(parseDeadCodeJson("[1,2,3]")).toBeNull();
		expect(parseDeadCodeJson('"a string"')).toBeNull();
	});

	it("returns null when deadCodeCandidates is missing", () => {
		expect(parseDeadCodeJson(JSON.stringify({ metadata: {} }))).toBeNull();
	});

	it("skips malformed candidates but keeps valid ones", () => {
		const json = JSON.stringify({
			deadCodeCandidates: [
				{ file: "a.ts", name: "good", line: 1, confidence: "high", reason: "r" },
				{ name: "noFile" },
				{ file: "b.ts" },
				42,
				null,
			],
		});
		const result = parseDeadCodeJson(json);
		expect(result!.candidates).toHaveLength(1);
		expect(nonNull(result!.candidates[0]).name).toBe("good");
	});

	it("defaults confidence to low, line to 0, reason to empty when absent or invalid", () => {
		const json = JSON.stringify({
			deadCodeCandidates: [{ file: "a.ts", name: "x", confidence: "bogus" }],
		});
		const result = parseDeadCodeJson(json);
		expect(nonNull(result!.candidates[0]).confidence).toBe("low");
		expect(nonNull(result!.candidates[0]).line).toBe(0);
		expect(nonNull(result!.candidates[0]).reason).toBe("");
	});

	it("defaults totalDeclarations to 0 when metadata is absent", () => {
		const json = JSON.stringify({ deadCodeCandidates: [] });
		expect(parseDeadCodeJson(json)!.totalDeclarations).toBe(0);
	});

	// test-contract: boundary — the JSON literal `null` must return null cleanly, not throw.
	// Several OR/AND permutations of the object/null guard only diverge from the original on
	// this exact input (raw === null): skip the guard and `obj.deadCodeCandidates` throws on
	// null instead of returning null.
	it("returns null (without throwing) when the parsed JSON is the literal null", () => {
		expect(() => parseDeadCodeJson("null")).not.toThrow();
		expect(parseDeadCodeJson("null")).toBeNull();
	});

	// test-contract: public-api — "medium" is a real confidence value, not just an alias for
	// the high/low ends of the ternary.
	it("keeps a medium-confidence candidate's confidence as medium, not the low default", () => {
		const json = JSON.stringify({
			deadCodeCandidates: [{ file: "a.ts", name: "x", confidence: "medium" }],
		});
		expect(nonNull(parseDeadCodeJson(json)!.candidates[0]).confidence).toBe("medium");
	});

	// test-contract: boundary — an empty-string confidence is invalid input and must fall back
	// to "low", not be accepted as its own value.
	it("defaults an empty-string confidence to low, not to the empty string itself", () => {
		const json = JSON.stringify({
			deadCodeCandidates: [{ file: "a.ts", name: "x", confidence: "" }],
		});
		expect(nonNull(parseDeadCodeJson(json)!.candidates[0]).confidence).toBe("low");
	});

	// test-contract: boundary — a null metadata block must not crash the parse; totalDeclarations
	// stays at its 0 default (typeof null === "object" in JS, so the null check is load-bearing).
	it("returns totalDeclarations 0 (without throwing) when metadata is null", () => {
		const json = JSON.stringify({ deadCodeCandidates: [], metadata: null });
		expect(() => parseDeadCodeJson(json)).not.toThrow();
		expect(parseDeadCodeJson(json)!.totalDeclarations).toBe(0);
	});

	// test-contract: boundary — a non-number totalDeclarations must be rejected, not assigned
	// straight through into a field callers treat as a number.
	it("leaves totalDeclarations at 0 when metadata.totalDeclarations is not a number", () => {
		const json = JSON.stringify({
			deadCodeCandidates: [],
			metadata: { totalDeclarations: "412" },
		});
		expect(parseDeadCodeJson(json)!.totalDeclarations).toBe(0);
	});
});

describe("formatDeadCodeFindings", () => {
	it("returns an empty array when there are no candidates", () => {
		expect(formatDeadCodeFindings({ candidates: [], totalDeclarations: 5 })).toEqual([]);
	});

	it("orders candidates by confidence, highest first", () => {
		const analysis = parseDeadCodeJson(SAMPLE_JSON);
		const lines = formatDeadCodeFindings(analysis!);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("formatLegacy");
		expect(lines[0]).toContain("high confidence");
		expect(lines[1]).toContain("oldHandler");
	});

	it("tags each line and includes file:line and the reason", () => {
		const lines = formatDeadCodeFindings(parseDeadCodeJson(SAMPLE_JSON)!);
		expect(lines[0]).toContain("[interlinked:supermodel-dead-code]");
		expect(lines[0]).toContain("src/legacy/util.ts:88");
		expect(lines[0]).toContain("no callers");
	});

	it("caps the list and notes the overflow", () => {
		const candidates: DeadCodeCandidate[] = Array.from({ length: 25 }, (_, i) => ({
			file: `f${i}.ts`,
			name: `fn${i}`,
			line: i,
			confidence: "medium",
			reason: "unreferenced",
		}));
		const lines = formatDeadCodeFindings({ candidates, totalDeclarations: 100 }, { max: 20 });
		expect(lines).toHaveLength(21); // 20 shown + 1 overflow line
		expect(lines[20]).toContain("5 more");
	});

	// test-contract: boundary — the overflow count must be an exact subtraction. "25 more"
	// contains the substring "5 more" too, so a loose toContain assertion can't tell
	// `ranked.length - max` apart from `ranked.length + max`; this pins the full line.
	it("computes the overflow count as an exact subtraction, not a loose substring match", () => {
		const candidates: DeadCodeCandidate[] = Array.from({ length: 25 }, (_, i) => ({
			file: `f${i}.ts`,
			name: `fn${i}`,
			line: i,
			confidence: "medium",
			reason: "unreferenced",
		}));
		const lines = formatDeadCodeFindings({ candidates, totalDeclarations: 100 }, { max: 20 });
		expect(lines[20]).toBe("[interlinked:supermodel-dead-code] …and 5 more candidate(s).");
	});

	// test-contract: boundary — exactly `max` candidates must NOT trigger the overflow line
	// (ranked.length > max, not >=).
	it("does not add an overflow line when the candidate count exactly equals max", () => {
		const candidates: DeadCodeCandidate[] = Array.from({ length: 5 }, (_, i) => ({
			file: `f${i}.ts`,
			name: `fn${i}`,
			line: i,
			confidence: "low",
			reason: "r",
		}));
		const lines = formatDeadCodeFindings({ candidates, totalDeclarations: 5 }, { max: 5 });
		expect(lines).toHaveLength(5);
	});

	// test-contract: public-api — omitting opts.max entirely must apply the real default cap
	// (20), not silently show every candidate (opts.max ?? DEFAULT vs opts.max && DEFAULT only
	// diverge when opts.max is omitted).
	it("applies the default cap of 20 when no max option is given", () => {
		const candidates: DeadCodeCandidate[] = Array.from({ length: 25 }, (_, i) => ({
			file: `f${i}.ts`,
			name: `fn${i}`,
			line: i,
			confidence: "medium",
			reason: "unreferenced",
		}));
		const lines = formatDeadCodeFindings({ candidates, totalDeclarations: 100 });
		expect(lines).toHaveLength(21);
		expect(lines[20]).toBe("[interlinked:supermodel-dead-code] …and 5 more candidate(s).");
	});

	// test-contract: public-api — sorting must actually reorder out-of-order input by
	// confidence. SAMPLE_JSON's fixture is already pre-sorted (high, low), so a gutted
	// comparator, an emptied rank table, or a removed .sort() call all pass silently through
	// the other tests; this fixture is deliberately scrambled to force a real reorder.
	it("reorders out-of-order candidates by confidence (high, medium, low)", () => {
		const analysis = {
			candidates: [
				{ file: "l.ts", name: "L", line: 1, confidence: "low" as const, reason: "r" },
				{ file: "h.ts", name: "H", line: 2, confidence: "high" as const, reason: "r" },
				{ file: "m.ts", name: "M", line: 3, confidence: "medium" as const, reason: "r" },
			],
			totalDeclarations: 3,
		};
		expect(formatDeadCodeFindings(analysis)).toEqual([
			"[interlinked:supermodel-dead-code] h.ts:2 H (high confidence) — r",
			"[interlinked:supermodel-dead-code] m.ts:3 M (medium confidence) — r",
			"[interlinked:supermodel-dead-code] l.ts:1 L (low confidence) — r",
		]);
	});
});

describe("isSupermodelCliAvailable", () => {
	it("returns false for a binary that does not exist", () => {
		expect(isSupermodelCliAvailable("supermodel-nonexistent-binary-xyz")).toBe(false);
	});
});

describe("runSupermodelDeadCode", () => {
	it("returns null when the CLI binary is not found (graceful skip)", () => {
		const result = runSupermodelDeadCode(process.cwd(), {
			binary: "supermodel-nonexistent-binary-xyz",
		});
		expect(result).toBeNull();
	});
});
