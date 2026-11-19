// Regression: the May 2026 installer wrote runner copies of `enforce` with a
// rewritten description and ONE extra blank line before the closing `---`.
// The legacy recognizer compared frontmatter whitespace exactly, so it called
// those copies "unowned", refused to refresh them, and they kept teaching the
// obsolete top-level `session_predicate`. These cases pin the repair, and pin
// that a user-authored skill with the same name is still never overwritten.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "./non-null.js";
import { SKILL_INSTALL_MANIFEST } from "./skill-install-ownership.js";
import { findEnforceSkillSource, inspectInstalledSkills, installSkills } from "./skill-installers.js";

const CANONICAL = join(".interlinked", "skills", "enforce", "SKILL.md");
const CLAUDE = join(".claude", "skills", "enforce", "SKILL.md");
const CODEX_NEW = join(".agents", "skills", "enforce", "SKILL.md");
const CODEX_OLD = join(".codex", "skills", "enforce", "SKILL.md");

const OLD_BODY =
    "\n# /enforce — Make markdown guidance into enforced harness rules\n\n" +
    "Emit a top-level `session_predicate` such as `tests_passed_recently`.\n";
/** The May canonical copy: the long authored description, no extra blank line. */
const MAY_CANONICAL = `---\nname: enforce\ndescription: "Distill imperative markdown guidance (long form)."\n---\n${OLD_BODY}`;
/** The May runner copy: the swapped short description plus the extra blank line. */
const MAY_RUNNER = `---\nname: enforce\ndescription: "Distill imperative markdown guidance."\n\n---\n${OLD_BODY}`;
const USER_SKILL = `---\nname: enforce\ndescription: "Our team's own enforce rules"\n\n---\n\n# Our enforce\n\nTeam steps.\n`;

let root = "";

function put(relPath: string, content: string): void {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), content);
}

function read(relPath: string): string {
    return readFileSync(join(root, relPath), "utf-8");
}

function enforceResults(results: ReturnType<typeof installSkills>): ReturnType<typeof installSkills> {
    return results.filter((result) => result.skill === "enforce");
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skill-legacy-whitespace-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe("May-shaped enforce copies — positive (must refresh)", () => {
    it("P1: recognizes the May copies, refreshes them, and removes the old Codex copy", () => {
        const source = readFileSync(nonNull(findEnforceSkillSource()), "utf-8");
        put(CANONICAL, MAY_CANONICAL);
        put(CLAUDE, MAY_RUNNER);
        put(CODEX_OLD, MAY_RUNNER);

        const before = inspectInstalledSkills(root, ["claude", "codex"]);
        expect(before.blockedFiles).toEqual([]);
        expect(before.staleSkills).toContain("enforce");
        expect(before.issues).toContain(`${CODEX_OLD}: legacy install target`);

        const results = enforceResults(installSkills(root, ["claude", "codex"]));
        expect(results.map((result) => [result.client, result.installed, result.error])).toEqual([
            ["claude", true, undefined],
            ["codex", true, undefined],
        ]);
        expect(read(CANONICAL)).toBe(source);
        expect(read(CLAUDE)).toBe(source);
        expect(read(CODEX_NEW)).toBe(source);
        expect(existsSync(join(root, CODEX_OLD))).toBe(false);
        expect(read(CLAUDE)).not.toContain("Emit a top-level `session_predicate`");

        const manifest = JSON.parse(read(SKILL_INSTALL_MANIFEST)) as { files: Record<string, unknown> };
        expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining([CANONICAL, CLAUDE, CODEX_NEW]));
        expect(inspectInstalledSkills(root, ["claude", "codex"]).staleSkills).not.toContain("enforce");
    });
});

describe("same-name user skills — negative (must not overwrite)", () => {
    it("N1: keeps a user-authored enforce skill with May-shaped frontmatter", () => {
        put(CLAUDE, USER_SKILL);

        expect(inspectInstalledSkills(root, ["claude"]).blockedFiles).toEqual([`${CLAUDE} (unowned)`]);
        const [result] = enforceResults(installSkills(root, ["claude"]));

        expect(result?.installed).toBe(false);
        expect(result?.error).toBe(`Refusing to overwrite unowned skill file: ${CLAUDE}`);
        expect(read(CLAUDE)).toBe(USER_SKILL);
    });

    it("N2: keeps a user-authored runner skill next to an old canonical copy", () => {
        put(CANONICAL, MAY_CANONICAL);
        put(CLAUDE, USER_SKILL);

        expect(inspectInstalledSkills(root, ["claude"]).blockedFiles).toEqual([
            `${CANONICAL} (unowned)`,
            `${CLAUDE} (unowned)`,
        ]);
        const [result] = enforceResults(installSkills(root, ["claude"]));

        expect(result?.installed).toBe(false);
        expect(result?.error).toBe(`Refusing to overwrite unowned skill file: ${CANONICAL}`);
        expect(read(CANONICAL)).toBe(MAY_CANONICAL);
        expect(read(CLAUDE)).toBe(USER_SKILL);
    });
});
