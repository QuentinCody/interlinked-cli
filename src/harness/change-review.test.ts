import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { reviewChange } from "./change-review.js";

const roots: string[] = [];
function project() { const root = mkdtempSync(join(tmpdir(), "change-review-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

it("reviews a complete small change without representing test filenames as passing evidence", () => {
    const root = project();
    writeFileSync(join(root, "app.py"), "def visit(items):\n    for item in items:\n        print(item)\n        continue\n");
    writeFileSync(join(root, "test_app.py"), "def test_old_contract():\n    assert False\n");
    const result = reviewChange(root, { paths: ["app.py", "test_app.py"] });
    expect(result.status).toBe("partial");
    expect(result.gaps).toEqual([expect.objectContaining({ reason: expect.stringContaining("baseline/diff unavailable") })]);
    expect(result.files.map(file => file.role)).toEqual(["source", "test"]);
    expect(result.behavioralEvidence).toBe("not-run");
    expect(result.findings).toEqual([expect.objectContaining({ path: "app.py", line: 4 })]);
    expect(result.review.join(" ")).toContain("previous behavior, new requirements");
});

it("reports deleted files, unsafe paths and exhausted budgets as gaps", () => {
    const root = project(), outside = project();
    writeFileSync(join(outside, "outside.py"), "pass\n");
    symlinkSync(join(outside, "outside.py"), join(root, "link.py"));
    writeFileSync(join(root, "large.py"), "#".repeat(256 * 1024 + 1));
    const result = reviewChange(root, { paths: ["deleted.py", "link.py", "large.py", join(outside, "outside.py")] });
    expect(result.status).toBe("partial");
    expect(result.gaps).toHaveLength(4);
    expect(result.files).toHaveLength(0);
});

it("discovers staged, unstaged and new changes while excluding installer output", () => {
    const root = project();
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "app.py"), "pass\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "baseline"], { cwd: root });
    writeFileSync(join(root, "app.py"), "value = 1\n");
    writeFileSync(join(root, "test_app.py"), "def test_value():\n    assert True\n");
    execFileSync("git", ["add", "test_app.py"], { cwd: root });
    mkdirSync(join(root, ".venv"));
    writeFileSync(join(root, ".venv/pyvenv.cfg"), "home = /usr/bin");
    writeFileSync(join(root, ".venv/dependency.py"), "pass\n");
    const result = reviewChange(root);
    expect(result.files.map(file => file.path)).toEqual(["app.py", "test_app.py"]);
    expect(result.excluded).toEqual([{ path: ".venv/dependency.py", reason: "python-environment" }]);
    expect(reviewChange(root, { base: "missing-revision" }).status).toBe("partial");
});
