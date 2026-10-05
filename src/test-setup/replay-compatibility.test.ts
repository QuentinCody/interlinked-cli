import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { replayBinding, canReplay } from "./replay-compatibility.js";
it("rejects missing identity and changed test, generator, engine or runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "replay-binding-"));
    try {
        writeFileSync(join(root, "a.test.ts"), "generator one");
        const first = replayBinding(root, "a.test.ts::case", "generator-v1");
        expect(canReplay(first, first)).toBe(true);
        expect(canReplay(undefined, first)).toBe(false);
        for (const field of ["engine", "runtime", "test", "generator", "dependencies"] as const) {
            expect(canReplay({ ...first, [field]: "changed" }, first)).toBe(false);
        }
        writeFileSync(join(root, "a.test.ts"), "generator two");
        expect(canReplay(first, replayBinding(root, "a.test.ts::case", "generator-v1"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
