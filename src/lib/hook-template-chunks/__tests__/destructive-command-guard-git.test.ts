// Companion test for dcgCheckGitDestruction, extracted from
// destructive-command-guard.ts during the line-cap split. Covers each git
// history-rewriting/data-loss rule the function guards, plus the interactive
// rebase/add carve-outs called out in the source comments.

import { describe, expect, it } from "vitest";
import { dcgCheckGitDestruction } from "../destructive-command-guard-git.js";

describe("dcgCheckGitDestruction — positive (must fire)", () => {
	it("P1: blocks git push --force", () => {
		expect(dcgCheckGitDestruction("git push --force origin main")?.reason).toContain(
			"git push --force",
		);
	});

	it("P2: blocks git push -f", () => {
		expect(dcgCheckGitDestruction("git push -f origin main")?.reason).toContain(
			"git push --force",
		);
	});

	it("P3: blocks git reset --hard", () => {
		expect(dcgCheckGitDestruction("git reset --hard HEAD~1")?.reason).toContain(
			"git reset --hard",
		);
	});

	it("P4: blocks git clean -f", () => {
		expect(dcgCheckGitDestruction("git clean -fd")?.reason).toContain("git clean -f");
	});

	it("P5: blocks git checkout -- .", () => {
		expect(dcgCheckGitDestruction("git checkout -- .")?.reason).toContain("git checkout");
	});

	it("P6: blocks git restore --worktree", () => {
		expect(dcgCheckGitDestruction("git restore --worktree src/foo.ts")?.reason).toContain(
			"git restore --worktree",
		);
	});

	it("P7: blocks git branch -D", () => {
		expect(dcgCheckGitDestruction("git branch -D feature")?.reason).toContain("git branch -D");
	});

	it("P8: blocks git stash drop", () => {
		expect(dcgCheckGitDestruction("git stash drop")?.reason).toContain("git stash");
	});

	it("P9: blocks git restore .", () => {
		expect(dcgCheckGitDestruction("git restore .")?.reason).toContain("git restore .");
	});

	it("P10: blocks git filter-branch", () => {
		expect(dcgCheckGitDestruction("git filter-branch --tree-filter x HEAD")?.reason).toContain(
			"filter-branch",
		);
	});

	it("P11: blocks git rebase -i", () => {
		expect(dcgCheckGitDestruction("git rebase -i HEAD~3")?.reason).toContain("git rebase -i");
	});

	it("P12: blocks git rebase --interactive in any flag position", () => {
		expect(dcgCheckGitDestruction("git rebase main --interactive")?.reason).toContain(
			"git rebase -i",
		);
	});

	it("P13: blocks git add -p / --patch / -e", () => {
		expect(dcgCheckGitDestruction("git add -p")?.reason).toContain("git add -i");
		expect(dcgCheckGitDestruction("git add --patch")?.reason).toContain("git add -i");
		expect(dcgCheckGitDestruction("git add src/a.ts -e")?.reason).toContain("git add -i");
	});
});

describe("dcgCheckGitDestruction — negative (must not fire)", () => {
	it("N1: allows git push --force-with-lease", () => {
		expect(dcgCheckGitDestruction("git push --force-with-lease origin main")).toBeNull();
	});

	it("N2: allows git clean -n (dry-run)", () => {
		expect(dcgCheckGitDestruction("git clean -fd -n")).toBeNull();
	});

	it("N3: allows an ordinary git status/commit", () => {
		expect(dcgCheckGitDestruction("git status")).toBeNull();
		expect(dcgCheckGitDestruction('git commit -m "msg"')).toBeNull();
	});

	it("N4: does not false-block on 'mkdir -p' appearing after an unrelated git rebase", () => {
		expect(dcgCheckGitDestruction("git rebase main && mkdir -p out")).toBeNull();
	});
});
