import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ target: "" }));
vi.mock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
        ...actual,
        renameSync: (from: string, to: string) => {
            if (to === fault.target && from.includes(".interlinked-tx-")) throw new Error("simulated rename failure");
            actual.renameSync(from, to);
        },
    };
});
vi.mock("../../harness/content-gate.js", async () => {
    const actual = await vi.importActual<typeof import("../../harness/content-gate.js")>("../../harness/content-gate.js");
    return { ...actual, gateProposedContent: vi.fn() };
});

import { gateProposedContent } from "../../harness/content-gate.js";
import { runMultiEdit } from "../multi-edit.js";
import { writeCommand } from "../write.js";

type Command = "write" | "multi-edit";
class CommandExit extends Error {}
let root: string;
let target: string;
const gate = vi.mocked(gateProposedContent);
const pass = { ok: true, failures: [], elapsedMs: 1 };

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "interlinked-command-transaction-")));
    target = join(root, "a.txt");
    writeFileSync(target, "old");
    fault.target = "";
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(process, "exit").mockImplementation(() => { throw new CommandExit(); });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    gate.mockReset().mockReturnValue(pass);
});
afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
});

async function execute(command: Command, paths = [target]): Promise<boolean> {
    if (command === "multi-edit") {
        return runMultiEdit(paths.map((path) => ({ path, edits: [{ old_string: "old", new_string: "ours" }] })), { projectRoot: root }).ok;
    }
    const manifest = join(root, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, writes: paths.map((path) => ({ path, content: "ours" })) }));
    try {
        await writeCommand(undefined, { batch: manifest, json: true });
        return true;
    } catch (error) {
        if (error instanceof CommandExit) return false;
        throw error;
    }
}

describe.each<Command>(["write", "multi-edit"])("%s transaction integration", (command) => {
    it("aborts when another writer changes a target during verification", async () => {
        gate.mockImplementation(() => { writeFileSync(target, "concurrent edit"); return pass; });
        expect(await execute(command)).toBe(false);
        expect(readFileSync(target, "utf-8")).toBe("concurrent edit");
    });

    it("preserves the target's executable permission bits", async () => {
        chmodSync(target, 0o751);
        expect(await execute(command)).toBe(true);
        expect(readFileSync(target, "utf-8")).toBe("ours");
        expect(statSync(target).mode & 0o777).toBe(0o751);
    });

    it("rejects duplicate physical targets before invoking the gate", async () => {
        expect(await execute(command, [target, join(root, "sub", "..", "a.txt")])).toBe(false);
        expect(gate).not.toHaveBeenCalled();
        expect(readFileSync(target, "utf-8")).toBe("old");
    });

    it("rejects replacing the project directory with file content", async () => {
        expect(await execute(command, [root])).toBe(false);
        expect(gate).not.toHaveBeenCalled();
        expect(statSync(root).isDirectory()).toBe(true);
        expect(readFileSync(target, "utf-8")).toBe("old");
    });

    it("rejects a parent symlink escaping the project root", async () => {
        const project = join(root, "project");
        mkdirSync(project);
        symlinkSync(root, join(project, "escape"), "dir");
        vi.mocked(process.cwd).mockReturnValue(project);
        const outerRoot = root;
        root = project;
        try {
            expect(await execute(command, [join(project, "escape", "a.txt")])).toBe(false);
        } finally {
            root = outerRoot;
        }
        expect(gate).not.toHaveBeenCalled();
        expect(readFileSync(target, "utf-8")).toBe("old");
    });

    it("rejects a parent redirected outside the project during verification", async () => {
        const parent = join(root, "nested");
        const originalParent = join(root, "original-nested");
        const outside = mkdtempSync(join(tmpdir(), "interlinked-transaction-outside-"));
        mkdirSync(parent);
        target = join(parent, "a.txt");
        writeFileSync(target, "old");
        writeFileSync(join(outside, "a.txt"), "old");
        gate.mockImplementation(() => {
            renameSync(parent, originalParent);
            symlinkSync(outside, parent, "dir");
            return pass;
        });
        try {
            expect(await execute(command)).toBe(false);
            expect(readFileSync(join(outside, "a.txt"), "utf-8")).toBe("old");
            expect(readFileSync(join(originalParent, "a.txt"), "utf-8")).toBe("old");
            expect(readdirSync(outside)).toEqual(["a.txt"]);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it("restores the first file when a later rename fails", async () => {
        const second = join(root, "b.txt");
        writeFileSync(second, "old");
        fault.target = second;
        expect(await execute(command, [target, second])).toBe(false);
        expect(readFileSync(target, "utf-8")).toBe("old");
        expect(readFileSync(second, "utf-8")).toBe("old");
    });

    it("leaves the entire batch untouched when Biome cannot return a verdict", async () => {
        gate.mockReturnValue({ ok: false, elapsedMs: 1, failures: [{ path: target, tool: "biome", code: "biome-overlay-unavailable", severity: "error", line: 0, message: "NOT CHECKED" }] });
        expect(await execute(command)).toBe(false);
        expect(readFileSync(target, "utf-8")).toBe("old");
    });
});

it("reports the later target that failed after restoring earlier writes", () => {
    const second = join(root, "b.txt");
    writeFileSync(second, "old");
    fault.target = second;
    const result = runMultiEdit([target, second].map((path) => ({
        path,
        edits: [{ old_string: "old", new_string: "ours" }],
    })), { projectRoot: root });
    expect(result.ok).toBe(false);
    expect(result.error_detail?.path).toBe(second);
    expect(readFileSync(target, "utf-8")).toBe("old");
    expect(readFileSync(second, "utf-8")).toBe("old");
});
