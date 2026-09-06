// Coverage fills for src/harness/tsgo-diagnostics.ts. No companion test file
// existed prior to this — these cases target the specific gaps recorded in
// coverage/lcov.info: lines 94, 118, 242, 243, 254, 255, 261 and branch lines
// 74, 157, 316.

import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TsgoDiagnostic } from "./daemon-protocol.js";
import {
	computeCacheKey,
	filterDiagnosticsForFile,
	findTsconfigDir,
	locateTsgo,
	parseDiagnosticLine,
	runTsgoOneShot,
	spawnCollect,
} from "./tsgo-diagnostics.js";

// runTsgoOneShot's compiler-lease admission is a dependency of the module
// under test, not the module itself — mocked here (not vi.spyOn on tsc/tsgo)
// because filling the real cross-process/queue admission state deterministically
// would require racing several concurrent calls against internal module state.
vi.mock("./project-compiler-gate.js", () => ({
	runWithProjectCompilerLease: () =>
		Promise.reject(new Error("compiler lease unavailable (test)")),
}));

// ============================================================
// locateTsgo — env var branch (L74)
// ============================================================

describe("locateTsgo", () => {
	const ORIGINAL = process.env.INTERLINKED_TSGO;
	afterEach(() => {
		if (ORIGINAL === undefined) delete process.env.INTERLINKED_TSGO;
		else process.env.INTERLINKED_TSGO = ORIGINAL;
	});

	it("falls back to bare 'tsgo' when INTERLINKED_TSGO is unset", () => {
		delete process.env.INTERLINKED_TSGO;
		expect(locateTsgo()).toBe("tsgo");
	});

	it("falls back to bare 'tsgo' when INTERLINKED_TSGO points at a nonexistent path", () => {
		process.env.INTERLINKED_TSGO = "/definitely/does/not/exist/tsgo-binary";
		expect(locateTsgo()).toBe("tsgo");
	});

	it("returns the env path when it exists on disk", () => {
		process.env.INTERLINKED_TSGO = __filename;
		expect(locateTsgo()).toBe(__filename);
	});
});

// ============================================================
// findTsconfigDir — loop-exhausted branch (L94)
// ============================================================

describe("findTsconfigDir", () => {
	const root = realpathSync(tmpdir());
	const deepBase = join(root, `interlinked-tsgo-diag-test-${Date.now()}`);

	afterEach(() => {
		rmSync(deepBase, { recursive: true, force: true });
	});

	it("returns null when no tsconfig.json is found within the 8-level walk-up limit", () => {
		const deepDir = join(deepBase, "a", "b", "c", "d", "e", "f", "g", "h", "i");
		mkdirSync(deepDir, { recursive: true });
		const target = join(deepDir, "file.ts");
		expect(findTsconfigDir(target)).toBeNull();
	});

	it("returns the directory containing tsconfig.json when found within range", () => {
		const shallowDir = join(deepBase, "proj");
		mkdirSync(shallowDir, { recursive: true });
		mkdirSync(join(shallowDir, "tsconfig.json")); // directory named tsconfig.json is enough for existsSync
		const target = join(shallowDir, "file.ts");
		expect(findTsconfigDir(target)).toBe(shallowDir);
	});
});

// ============================================================
// computeCacheKey — statSync failure branch (L118)
// ============================================================

describe("computeCacheKey", () => {
	it("degrades to mtime=0/size=0 when the path does not exist (catch branch)", () => {
		const key = computeCacheKey("/definitely/does/not/exist/nope.ts");
		// Deterministic given a fixed nonexistent path: hash over
		// (path|0|0). Two calls against the same nonexistent path agree.
		expect(key).toBe(computeCacheKey("/definitely/does/not/exist/nope.ts"));
		expect(key).toHaveLength(64); // sha256 hex digest
	});

	it("produces a different key for a real, existing file", () => {
		const key = computeCacheKey(__filename);
		expect(key).toHaveLength(64);
		expect(key).not.toBe(computeCacheKey("/definitely/does/not/exist/nope.ts"));
	});
});

// ============================================================
// filterDiagnosticsForFile — empty-file skip branch (L157)
// ============================================================

