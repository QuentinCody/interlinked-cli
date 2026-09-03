// ===========================================
// Skill installers — safe fan-out across supported runners
// ===========================================

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClientName } from "./settings.js";
import {
    countMatchingSkillFiles,
    errorText,
    reportLegacySkillTargets,
} from "./skill-install-inspect.js";
import {
    assertSafeSkillPath,
    loadSkillInstallManifest,
    type ManagedSkillFile,
    removeManagedSkillFiles,
    removeOwnedFilesForClients,
    type SkillInstallManifest,
    writeManagedSkillFiles,
} from "./skill-install-ownership.js";
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
}

function sourceSkillContent(files: readonly SkillSourceFile[]): string {
    const entry = files.find((file) => file.relPath === "SKILL.md");
    if (!entry) throw new Error("Bundled skill has no SKILL.md entry");
    return entry.content.toString("utf-8");
}

function normalizedDescription(content: string): string {
    return content.replace(
        /^(description\s*:\s*).+$/m,
        "$1\"__INTERLINKED_MANAGED_DESCRIPTION__\"",
    );
}

function hasSkillName(content: string, name: string): boolean {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^name\\s*:\\s*${escaped}\\s*$`, "m").test(content);
}

function recognizedLegacySkill(
    expected: Buffer,
    name: string,
    evidencedLegacy?: Buffer,
): (content: Buffer) => boolean {
    const expectedText = expected.toString("utf-8");
    return (content) => {
        const currentText = content.toString("utf-8");
        if (!hasSkillName(currentText, name)) return false;
        return (
            normalizedDescription(currentText) === normalizedDescription(expectedText) ||
            evidencedLegacy?.equals(content) === true
        );
    };
}

/** Both headings the pre-native-Cursor installer emitted: the generated
 * teaching-skill alias used `# <name>`, the hand-written enforce alias used the
 * slash-command form `# /<name>`. Recognizing only the first left every
 * `.cursor/rules/enforce.mdc` un-flagged by `doctor` and undeleted by
 * uninstall. Both still require the canonical-path pointer as corroboration. */
function recognizedCursorAlias(name: string): (content: Buffer) => boolean {
    const headings = [`# ${name} — Cursor rule alias`, `# /${name} — Cursor rule alias`];
    return (content) => {
        const text = content.toString("utf-8");
        return (
            headings.some((heading) => text.includes(heading)) &&
            text.includes(`.interlinked/skills/${name}/SKILL.md`)
        );
    };
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
        if (
            normalizedDescription(runnerCopy.toString("utf-8")) !==
            normalizedDescription(canonical.toString("utf-8"))
        ) {
            continue;
        }
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
                      renderTargetContent(
                          args.client,
                          args.config,
                          args.target,
                          args.skillContent,
                      ),
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
                content: Buffer.from(renderTargetContent(client, config, target, skillContent)),
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
    const oldContent = Buffer.from(renderTargetContent(client, config, oldTarget, skillContent));
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

export function inspectInstalledSkills(
    cwd: string,
    clients: readonly ClientName[],
): SkillInstallationInspection {
    let expectedFiles = 0;
    let currentFiles = 0;
    const issues: string[] = [];
    for (const name of listInstallableSkills()) {
        const files = readSkillSourceFiles(name);
        if (!files) continue;
        const skillContent = sourceSkillContent(files);
        const config = buildSkillConfig(name);
        for (const client of clients) {
            const specs = targetFiles(client, name, config, files, skillContent);
            expectedFiles += specs.length;
            currentFiles += countMatchingSkillFiles(cwd, specs, issues);
            reportLegacySkillTargets(cwd, legacyTargets(client, name, config, skillContent), issues);
        }
    }
    return { expectedFiles, currentFiles, issues };
}
