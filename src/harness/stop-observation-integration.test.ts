import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { makeSession } from "./__tests__/fixtures/evaluator.js";
import { buildPatternRescanWarnings } from "./stop-rescan.js";
import { readFindingOutcomes } from "./check-observation-reader.js";

it("persists observations through the actual Stop entry and keeps dry runs write-free", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "stop-entry-evidence-"));
    try {
        const file = join(cwd, "a.ts");
        writeFileSync(file, "export const bad = value === NaN;\n");
        const session = { ...makeSession(), files_written: new Set([file]) };
        const attribution = { byFile: new Map<string, string[]>(), agents: new Set<string>() };
        buildPatternRescanWarnings(session, cwd, { dryRun: true, attribution });
        expect((await readFindingOutcomes(cwd)).observations).toBe(0);
        const warnings = buildPatternRescanWarnings(session, cwd, { attribution });
        expect(warnings.join("\n")).toContain("nan_comparison");
        const recorded = await readFindingOutcomes(cwd);
        expect(recorded.checks.find(row => row.check === "nan_comparison")).toMatchObject({ present: 1, emissions: 1 });
        expect(recorded.observations).toBe(1);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
});
