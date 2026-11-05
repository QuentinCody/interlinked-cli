import { expect, it } from "vitest";
import { compareDiagnosticSnapshots } from "./diagnostic-compare.js";
import { measureDiagnosticInventory } from "./diagnostic-report.js";
import { parseDiagnosticSnapshot } from "./diagnostic-snapshot.js";
import { hashBytes, inventoryHash } from "./inventory.js";
import { sourceLanguage } from "./inventory-roles.js";

function snapshot(sources: Record<string, string>) {
    const files = Object.entries(sources).map(([path, content]) => ({ path, content, role: "product" as const, language: sourceLanguage(path), sha256: hashBytes(content) }));
    return parseDiagnosticSnapshot(measureDiagnosticInventory({ version: "interlinked-source-roles-v3", root: "/fixture", discovery: "git", files,
        gaps: [], excluded: [], issues: [], inputHash: inventoryHash(files), sourceHash: inventoryHash(files) }));
}

// test-contract: public-api — a file with identical bytes on both sides is reported unchanged
it("labels a file with the same content on both sides as unchanged", () => {
    const same = snapshot({ "a.ts": "export const a = 1;" });
    expect(compareDiagnosticSnapshots(same, same).files[0]?.state).toBe("unchanged");
});

// test-contract: public-api — a file whose bytes differ between snapshots is reported changed
it("labels a file whose content differs as changed", () => {
    const before = snapshot({ "a.ts": "export const a = 1;" });
    const after = snapshot({ "a.ts": "export const a = 2;" });
    expect(compareDiagnosticSnapshots(before, after).files[0]?.state).toBe("changed");
});
