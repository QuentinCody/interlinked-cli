// Commit-time function-token backstop. Most cases below stub every field of
// `CommitFunctionTokenDeps` (see `deps()`) so no real git process ever runs.
// Two exceptions use REAL filesystem fixtures instead of mocks: the
// `DEFAULT_DEPS.readFile` cases exercise the real exists/read/EISDIR branches
// against a temp dir (mkdtempSync), and `runCommitFunctionTokenGate` is
// exercised through its own injectable `deps` parameter (added for testing —
// its default still preserves the module's real DEFAULT_DEPS behavior).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeTypeScriptFunctionTokens } from "../function-tokens/typescript.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import {
    checkCommitFunctionTokenGate,
    DEFAULT_DEPS,
    runCommitFunctionTokenGate,
} from "./commit-function-token-gate.js";

function functionWithTokens(count: number): string {
    const shell = "function target(){}";
    const base = computeTypeScriptFunctionTokens(shell, "src/example.ts")?.[0]?.canonicalTokens;
    if (base === undefined || base > count) throw new Error("invalid fixture token target");
    return `function target(){${";".repeat(count - base)}}`;
}

function event(command = "git commit -m test"): HarnessEvent {
    return {
        hook_event: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: "/repo",
        session_id: "session",
        agent_source: "codex",
        timestamp: "2026-08-30T00:00:00.000Z",
    };
}

function deps(before: string, after: string) {
    return {
        resolveRepoRoot: vi.fn(() => "/repo"),
        changedFiles: vi.fn(() => ["src/example.ts"]),
        gitShow: vi.fn((_root: string, ref: string) => {
            if (ref.startsWith("HEAD:")) return before;
            if (ref.startsWith(":")) return after;
            return null;
        }),
        readFile: vi.fn(() => after),
    };
}

describe("commit function-token backstop", () => {
    it("blocks a staged function that crosses from 500 to 501", () => {
        const result = checkCommitFunctionTokenGate(
            event(),
            deps(functionWithTokens(500), functionWithTokens(501)),
        );
        expect(result?.rule_id).toBe("commit-function-tokens-cap");
        expect(result?.reason).toContain("src/example.ts");
        expect(result?.reason).toContain("501");
    });

    it("allows existing over-cap debt to hold or shrink", () => {
        expect(
            checkCommitFunctionTokenGate(
                event(),
                deps(functionWithTokens(700), functionWithTokens(700)),
            ),
        ).toBeNull();
        expect(
            checkCommitFunctionTokenGate(
                event(),
                deps(functionWithTokens(700), functionWithTokens(501)),
            ),
        ).toBeNull();
    });

    it("blocks existing over-cap debt growing by one token", () => {
        const result = checkCommitFunctionTokenGate(
            event(),
            deps(functionWithTokens(700), functionWithTokens(701)),
        );
        expect(result?.reason).toContain("raised from 700");
    });

    it("reads worktree content for git commit -a", () => {
        const d = deps(functionWithTokens(500), functionWithTokens(501));
        const result = checkCommitFunctionTokenGate(event("git commit -am test"), d);
        expect(result?.decision).toBe("block");
        expect(d.readFile).toHaveBeenCalledWith("/repo/src/example.ts");
        expect(d.gitShow).not.toHaveBeenCalledWith("/repo", ":src/example.ts");
    });

    it("does no git work for a non-commit command", () => {
        const d = deps("", "");
        expect(checkCommitFunctionTokenGate(event("git status"), d)).toBeNull();
        expect(d.resolveRepoRoot).not.toHaveBeenCalled();
    });

    it("unions the staged set for a constructed commit that also includes the index", () => {
        // "git add p && git commit" (no pathspec on the commit itself) sets
        // constructsContent (worktree mode) AND includesIndex, so the gate
        // must call the stagedSet() fallback closure and union its result
        // into the evaluated paths (line 62's callback).
        const changedFiles = vi.fn((_root: string, stagedOnly?: boolean) =>
            stagedOnly ? ["src/staged-only.ts"] : ["src/example.ts"],
        );
        const d = {
            resolveRepoRoot: vi.fn(() => "/repo"),
            changedFiles,
            gitShow: vi.fn((_root: string, ref: string) =>
                ref.startsWith("HEAD:") ? functionWithTokens(500) : null,
            ),
            readFile: vi.fn(() => functionWithTokens(501)),
        };
        const result = checkCommitFunctionTokenGate(
            event("git add src/example.ts && git commit -m test"),
            d,
        );
        expect(changedFiles).toHaveBeenCalledWith("/repo", true);
        expect(result?.reason).toContain("src/example.ts");
        expect(result?.reason).toContain("src/staged-only.ts");
    });

    it("skips a path whose file is not cappable (a test source file)", () => {
        // isCappableFile() excludes *.test.ts, so even though `after` here
        // would otherwise read as a huge token-count violation, collectViolations
        // must `continue` past it (line 88) and report no block at all.
        const d = deps(functionWithTokens(500), functionWithTokens(900));
        d.changedFiles = vi.fn(() => ["src/example.test.ts"]);
        expect(checkCommitFunctionTokenGate(event(), d)).toBeNull();
    });

    it("skips a path whose staged content cannot be read (deleted from the index)", () => {
        // gitShow(":path") returning null means the file is absent from the
        // evaluation tree -> afterContent returns null -> continue (line 88).
        const d = {
            resolveRepoRoot: vi.fn(() => "/repo"),
            changedFiles: vi.fn(() => ["src/deleted.ts"]),
            gitShow: vi.fn((_root: string, ref: string) =>
                ref.startsWith("HEAD:") ? functionWithTokens(500) : null,
            ),
            readFile: vi.fn(() => null),
        };
        expect(checkCommitFunctionTokenGate(event(), d)).toBeNull();
    });

    describe("DEFAULT_DEPS.readFile", () => {
        let dir: string;

        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), "token-gate-readfile-"));
        });

        afterEach(() => {
            rmSync(dir, { recursive: true, force: true });
        });

        it("returns the file's content when the worktree path exists", () => {
            const filePath = join(dir, "example.ts");
            writeFileSync(filePath, "function target(){}");
            expect(DEFAULT_DEPS.readFile(filePath)).toBe("function target(){}");
        });

        it("returns null when the worktree path does not exist", () => {
            expect(DEFAULT_DEPS.readFile(join(dir, "missing.ts"))).toBeNull();
        });

        it("returns null when reading throws (path is a directory, EISDIR)", () => {
            // existsSync(dir) is true for a directory, but
            // readFileSync(dir, "utf8") throws — exercises the catch block.
            expect(DEFAULT_DEPS.readFile(dir)).toBeNull();
        });
    });

    describe("runCommitFunctionTokenGate", () => {
        it("merges preDecision warnings onto the function-token block and returns it", () => {
            const d = deps(functionWithTokens(500), functionWithTokens(501));
            const preDecision: HarnessDecision = {
                decision: "allow",
                warnings: ["pre-existing warning"],
            };
            const result = runCommitFunctionTokenGate(event(), preDecision, d);
            expect(result?.decision).toBe("block");
            expect(result?.warnings).toEqual(["pre-existing warning"]);
        });
    });
});
