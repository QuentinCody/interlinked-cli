// ===========================================
// change-set-external-candidates.ts — shallow-tail coverage
// ===========================================
// Two behaviors this file has no companion test for yet:
//   1. `pathMatchesCheck` with `skip_test_files: true` actually distinguishing
//      a test file from a source file (the `isLikelyTestFile` branch).
//   2. `candidateChecks` classifying a configured, file-matching, enabled
//      check whose tool id has no bounded project-batch runner as
//      "deferred" (not silently dropped, not run).

import { describe, expect, it } from "vitest";
import { candidateChecks, pathMatchesCheck } from "./change-set-external-candidates.js";
import type { QualityCheckConfig } from "../types.js";

function makeCheck(overrides: Partial<QualityCheckConfig> = {}): QualityCheckConfig {
	return {
		enabled: true,
		file_types: [".ts"],
		timeout_ms: 5_000,
		severity: "error",
		...overrides,
	};
}

describe("pathMatchesCheck — skip_test_files gate", () => {
	it("rejects a test file when skip_test_files is true", () => {
		const check = makeCheck({ skip_test_files: true });
		// If the skip_test_files branch were skipped (treated as a no-op),
		// this would return true like the non-skipping path does below.
		expect(pathMatchesCheck("src/foo.test.ts", check)).toBe(false);
	});

	it("accepts a non-test file when skip_test_files is true", () => {
		const check = makeCheck({ skip_test_files: true });
		expect(pathMatchesCheck("src/foo.ts", check)).toBe(true);
	});
});

describe("candidateChecks — deferred classification", () => {
	it("defers a matching, enabled check whose tool has no bounded multi-file mode", () => {
		const result = candidateChecks({
			paths: ["scripts/build.sh"],
			checks: {
				shellcheck: makeCheck({ file_types: [".sh"], command: "shellcheck" }),
			},
		});
		expect(result.candidates).toEqual([]);
		expect(result.deferred).toEqual([
			{
				name: "shellcheck",
				reason: "the configured runner is file-only and has no bounded multi-file mode",
			},
		]);
	});
});
