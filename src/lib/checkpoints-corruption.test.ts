import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./git-shell.js", () => ({ gitShell: vi.fn(() => "fixture-repository") }));
import { archiveCheckpoints, createCheckpoint, listCheckpoints, pruneCheckpoints, type Checkpoint } from "./checkpoints.js";
import { gitShell } from "./git-shell.js";

const roots: string[] = [];
beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gitShell).mockImplementation(() => "fixture-repository");
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(content: string) {
    const root = mkdtempSync(join(tmpdir(), "checkpoint-corruption-"));
    roots.push(root);
    mkdirSync(join(root, ".interlinked"));
    const path = join(root, ".interlinked", "checkpoints.json");
    writeFileSync(path, content);
    return { root, path };
}

const retained: Checkpoint = {
    id: "retained", session_id: "session", agent: "worker", message: "Original snapshot",
    timestamp: "2026-09-08T00:00:00Z", base_commit: "abc", trigger: "manual", files_changed: ["app.ts"], restorable: false,
};

describe("checkpoint metadata preservation", () => {
    it.each([
        JSON.stringify([retained, { ...retained, id: "damaged", files_changed: null }]),
        "{incomplete JSON",
    ])("refuses metadata mutations without overwriting damaged history: %s", content => {
        const { root, path } = fixture(content);
        expect(() => pruneCheckpoints({ cwd: root, keep_latest: 100 })).toThrow(path);
        expect(() => archiveCheckpoints({ cwd: root })).toThrow(path);
        expect(() => createCheckpoint({ cwd: root, sessionId: "session", agent: "worker", message: "Next", trigger: "manual" })).toThrow(path);
        expect(readFileSync(path, "utf8")).toBe(content);
        // Repository detection may run, but no stash, checkout or other git
        // operation may precede validation of the existing history.
        expect(vi.mocked(gitShell).mock.calls.map(call => call[0])).toEqual(["rev-parse --git-dir"]);
    });

    it("distinguishes missing history from an existing unreadable path", () => {
        const { root, path } = fixture("[]");
        rmSync(path);
        expect(listCheckpoints({ cwd: root })).toEqual([]);
        mkdirSync(path);
        expect(() => listCheckpoints({ cwd: root })).toThrow(path);
    });

    it("continues to read and prune well-formed history", () => {
        const { root } = fixture(JSON.stringify([retained, { ...retained, id: "newer", timestamp: "2026-09-09T00:00:00Z" }]));
        expect(pruneCheckpoints({ cwd: root, keep_latest: 1 })).toBe(1);
        expect(listCheckpoints({ cwd: root }).map(checkpoint => checkpoint.id)).toEqual(["newer"]);
    });

    it("retains a checkpoint appended while the git snapshot is being captured", () => {
        const { root, path } = fixture(JSON.stringify([retained]));
        const concurrent = { ...retained, id: "concurrent" };
        vi.mocked(gitShell).mockImplementation(command => {
            if (command.startsWith("stash push")) writeFileSync(path, JSON.stringify([retained, concurrent]));
            return "fixture-repository";
        });
        const created = createCheckpoint({ cwd: root, sessionId: "session", agent: "worker", message: "Next", trigger: "manual" });
        expect(new Set(listCheckpoints({ cwd: root }).map(checkpoint => checkpoint.id))).toEqual(new Set([retained.id, concurrent.id, created.id]));
    });
});
