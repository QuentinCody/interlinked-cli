import { afterEach, expect, it, vi } from "vitest";
import type { ToolAvailability } from "../../harness/check-engine/types.js";
import { runAsyncTool } from "../../harness/check-engine/index-runtime.js";
import { streamExternalTools } from "./verify-tools.js";

vi.mock("../../harness/check-engine/index-runtime.js", async (original) => ({
	...await original<typeof import("../../harness/check-engine/index-runtime.js")>(),
	runAsyncTool: vi.fn(),
}));

const exitCode = process.exitCode;
afterEach(() => {
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

async function render(tool: ToolAvailability, only: string, skipChecks = new Set<string>()) {
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	const allFlaggedFiles = new Set<string>();
	await streamExternalTools({
		engine: { discoverTools: () => [tool] }, cwd: process.cwd(), opts: { only, toolTimeout: 3200 },
		skipChecks, summary: [], allFlaggedFiles, details: true,
	});
	return { text: stderr.mock.calls.map(([chunk]) => chunk).join(""), allFlaggedFiles };
}

it("retains the managed runner's partial findings and unavailable verdict for a catalog alias", async () => {
	vi.mocked(runAsyncTool).mockResolvedValue({
		results: [{ tool: "ruff", file: "src/x.py", severity: "error", line: 4, message: "undeclared name" }],
		metric: { tool: "ruff", elapsedMs: 1, findingCount: 1, cacheHit: false },
		skipped: { check: "ruff", category: "error", reason: "second input unreadable" },
	});
	const result = await render({ id: "ruff", available: true }, "ruff_lint");
	expect(vi.mocked(runAsyncTool)).toHaveBeenCalledWith({ id: "ruff", available: true },
		{ projectRoot: process.cwd(), mode: "project" }, 3200, expect.objectContaining({ resourcePolicy: "foreground-verify" }));
	expect(result.text).toContain("second input unreadable");
	expect(result.text).toContain("L4: undeclared name");
	expect(result.allFlaggedFiles.has("src/x.py")).toBe(true);
	expect(process.exitCode).toBe(75);
});

it("reports a selected tool's missing installation and preserves exclusion by alias", async () => {
	const result = await render({ id: "ruff", available: false, reason: "ruff binary missing" }, "ruff_lint");
	expect(result.text).toContain("ruff binary missing");
	vi.restoreAllMocks();
	const excluded = await render({ id: "ruff", available: true }, "ruff", new Set(["ruff_lint"]));
	expect(excluded.text).toBe("");
	expect(runAsyncTool).not.toHaveBeenCalled();
});
