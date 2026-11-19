// Companion tests for `skill-legacy-match.ts`: the text compare that decides
// whether an unmanifested skill file is an old Interlinked copy.
import { describe, expect, it } from "vitest";
import {
    hasSkillName,
    legacyComparableText,
    recognizedCursorAlias,
    recognizedLegacySkill,
} from "./skill-legacy-match.js";

const BODY = "\n# /enforce — old body\n\nEmit a top-level `session_predicate`.\n";
const CURRENT = `---\nname: enforce\ndescription: "Current description"\n---\n${BODY}`;
// The shape the May installer wrote to runner directories: a rewritten
// description and one extra blank line before the closing delimiter.
const MAY_RUNNER = `---\nname: enforce\ndescription: "Short description"\n\n---\n${BODY}`;

describe("legacyComparableText — positive (must compare equal)", () => {
    it("P1: ignores a blank line before the closing frontmatter delimiter", () => {
        expect(legacyComparableText(MAY_RUNNER)).toBe(legacyComparableText(CURRENT));
    });

    it("P2: ignores trailing whitespace and CRLF line ends inside the frontmatter", () => {
        const crlf = `---\r\nname: enforce   \r\ndescription: "x"\r\n---\r\n${BODY}`;
        expect(legacyComparableText(crlf)).toBe(legacyComparableText(CURRENT));
    });

    it("P3: masks a block-scalar description together with its indented lines", () => {
        const block = `---\nname: enforce\ndescription: |\n  Line one\n\n  Line two\n---\n${BODY}`;
        expect(legacyComparableText(block)).toBe(legacyComparableText(CURRENT));
    });
});

describe("legacyComparableText — negative (must not compare equal)", () => {
    it("N1: keeps body whitespace, so a body with one more blank line differs", () => {
        expect(legacyComparableText(`${CURRENT}\n`)).not.toBe(legacyComparableText(CURRENT));
    });

    it("N2: keeps every non-description frontmatter key", () => {
        const renamed = CURRENT.replace("name: enforce", "name: enforce-mine");
        expect(legacyComparableText(renamed)).not.toBe(legacyComparableText(CURRENT));
    });

    it("N3: returns a file without frontmatter unchanged", () => {
        const plain = "description: not frontmatter\nbody\n";
        expect(legacyComparableText(plain)).toBe(plain);
    });

    it("N4: keeps a key that follows an inline description", () => {
        const extra = CURRENT.replace('"Current description"\n', '"Current description"\ntags: x\n');
        expect(legacyComparableText(extra)).not.toBe(legacyComparableText(CURRENT));
    });
});

describe("recognizedLegacySkill", () => {
    it("P4: recognizes the May runner shape against the current expected bytes", () => {
        const recognize = recognizedLegacySkill(Buffer.from(CURRENT), "enforce");
        expect(recognize(Buffer.from(MAY_RUNNER))).toBe(true);
    });

    it("P5: recognizes exact evidenced bytes even when the body differs", () => {
        const evidence = Buffer.from(`${MAY_RUNNER}extra\n`);
        const recognize = recognizedLegacySkill(Buffer.from(CURRENT), "enforce", evidence);
        expect(recognize(evidence)).toBe(true);
    });

    it("N5: rejects a same-name skill with its own body", () => {
        const recognize = recognizedLegacySkill(Buffer.from(CURRENT), "enforce");
        const mine = `---\nname: enforce\ndescription: "Mine"\n\n---\n\n# My own enforce\n`;
        expect(recognize(Buffer.from(mine))).toBe(false);
    });

    it("N6: rejects a copy whose name line names another skill", () => {
        const recognize = recognizedLegacySkill(Buffer.from(CURRENT), "enforce", Buffer.from(CURRENT));
        expect(recognize(Buffer.from(CURRENT.replace("name: enforce", "name: other")))).toBe(false);
    });
});

describe("hasSkillName", () => {
    it("P6: matches the exact name line", () => {
        expect(hasSkillName(CURRENT, "enforce")).toBe(true);
    });

    it("N7: treats regex characters in the name literally", () => {
        expect(hasSkillName("name: enforceX\n", "enforc.")).toBe(false);
        expect(hasSkillName("name: a.b\n", "a.b")).toBe(true);
    });
});

describe("recognizedCursorAlias", () => {
    const pointer = ".interlinked/skills/enforce/SKILL.md";

    it("P7: accepts the slash heading with the canonical pointer", () => {
        const alias = `# /enforce — Cursor rule alias\n\n\`${pointer}\`\n`;
        expect(recognizedCursorAlias("enforce")(Buffer.from(alias))).toBe(true);
    });

    it("N8: rejects the heading without the canonical pointer", () => {
        const alias = "# enforce — Cursor rule alias\n\nno pointer\n";
        expect(recognizedCursorAlias("enforce")(Buffer.from(alias))).toBe(false);
    });
});
