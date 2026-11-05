// Mutation-kill tests for fail-before-fix/snapshot.ts — 2026-11-05 dogfood campaign
// (docs/reviews/kill-proof-dogfood.md): link rewriting into the copy, dangling links,
// and override removal.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectCopy, gitVisibleFiles } from "./snapshot.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function repo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "snapshot-mk-")));
    dirs.push(root);
    execFileSync("git", ["-C", root, "init", "-q"]);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/real.ts"), "export const real = 1;\n");
    return root;
}
function copyOf(root: string, overrides = new Map<string, string | null>()): string {
    execFileSync("git", ["-C", root, "add", "."]);
    const files = gitVisibleFiles(root);
    if (files === null) throw new Error("not a git work tree");
    const copy = createProjectCopy(root, files, overrides);
    dirs.push(copy.dir);
    return copy.dir;
}

describe("createProjectCopy — links", () => {
    // test-contract: invariant - an absolute in-repo link is rewritten to the COPY's twin, never left pointing at the live tree (kill-proof review N1/N2)
    it("an absolute in-repo symlink resolves inside the copy", () => {
        const root = repo();
        symlinkSync(join(root, "src/real.ts"), join(root, "src/link.ts"));
        const dir = copyOf(root);
        expect(lstatSync(join(dir, "src/link.ts")).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(dir, "src/link.ts"))).toBe("real.ts");
        expect(realpathSync(join(dir, "src/link.ts"))).toBe(join(dir, "src/real.ts"));
    });
    // test-contract: public-api - a tracked dangling symlink is still copied as a link (git sees it; its absence would change what the copy resolves)
    it("a dangling tracked symlink is copied as a link", () => {
        const root = repo();
        symlinkSync("missing.ts", join(root, "src/dangling.ts"));
        const dir = copyOf(root);
        expect(lstatSync(join(dir, "src/dangling.ts")).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(dir, "src/dangling.ts"))).toBe("missing.ts");
    });
});

describe("createProjectCopy — overrides", () => {
    // test-contract: public-api - a null override removes the file from the copy without throwing
    it("a null override removes the file and the copy is still created", () => {
        const root = repo();
        let dir = "";
        expect(() => { dir = copyOf(root, new Map([["src/real.ts", null]])); }).not.toThrow();
        expect(existsSync(join(dir, "src/real.ts"))).toBe(false);
    });
});
