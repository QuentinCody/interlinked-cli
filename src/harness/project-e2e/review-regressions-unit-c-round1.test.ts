// Unit C review round 1 (2026-09-24, findings C1–C6 in scratch/review-project-e2e-unit-c/REVIEW.md), one pin per
// finding. Three were false-pass defects: a native test stage could rewrite protected source before the contracts
// ran (C1), any nonzero runner exit counted as ok (C2), cancellation never reached the managed contracts (C3).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import { fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { ATTEMPT_FILE, listOrphanedRuns, ORPHANED_FILE, readAttemptRecord, recoverOrphanedRuns, writeAttemptRecord } from "./attempts.js";
import { evaluateE2e } from "./evaluate.js";
import { collectProjectE2eWarnings } from "./hooks.js";
import { appendE2eTxn, readE2eTxns, reduceE2eLedger } from "./ledger.js";
import { E2E_POLICY_PATH, type E2ePolicy } from "./policy.js";
import { E2E_RUNS_DIRECTORY } from "./receipt.js";
import { openRequests } from "./requests.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 90_000;
const DEAD_PID = 2_147_483_646;
const GENERATION = "c".repeat(64);
function fresh(): FixtureProject { const project = fixtureProject("py", { accept: true }); projects.push(project); return project; }
function readJson(path: string): Record<string, unknown> & { [key: string]: never } {
    return JSON.parse(readFileSync(path, "utf8")); // SAFETY: test-authored files re-read by the test
}
/** Turns the fixture's suite into a structured-runner suite whose `native.mjs` runs `code`, writes `cases` as the report and exits `exitCode`. */
function nativeSuite(root: string, code: string, exitCode = 0, cases: unknown[] = [{ id: "native", status: "passed" }]): void {
    const path = join(root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(path, "utf8")) as E2ePolicy; // SAFETY: fixture-authored, re-parsed on load
    const suite = policy.projects[0]!.suites[0]!;
    suite.adapter = "structured-runner"; suite.run = { argv: ["node", "native.mjs"] }; suite.report = { format: "json", path: "report.json" };
    const scenario = policy.projects[0]!.scenarios[0]!;
    delete scenario.boundary; scenario.caseIds = ["native"];
    writeFileSync(join(root, "native.mjs"), `import { writeFileSync } from "node:fs";\n${code}\nwriteFileSync("report.json", ${JSON.stringify(JSON.stringify({ version: 1, cases }))});\nprocess.exit(${exitCode});\n`);
    writeFileSync(path, JSON.stringify(policy));
}
function codes(root: string, atMs: number): string[] { return evaluateE2e({ root, atMs }).verdicts[0]!.reasons.map(row => row.code); }

