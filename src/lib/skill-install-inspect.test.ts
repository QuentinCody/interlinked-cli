import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentDigest, type ManagedSkillFile } from "./skill-install-ownership.js";
import {
    countCurrentSkillFiles,
    errorText,
    noteRefusedSkillFiles,
    reportLegacySkillTargets,
    type SkillInspectionLedger,
} from "./skill-install-inspect.js";

let cwd = "";

function emptyLedger(files: SkillInspectionLedger["manifest"]["files"] = {}): SkillInspectionLedger {
    return { manifest: { version: 1, files }, issues: [], blockedFiles: [] };
}

function ownedEntry(body: string): SkillInspectionLedger["manifest"]["files"][string] {
    return { sha256: contentDigest(Buffer.from(body)), skill: "a", owner: "canonical", kind: "spec" };
}

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

describe("countCurrentSkillFiles", () => {
    it("counts a file whose bytes match and records no issue", () => {
        write(".interlinked/skills/a/SKILL.md", "hello");
        const ledger = emptyLedger();
        expect(countCurrentSkillFiles(cwd, [spec(".interlinked/skills/a/SKILL.md", "hello")], ledger)).toBe(1);
        expect(ledger.issues).toEqual([]);
        expect(ledger.blockedFiles).toEqual([]);
    });

    it("reports a missing or stale file, and blocks the existing unowned one only", () => {
        write(".interlinked/skills/a/SKILL.md", "other");
        const ledger = emptyLedger();
        expect(
            countCurrentSkillFiles(
                cwd,
                [spec(".interlinked/skills/a/SKILL.md", "hello"), spec(".interlinked/skills/a/gone.md", "x")],
                ledger,
            ),
        ).toBe(0);
        expect(ledger.issues).toEqual([
            ".interlinked/skills/a/SKILL.md: missing or stale",
            ".interlinked/skills/a/gone.md: missing or stale",
        ]);
        expect(ledger.blockedFiles).toEqual([".interlinked/skills/a/SKILL.md (unowned)"]);
    });

    it("does not block a stale file that the manifest owns unmodified", () => {
        write(".interlinked/skills/a/SKILL.md", "old");
        const ledger = emptyLedger({ ".interlinked/skills/a/SKILL.md": ownedEntry("old") });
        expect(countCurrentSkillFiles(cwd, [spec(".interlinked/skills/a/SKILL.md", "new")], ledger)).toBe(0);
        expect(ledger.issues).toEqual([".interlinked/skills/a/SKILL.md: missing or stale"]);
        expect(ledger.blockedFiles).toEqual([]);
    });

    it("blocks a manifest-owned file that was edited after install", () => {
        write(".interlinked/skills/a/SKILL.md", "edited");
        const ledger = emptyLedger({ ".interlinked/skills/a/SKILL.md": ownedEntry("old") });
        countCurrentSkillFiles(cwd, [spec(".interlinked/skills/a/SKILL.md", "new")], ledger);
        expect(ledger.blockedFiles).toEqual([".interlinked/skills/a/SKILL.md (modified)"]);
    });

    it("records the error text when the path is unsafe", () => {
        const ledger = emptyLedger();
        expect(countCurrentSkillFiles(cwd, [spec("../escape.md", "hello")], ledger)).toBe(0);
        expect(ledger.issues).toHaveLength(1);
        expect(ledger.issues[0]).toContain("../escape.md: ");
    });
});

describe("noteRefusedSkillFiles", () => {
    it("blocks an existing unowned file without adding an issue", () => {
        write(".interlinked/skills/a/SKILL.md", "theirs");
        const ledger = emptyLedger();
        noteRefusedSkillFiles(cwd, [spec(".interlinked/skills/a/SKILL.md", "ours")], ledger);
        expect(ledger.blockedFiles).toEqual([".interlinked/skills/a/SKILL.md (unowned)"]);
        expect(ledger.issues).toEqual([]);
    });

    it("stays quiet for an absent, current, or recognized file", () => {
        write(".interlinked/skills/a/SKILL.md", "ours");
        write(".interlinked/skills/a/old.md", "legacy");
        const ledger = emptyLedger();
        noteRefusedSkillFiles(
            cwd,
            [
                spec(".interlinked/skills/a/SKILL.md", "ours"),
                spec(".interlinked/skills/a/absent.md", "x"),
                { ...spec(".interlinked/skills/a/old.md", "new"), isRecognizedLegacy: () => true },
            ],
            ledger,
        );
        expect(ledger.blockedFiles).toEqual([]);
        expect(ledger.issues).toEqual([]);
    });

    it("records the error text when the path is unsafe", () => {
        const ledger = emptyLedger();
        noteRefusedSkillFiles(cwd, [spec("../escape.md", "hello")], ledger);
        expect(ledger.issues).toHaveLength(1);
        expect(ledger.issues[0]).toContain("../escape.md: ");
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
