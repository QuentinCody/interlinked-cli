import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkIndexStability, indexQuarantined } from "./stability.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("requires three agreeing observations after coverage changes without an input change", () => {
    const root = mkdtempSync(join(tmpdir(), "index-stability-")); roots.push(root);
    const input = { fingerprint: "same-inputs", signature: "new-coverage", priorSignature: "old-coverage" };
    expect(() => checkIndexStability(root, input)).toThrow("quarantined");
    expect(indexQuarantined(root, "same-inputs")).toBe(true);
    expect(() => checkIndexStability(root, input)).toThrow("quarantined");
    checkIndexStability(root, input);
    expect(indexQuarantined(root, "same-inputs")).toBe(false);
    expect(indexQuarantined(root, "changed-inputs")).toBe(false);
});
