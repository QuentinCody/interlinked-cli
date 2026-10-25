// Mutation-kill companion for complexity-write-guard.ts (LEAN MODE, pass-1 fleet).
// Split into its OWN file (not the main `complexity-write-guard.test.ts`) for two
// reasons that don't fit that file's existing setup:
//   1. The module-init test below needs the pythonDegradeWarned latch's PRISTINE
//      (freshly-loaded-module) value, before any test calls the reset helper —
//      it must be the first thing this file's module registry observes, which
//      only holds if it is the first `it()` in a file vitest hasn't touched yet
//      (per-file module isolation is vitest's default: each test FILE gets its
//      own module registry, so this file's copy of complexity-write-guard.ts is
//      independent of the companion file's copy).
//   2. The js_ts-silent-path test needs `../checks/cyclomatic-ast.js` MOCKED —
//      the main companion file deliberately keeps that module REAL ("the TS
//      analyzer stays REAL so the JS/TS tests exercise the unchanged path
//      end-to-end"), so mocking it here would break every real-AST assertion
//      there if done in the same file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../checks/cyclomatic-python.js", () => ({
	computeCyclomaticPython: vi.fn(),
}));
vi.mock("../checks/cyclomatic-ast.js", () => ({
	computeCyclomaticAst: vi.fn(() => null),
	// Water-line modules on the import path parse with it; null = TypeScript unavailable.
	parseTsSource: vi.fn(() => null),
}));

import { computeCyclomaticPython as mockedComputeCyclomaticPython } from "../checks/cyclomatic-python.js";
import {
	__resetPythonDegradeWarningForTesting,
	checkFunctionComplexityWrite,
} from "./complexity-write-guard.js";

const pythonMock = vi.mocked(mockedComputeCyclomaticPython);

let tmp: string;
afterEach(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// MUST stay the first describe/it in this file: it asserts the pythonDegradeWarned
// latch's value as loaded fresh by the module system, before anything (including
// this file's own other tests) has a chance to call the reset helper or trip the
// latch itself. Kills mutantId 65ffee1be8df96fb (module-init `false` -> `true`).
describe("module init — pythonDegradeWarned latch starts false", () => {
	// test-contract: invariant — a fresh process has never warned about a
	// missing `radon`, so the FIRST unanalyzable .py edit must be loud, not
	// silently swallowed by an already-tripped latch.
	it("P0: the first unavailable-Python edit in a fresh module warns immediately (latch did not start already-tripped)", () => {
		pythonMock.mockReturnValue(null);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		tmp = mkdtempSync(join(tmpdir(), "cyc-guard-mk0-"));
		try {
			checkFunctionComplexityWrite(
				{ file_path: join(tmp, "f.py"), content: "def f():\n    pass\n" },
				tmp,
			);
			const wrote = stderrSpy.mock.calls.some(
				(c) => typeof c[0] === "string" && c[0].includes("radon"),
			);
			expect(wrote).toBe(true);
		} finally {
			stderrSpy.mockRestore();
		}
	});
});

// Kills mutantId 3a63f3fcff879f20 (`language !== "python"` forced to `false`
// inside warnAnalyzerUnavailable's early-return guard).
describe("warnAnalyzerUnavailable — the js_ts path is a silent no-op", () => {
	// test-contract: public-api — the JS/TS degrade is announced once at
	// daemon startup, not per-edit (module header); per-edit stderr for
	// js_ts would be a nagging regression.
	it("does not write to stderr when the TS analyzer is unavailable (already announced at daemon startup)", () => {
		__resetPythonDegradeWarningForTesting();
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		tmp = mkdtempSync(join(tmpdir(), "cyc-guard-mk1-"));
		try {
			const out = checkFunctionComplexityWrite(
				{ file_path: join(tmp, "f.ts"), content: "export function f() { return 1; }\n" },
				tmp,
			);
			expect(out).toBeNull(); // fail OPEN — never a false block
			expect(stderrSpy).not.toHaveBeenCalled();
		} finally {
			stderrSpy.mockRestore();
		}
	});
});
