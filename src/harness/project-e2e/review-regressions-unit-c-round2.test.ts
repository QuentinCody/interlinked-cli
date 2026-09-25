// Unit C review round 2 (2026-09-24, D1–D2 in scratch/review-project-e2e-unit-c/REVIEW-round2.md): two
// concurrency-boundary consistency defects. D1: a request arriving DURING execution was served without appearing in
// the receipt (attribution was captured before execution, serving happened after publication against the live
// ledger). D2: two recoverers could both append the same orphan's `unavailable` row with different timestamps.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { fileMutationLockOwnerPath, fileMutationLockPath, withFileMutationLock } from "../../lib/file-mutation-lock.js";
import type { HarnessEvent } from "../types.js";
import { fixtureProject, touchSource, type FixtureProject } from "./__tests__/fixture-projects.js";
import { ORPHANED_FILE, recoverOrphanedRuns, recoveryLockTarget, writeAttemptRecord } from "./attempts.js";
import { collectProjectE2eWarnings } from "./hooks.js";
import { appendE2eTxn, readE2eTxns, reduceE2eLedger } from "./ledger.js";
import { E2E_POLICY_PATH, type E2ePolicy } from "./policy.js";
import { E2E_RUNS_DIRECTORY } from "./receipt.js";
import { openRequests, readRequestTxns } from "./requests.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 90_000;
const DEAD_PID = 2_147_483_646;
const KEY = "orders/order-persists";
const GENERATION = "a".repeat(64);
function fresh(): FixtureProject { const project = fixtureProject("py", { accept: true }); projects.push(project); return project; }
function editEvent(root: string, session_id: string): HarnessEvent {
    return { hook_event: "PostToolUse", session_id, agent_source: "claude", tool_name: "Edit", cwd: root, timestamp: "2026-09-24T00:00:00.000Z", tool_input: { file_path: join(root, "orders_cli.py") } };
}
async function until(ready: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!ready()) { if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`); await delay(10); }
}
function attemptRecord(runId: string, pid: number) {
    return { version: 1 as const, runId, pid, hostname: hostname(), startedAt: "2026-09-24T00:00:00.000Z", projectId: "orders", scenarioIds: ["order-persists"], keys: [KEY], generations: { [KEY]: GENERATION } };
}

describe("D1 — attribution is frozen at publication and exactly those ids are served", () => {
    it("P1: a second session arriving DURING execution is in the receipt and served; a session arriving AFTER publication stays open", async () => {
        const project = fresh();
        const policyPath = join(project.root, E2E_POLICY_PATH), policy = JSON.parse(readFileSync(policyPath, "utf8")) as E2ePolicy; // SAFETY: fixture-authored
        writeFileSync(join(project.root, "prepare.mjs"), "await new Promise(resolve => setTimeout(resolve, 800));\n");
        policy.projects[0]!.suites[0]!.prepare = [{ argv: ["node", "prepare.mjs"] }];
        writeFileSync(policyPath, JSON.stringify(policy));
        collectProjectE2eWarnings(editEvent(project.root, "session-a"));
        const running = runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        const runs = join(project.root, E2E_RUNS_DIRECTORY);
        await until(() => existsSync(runs) && readdirSync(runs).some(id => existsSync(join(runs, id, "attempt.json"))), "the attempt record");
        collectProjectE2eWarnings(editEvent(project.root, "session-b"));
        const beforePublication = [...openRequests(project.root).keys()].sort();
        expect(beforePublication).toHaveLength(2);
        const result = await running;
        expect(result.exitCode).toBe(0);
        const receipt = JSON.parse(readFileSync(join(project.root, result.receipts[0]!.path), "utf8")) as { requestIds: string[] }; // SAFETY: receipt this run wrote
        expect([...receipt.requestIds].sort()).toEqual(beforePublication);
        const served = readRequestTxns(project.root).filter(row => row.op === "served").map(row => row.id).sort();
        expect(served).toEqual(beforePublication);
        expect(openRequests(project.root).size).toBe(0);
        // After publication: a later edit opens a NEW generation; that session's request is durable, open, and never served by the earlier receipt.
        touchSource(project);
        collectProjectE2eWarnings(editEvent(project.root, "session-c"));
        const late = [...openRequests(project.root).values()];
        expect(late.map(row => row.sessionId)).toEqual(["session-c"]);
        expect(readRequestTxns(project.root).filter(row => row.op === "served")).toHaveLength(2);
    }, TIMEOUT);
});
describe("D2 — recovery of one orphan is serialized across processes", () => {
    it("N1: two real recoverer processes released at the same instant with different timestamps produce ONE attempt row and attempts: 1", async () => {
        const project = fresh();
        appendE2eTxn(project.root, { op: "pending", key: KEY, generation: GENERATION, atMs: 0, reason: "test" });
        writeAttemptRecord(project.root, attemptRecord("one-orphan", DEAD_PID));
        const worker = join(project.root, "recover-worker.mjs");
        writeFileSync(worker, [
            'import { existsSync, writeFileSync } from "node:fs";',
            'import { join } from "node:path";',
            `import { recoverOrphanedRuns } from ${JSON.stringify(new URL("./attempts.ts", import.meta.url).href)};`,
            "const [root, id] = process.argv.slice(2);",
            "recoverOrphanedRuns(root, Number(id), { isAlive() {",
            '  writeFileSync(join(root, "ready-" + id), "");',
            "  const deadline = Date.now() + 10000;",
            '  while (!existsSync(join(root, "go"))) { if (Date.now() > deadline) throw new Error("barrier timed out"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }',
            "  return false;",
            "} });",
            "",
        ].join("\n"));
        const children = ["1", "2"].map(id => new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", worker, project.root, id], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            child.stderr.on("data", chunk => { stderr += String(chunk); });
            child.on("error", reject);
            child.on("exit", code => code === 0 ? resolve() : reject(new Error(`worker ${id} exited ${code}: ${stderr}`)));
        }));
        await until(() => ["1", "2"].every(id => existsSync(join(project.root, `ready-${id}`))), "both workers at the barrier");
        writeFileSync(join(project.root, "go"), "");
        await Promise.all(children);
        const txns = readE2eTxns(project.root);
        expect(txns.filter(row => row.op === "attempt")).toHaveLength(1);
        expect(reduceE2eLedger(txns).get(KEY)?.attempts).toBe(1);
        expect(existsSync(join(project.root, E2E_RUNS_DIRECTORY, "one-orphan", ORPHANED_FILE))).toBe(true);
        expect(existsSync(fileMutationLockPath(recoveryLockTarget(project.root, "one-orphan")))).toBe(false);
    }, TIMEOUT);
    it("N2 (round 3, E1): a lock held by a LIVE owner defers the orphan and the owner's lock survives; a DEAD owner's lock is recovered and the run completes", () => {
        const project = fresh();
        appendE2eTxn(project.root, { op: "pending", key: KEY, generation: GENERATION, atMs: 0, reason: "test" });
        writeAttemptRecord(project.root, attemptRecord("locked", DEAD_PID));
        const target = recoveryLockTarget(project.root, "locked"), lockDirectory = fileMutationLockPath(target);
        // Live owner: this process holds the run's lock while a recoverer runs — deferred, no row, the holder's lock untouched (ownership-checked release).
        const deferred = withFileMutationLock(target, () => ({ recovered: recoverOrphanedRuns(project.root, 2).recovered, lockPresent: existsSync(lockDirectory) }), { waitMs: 0 });
        expect(deferred).toEqual({ recovered: [], lockPresent: true });
        expect(readE2eTxns(project.root).filter(row => row.op === "attempt")).toHaveLength(0);
        // Dead owner: an owner record from a process that no longer exists is recovered by the lock itself.
        mkdirSync(lockDirectory, { recursive: true });
        writeFileSync(fileMutationLockOwnerPath(target, "dead-owner"), JSON.stringify({ pid: DEAD_PID, token: "dead-owner", acquired_at_ms: 1 }));
        expect(recoverOrphanedRuns(project.root, 3).recovered).toEqual(["locked"]);
        expect(readE2eTxns(project.root).filter(row => row.op === "attempt")).toHaveLength(1);
        expect(existsSync(lockDirectory)).toBe(false);
        expect(recoverOrphanedRuns(project.root, 4).recovered).toEqual([]); // completed: marker present, nothing missing
    });
});
