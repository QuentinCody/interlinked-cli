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
    it.each([["shellcheck", ".sh"], ["taplo", ".toml"]])("admits %s only as bounded file-mode recovery", (name, suffix) => {
        const check = makeCheck({ file_types: [suffix], command: name });
        const result = candidateChecks({ paths: [`a${suffix}`, `b${suffix}`], checks: { [name]: check }, recovery: true, maxFiles: 32 });
        expect(result.candidates).toEqual([{ name, check, toolId: name, fileOnly: true }]);
        expect(result.deferred).toEqual([]);
        const tooMany = candidateChecks({ paths: [`a${suffix}`, `b${suffix}`], checks: { [name]: check }, recovery: true, maxFiles: 1 });
        expect(tooMany.candidates).toEqual([]);
        expect(tooMany.deferred[0]?.reason).toContain("attribution budget exhausted");
    });
    it("reserves project-wide Gitleaks for recovery and never records an edit-time pass", () => {
        const options = { paths: ["src/a.ts"], checks: { gitleaks: makeCheck({ command: "gitleaks" }) } };
        const foreground = candidateChecks(options);
        expect(foreground.candidates).toEqual([]);
        expect(foreground.deferred).toEqual([{ name: "gitleaks", reason: expect.stringContaining("background recovery") }]);
        expect(candidateChecks({ ...options, recovery: true }).candidates.map(row => row.toolId)).toEqual(["gitleaks"]);
        expect(candidateChecks({ ...options, recovery: true }).deferred).toEqual([]);
    });
    it("admits imported lint through its existing project-scoped async runner", () => {
        const lint = makeCheck({ file_types: [""], command: "interlinked lint check" });
        const result = candidateChecks({ paths: ["src/one.ts", "src/two.ts"], checks: { lint_import: lint } });
        expect(result.candidates).toEqual([{ name: "lint_import", check: lint, toolId: "lint-import" }]);
        expect(result.deferred).toEqual([]);
    });

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
