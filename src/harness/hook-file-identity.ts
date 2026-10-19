import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, type Stats } from "node:fs";

const MAX_IDENTITY_BYTES = 64 * 1024 * 1024;

function missing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** ctime is in the key because a writer can restore mtime with utimes but not ctime. */
function statKey(stat: Stats): string {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** sha256 identities for observed files, re-hashed only when the file's stat changes.
 * Reconciliation runs every 2 s and on every hook, over every pending file (F77: 21.5 ms
 * per 1k pending rows when each one was read and hashed again). */
export class FileIdentityCache {
    private readonly entries = new Map<string, { key: string; identity: string }>();
    constructor(private readonly read: (path: string) => Buffer = path => readFileSync(path)) {}

    identityOf(path: string): string {
        try {
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) throw new Error(`unmeasured symbolic link: ${path} -> ${readlinkSync(path)}`);
            if (!stat.isFile() || stat.size > MAX_IDENTITY_BYTES) throw new Error(`unmeasured non-file or oversized policy: ${path}`);
            const key = statKey(stat), cached = this.entries.get(path);
            if (cached?.key === key) return cached.identity;
            // A write between lstat and read leaves an older key, so the next call re-hashes.
            const identity = createHash("sha256").update(this.read(path)).digest("hex");
            this.entries.set(path, { key, identity });
            return identity;
        } catch (error) {
            this.entries.delete(path);
            if (missing(error)) return "missing";
            throw error;
        }
    }

    /** Forget paths outside the current selection so the cache stays bounded by it. */
    retain(paths: Iterable<string>): void {
        const kept = new Set(paths);
        for (const path of this.entries.keys()) if (!kept.has(path)) this.entries.delete(path);
    }
}
