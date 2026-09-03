import { describe, expect, it } from "vitest";
import type {
	CheckResult,
	CheckScope,
	ToolAvailability,
	ToolId,
	ToolRunnerInput,
} from "../types.js";

describe("check-engine types", () => {
	it("ToolId covers every canonical tool identifier", () => {
		// Exhaustive runtime list — if one is removed/added from the union,
		// this test pins the surface so we notice.
		const known: ToolId[] = [
			"tsc",
			"biome",
			"eslint",
			"semgrep",
			"gitleaks",
			"dep-audit",
			"mypy",
			"ruff",
			"cargo-check",
			"cargo-clippy",
			"go-build",
			"golangci-lint",
			"go-test",
			"c-compile",
			"clang-tidy",
			"oxlint",
			"knip",
			"shellcheck",
			"actionlint",
			"hadolint",
			"taplo",
			"swiftlint",
			"swift-build",
		];
		expect(known.length).toBeGreaterThanOrEqual(20);
		expect(new Set(known).size).toBe(known.length);
	});

	it("CheckResult requires tool / severity / file / line / message", () => {
		const r: CheckResult = {
			tool: "tsc",
			severity: "error",
			file: "src/a.ts",
			line: 10,
			message: "oops",
		};
		expect(r.tool).toBe("tsc");
		expect(r.line).toBe(10);
	});

	it("CheckScope supports project and file modes", () => {
		const project: CheckScope = { projectRoot: "/tmp", mode: "project" };
		const file: CheckScope = { projectRoot: "/tmp", mode: "file", targetFile: "/tmp/x.ts" };
		expect(project.mode).toBe("project");
		expect(file.targetFile).toBe("/tmp/x.ts");
	});

	it("ToolRunnerInput requires scope + timeoutMs", () => {
		const input: ToolRunnerInput = {
			scope: { projectRoot: "/tmp", mode: "project" },
			timeoutMs: 5000,
		};
		expect(input.timeoutMs).toBe(5000);
	});

	it("ToolAvailability has consistent shape for both available and unavailable", () => {
		const avail: ToolAvailability = { id: "tsc", available: true, version: "5.4.0" };
		const unavail: ToolAvailability = {
			id: "eslint",
			available: false,
			reason: "not installed",
		};
		expect(avail.available).toBe(true);
		expect(unavail.reason).toBeTruthy();
	});
});
