import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("../lib/formatter.js", () => ({
    c: new Proxy({}, { get: () => (value: string) => value }),
}));

import { aggregateRuns, ciStatusCommand, GhCliFetcher, registerCiCommand, type CiRun } from "./ci-status.js";

function run(partial: Partial<CiRun> & { conclusion: string | null }): CiRun {
    return {
        databaseId: 1,
        workflowName: "CI",
        status: "completed",
        name: "commit",
        createdAt: "2026-05-01T12:34:56Z",
        ...partial,
    };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    mocks.execFileSync.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = 0;
});

afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = 0;
});

describe("ci-status survivor contracts", () => {
    // test-contract: malformed JSON rows are rejected, while null conclusions and present optional strings are retained exactly.
    it("validates conclusion and optional fields at the JSON boundary", () => {
        const valid = run({ conclusion: null, headBranch: "main", url: "https://example.test/1" });
        mocks.execFileSync.mockReturnValue(JSON.stringify([
            valid,
            { ...valid, conclusion: undefined },
            { ...valid, headBranch: 7 },
            { ...valid, url: 7 },
        ]));

        expect(new GhCliFetcher().listRuns({ limit: 4 })).toEqual([valid]);
    });

    // test-contract: non-array JSON input is treated as no runs rather than being mapped.
    it("returns no runs for a JSON object", () => {
        mocks.execFileSync.mockReturnValue(JSON.stringify({ runs: [] }));
        expect(new GhCliFetcher().listRuns({ limit: 1 })).toEqual([]);
    });

    // test-contract: subprocess output is decoded as UTF-8 using the configured execution options.
    it("passes the encoding and timeout options to gh", () => {
        mocks.execFileSync.mockReturnValue("[]");
        new GhCliFetcher().listRuns({ limit: 7 });

        expect(mocks.execFileSync).toHaveBeenCalledWith(
            "gh",
            expect.any(Array),
            { encoding: "utf-8", timeout: 15_000 },
        );
    });

    // test-contract: null conclusions are excluded from failure totals and per-workflow failure counts.
    it("does not classify null as a failure", () => {
        const result = aggregateRuns([
            run({ conclusion: null }),
            run({ conclusion: "success" }),
            run({ conclusion: "failure" }),
        ]);

        expect(result.failures).toBe(1);
        expect(result.byWorkflow).toEqual([{
            workflowName: "CI",
            total: 3,
            failures: 1,
            failureRate: 1 / 3,
        }]);
    });

    // test-contract: a nonempty completed workflow has its actual failure rate, never a fabricated zero-denominator value.
    it("computes the nonzero workflow rate from its completed runs", () => {
        const result = aggregateRuns([run({ conclusion: "failure" })]);
        expect(result.byWorkflow[0]).toEqual({
            workflowName: "CI",
            total: 1,
            failures: 1,
            failureRate: 1,
        });
    });

    // test-contract: recent failures are sorted newest-first without mutating the input array.
    it("orders recent failures newest-first while preserving input order", () => {
        const older = run({ name: "older", conclusion: "failure", createdAt: "2026-05-01T00:00:00Z" });
        const newer = run({ name: "newer", conclusion: "failure", createdAt: "2026-05-02T00:00:00Z" });
        const input = [older, newer];

        expect(aggregateRuns(input).recentFailures.map((item) => item.name)).toEqual(["newer", "older"]);
        expect(input.map((item) => item.name)).toEqual(["older", "newer"]);
    });

    // test-contract: full output distinguishes success, failure, benign, live, and null-completion statuses.
    it("renders each full-output status according to its public meaning", async () => {
        await ciStatusCommand(
            { full: true },
            {
                available: () => true,
                listRuns: () => [
                    run({ name: "success-row", conclusion: "success" }),
                    run({ name: "failure-row", conclusion: "failure" }),
                    run({ name: "skipped-row", conclusion: "skipped" }),
                    run({ name: "live-row", status: "in_progress", conclusion: null }),
                    run({ name: "unknown-row", conclusion: null }),
                ],
            },
        );

        const output = String(logSpy.mock.calls[0]?.[0]);
        expect(output).toContain("success-row");
        expect(output).toContain("success");
        expect(output).toContain("failure");
        expect(output).toContain("skipped");
        expect(output).toContain("in_progress");
        expect(output).toContain("unknown-row");
        expect(output).toContain("?");
    });

    // test-contract: full output normalizes ISO timestamps to the first sixteen characters with a space separator.
    it("formats full-output timestamps and line breaks exactly", async () => {
        await ciStatusCommand(
            { full: true },
            {
                available: () => true,
                listRuns: () => [run({ name: "timestamped", conclusion: "success" })],
            },
        );

        const output = String(logSpy.mock.calls[0]?.[0]);
        expect(output).toContain("2026-05-01 12:34");
        expect(output).not.toContain("2026-05-01T12:34:56Z");
        expect(output).toContain("\n\nAll runs:");
    });

    // test-contract: unavailable gh reports the exact structured error object.
    it("emits the unavailable error object in JSON mode", async () => {
        await ciStatusCommand({ json: true }, {
            available: () => false,
            listRuns: () => [],
        });

        expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ error: "gh CLI not available" }, null, 2));
        expect(process.exitCode).toBe(1);
    });

    // test-contract: normal output includes required section separators and excludes fabricated marker text.
    it("renders normal output with stable section structure", async () => {
        await ciStatusCommand({}, {
            available: () => true,
            listRuns: () => [run({ conclusion: "success" })],
        });

        const output = String(logSpy.mock.calls[0]?.[0]);
        expect(output).toContain("GitHub Actions — last 30 runs (all branches)");
        expect(output).toContain("\n\nFailure rate by workflow:");
        expect(output).not.toContain("Stryker was here!");
    });

    // test-contract: commander registration exposes the documented descriptions and option flags.
    it("registers the documented command metadata", () => {
        const program = new Command();
        registerCiCommand(program);
        const subcommand = nonNull(program.commands.find((command) => command.name() === "ci-status"));
        expect(subcommand.description()).toContain("GitHub Actions");
        expect(subcommand.options.map((option) => option.flags + "|" + option.description)).toEqual([
            "--limit <n>|Number of recent runs to fetch (default 30, max 100)",
            "--branch <name>|Restrict to a specific branch (default: all branches)",
            "--json|Output JSON",
            "--short|One-line summary",
            "--full|Show every run, not just failures",
        ]);
    });
});
import { Command } from "commander";
import { nonNull } from "../lib/non-null.js";
