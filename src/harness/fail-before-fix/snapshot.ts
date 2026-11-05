// ===========================================
// fail-before-fix — a disposable copy of the project as git sees it
// ===========================================
// Tracked plus untracked-but-not-ignored files (`git ls-files -co --exclude-standard`), symlinks kept as links,
// the root node_modules linked, and chosen files replaced or removed. Ignored bulk (scratch data, build output,
// caches) is never copied: the coverage overlay copies it, which costs gigabytes on this repository.

import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, promises as fsp, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ProjectCopy { dir: string; cleanup(): void; }
/** The async copy's handle: `cleanup` returns the removal so a caller can overlap it with the next run and await it later. */
export interface AsyncProjectCopy { dir: string; cleanup(): Promise<void>; }

/** Project-relative paths git shows (tracked + untracked, ignored excluded); null outside a git work tree. */
export function gitVisibleFiles(root: string): string[] | null {
    try {
        const out = execFileSync("git", ["-C", root, "ls-files", "-z", "-co", "--exclude-standard"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
        return [...new Set(out.split("\0").filter(Boolean))];
    } catch { return null; }
}

function isLink(path: string): boolean {
    try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** A comparison write must stay inside its copy and may never follow a symlink (including node_modules). */
export function copyWriteTarget(dir: string, path: string): string {
    const target = resolve(dir, path), rel = relative(dir, target);
    if (!rel || isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error(`comparison path escapes its copy: ${path}`);
    let current = dir;
    for (const part of rel.split(sep)) {
        current = join(current, part);
        if (isLink(current)) throw new Error(`comparison write would follow a symlink: ${path}`);
    }
    return target;
}

/** A link whose target resolves inside the root must point at the COPY's twin, never back at the live tree
 *  (kill-proof review N1/N2: an absolute in-repo link made the copy load the live, unmutated file). */
function copiedLinkTarget(rootReal: string, dir: string, source: string, target: string): string {
    const raw = readlinkSync(source);
    let real: string;
    try { real = realpathSync(resolve(dirname(source), raw)); } catch { return raw; }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return raw;
    return relative(dirname(target), join(dir, relative(rootReal, real))) || ".";
}

function copyEntry(root: string, dir: string, rel: string): void {
    const source = join(root, rel), target = join(dir, rel), link = isLink(source);
    if (!link && !existsSync(source)) return; // a tracked file deleted in the working tree
    mkdirSync(dirname(target), { recursive: true });
    if (link) symlinkSync(copiedLinkTarget(root, dir, source, target), target);
    // COPYFILE_FICLONE: a copy-on-write clone where the file system offers one (APFS, btrfs, XFS reflink);
    // elsewhere Node falls back to a byte copy. A proof copies the whole git-visible tree twice per run.
    else if (lstatSync(source).isFile()) copyFileSync(source, target, constants.COPYFILE_FICLONE);
}

/** Writes each override into an existing copy (null removes the file); every target goes through `copyWriteTarget`. */
export function applyOverrides(dir: string, overrides: ReadonlyMap<string, string | null>): void {
    for (const [rel, content] of overrides) {
        const target = copyWriteTarget(dir, rel);
        if (content === null) { rmSync(target, { force: true }); continue; }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
}

/** Copies the git-visible project, links node_modules, then writes each override (null removes the file). */
export function createProjectCopy(root: string, files: readonly string[], overrides: ReadonlyMap<string, string | null>): ProjectCopy {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "interlinked-fail-before-fix-")));
    const rootReal = realpathSync(root);
    try {
        for (const rel of files) copyEntry(rootReal, dir, rel);
        const modules = join(root, "node_modules");
        if (existsSync(modules) && !existsSync(join(dir, "node_modules"))) symlinkSync(modules, join(dir, "node_modules"));
        applyOverrides(dir, overrides);
    } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
    }
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Regular files in flight at once. Copying is bound by per-file create latency, not bytes (2026-11-05, 5,990 files on
 *  ext4: 0.4 ms median per `copyFileSync`); 64 concurrent copies cut one tree from ~2.2 s to ~0.65 s
 *  (`docs/reviews/kill-proof-performance.md`). */
const COPY_CONCURRENCY = 64;

/**
 * `createProjectCopy` with the regular-file copies issued concurrently. The resulting tree is the same: the same
 * entries are visited in the same order, directories and links are created synchronously exactly as `copyEntry`
 * does, only the byte copies run in parallel, and the node_modules link and the overrides are written after every
 * copy has finished (an override may replace a copied file).
 */
export async function createProjectCopyAsync(root: string, files: readonly string[], overrides: ReadonlyMap<string, string | null>): Promise<AsyncProjectCopy> {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "interlinked-fail-before-fix-")));
    const rootReal = realpathSync(root);
    try {
        const made = new Set<string>(), pending: string[] = [];
        for (const rel of files) {
            const source = join(rootReal, rel), target = join(dir, rel), link = isLink(source);
            if (!link && !existsSync(source)) continue;
            const parent = dirname(target);
            if (!made.has(parent)) { mkdirSync(parent, { recursive: true }); made.add(parent); }
            if (link) symlinkSync(copiedLinkTarget(rootReal, dir, source, target), target);
            else if (lstatSync(source).isFile()) pending.push(rel);
        }
        let next = 0;
        const worker = async (): Promise<void> => {
            while (next < pending.length) {
                const rel = pending[next++] ?? "";
                await fsp.copyFile(join(rootReal, rel), join(dir, rel), constants.COPYFILE_FICLONE);
            }
        };
        const workers = Array.from({ length: Math.min(COPY_CONCURRENCY, pending.length) }, worker);
        const settled = await Promise.allSettled(workers);
        const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failed) throw failed.reason;
        const modules = join(root, "node_modules");
        if (existsSync(modules) && !existsSync(join(dir, "node_modules"))) symlinkSync(modules, join(dir, "node_modules"));
        applyOverrides(dir, overrides);
    } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
    }
    return { dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}
