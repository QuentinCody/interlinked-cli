// ===========================================
// Skill installer ownership + safe filesystem operations
// ===========================================

import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmdirSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ClientName } from "./settings.js";

export const SKILL_INSTALL_MANIFEST = join(".interlinked", "skill-install-manifest.json");

export type SkillOwner = ClientName | "canonical";

export interface SkillManifestEntry {
    sha256: string;
    skill: string;
    owner: SkillOwner;
    kind: string;
}

export interface SkillInstallManifest {
    version: 1;
    files: Record<string, SkillManifestEntry>;
}

export interface ManagedSkillFile {
    relPath: string;
    content: Buffer;
    skill: string;
    owner: SkillOwner;
    kind: string;
    isRecognizedLegacy?: (content: Buffer) => boolean;
}

export interface ManagedWriteResult {
    changed: boolean;
}

const CANONICAL_MANIFEST_ROOT = join(".interlinked", "skills");
const CLIENT_SKILL_ROOTS: Record<ClientName, string> = {
    claude: join(".claude", "skills"),
    copilot: join(".github", "skills"),
    gemini: join(".gemini", "skills"),
    codex: join(".agents", "skills"),
    cursor: join(".cursor", "skills"),
    opencode: join(".opencode", "skills"),
    opencode2: join(".opencode", "skills"),
    pi: join(".pi", "skills"),
};

interface PlannedWrite {
    spec: ManagedSkillFile;
    previous: Buffer | null;
    previousEntry: SkillManifestEntry | undefined;
}

function digest(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
}

function isWithin(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Reject traversal and every existing symlink below cwd before a managed write/delete. */
export function assertSafeSkillPath(cwd: string, relPath: string): string {
    if (isAbsolute(relPath)) throw new Error(`Skill target must be repository-relative: ${relPath}`);
    const root = resolve(cwd);
    const target = resolve(root, relPath);
    if (!isWithin(root, target)) throw new Error(`Skill target escapes the repository: ${relPath}`);

    const parentRel = relative(root, dirname(target));
    let cursor = root;
    for (const segment of parentRel.split(sep).filter(Boolean)) {
        cursor = join(cursor, segment);
        if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
            throw new Error(`Refusing skill path through symlinked directory: ${relative(root, cursor)}`);
        }
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
        throw new Error(`Refusing symlinked skill target: ${relPath}`);
    }
    return target;
}

function ensureSafeParent(cwd: string, relPath: string): string {
    const target = assertSafeSkillPath(cwd, relPath);
    mkdirSync(dirname(target), { recursive: true });
    const realRoot = realpathSync(resolve(cwd));
    const realParent = realpathSync(dirname(target));
    if (!isWithin(realRoot, realParent)) {
        throw new Error(`Skill target parent escapes the repository: ${relPath}`);
    }
    return target;
}

function manifestEntries(value: unknown): Array<[string, unknown]> {
    if (!value || typeof value !== "object") {
        throw new Error("Skill install manifest is not an object");
    }
    const candidate = value as { version?: unknown; files?: unknown };
    if (
        candidate.version !== 1 ||
        !candidate.files ||
        typeof candidate.files !== "object" ||
        Array.isArray(candidate.files)
    ) {
        throw new Error("Unsupported or malformed skill install manifest");
    }
    return Object.entries(candidate.files);
}

function isSkillOwner(value: unknown): value is SkillOwner {
    return (
        value === "canonical" ||
        (typeof value === "string" && Object.prototype.hasOwnProperty.call(CLIENT_SKILL_ROOTS, value))
    );
}

function isValidManifestPath(relPath: string, entry: SkillManifestEntry): boolean {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.skill)) return false;
    const ownerRoot =
        entry.owner === "canonical" ? CANONICAL_MANIFEST_ROOT : CLIENT_SKILL_ROOTS[entry.owner];
    const skillRoot = join(ownerRoot, entry.skill);
    if (relPath.startsWith(`${skillRoot}${sep}`)) return true;
    return (
        entry.owner === "copilot" &&
        relPath === join(".github", "prompts", `${entry.skill}.prompt.md`)
    );
}

function validatedManifestEntry(relPath: string, value: unknown): SkillManifestEntry {
    if (!value || typeof value !== "object") {
        throw new Error(`Malformed skill install manifest entry: ${relPath}`);
    }
    const entry = value as Partial<SkillManifestEntry>;
    if (
        !isSkillOwner(entry.owner) ||
        typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        typeof entry.skill !== "string" ||
        typeof entry.kind !== "string"
    ) {
        throw new Error(`Malformed skill install manifest entry: ${relPath}`);
    }
    const complete = entry as SkillManifestEntry;
    if (!isValidManifestPath(relPath, complete)) {
        throw new Error(`Unsafe skill install manifest entry: ${relPath}`);
    }
    return complete;
}

function validateManifest(value: unknown): SkillInstallManifest {
    const files: Record<string, SkillManifestEntry> = Object.create(null);
    for (const [relPath, entry] of manifestEntries(value)) {
        files[relPath] = validatedManifestEntry(relPath, entry);
    }
    return { version: 1, files };
}

