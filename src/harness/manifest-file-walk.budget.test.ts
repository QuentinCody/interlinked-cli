import { describe, expect, it, vi } from "vitest";
const tree = vi.hoisted(() => new Map<string, { name: string; isDirectory(): boolean; isFile(): boolean }[]>());
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
    readdirSync: (path: string) => tree.get(path) ?? [] }));
import { findManifestFiles } from "./manifest-file-walk.js";
const file = (name: string) => ({ name, isDirectory: () => false, isFile: () => true });
const dir = (name: string) => ({ name, isDirectory: () => true, isFile: () => false });

describe("manifest traversal budgets", () => {
    // test-contract: boundary — exhausting the shared budget inside a subtree must stop its parent before scanning siblings.
    it("stops ancestor traversal after a nested directory exhausts the budget", () => {
        tree.clear(); tree.set("/nested", [dir("a"), file("z.ts")]);
        tree.set("/nested/a", [file("first.ts"), file("second.ts")]);
        const onLimit = vi.fn(), match = vi.fn(() => true);
        expect(findManifestFiles("/nested", match, { maxEntries: 2, onLimit })).toEqual(["a/first.ts"]);
        expect(match.mock.calls).toEqual([["first.ts"]]);
        expect(onLimit).toHaveBeenCalledTimes(1);
    });

    it("MUST-NOT-FAIL when one subtree exceeds the JS argument limit", () => {
        tree.clear(); tree.set("/wide", [dir("src")]);
        tree.set("/wide/src", Array.from({ length: 150_000 }, (_, i) => file(`${i}.ts`)));
        expect(findManifestFiles("/wide", () => true)).toHaveLength(150_000);
    });
    it("excludes only requested root dirs and reports a shared entry budget once", () => {
        tree.clear(); tree.set("/repo", [dir("scratch"), dir("src")]);
        tree.set("/repo/scratch", [file("copy.ts")]);
        tree.set("/repo/src", [file("a.ts"), file("b.ts")]);
        const onLimit = vi.fn();
        expect(findManifestFiles("/repo", () => true, { skipRootDirs: ["scratch"], maxEntries: 3, onLimit })).toEqual(["src/a.ts"]);
        expect(onLimit).toHaveBeenCalledTimes(1);
        expect(findManifestFiles("/repo", () => true, { skipRootDirs: ["scratch"] })).toEqual(["src/a.ts", "src/b.ts"]);
    });
});
