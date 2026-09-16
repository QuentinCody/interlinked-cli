import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { contractFeedback } from "./feedback.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("uses observed paths independent of edit provider and deduplicates unchanged feedback", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "contract-feedback-"))); roots.push(root);
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "test_app.py"), "assert actual == 3\n");
    const acknowledged = new Set<string>();
    const first = contractFeedback(root, ["test_app.py"], acknowledged);
    expect(first.join("\n")).toContain("implementation");
    expect(contractFeedback(root, ["test_app.py"], acknowledged)).toEqual([]);
    writeFileSync(join(root, "test_app.py"), "assert actual == 4\n");
    expect(contractFeedback(root, [join(root, "test_app.py")], acknowledged).length).toBeGreaterThan(0);
});
