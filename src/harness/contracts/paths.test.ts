import { mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contractDigest, contractPath, readContractFile } from "./paths.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("contract file boundary", () => {
    it("reads bounded literal files and hashes their exact bytes", () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "contract-path-"))); roots.push(root);
        writeFileSync(join(root, "spec.md"), "hello\n");
        expect(readContractFile(root, "spec.md")).toBe("hello\n");
        expect(contractDigest("hello\n")).not.toBe(contractDigest("hello"));
        expect(() => readContractFile(root, "spec.md", 2)).toThrow(/budget/);
    });
    it("rejects traversal, absolute paths and symlink inputs", () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "contract-path-"))); roots.push(root);
        writeFileSync(join(root, "real"), "a"); symlinkSync(join(root, "real"), join(root, "alias"));
        expect(() => readContractFile(root, "alias")).toThrow(/symlink/);
        for (const path of ["../outside", "/tmp/outside", "a/../../out", ""]) expect(() => contractPath(root, path)).toThrow();
    });
});
