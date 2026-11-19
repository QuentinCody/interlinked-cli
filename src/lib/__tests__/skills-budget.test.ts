// Pinned size budget for every shipped skill (`skills/*/SKILL.md`).
//
// Why: runners list every skill description in standing context, and both
// Claude Code and Codex ask for SKILL.md files under 500 lines with detail in
// `references/`. The six large skills grew 3.7x to 10.2x in three months, and
// the per-file line cap does not cover markdown (`isCappableFile` exempts it),
// so nothing else stops the regrowth. Move detail to `skills/<name>/references/`
// rather than raising a limit here.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MAX_DESCRIPTION_CHARS = 600;
const MAX_BODY_LINES = 500;

const SKILLS_ROOT = fileURLToPath(new URL("../../../skills", import.meta.url));
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

interface SkillSize {
    relPath: string;
    descriptionChars: number | null;
    bodyLines: number;
}

/** The decoded value of a double-quoted `description:` scalar, or null. */
function descriptionOf(frontmatter: string): string | null {
    const match = /^description:\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(frontmatter);
    if (!match) return null;
    return (match[1] ?? "").replace(/\\(.)/g, "$1");
}

function lineCount(text: string): number {
    if (text === "") return 0;
    const lines = text.split("\n").length;
    return text.endsWith("\n") ? lines - 1 : lines;
}

function measure(name: string): SkillSize {
    const relPath = join("skills", name, "SKILL.md");
    const content = readFileSync(join(SKILLS_ROOT, name, "SKILL.md"), "utf-8");
    const match = FRONTMATTER.exec(content);
    const description = match ? descriptionOf(match[1] ?? "") : null;
    const body = match ? content.slice(match[0].length) : content;
    return { relPath, descriptionChars: description?.length ?? null, bodyLines: lineCount(body) };
}

const skillNames = readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_ROOT, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();

describe("skills budget", () => {
    // An empty list would make the it.each below pass with zero cases.
    it("finds the shipped skills", () => {
        expect(skillNames.length).toBeGreaterThanOrEqual(13);
        expect(skillNames).toContain("interlinked");
    });

    it.each(skillNames)(
        `%s: description <= ${MAX_DESCRIPTION_CHARS} chars and body <= ${MAX_BODY_LINES} lines`,
        (name) => {
            const size = measure(name);
            const report =
                `${size.relPath}: description ${size.descriptionChars ?? "missing"} chars ` +
                `(max ${MAX_DESCRIPTION_CHARS}), body ${size.bodyLines} lines (max ${MAX_BODY_LINES})`;
            const withinBudget =
                size.descriptionChars !== null &&
                size.descriptionChars <= MAX_DESCRIPTION_CHARS &&
                size.bodyLines <= MAX_BODY_LINES;
            expect(withinBudget, report).toBe(true);
        },
    );
});
