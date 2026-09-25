// Unit C4: run requests survive the daemon (append-only JSONL) and are served
// by the run that certifies their exact key + generation. Two sessions asking
// for the same current scope share one qualifying run with attribution
// (PE-12); a request for another scenario stays open (PE-13).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "./__tests__/fixture-projects.js";
import { evaluateE2e } from "./evaluate.js";
import { scenarioKey } from "./ledger.js";
import { E2E_POLICY_PATH, type E2ePolicy } from "./policy.js";
import { E2E_REQUESTS_PATH, openRequest, openRequests, readRequestTxns, serveRequests } from "./requests.js";
import { runProjectE2e } from "./run.js";

const projects: FixtureProject[] = [];
afterEach(() => { for (const project of projects.splice(0)) rmSync(project.root, { recursive: true, force: true }); });
const TIMEOUT = 90_000;
const KEY = scenarioKey("orders", "order-persists");

describe("run requests — positive", () => {
    it("P1: opening a request twice for the same key and generation yields one open request; serving it closes it", () => {
        const project = fixtureProject("py"); projects.push(project);
        const generation = "b".repeat(64);
        const first = openRequest(project.root, { key: KEY, generation, sessionId: "s1", atMs: 1 });
        const again = openRequest(project.root, { key: KEY, generation, sessionId: "s1", atMs: 2 });
        expect(again).toBe(first);
        expect([...openRequests(project.root).keys()]).toEqual([first]);
        expect(serveRequests(project.root, "run-1", [first, "unknown-id"], 3)).toEqual([first]);
        expect(openRequests(project.root).size).toBe(0);
        expect(readRequestTxns(project.root)).toHaveLength(2); // open + served; the duplicate open appended nothing
    });
    it("P2 (PE-12): two sessions requesting the same current scope share one supervised run — the receipt names both requests", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const generation = evaluateE2e({ root: project.root, atMs: 1 }).verdicts[0]!.generation;
        const a = openRequest(project.root, { key: KEY, generation, sessionId: "session-a", atMs: 1 });
        const b = openRequest(project.root, { key: KEY, generation, sessionId: "session-b", atMs: 2 });
        expect(a).not.toBe(b);
        const result = await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, sessionId: "session-a" });
        const receipt = JSON.parse(readFileSync(join(project.root, result.receipts[0]!.path), "utf8"));
        expect(receipt.requestIds).toEqual(expect.arrayContaining([a, b]));
        expect(receipt.initiator).toBe("session-a");
        expect(openRequests(project.root).size).toBe(0);
    }, TIMEOUT);
});
describe("run requests — negative (never served by the wrong run)", () => {
    it("N1 (PE-13): a request for another scenario, or for another generation of the same scenario, stays open after an unrelated run", async () => {
        const project = fixtureProject("py", { accept: true }); projects.push(project);
        const policy = JSON.parse(readFileSync(join(project.root, E2E_POLICY_PATH), "utf8")) as E2ePolicy; // SAFETY: fixture-authored, re-parsed on load
        policy.projects[0]!.scenarios.push({ ...policy.projects[0]!.scenarios[0]!, id: "other", contractIds: ["orders.invalid"] });
        writeFileSync(join(project.root, E2E_POLICY_PATH), JSON.stringify(policy));
        const generation = evaluateE2e({ root: project.root, atMs: 1 }).verdicts.find(row => row.scenarioId === "other")!.generation;
        const other = openRequest(project.root, { key: scenarioKey("orders", "other"), generation, sessionId: "s2", atMs: 1 });
        const olderGeneration = openRequest(project.root, { key: KEY, generation: "c".repeat(64), sessionId: "s3", atMs: 2 });
        await runProjectE2e({ root: project.root, timeoutMs: TIMEOUT, scenarioIds: ["order-persists"] });
        expect([...openRequests(project.root).keys()].sort()).toEqual([other, olderGeneration].sort());
    }, TIMEOUT);
    it("N2: malformed rows are skipped and a served row for an unknown request is ignored, never a phantom open request", () => {
        const project = fixtureProject("py"); projects.push(project);
        writeFileSync(join(project.root, E2E_REQUESTS_PATH), `not json\n${JSON.stringify({ op: "served", id: "ghost", runId: "r", atMs: 1 })}\n${JSON.stringify({ op: "open", id: "x", key: KEY, generation: "zz", atMs: 1 })}\n`);
        expect(readRequestTxns(project.root)).toHaveLength(1);
        expect(openRequests(project.root).size).toBe(0);
    });
});
