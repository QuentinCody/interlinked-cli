// ===========================================
// Skill installers — safe fan-out across supported runners
// ===========================================

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClientName } from "./settings.js";
import {
    countCurrentSkillFiles,
    errorText,
    noteRefusedSkillFiles,
    reportLegacySkillTargets,
    type SkillInspectionLedger,
} from "./skill-install-inspect.js";
import {
    assertSafeSkillPath,
    loadSkillInstallManifest,
    type ManagedSkillFile,
    removeManagedSkillFiles,
    removeOwnedFilesForClients,
    SKILL_INSTALL_MANIFEST,
    type SkillInstallManifest,
    writeManagedSkillFiles,
} from "./skill-install-ownership.js";
import {
    hasSkillName,
    legacyComparableText,
    recognizedCursorAlias,
    recognizedLegacySkill,
} from "./skill-legacy-match.js";
import {
    buildSkillConfig,
    type RunnerSkillTarget,
    renderTargetContent,
    runnerTargets,
    type SkillRenderConfig,
} from "./skill-install-templates.js";
import {
    ENFORCE_SKILL,
    findEnforceSkillSource,
    findSkillSource,
    listInstallableSkills,
    readSkillSourceFiles,
    type SkillSourceFile,
} from "./skill-source-files.js";

export { findEnforceSkillSource, findSkillSource, listInstallableSkills };

const CANONICAL_SKILLS_DIR = join(".interlinked", "skills");

export interface SkillInstallResult {
    skill: string;
    client: ClientName;
    path: string;
    installed: boolean;
    changed?: boolean;
    error?: string;
}

interface SkillInstallationInspection {
    expectedFiles: number;
    currentFiles: number;
    issues: string[];
    /** Sorted names of the bundled skills with at least one issue or refusal. */
    staleSkills: string[];
    /** Existing files a refresh would refuse: `<relPath> (modified|unowned)`. */
    blockedFiles: string[];
}

function sourceSkillContent(files: readonly SkillSourceFile[]): string {
    const entry = files.find((file) => file.relPath === "SKILL.md");
    if (!entry) throw new Error("Bundled skill has no SKILL.md entry");
    return entry.content.toString("utf-8");
}

function oldSkillRelPath(client: ClientName, name: string): string | null {
    if (client === "codex") return join(".codex", "skills", name, "SKILL.md");
    if (client === "gemini") return join(".gemini", "extensions", name, "SKILL.md");
    return null;
}

function readCandidate(cwd: string, relPath: string): Buffer | null {
    try {
        const target = assertSafeSkillPath(cwd, relPath);
        return existsSync(target) ? readFileSync(target) : null;
    } catch {
        return null;
    }
}

/** Recognize the old manifestless installer by its duplicate canonical/runner
 * SKILL.md copies. A single user-owned file is never enough evidence. */
function collectLegacyEvidence(
    cwd: string,
    clients: readonly ClientName[],
    name: string,
    config: SkillRenderConfig,
): ReadonlyMap<string, Buffer> {
    const evidence = new Map<string, Buffer>();
    const canonicalRel = join(CANONICAL_SKILLS_DIR, name, "SKILL.md");
    const canonical = readCandidate(cwd, canonicalRel);
    if (!canonical || !hasSkillName(canonical.toString("utf-8"), name)) return evidence;
    const canonicalShape = legacyComparableText(canonical.toString("utf-8"));
    const candidates = clients.flatMap((client) => {
        const current = runnerTargets(client, name, config)
            .filter((target) => target.kind === "spec")
            .map((target) => target.relPath);
        const old = oldSkillRelPath(client, name);
        return old ? [...current, old] : current;
    });
    for (const relPath of candidates) {
        const runnerCopy = readCandidate(cwd, relPath);
        if (!runnerCopy || !hasSkillName(runnerCopy.toString("utf-8"), name)) continue;
        if (legacyComparableText(runnerCopy.toString("utf-8")) !== canonicalShape) continue;
        evidence.set(canonicalRel, canonical);
        evidence.set(relPath, runnerCopy);
    }
    return evidence;
}

