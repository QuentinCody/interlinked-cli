import { describe, expect, it } from "vitest";
import type { SessionCallCoverage } from "../harness/call-coverage.js";
import { callCoverageExitCode, renderCallCoverage } from "./harness-calls.js";

const full: SessionCallCoverage = { session: "bbbbbbbb-2222", provider: "codex", calls: 40, judged: 40, byTool: {}, byFolder: {}, firstUnjudged: null, lastUnjudged: null };
const holed: SessionCallCoverage = {
    session: "aaaaaaaa-1111", provider: "claude-code", calls: 734, judged: 599,
    byTool: { Edit: 31, Bash: 81, Write: 16, Agent: 6, Read: 1 },
    byFolder: { "scratch/e66": 44, "scratch/e64": 25, ".interlinked/archive": 22, "scratch/e47a": 19 },
    firstUnjudged: "2026-10-22T01:05:00.000Z", lastUnjudged: "2026-10-22T04:57:10.232Z",
};

describe("renderCallCoverage — positive", () => {
    it("P1: totals, then each session with unjudged calls (most first): tools, the folders they ran from, and the time span", () => {
        expect(renderCallCoverage([full, holed], "2026-10-15T00:00:00.000Z")).toBe([
            "tool calls the daemon judged since 2026-10-15T00:00:00.000Z: 639 of 774 (82.6%) in 2 session(s); 1 session(s) fully judged",
            "  aaaaaaaa claude-code: 599 of 734 judged, 135 not — Bash 81, Edit 31, Write 16, +2 more tool(s)",
            "    ran from: scratch/e66 44, scratch/e64 25, .interlinked/archive 22, +1 more folder(s)",
            "    between 2026-10-22T01:05:00.000Z and 2026-10-22T04:57:10.232Z",
        ].join("\n"));
    });

    it("P2: exit 0 reports; with --strict, exit 1 when any call went unjudged", () => {
        expect(callCoverageExitCode([full, holed], false)).toBe(0);
        expect(callCoverageExitCode([full, holed], true)).toBe(1);
        expect(callCoverageExitCode([full], true)).toBe(0);
    });
});

describe("renderCallCoverage — negative", () => {
    it("N1: no calls in the window is no evidence (exit 2), never a clean bill", () => {
        expect(renderCallCoverage([], "2026-10-15T00:00:00.000Z")).toBe("tool calls the daemon judged since 2026-10-15T00:00:00.000Z: no tool calls in the timeline for this window (no evidence)");
        expect(callCoverageExitCode([], false)).toBe(2);
    });
});
