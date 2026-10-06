import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recheckFindingFiles } from "./check-recheck.js";
import { readFindingOutcomes } from "./check-observation-reader.js";

it("records an actual detector hit, repair, and compatible clean follow-up", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "finding-recheck-"));
    try {
        writeFileSync(join(cwd, "a.ts"), "const bad = value === NaN;\n");
        expect(recheckFindingFiles(cwd, ["a.ts"]).checked).toBe(1);
        expect((await readFindingOutcomes(cwd)).checks.find((r) => r.check === "nan_comparison")?.present).toBe(1);
        writeFileSync(join(cwd, "a.ts"), "const good = Number.isNaN(value);\n");
        recheckFindingFiles(cwd, ["a.ts"]);
        expect((await readFindingOutcomes(cwd)).checks.find((r) => r.check === "nan_comparison")?.rechecked_clean).toBe(1);
        expect(recheckFindingFiles(cwd, ["../outside.ts"]).unavailable).toEqual(["../outside.ts"]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
});
it("retains a missing-file execution as unavailable, never clean", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "finding-deleted-"));
    try {
        writeFileSync(join(cwd, "a.ts"), "const bad = value === NaN;\n");
        recheckFindingFiles(cwd, ["a.ts"]);
        rmSync(join(cwd, "a.ts"));
        recheckFindingFiles(cwd, ["a.ts"]);
        const row = (await readFindingOutcomes(cwd)).checks.find(row => row.check === "nan_comparison");
        expect(row).toMatchObject({ unavailable: 1, rechecked_clean: 0, followup_coverage: 0 });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
});
