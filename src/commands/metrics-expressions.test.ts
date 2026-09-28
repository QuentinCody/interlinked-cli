import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExpressionReport } from "./metrics-expressions.js";

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
});
