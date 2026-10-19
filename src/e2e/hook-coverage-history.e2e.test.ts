import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_QUALITY_CHECKS } from "../harness/rules/default-config-quality-checks.js";
import { createFixture, type E2eFixture } from "./fixture.js";

let fixture: E2eFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

it("migrates legacy receipts once, refuses online repair, and preserves pending work during offline loss repair", async () => {
    const review = { id: "legacy-review", path: "README.md", identity: "old-version", evidence: "reviewed old fixture",
        reviewedAt: "2026-10-10T00:00:00Z", kind: "manual_review" };
    const quality_checks = Object.fromEntries(Object.entries(DEFAULT_QUALITY_CHECKS).map(([name, config]) => [name, { ...config, enabled: false }]));
    fixture = await createFixture({ rules: { quality_checks }, prepare(cwd) {
        writeFileSync(join(cwd, ".interlinked", "hook-coverage.json"), JSON.stringify({ schema: 1, generation: 1,
            policyGeneration: 0, files: {}, pending: [], acceptedPolicy: null, checks: [], reviews: [review] }));
    } });
    const started = await fixture.hook({ event: "SessionStart" });
    fixture.assertServed(started);
    const initial = await fixture.cli(["harness", "coverage", "status", "--json"]);
    expect(initial.code, initial.stderr).toBe(0);
    expect(JSON.parse(initial.stdout).reviews).toContainEqual(review);
    expect(readdirSync(fixture.dataDir).filter(name => name.startsWith("hook-coverage.json.legacy-"))).toHaveLength(1);
    const online = await fixture.cli(["harness", "coverage", "repair-history", "--json"]);
    expect(online.code).not.toBe(0);
    expect(online.stderr).toContain("Stop the daemon");
    await fixture.restartDaemon();
    const restarted = await fixture.cli(["harness", "coverage", "status", "--json"]);
    expect(JSON.parse(restarted.stdout).reviews).toContainEqual(review);
    expect(readdirSync(fixture.dataDir).filter(name => name.startsWith("hook-coverage.json.legacy-"))).toHaveLength(1);
    await fixture.stopDaemon();
    const statePath = join(fixture.dataDir, "hook-coverage.json");
    const before = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(join(fixture.dataDir, "hook-coverage-history.jsonl"), "{partial\n");
    const repair = await fixture.cli(["harness", "coverage", "repair-history", "--json"]);
    expect(repair.code, repair.stderr).toBe(0);
    expect(JSON.parse(repair.stdout).repaired).toBe(true);
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    expect(after.pending).toEqual(before.pending);
    expect(after.files).toEqual(before.files);
    expect(after.acceptedPolicy).toBe(before.acceptedPolicy);
    expect(after.history).toMatchObject({ bytes: 0, checks: 0, reviews: 0 });
    expect(readFileSync(JSON.parse(repair.stdout).orphan, "utf8")).toBe("{partial\n");
    await fixture.restartDaemon();
    const final = await fixture.cli(["harness", "coverage", "status", "--json"]);
    expect(final.code, final.stderr).toBe(0);
    expect(JSON.parse(final.stdout).readiness).toBe("ready");
});
