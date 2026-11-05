import { expect, it } from "vitest";
import { dcgCheckGitDestruction } from "./destructive-command-guard-git.js";

// test-contract: bug — `git stash clear` deletes every stash at once, so the cold guard must block it exactly like `git stash drop`
it("blocks git stash clear", () => {
	expect(dcgCheckGitDestruction("git stash clear")).toEqual({
		decision: "block",
		reason: "BLOCKED: git stash drop/clear permanently removes stashed work.",
	});
});

// test-contract: boundary — listing stashes destroys nothing and stays allowed
it("allows git stash list", () => {
	expect(dcgCheckGitDestruction("git stash list")).toBeNull();
});
