import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkFileDumpCold, measureFileDumpWindow } from "../../../lib/hook-template-chunks/file-dump-cold-guard.js";
import { GUARDS_INLINE_CHUNK } from "../../../lib/hook-template-chunks/guards-inline.js";
import { evaluateFileDumpGuard } from "../file-dump-guard.js";

type InlineGuard = (event: string, tool: string, input: { command: string }) => { decision: string } | null;
// SAFETY: the generated chunk declares inlineGuardCheck; all three guard paths
// are exercised against the same real-file output-budget cases below.
const inlineGuard: InlineGuard = new Function("fs", `
    const { existsSync, statSync, readFileSync, openSync, readSync, closeSync } = fs;
    ${GUARDS_INLINE_CHUNK}
    return inlineGuardCheck;
`)(fs);

let root: string;
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), "file-dump-window-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const guards = [
    { name: "daemon", blocks: (command: string) => evaluateFileDumpGuard({ command, cwd: root }).kind === "block" },
    { name: "cold", blocks: (command: string) => checkFileDumpCold("Bash", { command }, root, { ...fs, join })?.decision === "block" },
    { name: "generated", blocks: (command: string) => inlineGuard("PreToolUse", "Bash", { command })?.decision === "block" },
];

describe.each(guards)("$name bounded log reads", ({ blocks }) => {
    it.each(["tail -5", "tail -n 5", "tail -n5", "tail --lines=5", "tail", "head -5", "head -n 5", "head"])(
        "allows %s when its selected lines fit the byte budget", (command) => {
            const path = join(root, "large.log");
            fs.writeFileSync(path, "short log line\n".repeat(20000));
            expect(blocks(`${command} ${path}`)).toBe(false);
        },
    );

    it.each(["head", "tail"])("keeps %s blocked when a selected line exceeds the byte budget", (verb) => {
        const path = join(root, "long-line.log");
        fs.writeFileSync(path, `${"x".repeat(150 * 1024)}\n`);
        expect(blocks(`${verb} -n 1 ${path}`)).toBe(true);
    });

    it.each(["tail -n +5", "head -n -5", "tail -n 201", "cat"])("retains the size gate for %s", (command) => {
        const path = join(root, "large.log");
        fs.writeFileSync(path, "line\n".repeat(30000));
        expect(blocks(`${command} ${path}`)).toBe(true);
    });

    it("counts an unterminated final line in the tail window", () => {
        const path = join(root, "final-line.log");
        fs.writeFileSync(path, `${"x".repeat(150 * 1024)}\nsmall\nlast`);
        expect(blocks(`tail -n 2 ${path}`)).toBe(false);
        expect(blocks(`tail -n 3 ${path}`)).toBe(true);
    });

    it.each([102400, 102401])("enforces the byte boundary for a %i-byte tail line", (bytes) => {
        const path = join(root, "boundary.log");
        fs.writeFileSync(path, `prefix\n${"x".repeat(bytes - 1)}\n`);
        expect(blocks(`tail -n 1 ${path}`)).toBe(bytes > 102400);
    });
});

describe("bounded window I/O", () => {
    it("keeps the original size when a short read cannot measure the output", () => {
        const path = join(root, "changing.log");
        fs.writeFileSync(path, "short\n");
        expect(measureFileDumpWindow({ path, size: 200000, verb: "head", lines: 1, maxBytes: 102400 }, fs)).toBe(200000);
    });

    it("keeps the original size when the host cannot perform bounded reads", () => {
        expect(measureFileDumpWindow({ path: "unavailable.log", size: 200000, verb: "tail", lines: 5, maxBytes: 102400 }, {})).toBe(200000);
    });
});
