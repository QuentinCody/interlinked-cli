import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadChurn } from "./metrics-complexity.js";

let root: string;
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

function git(...args: string[]): void {
    execFileSync("git", ["-C", root, ...args], {
        env: { ...gitEnv, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        stdio: "pipe",
    });
}

function commit(): void {
    git("add", "-A");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture change");
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "interlinked-churn-"));
    git("init", "-q");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadChurn", () => {
    it("sums added and deleted lines and counts commits separately for each file", () => {
        writeFileSync(join(root, "a.ts"), "one\ntwo\n");
        commit();
        writeFileSync(join(root, "a.ts"), "one\nthree\nfour\n");
        writeFileSync(join(root, "b.ts"), "other\n");
        commit();
        expect(loadChurn(root, 90)).toEqual(new Map([
            ["a.ts", { lines: 5, commits: 2 }],
            ["b.ts", { lines: 1, commits: 1 }],
        ]));
    });

    it("excludes bulk commits touching more than thirty files", () => {
        for (let i = 0; i < 31; i++) writeFileSync(join(root, `file-${i}.ts`), "bulk\n");
        commit();
        writeFileSync(join(root, "file-0.ts"), "focused\n");
        commit();
        expect(loadChurn(root, 90)).toEqual(new Map([["file-0.ts", { lines: 2, commits: 1 }]]));
    });

    it("returns no churn when the repository has no commits", () => {
        expect(loadChurn(root, 90)).toEqual(new Map());
    });
});
