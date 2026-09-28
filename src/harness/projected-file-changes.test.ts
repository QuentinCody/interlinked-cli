import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectFileChanges } from "./projected-file-changes.js";
import { checkLargeFileLineCountWrite } from "./pre-checks.js";

describe("equivalent proposed file effects", () => {
    let root: string;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), "write-parity-")); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); });
    const patch = (body: string) => ({ command: `*** Begin Patch\n${body}\n*** End Patch` });

    it("advises on an oversized second patch target just like Write", () => {
        const content = Array.from({ length: 601 }, (_, i) => `value_${i} = ${i}`).join("\n");
        expect(checkLargeFileLineCountWrite({ file_path: join(root, "large.py"), content }, root)?.warning).toContain("file-size");
        expect(checkLargeFileLineCountWrite(patch(`*** Add File: small.py\n+x = 1\n*** Add File: large.py\n${content.split("\n").map(line => `+${line}`).join("\n")}`), root)?.warning).toContain("large.py");
    });

    it("normalizes Write, Edit, MultiEdit and patch updates to the same contents", () => {
        writeFileSync(join(root, "code.py"), "a = 1\nb = 2");
        const inputs = [
            { path: "code.py", content: "a = 1\nb = 3" },
            { path: "code.py", old_string: "b = 2", new_string: "b = 3" },
            { path: "code.py", edits: [{ old_string: "b = 2", new_string: "b = 3" }] },
            patch("*** Update File: code.py\n@@\n a = 1\n-b = 2\n+b = 3"),
        ];
        const effects = inputs.map(input => projectFileChanges(input, root));
        expect(effects).toHaveLength(4);
        for (const effect of effects) expect(effect).toEqual(effects[0]);
    });

    it("matches native Add File's terminating newline at the cap boundary", () => {
        const lines = Array.from({ length: 500 }, (_, i) => `v_${i} = ${i}`);
        const content = `${lines.join("\n")}\n`;
        const input = patch(`*** Add File: boundary.py\n${lines.map(line => `+${line}`).join("\n")}`);
        expect(projectFileChanges(input, root)[0]?.after).toBe(content);
        expect(checkLargeFileLineCountWrite(input, root)?.warning).toContain("501 lines");
        expect(checkLargeFileLineCountWrite({ path: "boundary.py", content }, root)?.warning).toContain("501 lines");
    });

    it("preserves source identity for moves and permits shrinking old debt", () => {
        const before = Array.from({ length: 601 }, (_, i) => `x_${i} = 1`).join("\n");
        writeFileSync(join(root, "old.py"), before);
        const input = patch("*** Update File: old.py\n*** Move to: new.py\n@@\n-x_0 = 1\n x_1 = 1");
        expect(projectFileChanges(input, root)[0]).toMatchObject({ sourcePath: join(root, "old.py"), path: join(root, "new.py"), existed: true });
        expect(checkLargeFileLineCountWrite(input, root)).toBeNull();
    });

    it("advises on growth from the unanchored EOF insertion used by the pinned native Codex client", () => {
        const before = Array.from({ length: 501 }, (_, i) => `value_${i} = ${i}\n`).join("");
        writeFileSync(join(root, "oversized.py"), before);
        const input = patch("*** Update File: oversized.py\n@@\n+extra_value = 1");
        expect(projectFileChanges(input, root)[0]?.after).toBe(`${before}extra_value = 1\n`);
        expect(checkLargeFileLineCountWrite(input, root)?.warning).toContain("503 lines");
    });

    it("does not manufacture a baseline for missing or unreadable update targets", () => {
        expect(projectFileChanges(patch("*** Update File: absent.py\n@@\n-x\n+y"), root)).toEqual([]);
        expect(projectFileChanges({ path: root, content: "x" }, root)).toEqual([]);
    });

    it("does not interpret a patch example inside a named Write as file effects", () => {
        const content = "*** Begin Patch\n*** Add File: other.py\n+x\n*** End Patch";
        expect(projectFileChanges({ path: "example.txt", content }, root)[0]?.path).toBe(join(root, "example.txt"));
    });
});
