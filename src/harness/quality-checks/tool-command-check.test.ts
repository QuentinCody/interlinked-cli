// Evidence for `runCommandCheck`'s typescript-only delta split
// (`typescriptDeltaResults`): the two branches that add a QualityCheckResult
// for introduced vs. pre-existing findings. Only `getOrCreateEngine` is
// mocked — `configNameToToolId` and `splitIntroducedFindings` run for real,
// so a cold-start call (no prior run recorded for this engine's project
// root) classifies a finding in the edited file as introduced and a finding
// in any other file as pre-existing, which is exactly the split this test
// exercises in one call.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckReport } from "../check-engine/types.js";
import type { QualityCheckConfig } from "../types.js";

// Hoisted: replaces only `getOrCreateEngine` with a mock the test controls
// per-case; `configNameToToolId` (a pure name → ToolId map) stays real so
// `runCommandCheck`'s early "unknown tool" guard is exercised honestly.
vi.mock("../check-engine/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../check-engine/index.js")>();
	return { ...actual, getOrCreateEngine: vi.fn() };
});

import { CheckEngine, getOrCreateEngine } from "../check-engine/index.js";
import { runCommandCheck } from "./tool-command-check.js";

const mockGetOrCreateEngine = vi.mocked(getOrCreateEngine);

let dir = "";

beforeEach(() => {
	// A fresh, never-before-seen project root each test so the module-level
	// "previous run" memory inside splitIntroducedFindings starts cold.
	dir = mkdtempSync(join(tmpdir(), "tool-command-check-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.clearAllMocks();
});

function mkReport(results: CheckReport["results"]): CheckReport {
	return {
		results,
		toolsRun: [],
		toolsSkipped: [],
		skipped: [],
		elapsedMs: 0,
		metrics: [],
		deduplicatedCount: 0,
	};
}

const CHECK: QualityCheckConfig = {
	enabled: true,
	file_types: [".ts"],
	timeout_ms: 5_000,
	severity: "error",
};

describe("runCommandCheck typescript delta split — positive (must appear)", () => {
	it("P1: reports an introduced finding for the edited file", async () => {
		const editedFile = join(dir, "src/foo.ts");
		const engine = new CheckEngine(dir);
		vi.spyOn(engine, "runChecksAsync").mockResolvedValue(mkReport([{ tool: "tsc", severity: "error", file: editedFile, line: 12, message: "TS2345: bad arg" }]),);
		mockGetOrCreateEngine.mockReturnValue(engine);

		const results = await runCommandCheck(
			{ filePath: editedFile, cwd: dir, tscFilterFile: undefined, outToolMetrics: undefined },
			"typescript",
			CHECK,
		);

		expect(results).toHaveLength(1);
		expect(results?.[0]?.message).toBe(`typescript found new issues in ${editedFile}`);
	});

	it("P2: reports pre-existing findings from a different file as not-introduced", async () => {
		const editedFile = join(dir, "src/foo.ts");
		const otherFile = join(dir, "src/bar.ts");
		const engine = new CheckEngine(dir);
		vi.spyOn(engine, "runChecksAsync").mockResolvedValue(mkReport([{ tool: "tsc", severity: "error", file: otherFile, line: 3, message: "TS2322: type mismatch" }]),);
		mockGetOrCreateEngine.mockReturnValue(engine);

		const results = await runCommandCheck(
			{ filePath: editedFile, cwd: dir, tscFilterFile: undefined, outToolMetrics: undefined },
			"typescript",
			CHECK,
		);

		expect(results).toHaveLength(1);
		expect(results?.[0]?.severity).toBe("warning");
		expect(results?.[0]?.message).toBe(
			`typescript: 1 pre-existing issue(s) in ${otherFile} (while checking ${editedFile}) — not introduced by this edit`,
		);
	});
});
