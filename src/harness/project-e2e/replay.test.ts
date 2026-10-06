import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fixtureProject, injectPersistenceDefect, type FixtureProject } from "./__tests__/fixture-projects.js";
import { qualifyStability } from "./cohort.js";
import { replayStoredAttempt, storedAttempts } from "./replay.js";
import { evaluateE2e } from "./evaluate.js";
import { openRequest, openRequests, E2E_REQUESTS_PATH } from "./requests.js";
import { scenarioKey } from "./ledger.js";

const fixtures: FixtureProject[] = [];
it("a passing diagnostic replay leaves a failed obligation and open requests byte-identical", async () => {
    const fixture = fixtureProject("py", { accept: true }); fixtures.push(fixture);
    const marker = join(fixture.root, ".interlinked", "external-failure");
    writeFileSync(marker, "fail");
    const source = join(fixture.root, fixture.sourceFile);
    const save = 'json.dump(orders, handle, separators=(",", ":"))';
    writeFileSync(source, readFileSync(source, "utf8").replace(save,
        `(None if __import__("os").path.exists(${JSON.stringify(marker)}) else ${save})`));
    const run = await qualifyStability({ root: fixture.root, scenarioId: "order-persists", timeoutMs: 60000, runs: 1 });
    const verdict = evaluateE2e({ root: fixture.root, atMs: Date.now(), dryRun: true, reconcile: false }).verdicts[0]!;
    expect(verdict.status).toBe("failed");
    const request = openRequest(fixture.root, { key: scenarioKey(verdict.projectId, verdict.scenarioId), generation: verdict.generation, atMs: Date.now() });
    const paths = [".interlinked/e2e-obligations.jsonl", E2E_REQUESTS_PATH];
    const before = paths.map(path => readFileSync(join(fixture.root, path), "utf8"));
    rmSync(marker);
    const result = await replayStoredAttempt({ root: fixture.root, cohortId: run.cohort.cohortId, attempt: 1, timeoutMs: 60000 });
    expect(result.outcome).toBe("not-reproduced");
    expect(paths.map(path => readFileSync(join(fixture.root, path), "utf8"))).toEqual(before);
    expect(openRequests(fixture.root).has(request)).toBe(true);
    expect(evaluateE2e({ root: fixture.root, atMs: Date.now(), dryRun: true, reconcile: false }).verdicts[0]?.status).toBe("failed");
}, 120000);
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture.root, { recursive: true, force: true }); });
it("replays a real failing CLI attempt with its seed and preserves original bytes; refuses changed inputs", async () => {
    const fixture = fixtureProject("py", { accept: true }); fixtures.push(fixture);
    injectPersistenceDefect(fixture);
    const run = await qualifyStability({ root: fixture.root, scenarioId: "order-persists", timeoutMs: 60000, runs: 1 });
    const attempt = run.cohort.attempts[0]!;
    const original = readFileSync(join(fixture.root, attempt.receipt), "utf8");
    const result = await replayStoredAttempt({ root: fixture.root, cohortId: run.cohort.cohortId, attempt: 1, timeoutMs: 60000 });
    expect(result).toMatchObject({ outcome: "reproduced", failing_cases: ["orders.create"] });
    expect(result.replay).not.toBe(attempt.receipt);
    expect(readFileSync(join(fixture.root, attempt.receipt), "utf8")).toBe(original);
    expect(storedAttempts(fixture.root, run.cohort.cohortId)).toMatchObject({ attempts: [{ receipt_valid: true, status: "failed" }] });
    writeFileSync(join(fixture.root, fixture.sourceFile), "# changed\n" + readFileSync(join(fixture.root, fixture.sourceFile), "utf8"));
    expect((await replayStoredAttempt({ root: fixture.root, cohortId: run.cohort.cohortId, attempt: 1, timeoutMs: 60000 })).outcome).toBe("refused");
}, 120000);
