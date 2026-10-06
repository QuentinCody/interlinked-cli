import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
it("leaves plain fast-check unseeded in a real CI exploration process", () => {
    const code = 'await import("./src/test-setup/property-budget.ts"); const fc = await import("fast-check"); process.stdout.write(JSON.stringify({ seed: fc.readConfigureGlobal().seed ?? null, run: fc.check(fc.property(fc.integer(), () => true), { numRuns: 1 }).seed }));';
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        cwd: process.cwd(), encoding: "utf8", env: { ...process.env, CI: "1", INTERLINKED_FC_EXPLORE: "1", INTERLINKED_FC_CI_SEED: "77" },
    });
    const result = JSON.parse(output);
    expect(result.seed).toBeNull();
    expect(Number.isInteger(result.run)).toBe(true);
});
