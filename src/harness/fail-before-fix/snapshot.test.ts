import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectCopy, gitVisibleFiles } from "./snapshot.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fbf-snap-"))); roots.push(root);
    execFileSync("git", ["init", "--quiet", root]);
    writeFileSync(join(root, ".gitignore"), "bulk/\nnode_modules\n");
    mkdirSync(join(root, "src")); mkdirSync(join(root, "bulk")); mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "src/a.ts"), "a\n");
    writeFileSync(join(root, "src/b.ts"), "b\n");
    writeFileSync(join(root, "bulk/huge.bin"), "x");
    symlinkSync("a.ts", join(root, "src/link.ts"));
    return root;
}

describe("project copy — positive", () => {
    it("P1: git-visible files are copied, a symlink stays a link, node_modules is linked, overrides replace or remove", () => {
        const root = repo();
        const files = gitVisibleFiles(root);
        expect(files?.sort()).toEqual([".gitignore", "src/a.ts", "src/b.ts", "src/link.ts"]);
        const copy = createProjectCopy(root, files ?? [], new Map([["src/a.ts", "pre-session a\n"], ["src/b.ts", null], ["src/new/c.ts", "c\n"]]));
        try {
            expect(readFileSync(join(copy.dir, "src/a.ts"), "utf8")).toBe("pre-session a\n");
            expect(existsSync(join(copy.dir, "src/b.ts"))).toBe(false);
            expect(readFileSync(join(copy.dir, "src/new/c.ts"), "utf8")).toBe("c\n");
            expect(lstatSync(join(copy.dir, "src/link.ts")).isSymbolicLink()).toBe(true);
            expect(lstatSync(join(copy.dir, "node_modules")).isSymbolicLink()).toBe(true);
            expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("a\n"); // the live tree is only read
        } finally { copy.cleanup(); }
        expect(existsSync(copy.dir)).toBe(false);
    });
});

describe("project copy — negative", () => {
    it("refuses an override through an absolute link to the live tree", () => {
        const root = repo();
        symlinkSync(join(root, "src/a.ts"), join(root, "src/absolute.ts"));
        expect(() => createProjectCopy(root, gitVisibleFiles(root) ?? [], new Map([["src/absolute.ts", "changed"]]))).toThrow(/symlink/);
        expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("a\n");
    });
    it("refuses overrides through a symlink parent or outside the copy", () => {
        const root = repo();
        symlinkSync(join(root, "src"), join(root, "linked"));
        const files = gitVisibleFiles(root) ?? [];
        expect(() => createProjectCopy(root, files, new Map([["linked/a.ts", "changed"]]))).toThrow(/symlink/);
        expect(() => createProjectCopy(root, files, new Map([[join(root, "src/a.ts"), "changed"]]))).toThrow(/escapes/);
        expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("a\n");
    });
    it("N1: ignored bulk is never copied, and a directory outside git has no visible files", () => {
        const root = repo();
        const copy = createProjectCopy(root, gitVisibleFiles(root) ?? [], new Map());
        try { expect(existsSync(join(copy.dir, "bulk"))).toBe(false); } finally { copy.cleanup(); }
        const plain = realpathSync(mkdtempSync(join(tmpdir(), "fbf-plain-"))); roots.push(plain);
        expect(gitVisibleFiles(plain)).toBeNull();
    });
});
