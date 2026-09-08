// ===========================================
// clone-repo unit tests
// ===========================================
//
// The two OS boundaries clone-repo touches — `execFileSync` (node:child_process,
// the actual `git clone`) and `rmSync` (node:fs, failure cleanup) — are mocked
// so nothing is ever spawned and no real network/git is involved. `randomUUID`,
// `tmpdir`, and `join` are left real so the returned temp-dir path is genuine and
// assertable. The mocks are reset per-test; assertions pin the exact git argv,
// the spawn options, the returned shape, and that cleanup runs on failure.

import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../../lib/non-null.js";

const execFileSyncMock = vi.fn<typeof import("node:child_process").execFileSync>();
const rmSyncMock = vi.fn<typeof import("node:fs").rmSync>();

vi.mock("node:child_process", () => ({
	execFileSync: (...args: Parameters<typeof execFileSyncMock>) => execFileSyncMock(...args),
}));

vi.mock("node:fs", () => ({
	rmSync: (...args: Parameters<typeof rmSyncMock>) => rmSyncMock(...args),
}));

// Imported after the mocks are registered so clone-repo binds the mocked fns.
const { CLONE_TIMEOUT_MS, cloneRepo, isGitUrl, normalizeGitUrl, repoDisplayName, SHELL_META } =
	await import("./clone-repo.js");

beforeEach(() => {
	execFileSyncMock.mockReset();
	rmSyncMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isGitUrl", () => {
	it("recognizes https URLs", () => {
		expect(isGitUrl("https://github.com/owner/repo")).toBe(true);
		expect(isGitUrl("http://example.com/owner/repo")).toBe(true);
	});

	it("recognizes ssh/git@ URLs", () => {
		expect(isGitUrl("git@github.com:owner/repo.git")).toBe(true);
		expect(isGitUrl("ssh://git@example.com/owner/repo")).toBe(true);
	});

	it("recognizes bare owner/repo host patterns", () => {
		expect(isGitUrl("github.com/owner/repo")).toBe(true);
	});

	it("recognizes .git suffix", () => {
		expect(isGitUrl("example.com/owner/repo.git")).toBe(true);
	});

	it("recognizes a bare .git suffix that matches no earlier rule", () => {
		// No scheme, no git@/ssh, and no host/owner/repo path structure, so this
		// reaches the final `.endsWith('.git')` check specifically (line 21).
		expect(isGitUrl("myrepo.git")).toBe(true);
		expect(isGitUrl("some.deep/path/thing.git")).toBe(true);
	});

	it("rejects plain filesystem paths", () => {
		expect(isGitUrl("/tmp/foo")).toBe(false);
		expect(isGitUrl("./local")).toBe(false);
	});
});

describe("normalizeGitUrl", () => {
	it("adds https:// when missing for bare host patterns", () => {
		expect(normalizeGitUrl("github.com/owner/repo")).toBe("https://github.com/owner/repo");
	});

	it("preserves URLs that already have a scheme", () => {
		expect(normalizeGitUrl("https://github.com/owner/repo")).toBe(
			"https://github.com/owner/repo",
		);
		expect(normalizeGitUrl("git@github.com:owner/repo")).toBe("git@github.com:owner/repo");
	});
});

describe("repoDisplayName", () => {
	it("extracts owner/repo from ssh URL", () => {
		expect(repoDisplayName("git@github.com:owner/repo.git")).toBe("owner/repo");
	});

	it("extracts owner/repo from https URL", () => {
		expect(repoDisplayName("https://github.com/owner/repo")).toBe("owner/repo");
		expect(repoDisplayName("https://github.com/owner/repo.git")).toBe("owner/repo");
	});

	it("falls back to the URL when no match", () => {
		expect(repoDisplayName("something-weird")).toBe("something-weird");
	});
});

