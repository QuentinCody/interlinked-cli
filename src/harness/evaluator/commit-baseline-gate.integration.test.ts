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
	it("protects an adopted inherited metric against staged global posture downgrade", () => {
		const config = ".interlinked/config.json", policy = ".interlinked/check-policy.json";
		writeBaseline(config, { harness: { edit_metrics: { mode: "enforced" } } });
		writeBaseline(policy, { metrics: { cyclomatic: { threshold: 10 } } });
		git("add", "-f", config, policy); git("commit", "-q", "-m", "seed inherited policy");
		writeBaseline(config, {}); git("add", "-f", config);
		expect(checkCommitBaselineGate(commitEvent("git commit -m global"))?.reason).toContain("metric-policy:cyclomatic:mode");
	});
	it("allows historical global posture changes without metric adoption", () => {
		const config = ".interlinked/config.json";
		writeBaseline(config, { harness: { edit_metrics: { mode: "enforced" } } });
		git("add", "-f", config); git("commit", "-q", "-m", "seed global policy");
		writeBaseline(config, {}); git("add", "-f", config);
		expect(checkCommitBaselineGate(commitEvent("git commit -m global"))).toBeNull();
	});
	it("blocks a staged adopted metric-policy downgrade", () => {
		const policy = ".interlinked/check-policy.json";
		writeBaseline(policy, { metrics: { cyclomatic: { mode: "block", threshold: 10 } } });
		git("add", "-f", policy); git("commit", "-q", "-m", "seed metric policy");
		writeBaseline(policy, { metrics: { cyclomatic: { mode: "warn" } } });
		git("add", "-f", policy);
		writeBaseline(policy, { metrics: { cyclomatic: { mode: "block", threshold: 5 } } });
		expect(checkCommitBaselineGate(commitEvent("git commit -m policy"))?.reason).toContain("metric-policy:cyclomatic:mode");
	});
	it("protects inherited enforcement from a newly staged team override", () => {
		writeBaseline(".interlinked/config.json", { harness: { edit_metrics: { mode: "enforced" } } });
		writeBaseline(".interlinked/check-policy.json", { metrics: { cyclomatic: { mode: "off" } } });
		git("add", "-f", ".interlinked/check-policy.json");
		expect(checkCommitBaselineGate(commitEvent("git commit -m override"))?.reason).toContain("metric-policy:cyclomatic:mode");
	});
	it("allows deletion of historical check-only policy without metric adoption", () => {
		const policy = ".interlinked/check-policy.json";
		writeBaseline(policy, { checks: { test_without_description: { action: "warn_after" } } });
		git("add", "-f", policy); git("commit", "-q", "-m", "seed check policy");
		git("rm", "-q", policy);
		expect(checkCommitBaselineGate(commitEvent("git commit -m remove-check-policy"))).toBeNull();
	});
	it("blocks removal of an adopted metric policy", () => {
		const policy = ".interlinked/check-policy.json";
		writeBaseline(policy, { metrics: { cyclomatic: { mode: "block", threshold: 10 } } });
		git("add", "-f", policy); git("commit", "-q", "-m", "seed metric policy");
		git("rm", "-q", policy);
		expect(checkCommitBaselineGate(commitEvent("git commit -m remove-metric-policy"))?.reason).toContain("metric-policy:cyclomatic:mode");
	});
	it("uses staged companion caps when a policy target falls back to a tighter cap", () => {
		const policy = ".interlinked/check-policy.json", caps = ".interlinked/metric-caps.json";
		writeBaseline(policy, { metrics: { cyclomatic: { mode: "block", threshold: 5 } } });
		writeBaseline(caps, { max_cyclomatic: 25 });
		git("add", "-f", policy, caps); git("commit", "-q", "-m", "seed metric target");
		writeBaseline(policy, { metrics: { cyclomatic: { mode: "block" } } });
		writeBaseline(caps, { max_cyclomatic: 4 });
		git("add", "-f", policy, caps);
		expect(checkCommitBaselineGate(commitEvent("git commit -m tighten"))).toBeNull();
	});
	it("blocks broad removals while ignoring baselines that were never tracked", () => {
		const decision = checkCommitBaselineGate(commitEvent("git rm -r -- .interlinked && git commit -m remove"));
		expect(decision).toMatchObject({ decision: "block" });
		expect(decision?.reason).toContain(`[deleted] ${REL}`);
		expect(decision?.reason).not.toContain("[deleted] .interlinked/metric-caps.json");
	});

	it("P2 n19: `git rm --pathspec-from-file` before a commit is a broad removal (the gate cannot see the list)", () => {
		writeFileSync(join(root, "list"), `${REL}\n`);
		const decision = checkCommitBaselineGate(commitEvent("git rm --pathspec-from-file=list && git commit -m remove"));
		expect(decision?.reason).toContain(`[deleted] ${REL}`);
	});

	it.each([`git mv ${REL} moved.json`, `git mv -f -- ${REL} moved.json`, `git mv ${REL} .interlinked/other.json elsewhere/`])("P2 n21: `git mv` of a tracked water-line away from its path is a removal (%s)", (mv) => {
		const decision = checkCommitBaselineGate(commitEvent(`${mv} && git commit -m move`));
		expect(decision?.reason).toContain(`[deleted] ${REL}`);
	});

	it("N n21: `git mv` of another file, or a dry-run mv, leaves the baseline alone", () => {
		writeFileSync(join(root, "note.txt"), "x");
		git("add", "note.txt");
		git("commit", "-q", "-m", "note");
		expect(checkCommitBaselineGate(commitEvent("git mv note.txt note2.txt && git commit -m move"))).toBeNull();
		expect(checkCommitBaselineGate(commitEvent(`git mv -n ${REL} moved.json && git commit -m dry`))).toBeNull();
	});

	it.each(["-A", "--pathspec-from-file=list"])("checks worktree bytes before a broad add followed by write-tree (%s)", (options) => {
		writeBaseline(REL, { max_lines: 800, files: {} });
		writeFileSync(join(root, "list"), `${REL}\n`);
		const decision = checkCommitBaselineGate(commitEvent(`git add ${options} && git write-tree`));
		expect(decision).toMatchObject({ decision: "block" });
		expect(decision?.reason).toContain("max_lines");
	});

	it("checks every baseline when a commit pathspec resolves to the repository root", () => {
		writeBaseline(REL, { max_lines: 800, files: {} });
		expect(checkCommitBaselineGate(commitEvent("git commit -m raise -- ."))?.reason).toContain("max_lines");
	});

	it("does not attribute a removal in a different repository to this commit", () => {
		const other = join(root, "other");
		mkdirSync(other);
		execFileSync("git", ["-C", other, "init", "-q"]);
		expect(checkCommitBaselineGate(commitEvent("git -C other rm -r -- .interlinked && git commit -m unchanged"))).toBeNull();
	});

	it("does not invent a repository for a commit whose selected directory is absent", () => {
		expect(checkCommitBaselineGate(commitEvent("git -C absent commit -m unavailable"))).toBeNull();
	});
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
	it("preserves an allowed pipeline result when the committed baselines are unchanged", () => {
		expect(runCommitBaselineGate(commitEvent("git commit -m unrelated"), allow())).toBeNull();
	});
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
