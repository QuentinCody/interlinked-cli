import { describe, expect, it } from "vitest";
import { compareDiagnosticSnapshots } from "./diagnostic-compare.js";
import { measureDiagnosticInventory } from "./diagnostic-report.js";
import { parseDiagnosticSnapshot } from "./diagnostic-snapshot.js";
import { hashBytes, inventoryHash } from "./inventory.js";
import { sourceLanguage } from "./inventory-roles.js";

function report(sources: Record<string, string>) {
    const files = Object.entries(sources).map(([path, content]) => ({ path, content, role: "product" as const, language: sourceLanguage(path), sha256: hashBytes(content) }));
    return measureDiagnosticInventory({ version: "interlinked-source-roles-v2", root: "/fixture", discovery: "git", files,
        gaps: [], excluded: [], issues: [], inputHash: inventoryHash(files), sourceHash: inventoryHash(files) });
}
const complex = "function f(x: number) {\n" + Array.from({ length: 10 }, (_, i) => `if(x === ${i}) return ${i};`).join("\n") + "\nreturn -1;\n}";

describe("diagnostic snapshot comparisons", () => {
    it("shows denominator dilution even for a compatible same-file change", () => {
        const before = parseDiagnosticSnapshot(report({ "a.ts": complex }));
        const after = parseDiagnosticSnapshot(report({ "a.ts": complex + "\nfunction simple() { return 1; }" }));
        const result = compareDiagnosticSnapshots(before, after);
        expect(result.comparable).toBe(true);
        expect(result.erosion).toMatchObject({ numeratorDelta: 0, dilution: true });
        expect(result.erosion.fractionDelta).toBeLessThan(0);
        expect(result.files[0]?.slocDelta).toBe(1);
    });
    it("withholds an overall delta when files disappear or become unmeasured", () => {
        const before = parseDiagnosticSnapshot(report({ "a.ts": complex, "b.ts": "export const b = 1;" }));
        for (const source of [{ "b.ts": "export const b = 1;" }, { "a.ts": "function broken( {", "b.ts": "export const b = 1;" }]) {
            const result = compareDiagnosticSnapshots(before, parseDiagnosticSnapshot(report(source)));
            expect(result.comparable).toBe(false);
            expect(result.erosion.numeratorDelta).toBeNull();
            expect(result.files[0]?.state).toBe("removed-or-unmeasured");
            expect(result.files[1]?.slocDelta).toBe(0);
        }
    });
    it("refuses parser changes, discovery changes, and new exclusions", () => {
        const raw = report({ "a.ts": complex }), before = parseDiagnosticSnapshot(raw);
        const changed = structuredClone(raw);
        changed.parsers = ["different-parser"];
        changed.measurementIdentity = hashBytes(JSON.stringify([changed.profile, changed.scope.roleVersion, changed.parsers]));
        expect(compareDiagnosticSnapshots(before, parseDiagnosticSnapshot(changed)).comparable).toBe(false);
        const excluded = structuredClone(raw);
        excluded.scope.exclusions.push({ path: "ignored.ts", role: "generated", reason: "new exclusion" });
        expect(compareDiagnosticSnapshots(before, parseDiagnosticSnapshot(excluded)).reasons).toContain("Recorded exclusions differ");
        expect(compareDiagnosticSnapshots(before, { ...before, discovery: "filesystem" }).comparable).toBe(false);
    });
    it("preserves empty denominators and rejects malformed, duplicated, or inconsistent reports", () => {
        const empty = parseDiagnosticSnapshot(report({ "a.ts": "// no code" }));
        expect(compareDiagnosticSnapshots(empty, empty).erosion.fractionDelta).toBeNull();
        expect(() => parseDiagnosticSnapshot({})).toThrow();
        const duplicate = report({ "a.ts": complex });
        duplicate.files.push(duplicate.files[0]!);
        expect(() => parseDiagnosticSnapshot(duplicate)).toThrow(/Duplicate/);
        const bad = report({ "a.ts": complex });
        bad.erosion.numerator = 0;
        bad.erosion.fraction = 0;
        expect(() => parseDiagnosticSnapshot(bad)).toThrow(/totals/);
        const mismatched = report({ "a.ts": complex });
        mismatched.parsers.push("other");
        expect(() => parseDiagnosticSnapshot(mismatched)).toThrow(/identity/);
    });
});
