// Coverage-gap tests for diff-overlay.ts that need a controllable engine
// (error injection, crafted diagnostics with missing fields) rather than a
// real biome/tsc invocation. The real-tool integration paths are covered by
// `diff-overlay.test.ts` (biome) and `tsc-overlay.test.ts` (tsc).
//
// `getOrCreateEngine` is mocked so no subprocess ever runs here — every case
// is deterministic and fast. `statSync` is selectively trapped (by exact
// path) to exercise the tscCacheKey race-condition fallback without
// disturbing any other file's stat calls in the same run.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CheckResult } from "../check-engine/types.js";

let statTrapPath: string | null = null;

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		statSync: (...args: Parameters<typeof actual.statSync>) => {
			if (statTrapPath !== null && args[0] === statTrapPath) {
				throw new Error("stat trap for coverage");
			}
			return actual.statSync(...args);
		},
	};
});

const mockEngine = {
	getDiagnostics: vi.fn<(filePath: string) => CheckResult[]>(),
	getBiomeDiagnosticsForOverlay: vi.fn<
		(filePath: string, content: string, timeoutMs?: number) => CheckResult[]
	>(),
	getTscDiagnosticsForOverlay: vi.fn<
		(
			filePath: string,
			content: string,
			siblings?: ReadonlyArray<{ filePath: string; content: string }>,
		) => CheckResult[]
	>(),
	// Typed variant (sidecar unavailable-vs-clean contract, 2026-08-26):
	// diff-overlay now calls this one; delegate to the legacy mock so every
	// existing mockReturnValue/assertion keeps working unchanged.
	getTscDiagnosticsForOverlayTyped(
		filePath: string,
		content: string,
		siblings?: ReadonlyArray<{ filePath: string; content: string }>,
	): { status: "ok"; findings: CheckResult[] } {
		return { status: "ok", findings: mockEngine.getTscDiagnosticsForOverlay(filePath, content, siblings) };
	},
	clearCache: vi.fn<() => void>(),
};

vi.mock("../check-engine/index.js", () => ({
	getOrCreateEngine: vi.fn(() => mockEngine),
}));

const {
	_isJsTsExt,
	_resetEngineCacheForTest,
	evaluateBiomeDiffOverlay,
	evaluateTscDiffOverlay,
} = await import("../diff-overlay.js");

const TMP_ROOT = mkdtempSync(join(tmpdir(), "interlinked-diff-overlay-mock-"));

afterAll(() => {
	try {
		rmSync(TMP_ROOT, { recursive: true, force: true });
	} catch {
		// intentional: best-effort cleanup
	}
});

function resetEngineMocks(): void {
	mockEngine.getDiagnostics.mockReset();
	mockEngine.getBiomeDiagnosticsForOverlay.mockReset();
	mockEngine.getTscDiagnosticsForOverlay.mockReset();
	mockEngine.clearCache.mockReset();
	statTrapPath = null;
}

describe("evaluateBiomeDiffOverlay — unreadable file", () => {
	it("returns empty when the target cannot be read as text (e.g. a directory)", () => {
		resetEngineMocks();
		const dirPath = join(TMP_ROOT, "biome-not-a-file.ts");
		mkdirSync(dirPath);
		// Non-empty and mixed-tool so the pre-edit `.filter((r) => r.tool ===
		// "biome")` callback actually runs (both a match and a non-match) rather
		// than short-circuiting on an empty array.
		mockEngine.getDiagnostics.mockReturnValue([
			{ tool: "biome", severity: "warning", file: "x.ts", line: 1, message: "pre-existing" },
			{ tool: "tsc", severity: "error", file: "x.ts", line: 2, message: "unrelated tool" },
		]);
		const result = evaluateBiomeDiffOverlay(dirPath, "content", TMP_ROOT);
		expect(result).toEqual({
			newFindings: [], proposedFindings: null, elapsedMs: 0, exceededBudget: false,
			checkerUnavailable: "Biome baseline could not be read",
		});
		expect(mockEngine.getBiomeDiagnosticsForOverlay).not.toHaveBeenCalled();
	});
});

