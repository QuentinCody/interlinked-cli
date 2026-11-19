import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentVerifyTimings, withVerifyTimings } from "./check-timing.js";
import { createToolInputScopeCollector } from "./tool-input-scope.js";

describe("external scan scope coverage", () => {
	it("retains the final snapshot and records each final exclusion and gap once", async () => {
		const root = mkdtempSync(join(tmpdir(), "verify-tool-scope-"));
		const previousExitCode = process.exitCode;
		try {
			await withVerifyTimings(root, () => {
				const collector = createToolInputScopeCollector();
				const initial = { tool: "gitleaks" as const, selectedFiles: 3, targets: ["./src"], excludedInputs: [], unavailableInputs: [] };
				collector.record(initial);
				const final = { ...initial, excludedInputs: [{ file: ".git", reason: "History is outside working scan" }], unavailableInputs: [{ file: "src/gone.ts", reason: "Removed during scan" }] };
				collector.record(final);
				expect(collector.finish()).toEqual([final]);
				expect(currentVerifyTimings()).toContainEqual(expect.objectContaining({ check: "gitleaks", skipped: 1, excluded: 1 }));
			});
			expect(process.exitCode).toBe(75);
		} finally { process.exitCode = previousExitCode; rmSync(root, { recursive: true, force: true }); }
	});
});
