import { describe, expect, it } from "vitest";
import type { ClientName } from "./settings.js";
import {
    buildSkillConfig,
    ENFORCE_SHORT_DESCRIPTION,
    processLinesLength,
    renderTargetContent,
    runnerTargets,
    swapFrontmatterDescription,
} from "./skill-install-templates.js";

const SKILL = `---
name: enforce
description: "Long canonical description"
---

# Enforce
`;

describe("skill install templates", () => {
    it("uses each runner's native project skill directory", () => {
        const config = buildSkillConfig("interlinked");
        expect(runnerTargets("claude", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".claude/skills/interlinked/SKILL.md" },
        ]);
        expect(runnerTargets("codex", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".agents/skills/interlinked/SKILL.md" },
        ]);
        expect(runnerTargets("gemini", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".gemini/skills/interlinked/SKILL.md" },
        ]);
        expect(runnerTargets("cursor", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".cursor/skills/interlinked/SKILL.md" },
        ]);
        expect(runnerTargets("copilot", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".github/skills/interlinked/SKILL.md" },
        ]);
        expect(runnerTargets("opencode", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".opencode/skills/interlinked/SKILL.md" },
        ]);
        expect(runnerTargets("pi", "interlinked", config)).toEqual([
            { kind: "spec", relPath: ".pi/skills/interlinked/SKILL.md" },
        ]);
    });

    it("adds only the intentional Copilot prompt alias", () => {
        const config = buildSkillConfig("enforce");
        expect(runnerTargets("copilot", "enforce", config)).toEqual([
            { kind: "spec", relPath: ".github/skills/enforce/SKILL.md" },
            {
                kind: "copilot-prompt-alias",
                relPath: ".github/prompts/enforce.prompt.md",
            },
        ]);
    });

    it("uses a validator-safe short description where a runner requires it", () => {
        const config = buildSkillConfig("enforce");
        const [codexTarget] = runnerTargets("codex", "enforce", config);
        const [cursorTarget] = runnerTargets("cursor", "enforce", config);
        const [opencodeTarget] = runnerTargets("opencode", "enforce", config);
        const [piTarget] = runnerTargets("pi", "enforce", config);
        expect(renderTargetContent("codex", config, codexTarget!, SKILL)).toContain(
            `description: ${JSON.stringify(ENFORCE_SHORT_DESCRIPTION)}`,
        );
        expect(renderTargetContent("cursor", config, cursorTarget!, SKILL)).toContain(
            `description: ${JSON.stringify(ENFORCE_SHORT_DESCRIPTION)}`,
        );
        expect(renderTargetContent("opencode", config, opencodeTarget!, SKILL)).toContain(
            `description: ${JSON.stringify(ENFORCE_SHORT_DESCRIPTION)}`,
        );
        expect(renderTargetContent("pi", config, piTarget!, SKILL)).toContain(
            `description: ${JSON.stringify(ENFORCE_SHORT_DESCRIPTION)}`,
        );
    });

    it("leaves other skill specs byte-equivalent in content", () => {
        const config = buildSkillConfig("interlinked");
        const [target] = runnerTargets("codex", "interlinked", config);
        expect(renderTargetContent("codex", config, target!, SKILL)).toBe(SKILL);
    });

    it("renders a Copilot alias that points at the canonical managed skill", () => {
        const config = buildSkillConfig("enforce");
        const alias = runnerTargets("copilot", "enforce", config).find(
            (target) => target.kind === "copilot-prompt-alias",
        );
        const rendered = renderTargetContent("copilot", config, alias!, SKILL);
        expect(rendered).toContain(".interlinked/skills/enforce/SKILL.md");
        expect(rendered).toContain("name: enforce");
    });

    it("swaps only the frontmatter description", () => {
        const rendered = swapFrontmatterDescription(SKILL, "Short description");
        expect(rendered).toContain('description: "Short description"');
        expect(rendered).toContain("# Enforce");
    });

    it("falls back to the raw skill content for a copilot-prompt-alias target when no alias is configured", () => {
        const config = buildSkillConfig("interlinked");
        const target = { kind: "copilot-prompt-alias" as const, relPath: ".github/prompts/interlinked.prompt.md" };
        expect(renderTargetContent("copilot", config, target, SKILL)).toBe(SKILL);
    });

    it("returns [] targets and unmodified spec content for a client outside the known set (defensive default)", () => {
        // SAFETY: deliberately supplies an unsupported client to verify the renderer's foreign-client fallback.
        const unknownClient = "windsurf" as ClientName;
        expect(runnerTargets(unknownClient, "interlinked", {})).toEqual([]);
        const config = buildSkillConfig("enforce");
        const target = { kind: "spec" as const, relPath: "whatever/SKILL.md" };
        expect(renderTargetContent(unknownClient, config, target, SKILL)).toBe(SKILL);
    });

    it("leaves content untouched when there is no frontmatter at all", () => {
        const plain = "plain body, no frontmatter\n";
        expect(swapFrontmatterDescription(plain, "New")).toBe(plain);
    });

    it("leaves content untouched when the frontmatter is never closed", () => {
        const unterminated = "---\nname: x\n";
        expect(swapFrontmatterDescription(unterminated, "New")).toBe(unterminated);
    });

    it("appends a description key when the frontmatter has none", () => {
        const noDescription = `---
name: interlinked
tags: foo
---

# Body
`;
        const rendered = swapFrontmatterDescription(noDescription, "New desc");
        expect(rendered).toBe(`---
name: interlinked
tags: foo

description: "New desc"
---

# Body
`);
    });

    it("consumes an indented block-scalar description (blank + whitespace continuation lines) and stops at the next unindented key", () => {
        const blockSkill = `---
name: enforce
description: |
  Line one of block

  Line two of block
tags: foo
---

# Enforce
`;
        const rendered = swapFrontmatterDescription(blockSkill, "Short");
        expect(rendered).toBe(`---
name: enforce
description: "Short"
tags: foo

---

# Enforce
`);
    });

    it("skips a hole in the frontmatter line array instead of copying it into the output (noUncheckedIndexedAccess guard)", () => {
        // `swapFrontmatterDescription` always builds `lines` from `String#split`,
        // which never produces a hole — this guard is unreachable through that
        // public path. Call the line-rewriter directly with a manufactured hole
        // to exercise it: real frontmatter parsers over hand-edited YAML can hit
        // trailing/malformed entries the same way.
        // SAFETY: deliberately manufacturing the hole `noUncheckedIndexedAccess`
        // guards against — real callers never produce one (see comment above).
        const linesWithHole = ["name: enforce", undefined, "tags: foo"] as string[];

        const { out, replaced } = processLinesLength(linesWithHole, '"New"');

        expect(out).toEqual(["name: enforce", "tags: foo"]);
        expect(replaced).toBe(false);
    });
});
