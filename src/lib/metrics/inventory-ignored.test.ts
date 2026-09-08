import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectRepositoryInventory } from "./inventory.js";

it("measures an explicitly selected ignored directory instead of reporting an empty Git census", () => {
    const root = mkdtempSync(join(tmpdir(), "metrics-ignored-"));
    try {
        execFileSync("git", ["init", "--quiet"], { cwd: root });
        writeFileSync(join(root, ".gitignore"), "ignored/\n");
        const selected = join(root, "ignored"); mkdirSync(selected);
        writeFileSync(join(selected, "index.js"), "export const result = 1;");
        const inventory = collectRepositoryInventory(selected);
        expect(inventory.discovery).toBe("filesystem");
        expect(inventory.files.map(row => row.path)).toEqual(["index.js"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
