import { mkdtempSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeSetEvidence } from "./change-set-evidence.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "batch-evidence-")); roots.push(root);
    const paths = [join(root, "a.ts"), join(root, "b.ts")];
    paths.forEach(path => writeFileSync(path, "export const x = 1;"));
    const checks = { typescript: { enabled: true, command: "tsc", file_types: [".ts"], timeout_ms: 1000, severity: "warning" as const } };
    return { paths, evidence: new ChangeSetEvidence(paths, checks, root) };
}
describe("shared batch execution evidence", () => {
    it("retains completed checks and exact request identities when another tool defers", () => {
        const { paths, evidence } = fixture(); evidence.finish();
        const result = evidence.forFile(paths[0]!, ["typescript"], new Map([[paths[0]!, [{ name: "external_check_deferred", severity: "warning", message: "ruff missing" }]]]));
        expect(result.checks).toEqual(["typescript"]);
        expect(result.unavailable).toHaveLength(1);
        expect(result.scopes[0]).toMatchObject({ check: "typescript", kind: "request-inputs", inputs: paths.map(path => ({ path, identity: expect.stringMatching(/^[a-f0-9]{64}$/) })) });
    });
    it("refuses attribution when another input changed while the shared tool ran", () => {
        const { paths, evidence } = fixture(); writeFileSync(paths[1]!, "changed"); evidence.finish();
        expect(evidence.forFile(paths[0]!, ["typescript"], new Map())).toMatchObject({ checks: [], scopes: [], unavailable: [expect.stringContaining("changed")] });
    });
    it("ignores inapplicable bytes but refuses an over-budget applicable input", () => {
        const { paths } = fixture(), root = join(paths[0]!, "..");
        const checks = { typescript: { enabled: true, command: "tsc", file_types: [".ts"], timeout_ms: 1000, severity: "warning" as const } };
        const evidence = new ChangeSetEvidence([...paths, join(root, "missing-cache.bin")], checks, root);
        evidence.finish();
        expect(evidence.forFile(paths[0]!, ["typescript"], new Map()).checks).toEqual(["typescript"]);
        truncateSync(paths[1]!, 65 * 1024 * 1024);
        const oversized = new ChangeSetEvidence(paths, checks, root);
        expect(oversized.forFile(paths[0]!, ["typescript"], new Map())).toMatchObject({ checks: [], unavailable: [expect.stringContaining("byte budget")] });
    });
});
