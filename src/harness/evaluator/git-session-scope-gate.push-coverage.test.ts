import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { makeSession } from "../__tests__/fixtures/evaluator.js";
import { evaluateGitScopeGate, parseGitVerb } from "./git-session-scope-gate.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("anchors explicit commit paths to cwd when repository discovery has no root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-scope-no-root-"));
    try {
        const session = makeSession();
        session.files_written.add(join(dir, "owned.ts"));
        expect(await evaluateGitScopeGate("git commit -- owned.ts", session, dir)).toEqual({
            decision: "allow", resolved_files: ["owned.ts"], unauthorized_files: [], baseline_files: [],
        });
        const unknown = await evaluateGitScopeGate("git commit -- other.ts", session, dir);
        expect(unknown).toMatchObject({ decision: "ask", resolved_files: ["other.ts"], unauthorized_files: ["other.ts"] });
        expect(unknown?.reason).toBe("This git commit would include 1 file(s) this session hasn't written (other.ts). Confirm intent.");
        session.git_session_baseline = {
            head_sha: "before-session", modified: new Set(), staged: new Set(["other.ts"]), untracked: new Set(),
        };
        const preexisting = await evaluateGitScopeGate("git commit -- other.ts", session, dir);
        expect(preexisting).toMatchObject({ decision: "ask", baseline_files: ["other.ts"] });
        expect(preexisting?.reason).toContain("existed in the working tree before this session started (other.ts)");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

it("keeps the no-upstream explanation when git throws a non-Error value", async () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => { throw "no upstream configured"; });
    expect(await evaluateGitScopeGate("git push", makeSession(), "/unused")).toEqual({
        decision: "allow", reason: "no upstream — push will set it; gate skipped.",
        resolved_files: [], unauthorized_files: [], baseline_files: [],
    });
});

it("preserves double-quoted filenames and defers force-push checks", async () => {
    expect(parseGitVerb('git commit -- "file with spaces.ts"')).toMatchObject({ verb: "commit", args: ["--", "file with spaces.ts"] });
    expect(parseGitVerb("   ")).toBeNull();
    expect(await evaluateGitScopeGate("git push --force", makeSession(), "/unused")).toBeNull();
});
