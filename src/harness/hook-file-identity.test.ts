import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileIdentityCache } from "./hook-file-identity.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "hook-file-identity-"));
    roots.push(root);
    const reads: string[] = [];
    const cache = new FileIdentityCache(path => { reads.push(path); return readFileSync(path); });
    return { root, reads, cache };
}

describe("file identity cache — positive (must fire)", () => {
    it("P1: a same-size rewrite with its mtime restored still re-hashes (utimes moves ctime)", () => {
        const { root, reads, cache } = fixture(), path = join(root, "policy.json");
        writeFileSync(path, "aaaa");
        // Start from an exactly representable filesystem timestamp, not the
        // fractional milliseconds lost by Stats.mtime's Date conversion.
        const timestamp = new Date("2020-01-01T00:00:00.000Z");
        utimesSync(path, timestamp, timestamp);
        const first = cache.identityOf(path);
        const before = statSync(path);
        writeFileSync(path, "bbbb");
        utimesSync(path, timestamp, timestamp);
        expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
        expect(cache.identityOf(path)).not.toBe(first);
        expect(reads).toHaveLength(2);
    });

    it("P2: reports deletion as missing and refuses a symbolic link", () => {
        const { root, cache } = fixture(), path = join(root, "policy.json"), link = join(root, "link.json");
        writeFileSync(path, "{}");
        cache.identityOf(path);
        rmSync(path);
        expect(cache.identityOf(path)).toBe("missing");
        writeFileSync(path, "{}");
        symlinkSync(path, link);
        expect(() => cache.identityOf(link)).toThrow("unmeasured symbolic link");
    });
});

describe("file identity cache — negative (must not fire)", () => {
    it("N1: an unchanged file is not read again", () => {
        const { root, reads, cache } = fixture(), path = join(root, "pending.ts");
        writeFileSync(path, "export const value = 1;\n");
        const identity = cache.identityOf(path);
        expect(cache.identityOf(path)).toBe(identity);
        expect(reads).toEqual([path]);
    });

    it("N2: a path dropped from the selection is forgotten, so it is hashed again when selected", () => {
        const { root, reads, cache } = fixture(), path = join(root, "pending.ts");
        writeFileSync(path, "x");
        cache.identityOf(path);
        cache.retain([]);
        cache.identityOf(path);
        expect(reads).toEqual([path, path]);
    });
});
