import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeSession } from "./__tests__/fixtures/evaluator.js";
import { buildAgentSafetyChecks } from "./check-registry/index.js";
import { recordUnavailableCheck } from "./check-unavailable.js";
import { buildPatternRescanWarnings, rescanSessionFiles } from "./stop-rescan.js";

vi.mock("./check-registry/index.js", () => ({ buildAgentSafetyChecks: vi.fn() }));
vi.mock("./check-unavailable.js", () => ({ recordUnavailableCheck: vi.fn() }));
let cwd: string;
beforeEach(() => {
    vi.clearAllMocks();
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "stop-rescan-unavailable-")));
    vi.mocked(buildAgentSafetyChecks).mockReturnValue([]);
});
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

it("records a vanished file as unavailable through the default reporter", () => {
    const session = { ...makeSession(), files_written: new Set(["gone.ts"]) };
    expect(rescanSessionFiles(session, cwd)).toEqual([]);
    expect(recordUnavailableCheck).toHaveBeenCalledWith(expect.objectContaining({ cwd, check: "stop-rescan:read",
        event: expect.objectContaining({ session_id: session.session_id, dry_run: false, tool_input: { file_path: join(cwd, "gone.ts") } }),
    }));
    expect(buildPatternRescanWarnings(session, cwd)).toEqual([
        `[interlinked:checks-deferred] NOT CHECKED: stop-rescan:read for ${join(cwd, "gone.ts")} (Stop rescan unavailable)`,
    ]);
});

it("does not suppress a current finding when any baseline detector failed", () => {
    writeFileSync(join(cwd, "a.ts"), "current");
    const match = { line: 1, text: "value === NaN" };
    vi.mocked(buildAgentSafetyChecks).mockImplementation(content => [
        { name: "nan_comparison", severity: "warning", fn: () => [match] },
        { name: "async_promise_executor", severity: "warning", fn: () => {
            if (content === "baseline") throw new Error("baseline detector unavailable");
            return [];
        } },
    ]);
    const session = { ...makeSession(), files_written: new Set(["a.ts"]), git_session_baseline: {
        head_sha: "before", modified: new Set<string>(), staged: new Set<string>(), untracked: new Set<string>(),
    } };
    const warnings = buildPatternRescanWarnings(session, cwd, { gitShow: () => "baseline" });
    expect(warnings.join("\n")).toContain("nan_comparison:1");
    expect(warnings.join("\n")).toContain("NOT CHECKED: async_promise_executor");
    expect(recordUnavailableCheck).toHaveBeenCalledWith(expect.objectContaining({ check: "async_promise_executor" }));
});
