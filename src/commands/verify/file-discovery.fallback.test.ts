import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execSync: () => { throw new Error("Git unavailable"); } }));
import { discoverFiles } from "./file-discovery.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("filesystem discovery without Git", () => {
    it("MUST-FIRE: reaches production sources and excludes disposable root scratch copies", () => {
        const root = mkdtempSync(join(tmpdir(), "discovery-")); roots.push(root);
        mkdirSync(join(root, "scratch", "copy", "src"), { recursive: true });
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "scratch", "copy", "src", "duplicate.ts"), "export const duplicate = 1;");
        writeFileSync(join(root, "src", "real.ts"), "export const real = 1;");
        expect(discoverFiles(root)).toEqual([join(root, "src", "real.ts")]);
    });
    it("MUST-NOT-FIRE: does not exclude a real nested src/scratch package", () => {
        const root = mkdtempSync(join(tmpdir(), "discovery-")); roots.push(root);
        mkdirSync(join(root, "src", "scratch"), { recursive: true });
        const file = join(root, "src", "scratch", "real.ts"); writeFileSync(file, "export const real = 1;");
        expect(discoverFiles(root)).toContain(file);
    });
});