describe("C1 — the native test stage cannot substitute the candidate (negative: must not pass)", () => {
    it("N1: a test command that rewrites protected source inside the snapshot leaves the run incomplete; no contract runs and check stays red", async () => {
        const project = fresh();
        const source = join(project.root, project.sourceFile), good = readFileSync(source, "utf8");
        injectPersistenceDefect(project);
        nativeSuite(project.root, `writeFileSync("orders_cli.py", ${JSON.stringify(good)});`);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        const receipt = readJson(join(project.root, result.receipts[0]!.path)) as unknown as { completion: { complete: boolean; reasons: string[] }; cases: Array<{ runnerKind: string }> };
        expect(receipt.completion.complete).toBe(false);
        expect(receipt.completion.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/the test command modified declared input orders_cli\.py/), expect.stringMatching(/the test command altered declared inputs; no case executed/)]));
        expect(receipt.cases.filter(row => row.runnerKind === "process")).toEqual([]);
        expect(evaluateE2e({ root: project.root, atMs: 2 }).exitCode).toBe(1);
        expect(readFileSync(source, "utf8")).not.toBe(good); // the live tree was never touched either way
    }, TIMEOUT);
});
describe("C2 — a nonzero test-command exit must be explained by the report", () => {
    it("N1: exit 17 under an all-green report records execution ok:false and an incomplete run (RUN_INCOMPLETE), never a pass", async () => {
        const project = fresh();
        nativeSuite(project.root, "", 17);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).not.toBe(0);
        const receipt = readJson(join(project.root, result.receipts[0]!.path)) as unknown as { execution: { exitCode: number; ok: boolean }; completion: { complete: boolean; reasons: string[] } };
        expect(receipt.execution).toMatchObject({ exitCode: 17, ok: false });
        expect(receipt.completion.complete).toBe(false);
        expect(receipt.completion.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/exited 17 but its report records no failure/)]));
        expect(codes(project.root, 2)).toContain("RUN_INCOMPLETE");
    }, TIMEOUT);
    it("P1: exit 1 explained by a failed case in the report is CASE_FAILED (a measured result), not an incomplete run", async () => {
        const project = fresh();
        nativeSuite(project.root, "", 1, [{ id: "native", status: "failed", message: "assertion failed" }]);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).toBe(1);
        const verdict = evaluateE2e({ root: project.root, atMs: 3 }).verdicts[0]!;
        expect(verdict.status).toBe("failed");
        expect(verdict.reasons.map(row => row.code)).toContain("CASE_FAILED");
        expect(verdict.reasons.map(row => row.code)).not.toContain("RUN_INCOMPLETE");
    }, TIMEOUT);
});
describe("C3 — cancellation reaches admission and the managed contracts (negative: a cancelled run never passes)", () => {
    it("N1: an already-aborted signal on a suite with NO preparation is refused before admission: no receipt, the obligation stays open", async () => {
        const project = fresh();
        const controller = new AbortController();
        controller.abort();
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, signal: controller.signal });
        expect(result.exitCode).not.toBe(0);
        expect(result.receipts).toEqual([]);
        expect(result.messages).toEqual([expect.stringMatching(/cancelled before admission/)]);
        expect(evaluateE2e({ root: project.root, atMs: 2 }).verdicts[0]!.satisfied).toBe(false);
    }, TIMEOUT);
    it("N2: aborting DURING contract execution kills the child, leaves every contract case unavailable and the run incomplete", async () => {
        const project = fresh();
        const source = join(project.root, "orders_cli.py");
        writeFileSync(source, readFileSync(source, "utf8").replace("import sys\n", "import sys\nimport time\ntime.sleep(5)\n"));
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 700);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, signal: controller.signal });
        expect(result.exitCode).not.toBe(0);
        const receipt = readJson(join(project.root, result.receipts[0]!.path)) as unknown as { completion: { complete: boolean; reasons: string[] }; cases: Array<{ state: string }> };
        expect(receipt.completion.complete).toBe(false);
        expect(receipt.completion.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/cancelled during contract execution/)]));
        expect(receipt.cases.map(row => row.state)).not.toContain("passed");
        expect(reduceE2eLedger(readE2eTxns(project.root)).get("orders/order-persists")?.status).toBe("unavailable");
    }, TIMEOUT);
});
describe("C4 — a queued automatic launch never outlives its authorization", () => {
    it("N1: an automatic launch re-validates the CURRENT policy — autoRun off runs nothing; once on, the same launch runs", async () => {
        const project = fresh();
        const off = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, automatic: true });
        expect(off.receipts).toEqual([]);
        expect(off.messages).toEqual([expect.stringMatching(/automatic execution is off/)]);
        const path = join(project.root, E2E_POLICY_PATH), policy = readJson(path) as Record<string, unknown>;
        policy.scheduling = { autoRun: true };
        writeFileSync(path, JSON.stringify(policy));
        const on = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, automatic: true });
        expect(on.receipts).toHaveLength(1);
        expect(on.exitCode).toBe(0);
    }, TIMEOUT);
});
describe("C5 — recovery is per (run, key), and the marker means COMPLETED", () => {
    it("N1: a crash between the per-scenario publication rows is recovered for exactly the missing scenario; the published row stands", async () => {
        const project = fresh();
        const policyPath = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(policyPath, "utf8")) as E2ePolicy; // SAFETY: fixture-authored
        policy.projects[0]!.scenarios.push({ ...policy.projects[0]!.scenarios[0]!, id: "second" });
        writeFileSync(policyPath, JSON.stringify(policy));
        const done = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(done.exitCode).toBe(0);
        const runId = done.receipts[0]!.runId;
        const ledger = join(project.root, ".interlinked/e2e-obligations.jsonl");
        writeFileSync(ledger, readFileSync(ledger, "utf8").split("\n").filter(line => !(line.includes("\"op\":\"attempt\"") && line.includes("\"orders/second\""))).join("\n"));
        const attemptPath = join(project.root, E2E_RUNS_DIRECTORY, runId, ATTEMPT_FILE), record = readAttemptRecord(attemptPath)!;
        rmSync(attemptPath);
        writeAttemptRecord(project.root, { ...record, pid: DEAD_PID });
        expect(listOrphanedRuns(project.root).map(row => row.missingKeys)).toEqual([["orders/second"]]);
        expect(recoverOrphanedRuns(project.root, 5).recovered).toEqual([runId]);
        const state = reduceE2eLedger(readE2eTxns(project.root));
        expect(state.get("orders/order-persists")?.status).toBe("satisfied");
        expect(state.get("orders/second")?.status).toBe("unavailable");
        expect(state.get("orders/second")?.reason).toMatch(/never reconciled into the ledger for orders\/second/);
        expect(existsSync(join(project.root, E2E_RUNS_DIRECTORY, runId, ORPHANED_FILE))).toBe(true);
        expect(recoverOrphanedRuns(project.root, 6).recovered).toEqual([]);
    }, TIMEOUT);
    it("N2: a crash between RECOVERY rows (one key recovered, no marker) resumes with only the keys still missing, then writes the marker", () => {
        const project = fresh();
        writeAttemptRecord(project.root, { version: 1, runId: "partial-recovery", pid: DEAD_PID, hostname: "elsewhere.invalid", startedAt: "2026-09-24T00:00:00.000Z", projectId: "orders", scenarioIds: ["a", "b"], keys: ["orders/a", "orders/b"], generations: { "orders/a": GENERATION, "orders/b": GENERATION } });
        appendE2eTxn(project.root, { op: "attempt", key: "orders/a", generation: GENERATION, runId: "partial-recovery", status: "unavailable", atMs: 1, receipt: "x", reason: "row written by the recovery that crashed" });
        expect(listOrphanedRuns(project.root).map(row => row.missingKeys)).toEqual([["orders/b"]]);
        expect(recoverOrphanedRuns(project.root, 2).recovered).toEqual(["partial-recovery"]);
        expect(readE2eTxns(project.root).filter(txn => txn.op === "attempt" && txn.runId === "partial-recovery").map(txn => txn.key)).toEqual(["orders/a", "orders/b"]);
        expect(existsSync(join(project.root, E2E_RUNS_DIRECTORY, "partial-recovery", ORPHANED_FILE))).toBe(true);
        expect(listOrphanedRuns(project.root)).toEqual([]);
    });
});
describe("C6 — every session observing an unresolved generation gets its own request", () => {
    it("P1: two hook sessions observing the SAME pending generation both open a request, and one run serves both", async () => {
        const project = fresh();
        const event = (session_id: string): HarnessEvent => ({ hook_event: "PostToolUse", session_id, agent_source: "claude", tool_name: "Edit", cwd: project.root, timestamp: "2026-09-24T00:00:00.000Z", tool_input: { file_path: join(project.root, "orders_cli.py") } });
        expect(collectProjectE2eWarnings(event("session-a"))).toHaveLength(1);
        collectProjectE2eWarnings(event("session-b"));
        const open = [...openRequests(project.root).values()];
        expect(open.map(row => row.sessionId).sort()).toEqual(["session-a", "session-b"]);
        expect(new Set(open.map(row => row.generation)).size).toBe(1);
        expect(readE2eTxns(project.root).filter(txn => txn.op === "pending")).toHaveLength(1); // the ledger obligation was opened once
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(result.exitCode).toBe(0);
        const receipt = readJson(join(project.root, result.receipts[0]!.path)) as unknown as { requestIds: string[] };
        expect(receipt.requestIds).toHaveLength(2);
        expect(openRequests(project.root).size).toBe(0);
    }, TIMEOUT);
});
