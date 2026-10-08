import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGitChangedFiles, defaultResolveRepoRoot, selectChangedSources } from "./commit-gate-changes.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("git changed-file query boundaries", () => {
    it("preserves whitespace and Unicode in NUL-delimited paths and deduplicates the union", () => {
        vi.mocked(execFileSync).mockReturnValueOnce("src/café.ts\0src/ space .ts\0")
            .mockReturnValueOnce("src/café.ts\0src/tracked.ts\0")
            .mockReturnValueOnce("src/new\nfile.ts\0");
        expect(defaultGitChangedFiles("/repo", false, true)).toEqual([
            "src/café.ts", "src/tracked.ts", "src/ space .ts", "src/new\nfile.ts",
        ]);
        expect(execFileSync).toHaveBeenNthCalledWith(1, "git", ["diff", "--cached", "--name-only", "-z"], expect.objectContaining({ cwd: "/repo" }));
        expect(execFileSync).toHaveBeenNthCalledWith(3, "git", ["ls-files", "--others", "--exclude-standard", "-z"], expect.any(Object));
    });

    it("does not inspect the worktree for an index-only commit", () => {
        vi.mocked(execFileSync).mockReturnValue("src/staged.ts\0");
        expect(defaultGitChangedFiles("/repo", true)).toEqual(["src/staged.ts"]);
        expect(execFileSync).toHaveBeenCalledOnce();
    });

    it("retains staged paths when HEAD is unavailable in an unborn repository", () => {
        vi.mocked(execFileSync).mockReturnValueOnce("src/first.ts\0").mockImplementationOnce(() => { throw new Error("HEAD missing"); });
        expect(defaultGitChangedFiles("/repo")).toEqual(["src/first.ts"]);
    });

    it("retains successful worktree results if other queries fail", () => {
        vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error("index unavailable"); })
            .mockReturnValueOnce("src/worktree.ts\0")
            .mockImplementationOnce(() => { throw new Error("untracked unavailable"); });
        expect(defaultGitChangedFiles("/repo", false, true)).toEqual(["src/worktree.ts"]);
    });

    it("distinguishes unavailable queries from an empty changed set", () => {
        vi.mocked(execFileSync).mockImplementation(() => { throw new Error("git unavailable"); });
        expect(defaultGitChangedFiles("/repo", false, true)).toBeNull();
        expect(defaultGitChangedFiles("/repo", true)).toBeNull();
        expect(defaultResolveRepoRoot("/repo")).toBeNull();
        vi.mocked(execFileSync).mockReturnValue("");
        expect(defaultGitChangedFiles("/repo")).toEqual([]);
        expect(defaultResolveRepoRoot("/repo")).toBeNull();
    });

    it("normalizes the repository-root line response", () => {
        vi.mocked(execFileSync).mockReturnValue("  /repo  \n\n");
        expect(defaultResolveRepoRoot("/repo/src")).toBe("/repo");
    });

    it("runs suites for test and generated changes but skips declaration-only changes", () => {
        const readFile = vi.fn((path: string) => path.endsWith("generated.ts") ? "// @generated\nexport const x = 1;" : "export const value = 1;");
        expect(selectChangedSources(["/repo/src/value.test.ts", "src/generated.ts", "src/types.d.ts"], "/repo", ["ts"], readFile))
            .toEqual({ sources: [], deletedPaths: [], suiteLanguages: ["ts"] });
        expect(readFile).toHaveBeenCalledWith("/repo/src/value.test.ts");
        expect(selectChangedSources(["src/types.d.ts"], "/repo", ["ts"], readFile)).toEqual({ sources: [], deletedPaths: [], suiteLanguages: [] });
    });
});
