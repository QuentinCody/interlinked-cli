import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { digest, saveImmutable, readJson, privateDirectory } from "./store.js";
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
