import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { COVERAGE_FLOW_SCENARIOS, type CoverageFlowDriver } from "../harness/__fixtures__/hook-coverage-contract.js";
import { isHookCoverageReport } from "../harness/hook-coverage-control.js";
import { DEFAULT_QUALITY_CHECKS } from "../harness/rules/default-config-quality-checks.js";
import { createFixture, type E2eFixture } from "./fixture.js";

let fixture: E2eFixture | undefined;
afterEach(async () => { await fixture?.close(); fixture = undefined; });

function driver(owned: E2eFixture): CoverageFlowDriver {
    async function command(operation: "status" | "verify") {
        owned.assertOwner("raw");
        owned.assertOwner("framed");
        const result = await owned.cli(["harness", "coverage", operation, "--json"]);
        owned.assertOwner("raw");
        owned.assertOwner("framed");
        const report: unknown = JSON.parse(result.stdout);
        assert(isHookCoverageReport(report), result.stderr);
        return { report, exitCode: result.code };
    }
    return {
        manifestPath: join(owned.cwd, "package.json"),
        async writeManifest(content) {
            if (content === null) rmSync(join(owned.cwd, "package.json"));
            else owned.file("package.json", content);
        },
        async status() {
            const result = await command("status");
            assert.equal(result.exitCode, 0);
            return result.report;
        },
        verify: () => command("verify"),
    };
}

it.each(COVERAGE_FLOW_SCENARIOS)("$name through the built CLI and daemon", async scenario => {
    const quality_checks = Object.fromEntries(Object.entries(DEFAULT_QUALITY_CHECKS).map(([name, config]) =>
        [name, { ...config, enabled: name === "package_json_consistency" }]));
    fixture = await createFixture({ rules: { quality_checks } });
    const session = await fixture.hook({ event: "SessionStart" });
    fixture.assertServed(session);
    await scenario.run(driver(fixture));
});
