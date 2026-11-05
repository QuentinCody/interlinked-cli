import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testsTraceCommand } from "./tests-trace.js";
import { OWNER_ENV, recordVerificationStage, STAGES_LEDGER_ENV, TRACE_ENV } from "../harness/verification-stages.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

function fixture(rows: Record<string, unknown>[]): string {
    const root = mkdtempSync(join(tmpdir(), "tests-trace-"));
    roots.push(root);
    mkdirSync(join(root, ".interlinked"));
    const ledger = join(root, ".interlinked", "verification-stages.jsonl");
    writeFileSync(ledger, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
    vi.stubEnv(STAGES_LEDGER_ENV, ledger);
    vi.stubEnv(TRACE_ENV, undefined);
    vi.stubEnv(OWNER_ENV, undefined);
    return root;
}

const base = { schema: "verification-stages.v1", stage: "push", identity: null, reused: false, platform: "x", node: "22", pid: 1, dry_run: false };

describe("tests trace — positive (must fire)", () => {
    // test-contract: invariant — fixtures own their telemetry; an enclosing protected push cannot redirect fixture reads or receive fixture writes.
    it("isolates fixture telemetry from an inherited protected push", () => {
        const parent = fixture([{ ...base, ts: "2026-11-06T00:00:00.000Z", check: "outer-push", status: "passed", trace: "parent-push-1" }]);
        const parentLedger = join(parent, ".interlinked", "verification-stages.jsonl"), before = readFileSync(parentLedger, "utf8");
        vi.stubEnv(STAGES_LEDGER_ENV, parentLedger);
        vi.stubEnv(TRACE_ENV, "parent-push-1");
        vi.stubEnv(OWNER_ENV, "git-hook");
        const root = fixture([{ ...base, ts: "2026-11-05T00:00:00.000Z", check: "fixture-push", status: "passed", trace: "fixture-push-1" }]);
        expect(recordVerificationStage(root, { stage: "cli", check: "fixture-test", status: "passed", identity: null, reused: false })).toBe(true);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        testsTraceCommand({ cwd: root, json: true });
        expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ trace: "fixture-push-1", rows: 1, scan: { recordsParsed: 2 } });
        expect(readFileSync(parentLedger, "utf8")).toBe(before);
        const rows = readFileSync(join(root, ".interlinked", "verification-stages.jsonl"), "utf8").trim().split("\n");
        expect(JSON.parse(rows[1]!)).toMatchObject({ check: "fixture-test", stage: "cli" });
        expect(JSON.parse(rows[1]!)).not.toHaveProperty("trace");
        expect(JSON.parse(rows[1]!)).not.toHaveProperty("owner");
        expect(process.exitCode).toBeUndefined();
    });

    // test-contract: public-api — with no --trace the newest push trace is explained; --json carries the summary
    it("P1: explains the newest push trace from the ledger", () => {
        const root = fixture([
            { ...base, ts: "2026-11-05T00:00:01.000Z", check: "pre-tool:managed-push", status: "fallback", owner: "daemon", trace: "aaaaaaaa-1", validate_ms: 30, exec_ms: 0, reuse_denied_reason: "handoff-fallback:stale-trust-map" },
            { ...base, ts: "2026-11-05T00:00:30.000Z", check: "pre-tool:project-typecheck", status: "passed", owner: "daemon", trace: "aaaaaaaa-1", wait_capacity_ms: 5, exec_ms: 20_000 },
            { ...base, ts: "2026-11-04T00:00:00.000Z", check: "vitest:full", status: "passed", owner: "git-hook", trace: "older-push", exec_ms: 1 },
        ]);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        testsTraceCommand({ cwd: root, json: true });
        const printed = JSON.parse(String(log.mock.calls[0]?.[0]));
        expect(printed).toMatchObject({ trace: "aaaaaaaa-1", rows: 2, fallback: { cause: "stale-trust-map" }, phases: { exec_ms: 20_000 } });
        expect(printed.scan).toMatchObject({ recordsParsed: 3 });
        expect(process.exitCode).toBeUndefined();
    });

    // test-contract: public-api — --trace selects one request; the human rendering names the fallback cause
    it("P2: explains the requested trace in prose", () => {
        const root = fixture([
            { ...base, ts: "2026-11-05T00:00:01.000Z", check: "pre-tool:managed-push", status: "fallback", owner: "daemon", trace: "bbbbbbbb-2", reuse_denied_reason: "handoff-fallback:environment-override" },
            { ...base, ts: "2026-11-05T00:00:02.000Z", check: "npm run docs:check", status: "passed", owner: "git-hook", trace: "cccccccc-3", exec_ms: 300 },
        ]);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        testsTraceCommand({ cwd: root, trace: "bbbbbbbb-2" });
        const text = log.mock.calls.map(call => String(call[0])).join("\n");
        expect(text).toContain("trace bbbbbbbb-2: 1 row(s)");
        expect(text).toContain("FALLBACK (environment-override)");
        expect(text).not.toContain("docs:check");
    });
});

describe("tests trace — negative (must not fire)", () => {
    // test-contract: invariant — no traced push is an explicit exit 2, never an empty success
    it("N1: exits 2 when no push trace exists", () => {
        const root = fixture([{ ...base, ts: "2026-11-05T00:00:01.000Z", stage: "edit", check: "vitest:selected", status: "passed" }]);
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        testsTraceCommand({ cwd: root });
        expect(process.exitCode).toBe(2);
        expect(String(error.mock.calls[0]?.[0])).toContain("no traced push");
    });
});
