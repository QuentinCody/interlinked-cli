import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "./interlinked-root.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "interlinked-root-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function dataDir(dir: string, ...files: string[]): void {
    mkdirSync(join(dir, ".interlinked"), { recursive: true });
    for (const file of files) writeFileSync(join(dir, ".interlinked", file), "");
}

describe("findRepoRoot — positive", () => {
    it("P1: a configured project (config.json, guard-rules.json, harness.pid or a socket) is found from any subfolder", () => {
        for (const marker of ["config.json", "guard-rules.json", "harness.pid", "harness-default.sock"]) {
            const project = join(root, marker);
            dataDir(project, marker);
            mkdirSync(join(project, "a", "b"), { recursive: true });
            expect(findRepoRoot(join(project, "a", "b"))).toBe(project);
        }
    });

    it("P2: a nested folder holding only hook-written files is passed on the way to the configured project", () => {
        dataDir(root, "config.json");
        const stray = join(root, "scratch", "probe");
        dataDir(stray, "payload-keys.json", "hook-transport.jsonl");
        expect(findRepoRoot(stray)).toBe(root);
    });

    it("P3: with nothing configured anywhere, the nearest .interlinked/ is the project (an unconfigured checkout)", () => {
        dataDir(root);
        dataDir(join(root, "inner"));
        expect(findRepoRoot(join(root, "inner"))).toBe(join(root, "inner"));
    });
});

describe("findRepoRoot — negative", () => {
    it("N1: a nested project that holds its own marker is not passed", () => {
        dataDir(root, "config.json");
        dataDir(join(root, "packages", "app"), "guard-rules.json");
        expect(findRepoRoot(join(root, "packages", "app"))).toBe(join(root, "packages", "app"));
    });

    it("N2: no .interlinked/ within twenty hops is null, and an unreadable data dir proves no project", () => {
        expect(findRepoRoot(root)).toBeNull();
        let deep = join(root, "deep");
        dataDir(deep, "config.json");
        for (let i = 0; i < 20; i++) deep = join(deep, `level-${i}`);
        mkdirSync(deep, { recursive: true });
        expect(findRepoRoot(deep)).toBeNull();
        if (typeof process.getuid === "function" && process.getuid() === 0) return; // root reads 000 folders
        const locked = join(root, "locked");
        dataDir(locked);
        chmodSync(join(locked, ".interlinked"), 0o000);
        try { expect(findRepoRoot(locked)).toBe(locked); } finally { chmodSync(join(locked, ".interlinked"), 0o755); }
    });
});
