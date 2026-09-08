import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLintBaseline, newLintFindings, retireLintDebt, tightenLintBaseline } from "./baseline.js";
import { writeUndoRecord } from "../../harness/evaluator/baseline-effect-guard.js";
import { LINT_BASELINE_PATH, writeLintJson } from "./policy.js";
import { lintDigest } from "./discovery.js";
import type { ImportedLintFinding, LintMeasurement } from "./types.js";

const directories: string[] = [];
function project(): string {
    const root = mkdtempSync(join(tmpdir(), "lint-baseline-"));
    directories.push(root);
    return root;
}
function finding(code: string): ImportedLintFinding {
    return { tool: "ruff", scope: ".", file: "app.py", line: 1, rule: "F401", message: code, fingerprint: lintDigest(code) };
}
function measured(...codes: string[]): LintMeasurement {
    return { entry: { tool: "ruff", scope: ".", sources: ["ruff.toml"] }, status: "measured", findings: codes.map(finding) };
}
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("imported lint debt ratchet", () => {
    it("retires resolved findings and never accepts replacements as equivalent totals", () => {
        const root = project();
        tightenLintBaseline(root, [measured("old-a", "old-b")]);
        expect(newLintFindings(measured("old-b", "new-c"), loadLintBaseline(root))).toEqual([finding("new-c")]);
        tightenLintBaseline(root, [measured("old-b", "new-c")]);
        expect(newLintFindings(measured("old-a", "old-b", "new-c"), loadLintBaseline(root))).toEqual([finding("old-a"), finding("new-c")]);
    });
    it("counts duplicate fingerprints so another identical violation is new debt", () => {
        const root = project();
        tightenLintBaseline(root, [measured("same")]);
        expect(newLintFindings(measured("same", "same"), loadLintBaseline(root))).toEqual([finding("same")]);
    });
    it("refuses partial measurements and preserves the existing baseline", () => {
        const root = project();
        const before = tightenLintBaseline(root, [measured("keep")]);
        const failed: LintMeasurement = { ...measured(), status: "unavailable", reason: "timeout" };
        expect(() => tightenLintBaseline(root, [failed])).toThrow("incomplete");
        expect(loadLintBaseline(root)).toEqual(before);
    });
    it("ordinary checks never seed debt and retire allowances after adoption", () => {
        const root = project();
        expect(retireLintDebt(root, [measured("old")]).entries).toEqual({});
        expect(existsSync(join(root, LINT_BASELINE_PATH))).toBe(false);
        tightenLintBaseline(root, [measured("old")]);
        retireLintDebt(root, [measured()]);
        expect(newLintFindings(measured("old"), loadLintBaseline(root))).toEqual([finding("old")]);
    });
    it("uses the recorded trusted value while a tampered baseline awaits restoration", () => {
        const root = project();
        const trusted = tightenLintBaseline(root, [measured("old")]);
        const loose = { version: 1, entries: { "ruff:.": { [lintDigest("old")]: 10 } } };
        writeLintJson(root, LINT_BASELINE_PATH, loose);
        writeUndoRecord(root, "lint-test", [{ file: LINT_BASELINE_PATH, beforeText: JSON.stringify(trusted), afterText: JSON.stringify(loose), details: ["increased"] }]);
        expect(loadLintBaseline(root)).toEqual(trusted);
        rmSync(join(root, LINT_BASELINE_PATH));
        expect(loadLintBaseline(root)).toEqual(trusted);
    });
});