describe("cloneRepo", () => {
	it("rejects URLs with shell metacharacters", () => {
		expect(() => cloneRepo("https://evil.com;rm -rf /", {})).toThrow(/shell metacharacters/);
	});

	it("rejects branches with shell metacharacters", () => {
		expect(() =>
			cloneRepo("https://github.com/owner/repo", { branch: "main$(whoami)" }),
		).toThrow(/shell metacharacters/);
	});

	it("rejects before ever invoking git when the URL is dangerous", () => {
		expect(() => cloneRepo("https://evil.com;rm -rf /", {})).toThrow(/shell metacharacters/);
		expect(execFileSyncMock).not.toHaveBeenCalled();
		expect(rmSyncMock).not.toHaveBeenCalled();
	});

	it("success (no branch): shallow-clones into a unique temp dir and returns its path + elapsed", () => {
		execFileSyncMock.mockReturnValue(Buffer.from("")); // git exits 0
		const result = cloneRepo("https://github.com/owner/repo", {});

		expect(result.dir.startsWith(tmpdir())).toBe(true);
		expect(result.dir).toMatch(/interlinked-verify-[0-9a-f]{8}$/);
		expect(typeof result.elapsed_ms).toBe("number");
		expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);

		expect(execFileSyncMock).toHaveBeenCalledOnce();
		const [bin, argv, rawOptions] = nonNull(execFileSyncMock.mock.calls[0]);
		const options = nonNull(rawOptions);
		expect(bin).toBe("git");
		// No --branch when none is requested.
		expect(argv).toEqual(["clone", "--depth", "1", "https://github.com/owner/repo", result.dir]);
		expect(options.timeout).toBe(CLONE_TIMEOUT_MS);
		expect(nonNull(options.env).GIT_TERMINAL_PROMPT).toBe("0");
		expect(options.stdio).toEqual(["pipe", "pipe", "inherit"]);

		// Success path must never attempt cleanup.
		expect(rmSyncMock).not.toHaveBeenCalled();
	});

	it("success (with clean branch): threads --branch <name> into the git argv", () => {
		execFileSyncMock.mockReturnValue(Buffer.from(""));
		const result = cloneRepo("https://github.com/owner/repo", { branch: "release-2.0" });

		const argv = nonNull(execFileSyncMock.mock.calls[0])[1];
		expect(argv).toEqual([
			"clone",
			"--depth",
			"1",
			"--branch",
			"release-2.0",
			"https://github.com/owner/repo",
			result.dir,
		]);
		expect(rmSyncMock).not.toHaveBeenCalled();
	});

	it("failure: cleans up the temp dir and rethrows a wrapped Error message", () => {
		execFileSyncMock.mockImplementation(() => {
			throw new Error("fatal: repository not found");
		});

		expect(() => cloneRepo("https://github.com/owner/missing", {})).toThrow(
			/Clone failed: fatal: repository not found/,
		);

		// Cleanup is attempted on the same temp dir, recursive + force.
		expect(rmSyncMock).toHaveBeenCalledOnce();
		const [dir, rmOpts] = nonNull(rmSyncMock.mock.calls[0]);
		expect(dir).toMatch(/interlinked-verify-[0-9a-f]{8}$/);
		expect(rmOpts).toEqual({ recursive: true, force: true });
	});

	it("failure with a non-Error throw: stringifies it via String(err)", () => {
		execFileSyncMock.mockImplementation(() => {
			// git layer throwing a non-Error value exercises the `instanceof Error` false arm.
			throw "boom-string";
		});

		expect(() => cloneRepo("https://github.com/owner/repo", {})).toThrow(/Clone failed: boom-string/);
		expect(rmSyncMock).toHaveBeenCalledOnce();
	});

	it("failure where cleanup itself throws: still surfaces the clone error, not the rmSync error", () => {
		execFileSyncMock.mockImplementation(() => {
			throw new Error("clone exploded");
		});
		rmSyncMock.mockImplementation(() => {
			throw new Error("EBUSY: cannot remove");
		});

		// The best-effort cleanup swallow means the original clone error wins.
		expect(() => cloneRepo("https://github.com/owner/repo", {})).toThrow(
			/Clone failed: clone exploded/,
		);
		expect(() => cloneRepo("https://github.com/owner/repo", {})).not.toThrow(/EBUSY/);
	});
});

describe("SHELL_META and CLONE_TIMEOUT_MS", () => {
	it("flags semicolons and backticks", () => {
		expect(SHELL_META.test("foo;bar")).toBe(true);
		expect(SHELL_META.test("foo`bar`")).toBe(true);
	});

	it("defines a positive timeout", () => {
		expect(CLONE_TIMEOUT_MS).toBeGreaterThan(0);
	});
});