function canonicalSpecs(
    name: string,
    files: readonly SkillSourceFile[],
    evidence: ReadonlyMap<string, Buffer>,
): ManagedSkillFile[] {
    return files.map((file) => ({
        relPath: join(CANONICAL_SKILLS_DIR, name, file.relPath),
        content: file.content,
        skill: name,
        owner: "canonical",
        kind: file.relPath === "SKILL.md" ? "spec" : "resource",
        ...(file.relPath === "SKILL.md"
            ? {
                  isRecognizedLegacy: recognizedLegacySkill(
                      file.content,
                      name,
                      evidence.get(join(CANONICAL_SKILLS_DIR, name, file.relPath)),
                  ),
              }
            : {}),
    }));
}

function specTargetFiles(args: {
    client: ClientName;
    name: string;
    config: SkillRenderConfig;
    target: RunnerSkillTarget;
    files: readonly SkillSourceFile[];
    skillContent: string;
    evidence: ReadonlyMap<string, Buffer>;
}): ManagedSkillFile[] {
    const base = dirname(args.target.relPath);
    return args.files.map((file) => {
        const relPath = join(base, file.relPath);
        const content =
            file.relPath === "SKILL.md"
                ? Buffer.from(
                      renderTargetContent(args.config, args.target, args.skillContent),
                  )
                : file.content;
        return {
            relPath,
            content,
            skill: args.name,
            owner: args.client,
            kind: file.relPath === "SKILL.md" ? "spec" : "resource",
            ...(file.relPath === "SKILL.md"
                ? {
                      isRecognizedLegacy: recognizedLegacySkill(
                          content,
                          args.name,
                          args.evidence.get(relPath),
                      ),
                  }
                : {}),
        };
    });
}

function targetFiles(
    client: ClientName,
    name: string,
    config: SkillRenderConfig,
    files: readonly SkillSourceFile[],
    skillContent: string,
    evidence: ReadonlyMap<string, Buffer> = new Map(),
): ManagedSkillFile[] {
    return runnerTargets(client, name, config).flatMap((target) => {
        if (target.kind === "spec") {
            return specTargetFiles({ client, name, config, target, files, skillContent, evidence });
        }
        return [
            {
                relPath: target.relPath,
                content: Buffer.from(renderTargetContent(config, target, skillContent)),
                skill: name,
                owner: client,
                kind: target.kind,
            },
        ];
    });
}

/** Targets used before native Codex/Gemini/Cursor skill discovery was adopted. */
function legacyTargets(
    client: ClientName,
    name: string,
    config: SkillRenderConfig,
    skillContent: string,
    evidence: ReadonlyMap<string, Buffer> = new Map(),
): Array<Pick<ManagedSkillFile, "relPath" | "isRecognizedLegacy">> {
    if (client === "cursor") {
        return [
            {
                relPath: join(".cursor", "rules", `${name}.mdc`),
                isRecognizedLegacy: recognizedCursorAlias(name),
            },
        ];
    }
    const oldRelPath = oldSkillRelPath(client, name);
    if (!oldRelPath) return [];
    const oldTarget: RunnerSkillTarget = { kind: "spec", relPath: oldRelPath };
    const oldContent = Buffer.from(renderTargetContent(config, oldTarget, skillContent));
    return [
        {
            relPath: oldRelPath,
            isRecognizedLegacy: recognizedLegacySkill(
                oldContent,
                name,
                evidence.get(oldRelPath),
            ),
        },
    ];
}

function failedResults(
    clients: readonly ClientName[],
    name: string,
    error: unknown,
): SkillInstallResult[] {
    return clients.map((client) => ({
        skill: name,
        client,
        path: "",
        installed: false,
        error: errorText(error),
    }));
}

