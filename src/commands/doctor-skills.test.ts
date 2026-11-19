import { beforeEach, describe, expect, it, vi } from "vitest";

const { detectClientsMock, inspectInstalledSkillsMock, installSkillsMock } = vi.hoisted(() => ({
    detectClientsMock: vi.fn(),
    inspectInstalledSkillsMock: vi.fn(),
    installSkillsMock: vi.fn(),
}));

vi.mock("../lib/settings.js", () => ({ detectClients: detectClientsMock }));
vi.mock("../lib/skill-installers.js", () => ({
    inspectInstalledSkills: inspectInstalledSkillsMock,
    installSkills: installSkillsMock,
}));

import { skillInstallationChecks } from "./doctor-skills.js";

/** A full inspection result; tests override only the fields they exercise. */
function inspection(overrides: Record<string, unknown>): Record<string, unknown> {
    return { expectedFiles: 20, currentFiles: 20, issues: [], staleSkills: [], blockedFiles: [], ...overrides };
}

describe("skillInstallationChecks", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        detectClientsMock.mockReturnValue([{ name: "codex", exists: true }]);
        installSkillsMock.mockReturnValue([]);
    });

    it("warns that bundled skill sources are missing when none are found in this install", () => {
        inspectInstalledSkillsMock.mockReturnValue(inspection({ expectedFiles: 0, currentFiles: 0 }));

        expect(skillInstallationChecks("/repo", false)).toEqual([
            {
                name: "Agent skills",
                status: "warn",
                message: "Bundled skill sources were not found in this CLI installation",
            },
        ]);
        expect(installSkillsMock).not.toHaveBeenCalled();
    });

    it("passes when every deployed file is current", () => {
        inspectInstalledSkillsMock.mockReturnValue(inspection({}));

        expect(skillInstallationChecks("/repo", false)).toEqual([
            expect.objectContaining({ name: "Agent skills", status: "pass" }),
        ]);
        expect(installSkillsMock).not.toHaveBeenCalled();
    });

    it("warns with a safe repair action when a copy is stale, naming the skill and the fix command", () => {
        inspectInstalledSkillsMock.mockReturnValue(
            inspection({
                currentFiles: 19,
                issues: [".agents/skills/enforce/SKILL.md: missing or stale"],
                staleSkills: ["enforce"],
            }),
        );

        expect(skillInstallationChecks("/repo", false)).toEqual([
            {
                name: "Agent skills",
                status: "warn",
                message:
                    "1 deployed skill file(s) missing or stale against the bundled skills for codex " +
                    "(skills: enforce) -- run 'interlinked doctor --fix'",
                fixable: true,
                fixAction: "refresh-skills",
            },
        ]);
        expect(installSkillsMock).not.toHaveBeenCalled();
    });

    it("names the files a refresh would refuse and the manual step before the fix command", () => {
        inspectInstalledSkillsMock.mockReturnValue(
            inspection({
                currentFiles: 18,
                issues: ["a: missing or stale", "b: missing or stale"],
                staleSkills: ["a", "b", "c", "d", "e", "f", "g"],
                blockedFiles: [".claude/skills/enforce/SKILL.md (unowned)"],
            }),
        );

        const [check] = skillInstallationChecks("/repo", false);

        expect(check?.message).toBe(
            "2 deployed skill file(s) missing or stale against the bundled skills for codex " +
                "(skills: a, b, c, d, e, +2 more); 'interlinked doctor --fix' will not replace 1 file(s) " +
                "it does not own or that were edited: .claude/skills/enforce/SKILL.md (unowned) -- move each " +
                "aside if it is an old Interlinked copy, then run 'interlinked doctor --fix'",
        );
        expect(installSkillsMock).not.toHaveBeenCalled();
    });

    it("refreshes stale copies under --fix and re-inspects them", () => {
        inspectInstalledSkillsMock
            .mockReturnValueOnce(inspection({ currentFiles: 19, issues: ["stale"] }))
            .mockReturnValueOnce(inspection({}));

        const checks = skillInstallationChecks("/repo", true);

        expect(installSkillsMock).toHaveBeenCalledWith("/repo", ["codex"]);
        expect(checks[0]).toEqual(expect.objectContaining({ status: "pass" }));
    });

    it("surfaces ownership conflicts instead of claiming the fix worked", () => {
        inspectInstalledSkillsMock
            .mockReturnValueOnce(inspection({ currentFiles: 19, issues: ["stale"] }))
            .mockReturnValueOnce(
                inspection({
                    currentFiles: 19,
                    issues: ["stale"],
                    blockedFiles: [".agents/skills/enforce/SKILL.md (modified)"],
                }),
            );
        installSkillsMock.mockReturnValue([
            {
                skill: "enforce",
                client: "codex",
                path: "",
                installed: false,
                error: "Refusing to overwrite modified managed skill file",
            },
        ]);

        const [check] = skillInstallationChecks("/repo", true);

        expect(check?.status).toBe("warn");
        expect(check?.message).toContain("modified managed skill file");
    });
});
