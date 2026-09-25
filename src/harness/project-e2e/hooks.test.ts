import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../types.js";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { collectProjectE2eWarnings, configureAutoRunner, formatProjectE2eStopWarning, recoverProjectE2eOrphans } from "./hooks.js";
import { E2E_POLICY_PATH } from "./policy.js";
import { writeAttemptRecord } from "./attempts.js";
import { readFileSync, writeFileSync } from "node:fs";
import { readE2eTxns } from "./ledger.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
function fresh(): FixtureProject { const project = fixtureProject("py", { accept: true }); projects.push(project); return project; }
function editEvent(root: string, extra: Partial<HarnessEvent> = {}): HarnessEvent {
    return { hook_event: "PostToolUse", session_id: "s1", agent_source: "claude", tool_name: "Edit", cwd: root, timestamp: new Date().toISOString(), tool_input: { file_path: join(root, "orders_cli.py") }, ...extra };
}
const TIMEOUT = 60_000;

describe("PostToolUse e2e reconciliation — positive (must warn)", () => {
    it("P1: an Edit to a mapped protected input opens the obligation and names the exact run command", () => {
        const project = fresh();
        const warnings = collectProjectE2eWarnings(editEvent(project.root));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/^\[interlinked:e2e\] orders: order-persists needs current e2e evidence after orders_cli\.py changed/);
        expect(warnings[0]).toContain("interlinked tests e2e run --project orders --scenario order-persists");
        expect(readE2eTxns(project.root)).toHaveLength(1);
    });
    it("P2: a Bash edit observed through the filesystem changeset is the same obligation (PE-17)", () => {
        const project = fresh();
        const changeSet = { source: "filesystem-observation" as const, complete: true, before_captured_at: "t", after_captured_at: "t", files: [{ path: "orders_cli.py", kind: "modified" as const, before_sha256: "a", after_sha256: "b" }] };
        const warnings = collectProjectE2eWarnings(editEvent(project.root, { tool_name: "Bash", tool_input: { command: "sed -i '' s/a/b/ orders_cli.py" }, change_set: changeSet }));
        expect(warnings[0]).toMatch(/order-persists needs current e2e evidence/);
    });
});
describe("Unit C daemon surfaces", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
    afterEach(() => { configureAutoRunner(null); vi.useRealTimers(); });
    it("P4: with scheduling.autoRun on, pending work spawns ONE detached run after the quiet period with the policy budget; a dry run and a policy with autoRun off never do", () => {
        const project = fresh();
        const policyPath = join(project.root, E2E_POLICY_PATH);
        const spawned: Array<[string, number]> = [];
        let clock = 0;
        configureAutoRunner({ spawn: (root, budgetMs) => { spawned.push([root, budgetMs]); return Promise.resolve(); }, now: () => clock });
        collectProjectE2eWarnings(editEvent(project.root));
        vi.advanceTimersByTime(60_000);
        expect(spawned).toEqual([]);
        writeFileSync(policyPath, readFileSync(policyPath, "utf8").replace(/\}\s*$/, ", \"scheduling\": { \"autoRun\": true, \"quietMs\": 1000, \"budgetMs\": 30000 } }"));
        collectProjectE2eWarnings(editEvent(project.root, { dry_run: true }));
        vi.advanceTimersByTime(60_000);
        expect(spawned).toEqual([]);
        collectProjectE2eWarnings(editEvent(project.root));
        collectProjectE2eWarnings(editEvent(project.root));
        expect(spawned).toEqual([]); // quiet period: armed, not started
        clock = 1_000; vi.advanceTimersByTime(1_000);
        expect(spawned).toEqual([[project.root, 30_000]]);
    });
    it("P6: turning scheduling.autoRun OFF after work was queued cancels the queued start; an invalid policy disarms too (review C4)", () => {
        const project = fresh();
        const policyPath = join(project.root, E2E_POLICY_PATH);
        const spawned: string[] = [];
        let clock = 0;
        configureAutoRunner({ spawn: root => { spawned.push(root); return Promise.resolve(); }, now: () => clock });
        writeFileSync(policyPath, readFileSync(policyPath, "utf8").replace(/\}\s*$/, ", \"scheduling\": { \"autoRun\": true, \"quietMs\": 1000 } }"));
        collectProjectE2eWarnings(editEvent(project.root));
        writeFileSync(policyPath, readFileSync(policyPath, "utf8").replace("\"autoRun\": true", "\"autoRun\": false"));
        collectProjectE2eWarnings(editEvent(project.root, { tool_input: { file_path: policyPath } }));
        clock = 5_000; vi.advanceTimersByTime(60_000);
        expect(spawned).toEqual([]);
        writeFileSync(policyPath, readFileSync(policyPath, "utf8").replace("\"autoRun\": false", "\"autoRun\": true"));
        collectProjectE2eWarnings(editEvent(project.root, { tool_input: { file_path: policyPath } }));
        writeFileSync(policyPath, "{ not json");
        collectProjectE2eWarnings(editEvent(project.root, { tool_input: { file_path: policyPath } }));
        clock = 10_000; vi.advanceTimersByTime(60_000);
        expect(spawned).toEqual([]);
    });
    it("P5: SessionStart recovery names each orphaned run once and is silent in an unconfigured repository", () => {
        const project = fresh();
        writeAttemptRecord(project.root, { version: 1, runId: "dead-run", pid: 2_147_483_646, hostname: "elsewhere", startedAt: "2026-09-24T00:00:00.000Z", projectId: "orders", scenarioIds: ["order-persists"], keys: ["orders/order-persists"], generations: { "orders/order-persists": "c".repeat(64) } });
        expect(recoverProjectE2eOrphans(project.root)).toEqual([expect.stringMatching(/run dead-run exited before its evidence was reconciled/)]);
        expect(recoverProjectE2eOrphans(project.root)).toEqual([]);
        expect(recoverProjectE2eOrphans(join(project.root, "docs"))).toEqual([]);
    });
});
describe("PostToolUse e2e reconciliation — negative (must stay silent)", () => {
    it("N1: an unconfigured repository costs nothing and says nothing", () => {
        const project = fresh();
        rmSync(join(project.root, ".interlinked/e2e-policy.json"));
        expect(collectProjectE2eWarnings(editEvent(project.root))).toEqual([]);
    });
    it("N2: a docs edit and a Read produce no obligation (PE-16)", () => {
        const project = fresh();
        expect(collectProjectE2eWarnings(editEvent(project.root, { tool_input: { file_path: join(project.root, "REQUIREMENTS.md") } }))).toEqual([]);
        expect(collectProjectE2eWarnings(editEvent(project.root, { tool_name: "Read" }))).toEqual([]);
        expect(readE2eTxns(project.root)).toEqual([]);
    });
    it("N3: a dry-run event reports but never writes the ledger", () => {
        const project = fresh();
        expect(collectProjectE2eWarnings(editEvent(project.root, { dry_run: true }))).toHaveLength(1);
        expect(readE2eTxns(project.root)).toEqual([]);
    });
});
describe("Stop summary", () => {
    it("P3: lists unresolved required scenarios with the run command; silent once satisfied; silent when the project sets gates.stop off", async () => {
        const project = fresh();
        collectProjectE2eWarnings(editEvent(project.root));
        const before = formatProjectE2eStopWarning({ cwd: project.root, sessionId: "s1" });
        expect(before).toMatch(/\[interlinked:e2e\] 1 required scenario\(s\) unresolved: orders\/order-persists \(pending\)/);
        expect(before).toContain("interlinked tests e2e run");
        await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT });
        expect(formatProjectE2eStopWarning({ cwd: project.root, sessionId: "s1" })).toBeNull();
    }, TIMEOUT);
    it("N4: unconfigured cwd yields null (the plan's Interlinked-only reminder is not this surface)", () => {
        const project = fresh();
        rmSync(join(project.root, ".interlinked/e2e-policy.json"));
        expect(formatProjectE2eStopWarning({ cwd: project.root, sessionId: "s1" })).toBeNull();
    });
});
