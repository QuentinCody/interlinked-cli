// ===========================================
// Skill install inspection — per-target file comparison helpers
// ===========================================

import { existsSync, readFileSync } from "node:fs";
import {
    assertSafeSkillPath,
    type ManagedSkillFile,
    overwriteRefusal,
    type SkillInstallManifest,
} from "./skill-install-ownership.js";

export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Accumulator for the read-only doctor view of deployed skill copies. */
export interface SkillInspectionLedger {
    /** Ownership manifest, read only to predict which refreshes would be refused. */
    manifest: SkillInstallManifest;
    /** One line per runner file that is not byte-current, plus legacy and unsafe targets. */
    issues: string[];
    /** Existing files a refresh would refuse to replace: `<relPath> (modified|unowned)`. */
    blockedFiles: string[];
}

function existingBytes(cwd: string, relPath: string): Buffer | null {
    const target = assertSafeSkillPath(cwd, relPath);
    return existsSync(target) ? readFileSync(target) : null;
}

function noteRefusal(ledger: SkillInspectionLedger, spec: ManagedSkillFile, onDisk: Buffer): void {
    const refusal = overwriteRefusal(ledger.manifest, spec, onDisk);
    if (refusal !== null) ledger.blockedFiles.push(`${spec.relPath} (${refusal})`);
}

/** Counts specs whose on-disk bytes match. Every other spec gets a `missing or
 * stale` issue; an existing one that a refresh would refuse is also blocked. */
export function countCurrentSkillFiles(
    cwd: string,
    specs: readonly ManagedSkillFile[],
    ledger: SkillInspectionLedger,
): number {
    let matched = 0;
    for (const spec of specs) {
        try {
            const onDisk = existingBytes(cwd, spec.relPath);
            if (onDisk?.equals(spec.content) === true) {
                matched += 1;
                continue;
            }
            ledger.issues.push(`${spec.relPath}: missing or stale`);
            if (onDisk !== null) noteRefusal(ledger, spec, onDisk);
        } catch (err) {
            ledger.issues.push(`${spec.relPath}: ${errorText(err)}`);
        }
    }
    return matched;
}

/** Records refusals for files no runner reads (the canonical copy) without
 * counting them: a refused canonical write fails that skill for every client. */
export function noteRefusedSkillFiles(
    cwd: string,
    specs: readonly ManagedSkillFile[],
    ledger: SkillInspectionLedger,
): void {
    for (const spec of specs) {
        try {
            const onDisk = existingBytes(cwd, spec.relPath);
            if (onDisk !== null && !onDisk.equals(spec.content)) noteRefusal(ledger, spec, onDisk);
        } catch (err) {
            ledger.issues.push(`${spec.relPath}: ${errorText(err)}`);
        }
    }
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
