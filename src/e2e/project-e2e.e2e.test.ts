// Plan 31 Unit A through a REAL isolated daemon and the built CLI: a host
// project (the Python fixture) edited through the hook, checked, run, checked,
// edited again and stopped. Promoted from the review's daemon probe.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureProject, type FixtureProject } from "../harness/project-e2e/__tests__/fixture-projects.js";
import { createFixture, type E2eFixture } from "./fixture.js";

describe("project e2e lifecycle across a real daemon", () => {
    let fixture: E2eFixture;
    let product: FixtureProject;
    beforeAll(async () => {
        fixture = await createFixture({ protocol: "raw", rules: { per_edit_coverage: { enabled: false } } });
        product = fixtureProject("py", { accept: true });
        for (const name of ["orders_cli.py", "REQUIREMENTS.md", ".interlinked/e2e-policy.json", ".interlinked/behavioral-contracts.json", ".interlinked/contract-policy.json"]) {
            cpSync(join(product.root, name), join(fixture.cwd, name));
        }
    });
    afterAll(async () => { rmSync(product.root, { recursive: true, force: true }); await fixture?.close(); });

    it("PostToolUse opens the obligation, check/run/check/edit/check follow the exit contract, Stop summarizes", async () => {
        const sessionId = `${fixture.sessionPrefix}-project-e2e`;
        const source = join(fixture.cwd, "orders_cli.py");
        writeFileSync(source, `${readFileSync(source, "utf8")}\n# daemon-observed edit\n`);
        const post = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Edit", input: { file_path: source }, payload: { tool_response: "success" } });
        fixture.assertServed(post);
        expect(post.stdout + post.stderr).toContain("[interlinked:e2e] orders: order-persists needs current e2e evidence");
        expect((await fixture.cli(["tests", "e2e", "check", "--json"])).code).toBe(1);
        expect((await fixture.cli(["tests", "e2e", "run", "--json"])).code).toBe(0);
        expect((await fixture.cli(["tests", "e2e", "check", "--json"])).code).toBe(0);
        writeFileSync(source, `${readFileSync(source, "utf8")}\n# second generation\n`);
        const stale = await fixture.cli(["tests", "e2e", "check", "--json"]);
        expect(stale.code).toBe(1);
        expect(stale.stdout).toContain("STALE_GENERATION");
        const stop = await fixture.hook({ sessionId, event: "Stop" });
        fixture.assertServed(stop);
        expect(stop.stdout + stop.stderr).toContain("[interlinked:e2e] 1 required scenario(s) unresolved");
    }, 120_000);
});

/** Unit C5 through a REAL daemon: the detached child is the built CLI; review C4 pins that disabling before the timer fires cancels it. */
describe("adopted automatic execution across a real daemon", () => {
    for (const disableBeforeTimer of [false, true]) {
        it(disableBeforeTimer ? "N1: autoRun turned off before the quiet period elapses — no detached run, no attempt row" : "P1: an enabled policy spawns ONE detached run that publishes a passing attempt", async () => {
            const fixture = await createFixture({ protocol: "raw", rules: { per_edit_coverage: { enabled: false } } });
            const product = fixtureProject("py", { accept: true });
            try {
                for (const name of ["orders_cli.py", "REQUIREMENTS.md", ".interlinked/e2e-policy.json", ".interlinked/behavioral-contracts.json", ".interlinked/contract-policy.json"]) cpSync(join(product.root, name), join(fixture.cwd, name));
                const policyPath = join(fixture.cwd, ".interlinked/e2e-policy.json");
                const policy = JSON.parse(readFileSync(policyPath, "utf8")) as { scheduling?: Record<string, unknown> }; // SAFETY: fixture-authored
                policy.scheduling = { autoRun: true, quietMs: 1500, minIntervalMs: 10_000, budgetMs: 20_000 };
                writeFileSync(policyPath, JSON.stringify(policy));
                const sessionId = `${fixture.sessionPrefix}-auto`;
                const post = await fixture.hook({ sessionId, event: "PostToolUse", tool: "Edit", input: { file_path: join(fixture.cwd, "orders_cli.py") }, payload: { tool_response: "success" } });
                fixture.assertServed(post);
                if (disableBeforeTimer) {
                    policy.scheduling.autoRun = false;
                    writeFileSync(policyPath, JSON.stringify(policy));
                    fixture.assertServed(await fixture.hook({ sessionId, event: "PostToolUse", tool: "Edit", input: { file_path: policyPath }, payload: { tool_response: "success" } }));
                }
                await delay(6_000);
                const attempts = (fixture.ledger("e2e-obligations.jsonl") as Array<{ op: string; status?: string }>).filter(row => row.op === "attempt");
                if (disableBeforeTimer) { expect(attempts).toEqual([]); return; }
                expect(attempts.map(row => row.status)).toEqual(["passed"]);
                expect((await fixture.cli(["tests", "e2e", "check", "--json"])).code).toBe(0);
            } finally { rmSync(product.root, { recursive: true, force: true }); await fixture.close(); }
        }, 90_000);
    }
});
