import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hashBytes } from "./inventory.js";
import { validateRemoval } from "./removal-validation.js";
import type { RemovalPlan } from "./removal-plan.js";

const roots: string[] = [];
const SOURCE = 'export function used() { return 2; }\nfunction unused() { return 3; }\n';
const CHECKER = resolve("node_modules/typescript/bin/tsc");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(start: number, end: number): { root: string; plan: RemovalPlan } {
    const root = mkdtempSync(join(tmpdir(), "metrics-removal-")); roots.push(root);
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "index.js"), SOURCE);
    return { root, plan: { schemaVersion: 1, edits: [{ path: "index.js", sourceSha256: hashBytes(SOURCE), start, end }], checks: [
        { kind: "typecheck", argv: [process.execPath, CHECKER, "--noEmit", "--allowJs", "--checkJs", "--skipLibCheck", "--target", "es2022", "index.js"] },
        { kind: "test", argv: [process.execPath, "--input-type=module", "-e", 'import { used } from "./index.js"; import assert from "node:assert/strict"; assert.equal(used(), 2);'] },
    ] } };
}

it("validates a removal against baseline tests and compiler without editing the repository", async () => {
    const input = fixture(SOURCE.indexOf("function unused"), SOURCE.length);
    const result = await validateRemoval({ ...input, timeoutMs: 20_000 });
    expect(result.verdict).toBe("checks-passed");
    expect(result.before.every(row => row.outcome === "passed")).toBe(true);
    expect(result.after.every(row => row.outcome === "passed")).toBe(true);
    expect(readFileSync(join(input.root, "index.js"), "utf8")).toBe(SOURCE);
}, 25_000);

it("rejects removing behavior that the existing tests observe", async () => {
    const input = fixture(0, SOURCE.indexOf("function unused"));
    const result = await validateRemoval({ ...input, timeoutMs: 20_000 });
    expect(result.verdict).toBe("candidate-failed");
    expect(result.after.some(row => row.kind === "test" && row.outcome === "failed")).toBe(true);
    expect(readFileSync(join(input.root, "index.js"), "utf8")).toBe(SOURCE);
}, 25_000);
