import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedPushSnapshot, digest, removeManagedPushSnapshot } from "./managed-push-snapshot.js";

vi.mock("node:fs", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-snapshot-test-"))); roots.push(root);
    mkdirSync(join(root, "scripts/git-hooks"), { recursive: true });
    writeFileSync(join(root, "scripts/git-hooks/pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const manifest = { files: { "scripts/git-hooks/pre-push": digest(readFileSync(join(root, "scripts/git-hooks/pre-push"))) }, packages: [] };
    return { root, manifest };
}

describe("immutable managed push runtime", () => {
    it("retains frozen bytes when the original hook changes and removes only its snapshot", () => {
        const { root, manifest } = fixture();
        const snapshot = createManagedPushSnapshot(root, manifest);
        writeFileSync(join(root, "scripts/git-hooks/pre-push"), "#!/bin/sh\nexit 1\n");
        expect(readFileSync(join(snapshot.root, "scripts/git-hooks/pre-push"), "utf8")).toBe("#!/bin/sh\nexit 0\n");
        expect(snapshot.bytes).toBeGreaterThan(0);
        removeManagedPushSnapshot(snapshot.root);
        expect(existsSync(snapshot.root)).toBe(false);
        expect(existsSync(join(root, "scripts/git-hooks/pre-push"))).toBe(true);
    });
    it("refuses modified source and symlink substitutions before making a handoff", () => {
        const { root, manifest } = fixture();
        writeFileSync(join(root, "scripts/git-hooks/pre-push"), "modified");
        expect(() => createManagedPushSnapshot(root, manifest)).toThrow(/changed/);
        rmSync(join(root, "scripts/git-hooks/pre-push"));
        const outside = join(root, "outside"); writeFileSync(outside, "#!/bin/sh\nexit 0\n");
        symlinkSync(outside, join(root, "scripts/git-hooks/pre-push"));
        expect(() => createManagedPushSnapshot(root, manifest)).toThrow(/regular/);
    });
    it("rejects unbounded or escaping manifests", () => {
        const { root } = fixture();
        expect(() => createManagedPushSnapshot(root, { files: { "../outside": "bad" }, packages: [] })).toThrow(/path/);
        chmodSync(root, 0o777);
        expect(() => createManagedPushSnapshot(root, { files: {}, packages: [] })).toThrow(/writable/);
        chmodSync(root, 0o700);
    });

    it("rejects a source generation that changes an earlier file while a later file is copied", () => {
        const { root, manifest } = fixture();
        const helper = join(root, "scripts/helper.ts");
        writeFileSync(helper, "export const value = 1;\n");
        const trust = { files: { ...manifest.files, "scripts/helper.ts": digest(readFileSync(helper)) }, packages: [] };
        const read = vi.mocked(readFileSync);
        const originalRead = read.getMockImplementation();
        if (!originalRead) throw new Error("Missing real filesystem read implementation");
        let changed = false;
        read.mockImplementation((...args) => {
            const bytes = originalRead(...args);
            if (args[0] === helper) {
                writeFileSync(join(root, "scripts/git-hooks/pre-push"), "#!/bin/sh\nexit 9\n");
                changed = true;
            }
            return bytes;
        });
        try {
            expect(() => createManagedPushSnapshot(root, trust)).toThrow(/generation changed/);
            expect(changed).toBe(true);
        }
        finally { read.mockImplementation(originalRead); }
    });
});
