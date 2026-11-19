import { describe, expect, it } from "vitest";
import type { ClientName } from "./settings.js";
import {
    buildSkillConfig,
    renderTargetContent,
    runnerTargets,
} from "./skill-install-templates.js";

const ALL_CLIENTS: readonly ClientName[] = ["claude", "codex", "gemini", "copilot", "cursor", "opencode", "pi"];

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

    // The enforce description swap is gone: its 1,024-char reason no longer
    // held, and the rewritten frontmatter (one extra blank line) is what kept
    // old copies from being recognized as ours.
    it.each(ALL_CLIENTS)("ships the enforce SKILL.md to %s byte for byte", (client) => {
        const config = buildSkillConfig("enforce");
        const spec = runnerTargets(client, "enforce", config).find((target) => target.kind === "spec");
        expect(spec).toBeDefined();
        expect(renderTargetContent(config, spec!, SKILL)).toBe(SKILL);
    });

    it("leaves other skill specs byte-equivalent in content", () => {
        const config = buildSkillConfig("interlinked");
        const [target] = runnerTargets("codex", "interlinked", config);
        expect(renderTargetContent(config, target!, SKILL)).toBe(SKILL);
    });

    it("renders a Copilot alias that points at the canonical managed skill", () => {
        const config = buildSkillConfig("enforce");
        const alias = runnerTargets("copilot", "enforce", config).find(
            (target) => target.kind === "copilot-prompt-alias",
        );
        const rendered = renderTargetContent(config, alias!, SKILL);
        expect(rendered).toContain(".interlinked/skills/enforce/SKILL.md");
        expect(rendered).toContain("name: enforce");
    });

    it("falls back to the raw skill content for a copilot-prompt-alias target when no alias is configured", () => {
        const config = buildSkillConfig("interlinked");
        const target = { kind: "copilot-prompt-alias" as const, relPath: ".github/prompts/interlinked.prompt.md" };
        expect(renderTargetContent(config, target, SKILL)).toBe(SKILL);
    });

    it("returns [] targets for a client outside the known set (defensive default)", () => {
        // SAFETY: deliberately supplies an unsupported client to verify the target table's foreign-client fallback.
        const unknownClient = "windsurf" as ClientName;
        expect(runnerTargets(unknownClient, "interlinked", {})).toEqual([]);
    });

    it("gives only enforce a Copilot alias", () => {
        expect(buildSkillConfig("enforce").copilotPromptAlias).toContain("# /enforce — alias");
        expect(buildSkillConfig("interlinked")).toEqual({});
    });
});
