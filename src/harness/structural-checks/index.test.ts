// Smoke tests for the split structural-checks submodules. Real behavior is
// covered by src/harness/__tests__/structural-checks-extended.test.ts via the
// top-level runStructuralChecks entry point; these tests guard against
// accidental export drift and module-load failures in the extracted helpers.

import { describe, expect, it } from "vitest";
import { checkImportCycles } from "./cycles.js";
import { checkDeadExports } from "./dead-exports.js";
import { parseEnvKeys, readEnvExampleFromDir } from "./env-loader.js";
import { checkUndefinedEnvVars } from "./env-vars.js";
import {
	checkExportRippleCompilation,
	checkExportSurface,
	checkRippleTests,
	findTestFileForSource,
} from "./export-surface.js";
import { formatStructuralWarnings } from "./formatter.js";
import {
	escapeRegex,
	exportSurfaceChanged,
	extractFilePath,
	isReadOperation,
	isWriteOperation,
} from "./helpers.js";
import {
	checkCrossPackageImports,
	checkDeadImports,
	checkDuplicateSymbols,
	checkHallucinatedImports,
	checkImportResolution,
} from "./imports.js";
import {
	checkCoDependencyStaleness,
	checkInterfaceChangeImpact,
	checkJSDocParamMismatch,
	checkTestProximity,
} from "./misc-checks.js";

describe("structural-checks submodules (smoke)", () => {
	it("helpers export tool-name classifiers and regex utilities", () => {
		expect(isWriteOperation("Write")).toBe(true);
		expect(isReadOperation("Read")).toBe(true);
		expect(isReadOperation("Bash")).toBe(false);
		expect(escapeRegex("a.b")).toBe("a\\.b");
	});

	it("extractFilePath pulls file_path / path from tool_input", () => {
		expect(extractFilePath({ tool_input: { file_path: "/a.ts" } })).toBe("/a.ts");
		expect(extractFilePath({ tool_input: { path: "/b.ts" } })).toBe("/b.ts");
		expect(extractFilePath({ tool_input: {} })).toBeNull();
	});

	it("exportSurfaceChanged returns false for identical sets", () => {
		const same = [{ name: "foo", kind: "function" as const, isTypeOnly: false, line: 1 }];
		expect(exportSurfaceChanged(same, [...same])).toBe(false);
	});

	it("env-loader parseEnvKeys skips comments and empty lines", () => {
		const keys = parseEnvKeys("# comment\nFOO=1\n\nBAR=2");
		expect(keys.has("FOO")).toBe(true);
		expect(keys.has("BAR")).toBe(true);
		expect(keys.size).toBe(2);
	});

	it("env-loader readEnvExampleFromDir returns null for missing dir", () => {
		expect(readEnvExampleFromDir("/tmp/__no_such_dir__")).toBeNull();
	});

	it("formatter renders [interlinked:] prefixes and drops noisy checks", () => {
		const out = formatStructuralWarnings([
			{ check: "import_resolution", severity: "error", message: "m", file: "/a.ts" },
			{ check: "dead_imports", severity: "warning", message: "x", file: "/a.ts" },
		]);
		expect(out.some((s) => s.includes("[interlinked:import_resolution]"))).toBe(true);
		expect(out.some((s) => s.includes("dead_imports"))).toBe(false);
	});

	it("findTestFileForSource returns null for non-existent files", () => {
		expect(findTestFileForSource("/tmp/__missing__.ts")).toBeNull();
	});

	it("all named checks are exported as callable functions", () => {
		const fns = [
			checkImportCycles,
			checkDeadExports,
			checkUndefinedEnvVars,
			checkExportSurface,
			checkExportRippleCompilation,
			checkRippleTests,
			checkImportResolution,
			checkDuplicateSymbols,
			checkDeadImports,
			checkHallucinatedImports,
			checkCrossPackageImports,
			checkCoDependencyStaleness,
			checkInterfaceChangeImpact,
			checkJSDocParamMismatch,
			checkTestProximity,
		];
		for (const fn of fns) {
			expect(typeof fn).toBe("function");
		}
	});
});
