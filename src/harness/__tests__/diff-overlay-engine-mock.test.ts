// Coverage-gap tests for diff-overlay.ts that need a controllable engine
// (error injection, crafted diagnostics with missing fields) rather than a
// real biome/tsc invocation. The real-tool integration paths are covered by
// `diff-overlay.test.ts` (biome) and `tsc-overlay.test.ts` (tsc).
//
// `getOrCreateEngine` is mocked so no subprocess ever runs here — every case
// is deterministic and fast.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BiomeOverlayOutcome } from "../check-engine/tool-runners/biome.js";
import type { TscOverlayOutcome } from "../check-engine/tool-runners/tsc-overlay.js";
import type { CheckResult } from "../check-engine/types.js";

const mockEngine = {
	getBiomeDiagnosticsForOverlayTyped: vi.fn<
		(filePath: string, content: string, timeoutMs?: number) => BiomeOverlayOutcome
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
	): TscOverlayOutcome {
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
	mockEngine.getBiomeDiagnosticsForOverlayTyped.mockReset();
	mockEngine.getTscDiagnosticsForOverlay.mockReset();
	mockEngine.clearCache.mockReset();
}

it("leaves the proposed TypeScript result unmeasured when the baseline check is disabled", () => {
	resetEngineMocks();
	const file = join(TMP_ROOT, "disabled-baseline.ts");
	writeFileSync(file, "export const value = 1;\n");
	const run = vi.spyOn(mockEngine, "getTscDiagnosticsForOverlayTyped")
		.mockReturnValue({ status: "skipped", reason: "tsc overlay disabled by config" });
	try {
		const result = evaluateTscDiffOverlay(file, "export const value = 2;\n", TMP_ROOT);
		expect(result.newFindings).toEqual([]);
		expect(result.proposedFindings).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
	} finally {
		run.mockRestore();
	}
});

describe("evaluateBiomeDiffOverlay — unreadable file", () => {
	it("reports unavailable when the target cannot be read as text (e.g. a directory)", () => {
		resetEngineMocks();
		const dirPath = join(TMP_ROOT, "biome-not-a-file.ts");
		mkdirSync(dirPath);
		const result = evaluateBiomeDiffOverlay(dirPath, "content", TMP_ROOT);
		expect(result).toEqual({
			newFindings: [], proposedFindings: null, elapsedMs: 0, exceededBudget: false,
			checkerUnavailable: "Biome baseline could not be read",
		});
		expect(mockEngine.getBiomeDiagnosticsForOverlayTyped).not.toHaveBeenCalled();
	});
});

describe("evaluateTscDiffOverlay — unreadable file", () => {
	it("reports unavailable when the target cannot be read as text (e.g. a directory)", () => {
		resetEngineMocks();
		const dirPath = join(TMP_ROOT, "tsc-not-a-file.ts");
		mkdirSync(dirPath);
		const result = evaluateTscDiffOverlay(dirPath, "content", TMP_ROOT);
		expect(result).toEqual({
			newFindings: [],
			proposedFindings: null,
			elapsedMs: 0,
			exceededBudget: false,
			checkerUnavailable: "TypeScript baseline could not be read",
		});
		expect(mockEngine.getTscDiagnosticsForOverlay).not.toHaveBeenCalled();
	});
});