export function loadSkillInstallManifest(cwd: string): SkillInstallManifest {
    const path = assertSafeSkillPath(cwd, SKILL_INSTALL_MANIFEST);
    if (!existsSync(path)) return { version: 1, files: {} };
    try {
        return validateManifest(JSON.parse(readFileSync(path, "utf-8")));
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot read ${SKILL_INSTALL_MANIFEST}: ${detail}`, { cause: err });
    }
}

export function saveSkillInstallManifest(cwd: string, manifest: SkillInstallManifest): void {
    const target = ensureSafeParent(cwd, SKILL_INSTALL_MANIFEST);
    const tempRel = `${SKILL_INSTALL_MANIFEST}.tmp-${process.pid}-${randomUUID()}`;
    const temp = ensureSafeParent(cwd, tempRel);
    try {
        writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
        renameSync(temp, target);
    } finally {
        if (existsSync(temp)) unlinkSync(temp);
    }
}

function preflightWrite(
    cwd: string,
    manifest: SkillInstallManifest,
    spec: ManagedSkillFile,
): PlannedWrite {
    const target = assertSafeSkillPath(cwd, spec.relPath);
    const previous = existsSync(target) ? readFileSync(target) : null;
    const previousEntry = manifest.files[spec.relPath];
    if (previous === null) {
        return { spec, previous, previousEntry };
    }

    if (previousEntry) {
        if (digest(previous) !== previousEntry.sha256) {
            throw new Error(`Refusing to overwrite modified managed skill file: ${spec.relPath}`);
        }
        return { spec, previous, previousEntry };
    }

    if (spec.isRecognizedLegacy?.(previous) === true) {
        return { spec, previous, previousEntry };
    }
    throw new Error(`Refusing to overwrite unowned skill file: ${spec.relPath}`);
}

function restoreWrite(cwd: string, plan: PlannedWrite): void {
    const target = assertSafeSkillPath(cwd, plan.spec.relPath);
    if (plan.previous === null) {
        if (existsSync(target)) unlinkSync(target);
        return;
    }
    writeFileSync(target, plan.previous);
}

/** Write a target group transactionally and persist ownership only on success. */
export function writeManagedSkillFiles(
    cwd: string,
    manifest: SkillInstallManifest,
    specs: readonly ManagedSkillFile[],
): ManagedWriteResult {
    const duplicateCheck = new Set<string>();
    for (const spec of specs) {
        if (duplicateCheck.has(spec.relPath)) throw new Error(`Duplicate skill target: ${spec.relPath}`);
        duplicateCheck.add(spec.relPath);
    }
    const plans = specs.map((spec) => preflightWrite(cwd, manifest, spec));
    const changed = plans.some((plan) => !plan.previous?.equals(plan.spec.content));
    const applied: PlannedWrite[] = [];
    try {
        for (const plan of plans) {
            const target = ensureSafeParent(cwd, plan.spec.relPath);
            if (!plan.previous?.equals(plan.spec.content)) writeFileSync(target, plan.spec.content);
            manifest.files[plan.spec.relPath] = {
                sha256: digest(plan.spec.content),
                skill: plan.spec.skill,
                owner: plan.spec.owner,
                kind: plan.spec.kind,
            };
            applied.push(plan);
        }
        saveSkillInstallManifest(cwd, manifest);
        return { changed };
    } catch (err) {
        for (const plan of applied.reverse()) {
            try {
                restoreWrite(cwd, plan);
            } catch {
                // Best effort: retain the original error, which explains the failed transaction.
            }
            if (plan.previousEntry) manifest.files[plan.spec.relPath] = plan.previousEntry;
            else delete manifest.files[plan.spec.relPath];
        }
        throw err;
    }
}

function pruneEmptyParents(startDir: string, stopAt: string): void {
    let dir = startDir;
    for (let depth = 0; depth < 5; depth += 1) {
        if (dir === stopAt || !isWithin(stopAt, dir)) return;
        try {
            rmdirSync(dir);
        } catch {
            return;
        }
        dir = dirname(dir);
    }
}

function removeOne(
    cwd: string,
    manifest: SkillInstallManifest,
    spec: Pick<ManagedSkillFile, "relPath" | "isRecognizedLegacy">,
): boolean {
    const target = assertSafeSkillPath(cwd, spec.relPath);
    const entry = manifest.files[spec.relPath];
    if (!existsSync(target)) {
        if (entry) delete manifest.files[spec.relPath];
        return false;
    }
    const current = readFileSync(target);
    const ownedAndUnmodified = entry !== undefined && digest(current) === entry.sha256;
    const recognizedLegacy = entry === undefined && spec.isRecognizedLegacy?.(current) === true;
    if (!ownedAndUnmodified && !recognizedLegacy) {
        if (entry) delete manifest.files[spec.relPath];
        return false;
    }
    unlinkSync(target);
    delete manifest.files[spec.relPath];
    pruneEmptyParents(dirname(target), resolve(cwd));
    return true;
}

export function removeManagedSkillFiles(
    cwd: string,
    manifest: SkillInstallManifest,
    specs: readonly Pick<ManagedSkillFile, "relPath" | "isRecognizedLegacy">[],
): boolean {
    let changed = false;
    let manifestChanged = false;
    for (const spec of specs) {
        const hadEntry = manifest.files[spec.relPath] !== undefined;
        if (removeOne(cwd, manifest, spec)) changed = true;
        if (hadEntry && manifest.files[spec.relPath] === undefined) manifestChanged = true;
    }
    if (changed || manifestChanged) saveSkillInstallManifest(cwd, manifest);
    return changed;
}

/** Remove manifest-owned files for clients even when their source skill was renamed/removed. */
export function removeOwnedFilesForClients(
    cwd: string,
    manifest: SkillInstallManifest,
    clients: ReadonlySet<ClientName>,
    skills?: ReadonlySet<string>,
): boolean {
    const specs = Object.entries(manifest.files)
        .filter(
            ([, entry]) =>
                entry.owner !== "canonical" &&
                clients.has(entry.owner) &&
                (skills === undefined || skills.has(entry.skill)),
        )
        .map(([relPath]) => ({ relPath }));
    return removeManagedSkillFiles(cwd, manifest, specs);
}

export function contentDigest(content: Buffer): string {
    return digest(content);
}
