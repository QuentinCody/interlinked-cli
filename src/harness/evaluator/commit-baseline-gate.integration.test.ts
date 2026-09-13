import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import { checkCommitBaselineGate, runCommitBaselineGate } from "./commit-baseline-gate.js";

let root: string;
const REL = ".interlinked/large-files-baseline.json";

function git(...args: string[]): void {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function writeBaseline(rel: string, obj: unknown): void {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, JSON.stringify(obj, null, 2), "utf-8");
}

function commitEvent(command: string, cwd = root): HarnessEvent {
	return ({
		hook_event: "PreToolUse",
		session_id: "s1",
		agent_source: "claude",
		tool_name: "Bash",
		tool_input: { command },
		timestamp: "2026-06-21T00:00:00.000Z",
		cwd,
	} satisfies HarnessEvent);
}

function allow() {
	return { decision: "allow" as const };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "commit-baseline-"));
	git("init", "-q");
	git("config", "user.email", "t@t.test");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	writeBaseline(REL, { max_lines: 500, files: {} });
	git("add", "-f", REL);
	git("commit", "-q", "-m", "seed baseline");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("checkCommitBaselineGate", () => {
	it("blocks a commit that stages a loosened baseline (cap raised)", () => {
		writeBaseline(REL, { max_lines: 800, files: {} });
		git("add", "-f", REL);
		const d = checkCommitBaselineGate(commitEvent('git commit -m "raise cap"'));
		expect(d?.decision).toBe("block");
		expect(d?.rule_id).toBe("commit_baseline_integrity_gate");
		expect(d?.reason).toContain("max_lines");
	});

	it("blocks a staged untested-files floor drop", () => {
		writeBaseline(".interlinked/untested-files-baseline.json", { min_coverage_pct: 80, files: [] });
		git("add", "-f", ".interlinked/untested-files-baseline.json");
		git("commit", "-q", "-m", "seed untested");
		writeBaseline(".interlinked/untested-files-baseline.json", { min_coverage_pct: 50, files: [] });
		git("add", "-f", ".interlinked/untested-files-baseline.json");
		expect(checkCommitBaselineGate(commitEvent('git commit -m "drop floor"'))?.decision).toBe("block");
	});

	it("allows a commit that stages a tightened baseline (cap lowered)", () => {
		writeBaseline(REL, { max_lines: 300, files: {} });
		git("add", "-f", REL);
		expect(checkCommitBaselineGate(commitEvent('git commit -m "tighten"'))).toBeNull();
	});

	it("allows creating a brand-new baseline (no HEAD version)", () => {
		writeBaseline(".interlinked/metric-caps.json", { max_cyclomatic: 25 });
		git("add", "-f", ".interlinked/metric-caps.json");
		expect(checkCommitBaselineGate(commitEvent('git commit -m "add caps"'))).toBeNull();
	});

	it("is a no-op for a non-commit command", () => {
		writeBaseline(REL, { max_lines: 800, files: {} });
		git("add", "-f", REL);
		expect(checkCommitBaselineGate(commitEvent("git status"))).toBeNull();
	});

	it("honors the INTERLINKED_DISABLE_BASELINE_GUARD bypass", () => {
		writeBaseline(REL, { max_lines: 800, files: {} });
		git("add", "-f", REL);
		const prev = process.env.INTERLINKED_DISABLE_BASELINE_GUARD;
		process.env.INTERLINKED_DISABLE_BASELINE_GUARD = "1";
		try {
			expect(checkCommitBaselineGate(commitEvent('git commit -m "x"'))).toBeNull();
		} finally {
			if (prev === undefined) delete process.env.INTERLINKED_DISABLE_BASELINE_GUARD;
			else process.env.INTERLINKED_DISABLE_BASELINE_GUARD = prev;
		}
	});

	it("fail-opens outside a git repo", () => {
		const bare = mkdtempSync(join(tmpdir(), "commit-baseline-nogit-"));
		try {
			expect(checkCommitBaselineGate(commitEvent('git commit -m "x"', bare))).toBeNull();
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});

describe("runCommitBaselineGate (pipeline wrapper)", () => {
	it("blocks a loosened staged baseline even when the preceding phase has an empty warning list", () => {
		writeBaseline(REL, { max_lines: 800, files: {} });
		git("add", "-f", REL);
		const decision = runCommitBaselineGate(commitEvent('git commit -m "x"'), {
			decision: "allow", warnings: [],
		});
		expect(decision).toMatchObject({ decision: "block", rule_id: "commit_baseline_integrity_gate" });
		expect(decision?.reason).toContain("max_lines");
	});

	it("returns a block (merging warnings) on a loosened staged baseline", () => {
		writeBaseline(REL, { max_lines: 800, files: {} });
		git("add", "-f", REL);
		const d = runCommitBaselineGate(commitEvent('git commit -m "x"'), {
			decision: "allow",
			warnings: ["w1"],
		});
		expect(d?.decision).toBe("block");
		expect(d?.warnings).toContain("w1");
	});

	it("returns null when the running decision is not allow", () => {
		expect(runCommitBaselineGate(commitEvent('git commit -m "x"'), { decision: "block" })).toBeNull();
	});

	it("returns null for a non-Bash tool", () => {
		const ev = ({  ...commitEvent('git commit -m "x"'), tool_name: "Write" } satisfies HarnessEvent);
		expect(runCommitBaselineGate(ev, allow())).toBeNull();
	});
});
