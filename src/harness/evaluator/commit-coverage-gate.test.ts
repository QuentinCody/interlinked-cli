import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordCoverageSources } from "../coverage-source-binding.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { runCommitCoverageGate } from "./commit-coverage-gate.js";

let repo: string;

function git(...args: string[]): void {
	execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

function write(path: string, content: string): void {
	const target = join(repo, path);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, content);
}

/** A passed coverage run over the CURRENT bytes of `files`, with each file's lines/branches percentage. */
function coverageRun(runId: string, files: Record<string, number>): void {
	const directory = join(repo, ".interlinked/test-runs", runId);
	mkdirSync(join(directory, "coverage"), { recursive: true });
	const summary: Record<string, unknown> = { total: {} };
	for (const [path, pct] of Object.entries(files)) {
		summary[join(repo, path)] = { lines: { total: 10, covered: 0, skipped: 0, pct }, branches: { total: 10, covered: 0, skipped: 0, pct } };
	}
	writeFileSync(join(directory, "coverage/coverage-summary.json"), JSON.stringify(summary));
	recordCoverageSources(directory, repo);
}

function baseline(files: Record<string, number>): void {
	const entries = Object.fromEntries(Object.entries(files).map(([path, pct]) => [path, { lines_pct: pct, branches_pct: pct }]));
	write(".interlinked/coverage-baseline.json", JSON.stringify({ version: 1, updated_at: "2026-10-02T00:00:00.000Z", files: entries }));
}

function gate(command = 'git commit -m "x"'): string[] {
	const event: HarnessEvent = { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Bash", tool_input: { command }, timestamp: "2026-10-02T00:00:00Z", cwd: repo };
	const decision: HarnessDecision = { decision: "allow" };
	runCommitCoverageGate(event, decision);
	return decision.warnings ?? [];
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "commit-coverage-"));
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	write("src/a.ts", "export const a = 1;\n");
	git("add", "src/a.ts");
	git("commit", "-q", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("runCommitCoverageGate — positive (must warn)", () => {
	it("names a staged file whose exact bytes measured below the coverage baseline", () => {
		baseline({ "src/a.ts": 90 });
		write("src/a.ts", "export const a = 2;\n");
		coverageRun("run-1", { "src/a.ts": 70 });
		git("add", "src/a.ts");
		const lines = gate();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("src/a.ts");
		expect(lines[0]).toContain("lines 70% < baseline 90%");
		expect(lines[0]).toContain("run-1");
	});

	it("reports staged files no run measured as NOT MEASURED, with the command that measures them", () => {
		baseline({ "src/a.ts": 90 });
		write("src/a.ts", "export const a = 3;\n");
		git("add", "src/a.ts");
		expect(gate()).toEqual([
			"[interlinked:commit-coverage] NOT MEASURED: no coverage run read the staged bytes of 1 source file(s): src/a.ts. Measure before pushing: interlinked tests run --all --coverage",
		]);
	});

	it("does not trust a run that measured the worktree when the staged bytes differ", () => {
		baseline({ "src/a.ts": 90 });
		write("src/a.ts", "export const a = 4;\n");
		git("add", "src/a.ts");
		write("src/a.ts", "export const a = 5;\n");
		coverageRun("run-worktree", { "src/a.ts": 100 });
		expect(gate()[0]).toContain("NOT MEASURED");
	});
});

describe("runCommitCoverageGate — git failure", () => {
	it("says NOT CHECKED instead of passing when the index cannot be read", () => {
		writeFileSync(join(repo, ".git/index"), "not an index");
		expect(gate()).toEqual(["[interlinked:commit-coverage] NOT CHECKED: git or the coverage store could not be read."]);
	});
});

describe("runCommitCoverageGate — negative (must not warn)", () => {
	it("stays silent when the staged bytes measured at or above the baseline", () => {
		baseline({ "src/a.ts": 90 });
		write("src/a.ts", "export const a = 6;\n");
		coverageRun("run-1", { "src/a.ts": 90 });
		git("add", "src/a.ts");
		expect(gate()).toEqual([]);
	});

	it("ignores test files, non-code files and commands that are not commits", () => {
		write("src/a.test.ts", "it('x', () => {});\n");
		write("docs/notes.md", "# notes\n");
		git("add", "src/a.test.ts", "docs/notes.md");
		expect(gate()).toEqual([]);
		write("src/a.ts", "export const a = 7;\n");
		git("add", "src/a.ts");
		expect(gate("git status")).toEqual([]);
	});

	it("treats a file new to the baseline as measured without judging it", () => {
		write("src/b.ts", "export const b = 1;\n");
		coverageRun("run-1", { "src/b.ts": 10 });
		git("add", "src/b.ts");
		expect(gate()).toEqual([]);
	});

	it("does nothing when an earlier gate already blocked the call", () => {
		write("src/a.ts", "export const a = 8;\n");
		git("add", "src/a.ts");
		const event: HarnessEvent = { hook_event: "PreToolUse", session_id: "s", agent_source: "claude", tool_name: "Bash", tool_input: { command: "git commit -m x" }, timestamp: "2026-10-02T00:00:00Z", cwd: repo };
		const decision: HarnessDecision = { decision: "block", reason: "earlier" };
		runCommitCoverageGate(event, decision);
		expect(decision.warnings).toBeUndefined();
	});
});
