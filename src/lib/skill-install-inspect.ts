// ===========================================
// Skill install inspection — per-target file comparison helpers
// ===========================================

import { existsSync, readFileSync } from "node:fs";
import { assertSafeSkillPath, type ManagedSkillFile } from "./skill-install-ownership.js";

export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Counts specs whose on-disk bytes match, recording a `missing or stale` issue for the rest. */
export function countMatchingSkillFiles(
    cwd: string,
    specs: readonly ManagedSkillFile[],
    issues: string[],
): number {
    let matched = 0;
    for (const spec of specs) {
        try {
            const target = assertSafeSkillPath(cwd, spec.relPath);
            if (existsSync(target) && readFileSync(target).equals(spec.content)) matched += 1;
            else issues.push(`${spec.relPath}: missing or stale`);
        } catch (err) {
            issues.push(`${spec.relPath}: ${errorText(err)}`);
        }
    }
    return matched;
}

/** Records an issue for every legacy install target still present and recognized as ours. */
export function reportLegacySkillTargets(
    cwd: string,
    legacySpecs: ReadonlyArray<Pick<ManagedSkillFile, "relPath" | "isRecognizedLegacy">>,
    issues: string[],
): void {
    for (const legacy of legacySpecs) {
        try {
            const target = assertSafeSkillPath(cwd, legacy.relPath);
            if (existsSync(target) && legacy.isRecognizedLegacy?.(readFileSync(target))) {
                issues.push(`${legacy.relPath}: legacy install target`);
            }
        } catch (err) {
            issues.push(`${legacy.relPath}: ${errorText(err)}`);
        }
    }
}
