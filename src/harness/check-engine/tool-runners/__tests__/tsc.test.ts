import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCompletedCompiler, runTsc } from "../tsc.js";

describe("runTsc", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tsc-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("is a function with the ToolRunner signature", () => {
		expect(typeof runTsc).toBe("function");
	});

	it("returns [] when there's no tsconfig.json in the project tree", () => {
		const results = runTsc({
			scope: { projectRoot: tmp, mode: "project" },
			timeoutMs: 5_000,
		});
		expect(results).toEqual([]);
	});
});

describe("parseCompletedCompiler — output-size guard", () => {
	it("reports a truncated-output finding instead of parsing when output hits the 10MB read limit", () => {
		// Exactly at the limit, so the `>=` boundary is what fires — the length
		// check, not diagnostic parsing; the body is non-diagnostic filler,
		// proving the branch short-circuits before parseTscOutput ever runs on it.
		const hugeOutput = "x".repeat(10 * 1024 * 1024);
		const findings = parseCompletedCompiler(hugeOutput, 0, "src/example.ts");
		expect(findings).toEqual([
			{
				tool: "tsc",
				severity: "warning",
				file: "src/example.ts",
				line: 0,
				message: "[interlinked:tsc-unavailable] TypeScript was NOT CHECKED: compiler output was truncated",
				ruleId: "tsc-unavailable",
			},
		]);
	});
});


describe("runTscAsync — compiler-process failure (reached through the public entry point)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "tsc-async-fail-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
		vi.doUnmock("../../spawn-async.js");
		vi.resetModules();
	});

	it("project mode reports the thrown error's message under the admission-failed prefix", async () => {
		// A real tsconfig.json in tmp makes findTsconfig resolve tmp as the
		// project root on the FIRST check, so runTscAsync routes into the
		// project-mode compiler-lease path (not the standalone fallback).
		writeFileSync(join(tmp, "tsconfig.json"), "{}");
		vi.resetModules();
		vi.doMock("../../spawn-async.js", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../../spawn-async.js")>();
			return {
				...actual,
				runProcessAsync: vi.fn().mockRejectedValue(new Error("spawn refused: boom-run")),
			};
		});
		const { runTscAsync: reloadedRunTscAsync } = await import("../tsc.js");
		const findings = await reloadedRunTscAsync({
			scope: { projectRoot: tmp, mode: "project" },
			timeoutMs: 5_000,
		});
		expect(findings).toEqual([
			{
				tool: "tsc",
				severity: "warning",
				file: "tsconfig.json",
				line: 0,
				message:
					"[interlinked:tsc-unavailable] TypeScript was NOT CHECKED: compiler admission failed: spawn refused: boom-run",
				ruleId: "tsc-unavailable",
			},
		]);
	});

	it("file mode with no tsconfig in scope reports the thrown error's bare message (no admission prefix)", async () => {
		// cwd is never created, so findTsconfig walks 5 levels up and finds
		// nothing, routing runTscAsync into the standalone fallback instead.
		vi.resetModules();
		vi.doMock("../../spawn-async.js", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../../spawn-async.js")>();
			return {
				...actual,
				runProcessAsync: vi.fn().mockRejectedValue(new Error("spawn refused: boom-standalone")),
			};
		});
		const { runTscAsync: reloadedRunTscAsync } = await import("../tsc.js");
		const cwd = join(tmpdir(), "does-not-exist-standalone");
		const findings = await reloadedRunTscAsync({
			scope: { projectRoot: cwd, mode: "file", targetFile: join(cwd, "foo.ts") },
			timeoutMs: 5_000,
		});
		expect(findings).toEqual([
			{
				tool: "tsc",
				severity: "warning",
				file: "foo.ts",
				line: 0,
				message: "[interlinked:tsc-unavailable] TypeScript was NOT CHECKED: spawn refused: boom-standalone",
				ruleId: "tsc-unavailable",
			},
		]);
	});
});