describe("evaluateTscDiffOverlay — unreadable file", () => {
	it("returns empty when the target cannot be read as text (e.g. a directory)", () => {
		resetEngineMocks();
		const dirPath = join(TMP_ROOT, "tsc-not-a-file.ts");
		mkdirSync(dirPath);
		const result = evaluateTscDiffOverlay(dirPath, "content", TMP_ROOT);
		expect(result).toEqual({
			newFindings: [],
			proposedFindings: null,
			elapsedMs: 0,
			exceededBudget: false,
		});
		expect(mockEngine.getTscDiagnosticsForOverlay).not.toHaveBeenCalled();
	});
});

describe("evaluateTscDiffOverlay — tscCacheKey stat race", () => {
	it("falls back to a stable cache key and still runs the overlay when statSync fails post-read", () => {
		resetEngineMocks();
		const filePath = join(TMP_ROOT, "stat-race.ts");
		writeFileSync(filePath, "old content");
		statTrapPath = filePath;
		mockEngine.getTscDiagnosticsForOverlay.mockReturnValue([]);
		const result = evaluateTscDiffOverlay(filePath, "new content", TMP_ROOT);
		statTrapPath = null;
		expect(result.newFindings).toEqual([]);
		expect(mockEngine.getTscDiagnosticsForOverlay).toHaveBeenCalledTimes(2);
	});
});

describe("evaluateTscDiffOverlay — independent baselines", () => {
	it("runs the disk baseline and overlay against each proposed content", () => {
		resetEngineMocks();
		const filePath = join(TMP_ROOT, "baseline-content.ts");
		writeFileSync(filePath, "old content");
		mockEngine.getTscDiagnosticsForOverlay.mockReturnValue([]);
		expect(evaluateTscDiffOverlay(filePath, "new content", TMP_ROOT).newFindings).toEqual([]);
		expect(evaluateTscDiffOverlay(filePath, "newer content", TMP_ROOT).newFindings).toEqual([]);
		expect(mockEngine.getTscDiagnosticsForOverlay).toHaveBeenCalledTimes(4);
		expect(mockEngine.getTscDiagnosticsForOverlay.mock.calls.map(([path, content]) => [path, content])).toEqual([
			[filePath, "old content"],
			[filePath, "new content"],
			[filePath, "old content"],
			[filePath, "newer content"],
		]);
	});
});

describe("evaluateTscDiffOverlay — diagKey identity across tool/ruleId/message shapes", () => {
	it("diffs tsc and non-tsc findings with and without ruleId/message present", () => {
		resetEngineMocks();
		const filePath = join(TMP_ROOT, "diag-key.ts");
		writeFileSync(filePath, "old content");
		const overlayFindings: CheckResult[] = [
			{ tool: "tsc", severity: "error", file: "diag-key.ts", line: 1, message: "" },
			{
				tool: "tsc",
				severity: "error",
				file: "diag-key.ts",
				line: 2,
				message: "  spaced   out  message  ",
				ruleId: "TS1234",
			},
			{
				tool: "biome",
				severity: "warning",
				file: "diag-key.ts",
				line: 3,
				message: "lint issue",
			},
			{
				tool: "biome",
				severity: "warning",
				file: "diag-key.ts",
				line: 4,
				message: "lint issue 2",
				ruleId: "lint/x",
			},
		];
		mockEngine.getTscDiagnosticsForOverlay.mockReturnValueOnce([]); // pre-edit
		mockEngine.getTscDiagnosticsForOverlay.mockReturnValueOnce(overlayFindings); // proposed
		const result = evaluateTscDiffOverlay(filePath, "new content", TMP_ROOT);
		expect(result.newFindings).toEqual(overlayFindings);
		expect(result.proposedFindings).toEqual(overlayFindings);
	});
});

describe("_resetEngineCacheForTest", () => {
	it("clears the engine cache for the current working directory's engine", () => {
		resetEngineMocks();
		_resetEngineCacheForTest();
		expect(mockEngine.clearCache).toHaveBeenCalledTimes(1);
	});
});

describe("_isJsTsExt", () => {
	it("is true for a recognized JS/TS extension", () => {
		expect(_isJsTsExt("/a/b/c.ts")).toBe(true);
	});

	it("is false for a file with no extension (extname short-circuit)", () => {
		expect(_isJsTsExt("/a/b/README")).toBe(false);
	});

	it("is false for a non-JS/TS extension", () => {
		expect(_isJsTsExt("/a/b/c.py")).toBe(false);
	});
});
