import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFixture, type E2eFixture } from "./fixture.js";

let fixture: E2eFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

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
