import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

let fixture: E2eFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

it("delivers a missing-companion warning once while allowing the write and recognizes a real companion", async () => {
    fixture = await createFixture({ rules: { structural_checks: { test_first_mode: "warn" } } });
    const input = { file_path: join(fixture.cwd, "src/tally.ts"), content: "export const tally = 1;\n" };
    const before = await fixture.hook({ tool: "Write", input });
    fixture.assertServed(before);
    expect(before.stdout).not.toContain('"deny"');
    expect(before.stdout.match(/\[interlinked:tdd\]/g)).toHaveLength(1);
    fixture.file("src/tally.test.ts", 'import { expect, it } from "vitest";\nimport { tally } from "./tally.js";\nit("exposes the initial tally", () => expect(tally).toBe(1));\n');
    const after = await fixture.hook({ tool: "Write", input });
    fixture.assertServed(after);
    expect(after.stdout + after.stderr).not.toContain("[interlinked:tdd]");
    expect(after.stdout).not.toContain('"deny"');
});

// test-contract: public-api — metrics must report an incomplete repository scan as unavailable, even when its observed source prefix is small.
it("reports coverage reach unavailable when research artifacts exhaust the traversal budget", async () => {
    fixture = await createFixture({ prepare(cwd) {
        writeFileSync(join(cwd, "a-source.ts"), "export const value = 1;\n");
        const artifacts = join(cwd, "research");
        mkdirSync(artifacts);
        // Real directory entries exercise the built CLI's bounded walk without large payloads or a mocked limit.
        for (let index = 0; index < 50_001; index++) writeFileSync(join(artifacts, `${index}.json`), "");
    } });
    const result = await fixture.cli(["metrics", "gates", "--json"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ reach: { gates: [
        { gate: "coverage_ratchet", status: "source_unavailable", eligible: 1, measured: 0,
            reason: "eligible_domain_exceeded_50000_entry_budget" },
        { gate: "per_edit_coverage", status: "source_unavailable", eligible: 1, measured: 0,
            reason: "eligible_domain_exceeded_50000_entry_budget" },
    ] } });
});
