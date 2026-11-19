import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { digest, saveImmutable, readJson, privateDirectory } from "./store.js";
vi.mock("node:fs", { spy: true });

it("accepts an identical receipt on a cross-realm EEXIST and propagates other filesystem errors", () => {
    const root = mkdtempSync(join(tmpdir(), "decision-store-retry-"));
    try {
        const path = join(root, "receipt.json");
        saveImmutable(path, { run: 1 });
        const exists = runInNewContext('Object.assign(new Error("exists"), { code: "EEXIST" })');
        expect(exists).not.toBeInstanceOf(Error);
        vi.mocked(writeFileSync).mockImplementationOnce(() => { throw exists; });
        saveImmutable(path, { run: 1 });
        const denied = runInNewContext('Object.assign(new Error("denied"), { code: "EACCES" })');
        vi.mocked(writeFileSync).mockImplementationOnce(() => { throw denied; });
        expect(() => saveImmutable(path, { run: 1 })).toThrow("denied");
        expect(readJson(path)).toEqual({ run: 1 });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
it("retains immutable evidence and refuses conflicting rewrites", () => {
    const root = mkdtempSync(join(tmpdir(), "decision-store-"));
    try {
        privateDirectory(join(root, "runs"));
        const path = join(root, "runs", "one.json");
        saveImmutable(path, { a: 1 });
        expect(readJson(path)).toEqual({ a: 1 });
        expect(() => saveImmutable(path, { a: 2 })).toThrow(/immutable/);
        expect(readFileSync(path, "utf8")).toContain('"a": 1');
        expect(digest("one")).not.toBe(digest("two"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
