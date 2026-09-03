// Behavioral unit tests for the Go full-suite test runner (runGoTest) and its
// output parser (parseGoTestOutput). The subprocess boundary is mocked at the
// module edge (same pattern as go.integration.test.ts) so tests are
// deterministic and never spawn a real `go`.

import type { SpawnSyncReturns } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { parseGoTestOutput } from "../output-parsers.js";
import type { ResolvedToolCommand } from "../types.js";
import type { CheckScope, ToolRunnerInput } from "../types.js";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const { runGoTest } = await import("./go.js");

const PROJECT_ROOT = "/work/repo";

function projectScope(): CheckScope {
	return { projectRoot: PROJECT_ROOT, mode: "project" };
}

function runInput(override?: ResolvedToolCommand): ToolRunnerInput {
	return { scope: projectScope(), timeoutMs: 30_000, commandOverride: override };
}

function spawnResult(partial: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
	const base: SpawnSyncReturns<string> = {
		pid: 1,
		output: [],
		stdout: "",
		stderr: "",
		status: 0,
		signal: null,
	};
	return { ...base, ...partial };
}

describe("runGoTest — spawned argv", () => {
	beforeEach(() => {
		spawnSyncMock.mockReset();
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0 }));
	});

	it("spawns the default `go test ./...`", () => {
		runGoTest(runInput());
		const [bin, args] = spawnSyncMock.mock.calls[0] ?? [];
		expect(bin).toBe("go");
		expect(args).toEqual(["test", "./..."]);
	});

	it("honors configured base_args (project build tags) in the spawned argv", () => {
		runGoTest(
			runInput({
				baseArgs: ["-tags", "dev", "devaccounts", "./..."],
			}),
		);
		const [bin, args] = spawnSyncMock.mock.calls[0] ?? [];
		expect(bin).toBe("go");
		expect(args).toEqual(["test", "-tags", "dev", "devaccounts", "./..."]);
	});

	it("uses a full command override verbatim", () => {
		runGoTest(runInput({ baseArgs: [], argv: ["/custom/go", "test", "-v", "./..."] }));
		const [bin, args] = spawnSyncMock.mock.calls[0] ?? [];
		expect(bin).toBe("/custom/go");
		expect(args).toEqual(["test", "-v", "./..."]);
	});

	it("exit 0 is a clean run", () => {
		spawnSyncMock.mockReturnValue(spawnResult({ status: 0, stdout: "ok  package 0.1s\n" }));
		expect(runGoTest(runInput())).toEqual([]);
	});

	it("applies the configured timeout cap", () => {
		runGoTest(runInput({ baseArgs: [], timeoutMs: 300_000 }));
		const options = spawnSyncMock.mock.calls[0]?.[2];
		expect(options?.timeout).toBe(300_000);
	});

	it("missing binary (ENOENT) returns no-verdict [] like go-build", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: null, error: Object.assign(new Error("x"), { code: "ENOENT" }) }),
		);
		expect(runGoTest(runInput())).toEqual([]);
	});
});

describe("runGoTest — red-suite findings", () => {
	beforeEach(() => spawnSyncMock.mockReset());

	it("maps a failing test into a per-unit finding", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({
				status: 1,
				stdout: "--- FAIL: TestTombstone (0.01s)\nFAIL\nFAIL\tgithub.com/x/internal/history\t0.014s\n",
			}),
		);
		const findings = runGoTest(runInput());
		expect(findings.some((f) => f.message.includes("FAIL: TestTombstone"))).toBe(true);
		expect(findings.some((f) => f.message.includes("package github.com/x/internal/history failed"))).toBe(
			true,
		);
		expect(findings.every((f) => f.tool === "go-test")).toBe(true);
	});

	it("a non-zero exit with unparseable output still yields a [proven] verdict", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: 2, stderr: "go: unknown flag --nope\n" }),
		);
		const findings = runGoTest(runInput());
		expect(findings).toHaveLength(1);
		expect(findings[0]!.message).toContain("go test failed (exit 2)");
	});

	it("a timeout produces an explicit no-verdict warning, never clean", () => {
		spawnSyncMock.mockReturnValue(
			spawnResult({ status: null, error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }) }),
		);
		const findings = runGoTest(runInput());
		expect(findings).toHaveLength(1);
		expect(findings[0]!.message).toContain("timed out");
	});
});

describe("parseGoTestOutput", () => {
	it("parses FAIL test headers and FAIL package trailers", () => {
		const out = [
			"--- FAIL: TestA (0.01s)",
			"    a_test.go:12: got 1 want 2",
			"--- FAIL: TestB (0.00s)",
			"FAIL",
			"FAIL\tgithub.com/x/pkg\t0.020s",
			"FAIL",
		].join("\n");
		const findings = parseGoTestOutput(out, 1);
		expect(findings.map((f) => f.message)).toEqual([
			"FAIL: TestA (0.01s)",
			"FAIL: TestB (0.00s)",
			"package github.com/x/pkg failed",
		]);
		expect(nonNull(findings.find((f) => f.message.includes("github.com/x/pkg"))).file).toBe(
			"github.com/x/pkg",
		);
	});

	it("captures panic lines", () => {
		const findings = parseGoTestOutput("panic: runtime error: index out of range", 2);
		expect(findings.some((f) => f.message.startsWith("panic:"))).toBe(true);
	});

	it("falls back to a generic whole-run finding with a stderr tail", () => {
		const findings = parseGoTestOutput("fatal: no test files", 1);
		expect(findings).toHaveLength(1);
		expect(findings[0]!.message).toContain("fatal: no test files");
	});

	it("empty output with non-zero status still yields a finding (never clean)", () => {
		expect(parseGoTestOutput("", 1)).toHaveLength(1);
	});
});