describe("filterDiagnosticsForFile", () => {
	it("drops diagnostics with no file field (project-level) and keeps matching ones", () => {
		const target = "/repo/src/x.ts";
		const diagnostics: TsgoDiagnostic[] = [
			{ file: "", line: 0, column: 0, code: 1, severity: "error", message: "project-level" },
			{ file: "src/x.ts", line: 3, column: 7, code: 2322, severity: "error", message: "match" },
			{ file: "src/other.ts", line: 1, column: 1, code: 1, severity: "error", message: "skip" },
		];
		const filtered = filterDiagnosticsForFile(diagnostics, target, "/repo");
		expect(filtered).toEqual([
			{ file: "src/x.ts", line: 3, column: 7, code: 2322, severity: "error", message: "match" },
		]);
	});
});

// ============================================================
// spawnCollect — spawn-throw, timeout, and stderr-data branches (L242, L243, L254, L255, L261)
// ============================================================

describe("spawnCollect", () => {
	it("resolves null when spawn() throws synchronously (empty executable)", async () => {
		const result = await spawnCollect("", ["-e", "process.exit(0)"], undefined, 5000);
		expect(result).toBeNull();
	});

	it("resolves null (via the async 'error' event, not a sync throw) for a nonexistent cwd", async () => {
		const result = await spawnCollect(
			process.execPath,
			["-e", "process.exit(0)"],
			"/definitely/does/not/exist/as/a/cwd",
			5000,
		);
		expect(result).toBeNull();
	});

	it("resolves null on timeout and kills the child", async () => {
		const result = await spawnCollect(
			process.execPath,
			["-e", "setTimeout(() => {}, 5000)"],
			undefined,
			50,
		);
		expect(result).toBeNull();
	});

	it("collects stdout AND stderr and joins them with a newline", async () => {
		const result = await spawnCollect(
			process.execPath,
			["-e", "process.stdout.write('out-line'); process.stderr.write('err-line');"],
			undefined,
			5000,
		);
		expect(result).toBe("out-line\nerr-line");
	});

	it("treats a non-zero compiler exit without diagnostics as unavailable", async () => {
		const result = await spawnCollect(
			process.execPath,
			["-e", "process.stderr.write('internal compiler failure'); process.exit(2);"],
			undefined,
			5000,
		);
		expect(result).toBeNull();
	});

	it("preserves structured diagnostics from an ordinary non-zero compiler exit", async () => {
		const diagnostic = "src/x.ts(1,2): error TS2322: incompatible value";
		const result = await spawnCollect(
			process.execPath,
			["-e", `process.stdout.write(${JSON.stringify(diagnostic)}); process.exit(1);`],
			undefined,
			5000,
		);
		expect(result).toBe(`${diagnostic}\n`);
	});
});

// ============================================================
// runTsgoOneShot — compiler-lease rejection branch (L231)
// ============================================================

describe("runTsgoOneShot", () => {
	it("falls back to the tsgo-unavailable diagnostic when compiler admission rejects", async () => {
		const target = "/definitely/does/not/exist/nope.ts";
		const result = await runTsgoOneShot(process.execPath, target, [], 5000);
		// If the catch around runWithProjectCompilerLease were removed, the
		// mocked rejection above would propagate and this call would reject
		// instead of resolving to the unavailable-diagnostic fallback.
		expect(result).toEqual([
			{
				file: target,
				line: 0,
				column: 0,
				code: -1,
				severity: "warning",
				message:
					"[interlinked:tsgo-unavailable] TypeScript diagnostics were not checked because the compiler failed, timed out, or was killed.",
			},
		]);
	});
});

// ============================================================
// parseDiagnosticLine — malformed error-TS fallback branch (L316)
// ============================================================

describe("parseDiagnosticLine", () => {
	it("returns null when the line looks like a bare error-TS line but fails the structured regex (missing code digits)", () => {
		expect(parseDiagnosticLine("error TS: something went wrong", "default.ts")).toBeNull();
	});

	it("parses a well-formed bare error-TS line via the fallback branch", () => {
		expect(parseDiagnosticLine("error TS1234: something went wrong", "default.ts")).toEqual({
			file: "default.ts",
			line: 0,
			column: 0,
			severity: "error",
			code: 1234,
			message: "something went wrong",
		});
	});

	it("parses a well-formed bare warning-TS line via the fallback branch", () => {
		expect(parseDiagnosticLine("warning TS5678: heads up", "default.ts")).toEqual({
			file: "default.ts",
			line: 0,
			column: 0,
			severity: "warning",
			code: 5678,
			message: "heads up",
		});
	});

	it("returns null for a line that is neither structured nor a bare error/warning TS line", () => {
		expect(parseDiagnosticLine("just some noise", "default.ts")).toBeNull();
	});
});
