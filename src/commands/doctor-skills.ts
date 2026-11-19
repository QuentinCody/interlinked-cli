// ===========================================
// Doctor checks for deployed Interlinked skills
// ===========================================

import { type ClientName, detectClients } from "../lib/settings.js";
import { inspectInstalledSkills, installSkills } from "../lib/skill-installers.js";
import type { CheckResult } from "./doctor-checks.js";

function detectedClients(cwd: string): ClientName[] {
    return detectClients(cwd)
        .filter((client) => client.exists)
        .map((client) => client.name);
}

type SkillInspection = ReturnType<typeof inspectInstalledSkills>;

const FIX_COMMAND = "'interlinked doctor --fix'";
const MAX_LISTED = 5;

function listed(items: readonly string[]): string {
    const shown = items.slice(0, MAX_LISTED).join(", ");
    return items.length > MAX_LISTED ? `${shown}, +${items.length - MAX_LISTED} more` : shown;
}

/** The repair route. A refresh replaces only copies it owns, so files it would
 * refuse are named with the manual step that must come first. */
function repairAdvice(blockedFiles: readonly string[]): string {
    if (blockedFiles.length === 0) return ` -- run ${FIX_COMMAND}`;
    return (
        `; ${FIX_COMMAND} will not replace ${blockedFiles.length} file(s) it does not own or that were edited: ` +
        `${listed(blockedFiles)} -- move each aside if it is an old Interlinked copy, then run ${FIX_COMMAND}`
    );
}

function staleSkillResult(clients: readonly ClientName[], inspection: SkillInspection): CheckResult {
    const skills = inspection.staleSkills.length > 0 ? ` (skills: ${listed(inspection.staleSkills)})` : "";
    return {
        name: "Agent skills",
        status: "warn",
        message:
            `${inspection.issues.length} deployed skill file(s) missing or stale against the bundled skills for ` +
            `${clients.join(", ")}${skills}${repairAdvice(inspection.blockedFiles)}`,
        fixable: true,
        fixAction: "refresh-skills",
    };
}

/** Inspect native runner skill directories and optionally refresh safe,
 * Interlinked-owned copies. Modified user files remain warnings, never clobbers. */
export function skillInstallationChecks(cwd: string, fix: boolean): CheckResult[] {
    const clients = detectedClients(cwd);
    if (clients.length === 0) return [];

    const before = inspectInstalledSkills(cwd, clients);
    if (before.expectedFiles === 0) {
        return [
            {
                name: "Agent skills",
                status: "warn",
                message: "Bundled skill sources were not found in this CLI installation",
            },
        ];
    }
    if (before.issues.length === 0) {
        return [
            {
                name: "Agent skills",
                status: "pass",
                message: `${before.currentFiles} deployed skill file(s) current for ${clients.join(", ")}`,
            },
        ];
    }
    if (!fix) return [staleSkillResult(clients, before)];

    const installResults = installSkills(cwd, clients);
    const after = inspectInstalledSkills(cwd, clients);
    if (after.issues.length === 0) {
        return [
            {
                name: "Agent skills",
                status: "pass",
                message: `Refreshed ${after.currentFiles} deployed skill file(s) for ${clients.join(", ")}`,
            },
        ];
    }
    const errors = installResults
        .filter((result) => result.error !== undefined)
        .map((result) => result.error)
        .filter((error): error is string => error !== undefined);
    const detail = errors[0] ?? after.issues[0] ?? "unknown install error";
    return [
        {
            ...staleSkillResult(clients, after),
            message:
                `Could not safely refresh all deployed skills: ${detail}` +
                (after.blockedFiles.length > 0 ? repairAdvice(after.blockedFiles) : ""),
        },
    ];
}
