import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManagedSkillFile } from "./skill-install-ownership.js";
import { countMatchingSkillFiles, errorText, reportLegacySkillTargets } from "./skill-install-inspect.js";

let cwd = "";

function write(relPath: string, body: string): void {
    const target = join(cwd, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
}

function spec(relPath: string, body: string): ManagedSkillFile {
    return { relPath, content: Buffer.from(body), skill: "a", owner: "canonical", kind: "spec" };
}

beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "skill-inspect-"));
});

afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
});

describe("errorText", () => {
    it("returns the message of an Error", () => {
        expect(errorText(new Error("boom"))).toBe("boom");
    });

    it("stringifies a non-Error", () => {
        expect(errorText("plain")).toBe("plain");
    });
});

describe("countMatchingSkillFiles", () => {
    it("counts a file whose bytes match and records no issue", () => {
        write(".interlinked/skills/a/SKILL.md", "hello");
        const issues: string[] = [];
        expect(countMatchingSkillFiles(cwd, [spec(".interlinked/skills/a/SKILL.md", "hello")], issues)).toBe(1);
        expect(issues).toEqual([]);
    });

    it("reports a missing or stale file", () => {
        write(".interlinked/skills/a/SKILL.md", "other");
        const issues: string[] = [];
        expect(
            countMatchingSkillFiles(
                cwd,
                [spec(".interlinked/skills/a/SKILL.md", "hello"), spec(".interlinked/skills/a/gone.md", "x")],
                issues,
            ),
        ).toBe(0);
        expect(issues).toEqual([
            ".interlinked/skills/a/SKILL.md: missing or stale",
            ".interlinked/skills/a/gone.md: missing or stale",
        ]);
    });

    it("records the error text when the path is unsafe", () => {
        const issues: string[] = [];
        expect(countMatchingSkillFiles(cwd, [spec("../escape.md", "hello")], issues)).toBe(0);
        expect(issues).toHaveLength(1);
        expect(issues[0]).toContain("../escape.md: ");
    });
});

describe("reportLegacySkillTargets", () => {
    it("flags a recognized legacy target", () => {
        write(".claude/skills/a/SKILL.md", "legacy");
        const issues: string[] = [];
        reportLegacySkillTargets(
            cwd,
            [{ relPath: ".claude/skills/a/SKILL.md", isRecognizedLegacy: (buf) => buf.toString() === "legacy" }],
            issues,
        );
        expect(issues).toEqual([".claude/skills/a/SKILL.md: legacy install target"]);
    });

    it("stays quiet for an absent or unrecognized target", () => {
        write(".claude/skills/a/SKILL.md", "mine");
        const issues: string[] = [];
        reportLegacySkillTargets(
            cwd,
            [
                { relPath: ".claude/skills/a/SKILL.md", isRecognizedLegacy: () => false },
                { relPath: ".claude/skills/a/absent.md", isRecognizedLegacy: () => true },
                { relPath: ".claude/skills/a/SKILL.md" },
            ],
            issues,
        );
        expect(issues).toEqual([]);
    });

    it("records the error text when the path is unsafe", () => {
        const issues: string[] = [];
        reportLegacySkillTargets(cwd, [{ relPath: "../escape.md", isRecognizedLegacy: () => true }], issues);
        expect(issues).toHaveLength(1);
        expect(issues[0]).toContain("../escape.md: ");
    });
});
