import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { gitShell } from "../git-shell.js";

const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
	vi.restoreAllMocks();
	mockExecSync.mockImplementation(() => "");
});

describe("gitShell", () => {
	it("prefixes the argument string with `git ` and runs it through the shell", () => {
		mockExecSync.mockReturnValue("abc123\n");
		expect(gitShell("rev-parse HEAD", "/repo")).toBe("abc123");
		expect(mockExecSync).toHaveBeenCalledWith("git rev-parse HEAD", {
			cwd: "/repo",
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["pipe", "pipe", "pipe"],
		});
	});

	it("trims trailing whitespace from stdout", () => {
		mockExecSync.mockReturnValue("  main \n\n");
		expect(gitShell("branch --show-current", "/repo")).toBe("main");
	});

	it("returns an empty string when the command produces no output", () => {
		mockExecSync.mockReturnValue("");
		expect(gitShell("status --porcelain", "/repo")).toBe("");
	});

	it("passes shell metacharacters through unescaped so pipes work", () => {
		mockExecSync.mockReturnValue("12\n");
		expect(gitShell('diff --no-index /dev/null "a b.txt" -- | wc -l', "/repo")).toBe("12");
		expect(mockExecSync).toHaveBeenCalledWith(
			'git diff --no-index /dev/null "a b.txt" -- | wc -l',
			expect.objectContaining({ cwd: "/repo" }),
		);
	});

	it("propagates the error thrown on a non-zero exit", () => {
		const failure = new Error("fatal: not a git repository");
		mockExecSync.mockImplementation(() => {
			throw failure;
		});
		expect(() => gitShell("rev-parse --git-dir", "/tmp")).toThrow(failure);
	});
});