// Session review r6 (2026-09-06), finding 1: the disk baseline was cached by
// the file's path and mtime, but a DEPENDENCY can change this file's disk
// diagnostics without touching either. After a repair landed, reintroducing
// the same error read as pre-existing. The baseline is now recomputed on every
// evaluation, so it always describes the current pre-change tree.
describe("evaluateTscDiffOverlay — the disk baseline follows the dependencies (review r6, finding 1)", () => {
	it("P1: repair-then-regress in one process — the reintroduced error is NEW once the disk baseline is clean", () => {
		resetEngineMocks();
		const filePath = join(TMP_ROOT, "r6-consumer.ts");
		const disk = 'import { value } from "./value.js";\nexport const count: number = value;\n';
		writeFileSync(filePath, disk);
		const ts2322: CheckResult = {
			tool: "tsc",
			ruleId: "TS2322",
			severity: "error",
			file: filePath,
			line: 2,
			message: "Type 'string' is not assignable to type 'number'.",
		};
		// Before the repair the disk program already has the error, and the
		// proposal (a changed sibling) still shows it: pre-existing, nothing new.
		let diskDiagnostics: CheckResult[] = [ts2322];
		mockEngine.getTscDiagnosticsForOverlay.mockImplementation((_file, _content, siblings) =>
			siblings === undefined ? diskDiagnostics : [ts2322],
		);
		const siblings = [{ filePath: join(TMP_ROOT, "value.ts"), content: 'export const value = "changed";\n' }];
		expect(evaluateTscDiffOverlay(filePath, disk, TMP_ROOT, siblings).newFindings).toEqual([]);
		// The dependency is repaired on disk; this file's bytes and mtime are untouched.
		diskDiagnostics = [];
		const regress = evaluateTscDiffOverlay(filePath, disk, TMP_ROOT, siblings);
		expect(regress.newFindings.map((f) => f.ruleId)).toEqual(["TS2322"]);
	});

	it("N1: every evaluation runs its own baseline — two evaluations are two baseline runs and two overlay runs", () => {
		resetEngineMocks();
		const filePath = join(TMP_ROOT, "r6-baseline-count.ts");
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
	it("reports a second occurrence of an existing TypeScript diagnostic", () => {
		resetEngineMocks();
		const filePath = join(TMP_ROOT, "duplicate-diagnostic.ts");
		writeFileSync(filePath, "old content");
		const before: CheckResult = {
			tool: "tsc", ruleId: "TS2322", file: filePath, line: 1, severity: "error",
			message: "Type 'string' is not assignable to type 'number'.",
		};
		const moved = { ...before, line: 3 };
		const introduced = { ...before, line: 4 };
		mockEngine.getTscDiagnosticsForOverlay
			.mockReturnValueOnce([before])
			.mockReturnValueOnce([moved, introduced]);
		expect(evaluateTscDiffOverlay(filePath, "new content", TMP_ROOT).newFindings).toEqual([introduced]);
	});

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

// Session review r5 (2026-09-06), finding 2: the unchanged-text shortcut
// returned before the engine ran whenever the target's proposed bytes equalled
// its disk bytes — even when the batch overlaid CHANGED siblings the target
// depends on. The shortcut now holds only while nothing around the target
// changed either.
describe("evaluateTscDiffOverlay — an unchanged target beside proposed siblings (review r5, finding 2)", () => {
	const CONSUMER = 'import { value } from "./value.js";\nexport const count: number = value;\n';

	function unchangedTarget(name: string): string {
		const dir = join(TMP_ROOT, name);
		mkdirSync(dir, { recursive: true });
		const target = join(dir, "consumer.ts");
		writeFileSync(target, CONSUMER);
		return target;
	}

	function ts2322(file: string): CheckResult {
		return { tool: "tsc", ruleId: "TS2322", severity: "error", file, line: 2, message: "Type 'string' is not assignable to type 'number'." };
	}

	it("P1: runs the overlay WITH the siblings and reports the finding the changed sibling introduces", () => {
		resetEngineMocks();
		const target = unchangedTarget("r5-sibling-changed");
		mockEngine.getTscDiagnosticsForOverlay.mockImplementation((file, _content, siblings) =>
			siblings !== undefined && siblings.length > 0 ? [ts2322(file)] : [],
		);
		const siblings = [{ filePath: join(dirname(target), "value.ts"), content: 'export const value = "changed";\n' }];
		const result = evaluateTscDiffOverlay(target, readFileSync(target, "utf-8"), TMP_ROOT, siblings);
		expect(result.newFindings.map((f) => f.ruleId)).toEqual(["TS2322"]);
		expect(mockEngine.getTscDiagnosticsForOverlay).toHaveBeenLastCalledWith(target, CONSUMER, siblings);
	});

	it("N1: keeps the shortcut — the engine never runs — when no sibling is proposed", () => {
		resetEngineMocks();
		const target = unchangedTarget("r5-no-siblings");
		const result = evaluateTscDiffOverlay(target, readFileSync(target, "utf-8"), TMP_ROOT);
		expect(result.newFindings).toEqual([]);
		expect(mockEngine.getTscDiagnosticsForOverlay).not.toHaveBeenCalled();
	});
});
