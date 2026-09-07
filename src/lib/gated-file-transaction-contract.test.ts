import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureGatedWriteBaseline, commitGatedWrites, GatedWriteConflictError } from "./gated-file-transaction.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "interlinked-write-contract-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("gated edit snapshot contract", () => {
    it("rejects an edit constructed from content that is no longer current", () => {
        const target = join(root, "value.txt");
        writeFileSync(target, "other writer");
        expect(() => captureGatedWriteBaseline(root, [{ path: target, content: "ours", expectedContent: "old" }])).toThrow(GatedWriteConflictError);
        expect(readFileSync(target, "utf-8")).toBe("other writer");
    });

    it("includes unchanged batch members in the final conflict check", () => {
        writeFileSync(join(root, "changed.txt"), "old");
        writeFileSync(join(root, "context.txt"), "context");
        const transaction = captureGatedWriteBaseline(root, [
            { path: "changed.txt", content: "new", expectedContent: "old" },
            { path: "context.txt", content: "context", expectedContent: "context" },
        ]);
        writeFileSync(join(root, "context.txt"), "new context");
        expect(() => commitGatedWrites(transaction)).toThrow(GatedWriteConflictError);
        expect(readFileSync(join(root, "changed.txt"), "utf-8")).toBe("old");
    });

    it("preserves executable modes and leaves unchanged inodes alone", () => {
        const executable = join(root, "script.sh");
        const context = join(root, "context.txt");
        writeFileSync(executable, "old");
        chmodSync(executable, 0o751);
        writeFileSync(context, "unchanged");
        const prior = statSync(context);
        commitGatedWrites(captureGatedWriteBaseline(root, [
            { path: executable, content: "new" }, { path: context, content: "unchanged" },
        ]));
        expect(readFileSync(executable, "utf-8")).toBe("new");
        expect(statSync(executable).mode & 0o777).toBe(0o751);
        expect(statSync(context).ino).toBe(prior.ino);
        expect(statSync(context).mtimeMs).toBe(prior.mtimeMs);
    });
});
