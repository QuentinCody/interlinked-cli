import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoRelative, repositoryIdentity } from "./manual-debt-markers-repository-identity.js";

let root = "";

function write(rel: string, content: string): void {
    const absolute = join(root, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "manual-debt-markers-repo-identity-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("repoRelative", () => {
    it("returns a forward-slash relative path inside the project root", () => {
        const absolute = join(root, "src", "a.ts");
        expect(repoRelative(root, absolute)).toBe("src/a.ts");
    });

    it("returns null for a path outside the project root", () => {
        const outside = join(root, "..", "elsewhere.ts");
        expect(repoRelative(root, outside)).toBeNull();
    });

    it("returns '.' for the project root itself", () => {
        expect(repoRelative(root, root)).toBe(".");
    });
});

describe("repositoryIdentity", () => {
    it("returns null head/tree sha outside a git repository, plus a stable working-tree hash", () => {
        write("a.ts", "content-a");
        const absolute = join(root, "a.ts");
        const first = repositoryIdentity(root, [absolute]);
        expect(first.root).toBe(root);
        expect(first.head_sha).toBeNull();
        expect(first.tree_sha).toBeNull();
        expect(first.working_tree_sha256).toMatch(/^[0-9a-f]{64}$/);
        const second = repositoryIdentity(root, [absolute]);
        expect(second.working_tree_sha256).toBe(first.working_tree_sha256);
    });

    it("changes the working-tree hash when file content changes", () => {
        write("a.ts", "content-a");
        const absolute = join(root, "a.ts");
        const before = repositoryIdentity(root, [absolute]);
        write("a.ts", "content-a-changed");
        const after = repositoryIdentity(root, [absolute]);
        expect(after.working_tree_sha256).not.toBe(before.working_tree_sha256);
    });

    it("resolves head/tree sha inside a real git repository", () => {
        execFileSync("git", ["init", "-q"], { cwd: root });
        execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
        write("a.ts", "content-a");
        execFileSync("git", ["add", "."], { cwd: root });
        execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
        const identity = repositoryIdentity(root, [join(root, "a.ts")]);
        expect(identity.head_sha).toMatch(/^[0-9a-f]{40}$/);
        expect(identity.tree_sha).toMatch(/^[0-9a-f]{40}$/);
    });
});
