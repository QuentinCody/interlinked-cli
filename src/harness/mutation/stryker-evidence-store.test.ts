import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { retainMutationReport } from "./stryker-evidence-store.js";
it("retains exact report bytes and refuses to reuse a tampered artifact", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mutation-raw-"));
    const report = { files: {}, testFiles: {}, engineExitCode: 0, futureField: { keep: true } };
    try {
        const args = { cwd, report, run: "r", source: "test" };
        const first = retainMutationReport(args);
        expect(first.retained).toBe(true);
        if (!first.path) throw new Error("missing evidence path");
        expect(JSON.parse(JSON.parse(readFileSync(first.path, "utf8")).report_json)).toEqual(report);
        expect(retainMutationReport({ ...args, run: "r2" }).sha256).toBe(first.sha256);
        writeFileSync(first.path, "{}");
        expect(retainMutationReport(args)).toMatchObject({ retained: false, reason: expect.stringContaining("content identity") });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
});
