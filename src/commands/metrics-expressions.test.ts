import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectExpressionReport, metricsExpressionsCommand } from "./metrics-expressions.js";

const roots: string[] = [];
function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "interlinked-expressions-"));
    roots.push(root);
    return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("expression measurement command", () => {
    it("reports ranges, source identity and configured budgets for another codebase", () => {
        const root = fixture();
        mkdirSync(join(root, ".interlinked"));
        writeFileSync(join(root, ".interlinked/readability.json"), '{"version":1,"limits":{"expressionTokens":8}}');
        writeFileSync(join(root, "example.ts"), "const answer = a + b + c + d + e;");
        const report = collectExpressionReport("example.ts", root);
        expect(report.complete).toBe(true);
        expect(report.files[0]).toMatchObject({ status: "measured", limits: { expressionTokens: 8 }, findings: [{ check: "expression_size", line: 1, startOffset: 15 }] });
        expect(report.files[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("does not give a clean verdict for syntax or policy failures", () => {
        const root = fixture();
        writeFileSync(join(root, "broken.ts"), "const broken = (");
        expect(collectExpressionReport("broken.ts", root)).toMatchObject({ complete: false, files: [{ status: "unavailable" }] });
        writeFileSync(join(root, "other.py"), "x = 1");
        expect(collectExpressionReport("other.py", root)).toMatchObject({ complete: false, files: [{ status: "unsupported" }] });
    });

    it("keeps default source bounds while the public foreground command measures expressions after 2 MB", () => {
        const root = mkdtempSync(join(process.cwd(), "scratch", "expressions-full-")); roots.push(root);
        writeFileSync(join(root, "source.ts"), `/* ${"padding".repeat(300_000)} */\nconst answer = a + b + c;`);
        expect(collectExpressionReport("source.ts", root)).toMatchObject({ complete: false, files: [{ status: "unavailable", reason: expect.stringContaining("2 MB") }] });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const beforeExitCode = process.exitCode;
        try {
            metricsExpressionsCommand("source.ts", { cwd: root, json: true });
            const report = JSON.parse(String(log.mock.calls[0]?.[0]));
            expect(report).toMatchObject({ complete: true, files: [{ status: "measured" }] });
            expect(report.files[0].expressions.length).toBeGreaterThan(0);
            expect(process.exitCode).toBe(beforeExitCode);
        } finally { log.mockRestore(); process.exitCode = beforeExitCode; }
    });
});
