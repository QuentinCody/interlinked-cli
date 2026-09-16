import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sourceScanScope } from "./source-scan-scope.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
it("excludes verified untracked environment output while retaining explicit, tracked and policy edits", () => {
    const root = mkdtempSync(join(tmpdir(), "source-scope-")); roots.push(root);
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, ".venv/lib/site-packages"), { recursive: true });
    writeFileSync(join(root, ".venv/pyvenv.cfg"), "home = /usr/bin\n");
    const dependency = ".venv/lib/site-packages/dependency.py";
    writeFileSync(join(root, dependency), "pass\n");
    expect(sourceScanScope(root).reason(dependency)).toBe("python-environment");
    expect(sourceScanScope(root, [dependency]).reason(dependency)).toBeNull();
    execFileSync("git", ["add", dependency], { cwd: root });
    expect(sourceScanScope(root).reason(dependency)).toBeNull();
    expect(sourceScanScope(root).reason(".interlinked/guard-rules.json")).toBeNull();
    mkdirSync(join(root, ".interlinked"));
    writeFileSync(join(root, ".interlinked/payload-keys.json"), "{}");
    expect(sourceScanScope(root).reason(".interlinked/payload-keys.json")).toBe("harness-output");
    expect(sourceScanScope(root).reason("src/cache/feature.py")).toBeNull();
});

it("does not trust a directory name or an unavailable Git inventory", () => {
    const root = mkdtempSync(join(tmpdir(), "source-scope-")); roots.push(root);
    mkdirSync(join(root, ".venv"));
    expect(sourceScanScope(root).reason(".venv/application.py")).toBeNull();
});
