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

describe("skillInstallationChecks", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        detectClientsMock.mockReturnValue([{ name: "codex", exists: true }]);
        installSkillsMock.mockReturnValue([]);
    });

    it("warns that bundled skill sources are missing when none are found in this install", () => {
        inspectInstalledSkillsMock.mockReturnValue({
            expectedFiles: 0,
            currentFiles: 0,
            issues: [],
        });

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
        inspectInstalledSkillsMock.mockReturnValue({
            expectedFiles: 20,
            currentFiles: 20,
            issues: [],
        });

        expect(skillInstallationChecks("/repo", false)).toEqual([
            expect.objectContaining({ name: "Agent skills", status: "pass" }),
        ]);
        expect(installSkillsMock).not.toHaveBeenCalled();
    });

    it("warns with a safe repair action when a copy is stale", () => {
        inspectInstalledSkillsMock.mockReturnValue({
            expectedFiles: 20,
            currentFiles: 19,
            issues: [".agents/skills/enforce/SKILL.md: missing or stale"],
        });

        expect(skillInstallationChecks("/repo", false)).toEqual([
            expect.objectContaining({
                status: "warn",
                fixable: true,
                fixAction: "refresh-skills",
            }),
        ]);
    });

    it("refreshes stale copies under --fix and re-inspects them", () => {
        inspectInstalledSkillsMock
            .mockReturnValueOnce({ expectedFiles: 20, currentFiles: 19, issues: ["stale"] })
            .mockReturnValueOnce({ expectedFiles: 20, currentFiles: 20, issues: [] });

        const checks = skillInstallationChecks("/repo", true);

        expect(installSkillsMock).toHaveBeenCalledWith("/repo", ["codex"]);
        expect(checks[0]).toEqual(expect.objectContaining({ status: "pass" }));
    });

    it("surfaces ownership conflicts instead of claiming the fix worked", () => {
        inspectInstalledSkillsMock
            .mockReturnValueOnce({ expectedFiles: 20, currentFiles: 19, issues: ["stale"] })
            .mockReturnValueOnce({ expectedFiles: 20, currentFiles: 19, issues: ["stale"] });
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
