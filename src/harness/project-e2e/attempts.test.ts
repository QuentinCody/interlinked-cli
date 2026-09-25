// Unit C3: a run attempt is durable from its first instant. A process that dies
// before publication leaves an attempt record the next reader turns into an
// explicit `unavailable` attempt — never a pass, never silence (PE-28/29).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { ATTEMPT_FILE, listOrphanedRuns, ORPHANED_FILE, readAttemptRecord, recoverOrphanedRuns, writeAttemptRecord, type AttemptRecord } from "./attempts.js";
import { evaluateE2e } from "./evaluate.js";
import { appendE2eTxn, readE2eTxns, reduceE2eLedger, scenarioKey } from "./ledger.js";
import { E2E_RUNS_DIRECTORY } from "./receipt.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 90_000;
const GENERATION = "a".repeat(64);
const DEAD_PID = 2_147_483_646; // beyond any real pid table

function attemptFor(root: string, runId: string, pid: number, extra: Partial<AttemptRecord> = {}): AttemptRecord {
    const record: AttemptRecord = { version: 1, runId, pid, hostname: hostname(), startedAt: new Date().toISOString(), projectId: "orders", scenarioIds: ["order-persists"], keys: [scenarioKey("orders", "order-persists")], generations: { "orders/order-persists": GENERATION }, ...extra };
    writeAttemptRecord(root, record);
    return record;
}

describe("attempt records — positive", () => {
    it("P1: a supervised run writes its attempt record before executing and leaves no orphan after publication", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const runDirectory = join(project.root, E2E_RUNS_DIRECTORY, result.receipts[0]!.runId);
        const record = readAttemptRecord(join(runDirectory, ATTEMPT_FILE));
        expect(record).toMatchObject({ version: 1, runId: result.receipts[0]!.runId, pid: process.pid, projectId: "orders", keys: ["orders/order-persists"] });
        expect(listOrphanedRuns(project.root)).toEqual([]);
        expect(recoverOrphanedRuns(project.root, Date.now()).recovered).toEqual([]);
    }, TIMEOUT);
    it("P2: a live process's attempt (no receipt yet) is not an orphan; the record parser refuses foreign versions and escaping run ids", () => {
        const project = fixtureProject("py"); projects.push(project);
        attemptFor(project.root, "live-run", process.pid);
        expect(listOrphanedRuns(project.root)).toEqual([]);
        expect(() => writeAttemptRecord(project.root, { ...attemptFor(project.root, "other", process.pid), runId: "../escape" })).toThrow(/runId/);
        const path = join(project.root, E2E_RUNS_DIRECTORY, "bad", ATTEMPT_FILE);
        mkdirSync(join(project.root, E2E_RUNS_DIRECTORY, "bad"), { recursive: true });
        writeFileSync(path, JSON.stringify({ version: 2, runId: "bad" }));
        expect(readAttemptRecord(path)).toBeNull();
    });
});
describe("attempt records — negative (a crash never becomes satisfaction)", () => {
    it("N1: crash BEFORE publication — a dead pid's attempt becomes one `unavailable` attempt per key, check is unavailable, and recovery is idempotent", () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        appendE2eTxn(project.root, { op: "pending", key: "orders/order-persists", generation: GENERATION, reason: "test", atMs: 1 });
        attemptFor(project.root, "dead-run", DEAD_PID);
        const first = recoverOrphanedRuns(project.root, 2);
        expect(first.recovered).toEqual(["dead-run"]);
        const state = reduceE2eLedger(readE2eTxns(project.root)).get("orders/order-persists")!;
        expect(state.status).toBe("unavailable");
        expect(state.reason).toMatch(/orphaned.*process 2147483646/);
        expect(state.lastRunId).toBe("dead-run");
        expect(existsSync(join(project.root, E2E_RUNS_DIRECTORY, "dead-run", ORPHANED_FILE))).toBe(true);
        expect(recoverOrphanedRuns(project.root, 3).recovered).toEqual([]); // marker prevents a second txn
        expect(readE2eTxns(project.root).filter(txn => txn.op === "attempt")).toHaveLength(1);
        expect(evaluateE2e({ root: project.root, atMs: 4 }).verdicts[0]!.satisfied).toBe(false);
    });
    it("N2: crash AFTER the receipt but BEFORE the ledger row — the receipt is never adopted as satisfaction; recovery records it as unavailable to rerun", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const runId = result.receipts[0]!.runId;
        // Simulate the crash: drop the attempt row the run appended, keep the receipt and the attempt record.
        const ledgerPath = join(project.root, ".interlinked/e2e-obligations.jsonl");
        writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8").split("\n").filter(line => line && !line.includes("\"attempt\"")).join("\n") + "\n");
        const stale = readAttemptRecord(join(project.root, E2E_RUNS_DIRECTORY, runId, ATTEMPT_FILE))!;
        rmSync(join(project.root, E2E_RUNS_DIRECTORY, runId, ATTEMPT_FILE));
        writeAttemptRecord(project.root, { ...stale, pid: DEAD_PID });
        expect(evaluateE2e({ root: project.root, atMs: 5 }).verdicts[0]!.satisfied).toBe(false);
        const recovered = recoverOrphanedRuns(project.root, 6);
        expect(recovered.recovered).toEqual([runId]);
        const state = reduceE2eLedger(readE2eTxns(project.root)).get("orders/order-persists")!;
        expect(state.status).toBe("unavailable");
        expect(state.reason).toMatch(/never reconciled/);
    }, TIMEOUT);
    it("N3: an attempt from another host is an orphan regardless of pid; a run whose receipt AND ledger row exist is untouched", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        attemptFor(project.root, "elsewhere", process.pid, { hostname: "another-host.invalid" });
        expect(listOrphanedRuns(project.root).map(row => row.runId)).toEqual(["elsewhere"]);
        recoverOrphanedRuns(project.root, 7);
        expect(readE2eTxns(project.root).filter(txn => txn.op === "attempt" && txn.runId === result.receipts[0]!.runId)).toHaveLength(1);
        expect(evaluateE2e({ root: project.root, atMs: 8 }).verdicts[0]!.satisfied).toBe(true); // the completed run still stands
    }, TIMEOUT);
});