interface CanonicalWrite {
    skillContent: string;
    config: SkillRenderConfig;
    legacyEvidence: ReadonlyMap<string, Buffer>;
}

/** Prepare + write the canonical copies, degrading to per-client failures.
 * `sourceSkillContent` throws on a malformed bundled skill and used to sit
 * OUTSIDE this boundary, so `installSkills` aborted the whole fan-out where
 * `installEnforceSkill` (which wraps its call) merely reported. */
function writeCanonicalCopies(
    cwd: string,
    clients: readonly ClientName[],
    name: string,
    files: readonly SkillSourceFile[],
    manifest: SkillInstallManifest,
): CanonicalWrite | SkillInstallResult[] {
    try {
        const skillContent = sourceSkillContent(files);
        const config = buildSkillConfig(name);
        const legacyEvidence = collectLegacyEvidence(cwd, clients, name, config);
        writeManagedSkillFiles(cwd, manifest, canonicalSpecs(name, files, legacyEvidence));
        return { skillContent, config, legacyEvidence };
    } catch (err) {
        return failedResults(clients, name, err);
    }
}

function installOneSkill(
    cwd: string,
    clients: readonly ClientName[],
    name: string,
    manifest: SkillInstallManifest,
): SkillInstallResult[] {
    const files = readSkillSourceFiles(name);
    if (!files) return failedResults(clients, name, `Skill source not found: ${name}`);
    const canonical = writeCanonicalCopies(cwd, clients, name, files, manifest);
    if (Array.isArray(canonical)) return canonical;
    const { skillContent, config, legacyEvidence } = canonical;

    return clients.map((client) => {
        const specs = targetFiles(client, name, config, files, skillContent, legacyEvidence);
        const primary = specs.find((spec) => spec.kind === "spec")?.relPath ?? specs[0]?.relPath ?? "";
        try {
            const write = writeManagedSkillFiles(cwd, manifest, specs);
            let cleanupError: string | undefined;
            try {
                removeManagedSkillFiles(
                    cwd,
                    manifest,
                    legacyTargets(client, name, config, skillContent, legacyEvidence),
                );
            } catch (err) {
                cleanupError = `Installed, but legacy target cleanup failed: ${errorText(err)}`;
            }
            return {
                skill: name,
                client,
                path: join(cwd, primary),
                installed: true,
                changed: write.changed,
                ...(cleanupError ? { error: cleanupError } : {}),
            };
        } catch (err) {
            return {
                skill: name,
                client,
                path: primary ? join(cwd, primary) : "",
                installed: false,
                error: errorText(err),
            };
        }
    });
}

function loadManifestOrResults(
    cwd: string,
    clients: readonly ClientName[],
    skills: readonly string[],
): SkillInstallManifest | SkillInstallResult[] {
    try {
        return loadSkillInstallManifest(cwd);
    } catch (err) {
        return skills.flatMap((name) => failedResults(clients, name, err));
    }
}

export function installSkills(cwd: string, clients: readonly ClientName[]): SkillInstallResult[] {
    const skills = listInstallableSkills();
    const loaded = loadManifestOrResults(cwd, clients, skills);
    if (Array.isArray(loaded)) return loaded;
    return skills.flatMap((name) => installOneSkill(cwd, clients, name, loaded));
}

function legacySpecsForSkill(
    cwd: string,
    name: string,
    clients: readonly ClientName[],
): Array<Pick<ManagedSkillFile, "relPath" | "isRecognizedLegacy">> {
    const files = readSkillSourceFiles(name);
    if (!files) return [];
    const skillContent = sourceSkillContent(files);
    const config = buildSkillConfig(name);
    const evidence = collectLegacyEvidence(cwd, clients, name, config);
    const current = clients.flatMap((client) =>
        targetFiles(client, name, config, files, skillContent, evidence),
    );
    const legacy = clients.flatMap((client) =>
        legacyTargets(client, name, config, skillContent, evidence),
    );
    return [...current, ...legacy];
}

