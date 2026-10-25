import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../types.js";
import { checkCommitBaselineGate } from "./commit-baseline-gate.js";
import { gitShow, resolveRepoRoot } from "./commit-git-io.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("./commit-git-io.js", () => ({ gitShow: vi.fn(), resolveRepoRoot: vi.fn() }));

const REL = ".interlinked/large-files-baseline.json";
const event: HarnessEvent = {
	hook_event: "PreToolUse", session_id: "history-io", agent_source: "claude",
	timestamp: "2026-10-25T00:00:00Z", cwd: "/fixture/repo", tool_name: "Bash",
	tool_input: { command: "git commit -m restore" },
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(resolveRepoRoot).mockReturnValue("/fixture/repo");
	vi.mocked(gitShow).mockImplementation((_root, ref) =>
		ref === `:${REL}` ? '{"max_lines":800,"files":{}}' : null);
});

describe("commit baseline historical comparison I/O failures", () => {
	it("uses the process directory when the event supplies no cwd", () => {
		vi.mocked(gitShow).mockReturnValue(null);
		const { cwd: _cwd, ...withoutCwd } = event;
		expect(checkCommitBaselineGate(withoutCwd)).toBeNull();
		expect(resolveRepoRoot).toHaveBeenCalledWith(process.cwd());
	});
	it("does not invent a previous water-line when the history query fails", () => {
		vi.mocked(execFileSync).mockImplementation(() => { throw new Error("history unavailable"); });
		expect(checkCommitBaselineGate(event)).toBeNull();
		expect(execFileSync).toHaveBeenCalledWith("git", ["-C", "/fixture/repo", "rev-list", "-1", "HEAD", "--", REL], expect.any(Object));
		expect(gitShow).not.toHaveBeenCalledWith("/fixture/repo", expect.stringContaining("^:"));
	});

	it("does not compare against fabricated bytes when the historical parent blob is unavailable", () => {
		vi.mocked(execFileSync).mockReturnValue("123456789abcdef\n");
		expect(checkCommitBaselineGate(event)).toBeNull();
		expect(gitShow).toHaveBeenCalledWith("/fixture/repo", `123456789abcdef^:${REL}`);
	});
});
