import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MANAGED_PUSH_TRUST } from "./managed-push-manifest.js";

describe("managed runtime trust inventory", () => {
    it("binds both the managed hook and its helper entry points", () => {
        for (const path of ["scripts/git-hooks/pre-push", "scripts/run-resource-bounded.ts", "scripts/pre-push-coverage.mjs", "package.json", "package-lock.json"]) expect(MANAGED_PUSH_TRUST.files[path]).toMatch(/^[a-f0-9]{64}$/);
        expect(MANAGED_PUSH_TRUST.packages).toEqual(["tsx", "typescript"]);
    });
    it("generates the transitive static runtime closure and refuses computed dependencies", () => {
        const root = mkdtempSync(join(tmpdir(), "managed-trust-test-"));
        const generator = resolve("scripts/generate-managed-push-manifest.mjs");
        try {
            mkdirSync(join(root, "scripts/git-hooks"), { recursive: true });
            for (const path of ["package.json", "package-lock.json"]) writeFileSync(join(root, path), "{}\n");
            writeFileSync(join(root, "scripts/git-hooks/pre-push"), "#!/bin/sh\nexit 0\n");
            writeFileSync(join(root, "scripts/run-resource-bounded.ts"), 'import "./nested.js";\n');
            writeFileSync(join(root, "scripts/nested.ts"), 'export const x = 1;\n');
            writeFileSync(join(root, "scripts/pre-push-coverage.mjs"), 'import "node:fs";\n');
            const output = join(root, "trust.ts");
            expect(spawnSync(process.execPath, [generator, "--root", root, "--output", output]).status).toBe(0);
            expect(readFileSync(output, "utf8")).toContain('"scripts/nested.ts"');
            writeFileSync(join(root, "scripts/nested.ts"), "import(variable);\n");
            const bad = spawnSync(process.execPath, [generator, "--root", root, "--output", output], { encoding: "utf8" });
            expect(bad.status).not.toBe(0);
            expect(bad.stderr).toContain("Computed runtime dependency");
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