export function uninstallSkills(cwd: string, clients: readonly ClientName[]): boolean {
    let manifest: SkillInstallManifest;
    try {
        manifest = loadSkillInstallManifest(cwd);
    } catch {
        return false;
    }
    let changed = removeOwnedFilesForClients(cwd, manifest, new Set(clients));
    for (const name of listInstallableSkills()) {
        if (removeManagedSkillFiles(cwd, manifest, legacySpecsForSkill(cwd, name, clients))) changed = true;
    }
    return changed;
}

export function installEnforceSkill(
    cwd: string,
    clients: readonly ClientName[],
): SkillInstallResult[] {
    try {
        return installOneSkill(cwd, clients, ENFORCE_SKILL, loadSkillInstallManifest(cwd));
    } catch (err) {
        return failedResults(clients, ENFORCE_SKILL, err);
    }
}

export function uninstallEnforceSkill(cwd: string, clients: readonly ClientName[]): boolean {
    let manifest: SkillInstallManifest;
    try {
        manifest = loadSkillInstallManifest(cwd);
    } catch {
        return false;
    }
    let changed = removeOwnedFilesForClients(
        cwd,
        manifest,
        new Set(clients),
        new Set([ENFORCE_SKILL]),
    );
    if (removeManagedSkillFiles(cwd, manifest, legacySpecsForSkill(cwd, ENFORCE_SKILL, clients))) {
        changed = true;
    }
    return changed;
}

/** The manifest for the read-only view. An unreadable one is an issue, and
 * every differing file then reads as unowned, as an install would treat it. */
function inspectionManifest(cwd: string, issues: string[]): SkillInstallManifest {
    try {
        return loadSkillInstallManifest(cwd);
    } catch (err) {
        issues.push(`${SKILL_INSTALL_MANIFEST}: ${errorText(err)}`);
        return { version: 1, files: {} };
    }
}

/** Inspect one bundled skill with the same legacy evidence an install would
 * use, so a predicted refusal matches what `doctor --fix` would do. */
function inspectOneSkill(
    cwd: string,
    clients: readonly ClientName[],
    name: string,
    files: readonly SkillSourceFile[],
    ledger: SkillInspectionLedger,
): { expected: number; current: number } {
    const skillContent = sourceSkillContent(files);
    const config = buildSkillConfig(name);
    const evidence = collectLegacyEvidence(cwd, clients, name, config);
    if (clients.length > 0) noteRefusedSkillFiles(cwd, canonicalSpecs(name, files, evidence), ledger);
    let expected = 0;
    let current = 0;
    for (const client of clients) {
        const specs = targetFiles(client, name, config, files, skillContent, evidence);
        expected += specs.length;
        current += countCurrentSkillFiles(cwd, specs, ledger);
        const legacy = legacyTargets(client, name, config, skillContent, evidence);
        reportLegacySkillTargets(cwd, legacy, ledger.issues);
    }
    return { expected, current };
}

/** Read-only: compare every runner copy with the bundled source and predict
 * which files a refresh would refuse to replace. Writes nothing. */
export function inspectInstalledSkills(
    cwd: string,
    clients: readonly ClientName[],
): SkillInstallationInspection {
    const issues: string[] = [];
    const ledger: SkillInspectionLedger = { manifest: inspectionManifest(cwd, issues), issues, blockedFiles: [] };
    let expectedFiles = 0;
    let currentFiles = 0;
    const staleSkills: string[] = [];
    for (const name of listInstallableSkills()) {
        const files = readSkillSourceFiles(name);
        if (!files) continue;
        const findingsBefore = issues.length + ledger.blockedFiles.length;
        const counts = inspectOneSkill(cwd, clients, name, files, ledger);
        expectedFiles += counts.expected;
        currentFiles += counts.current;
        if (issues.length + ledger.blockedFiles.length > findingsBefore) staleSkills.push(name);
    }
    return { expectedFiles, currentFiles, issues, staleSkills, blockedFiles: ledger.blockedFiles };
}
