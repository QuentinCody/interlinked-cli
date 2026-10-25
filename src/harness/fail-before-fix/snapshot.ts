// ===========================================
// fail-before-fix — a disposable copy of the project as git sees it
// ===========================================
// Tracked plus untracked-but-not-ignored files (`git ls-files -co --exclude-standard`), symlinks kept as links,
// the root node_modules linked, and chosen files replaced or removed. Ignored bulk (scratch data, build output,
// caches) is never copied: the coverage overlay copies it, which costs gigabytes on this repository.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ProjectCopy { dir: string; cleanup(): void; }

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

function copyEntry(root: string, dir: string, rel: string): void {
    const source = join(root, rel), target = join(dir, rel), link = isLink(source);
    if (!link && !existsSync(source)) return; // a tracked file deleted in the working tree
    mkdirSync(dirname(target), { recursive: true });
    if (link) symlinkSync(readlinkSync(source), target);
    else if (lstatSync(source).isFile()) copyFileSync(source, target);
}

function applyOverrides(dir: string, overrides: ReadonlyMap<string, string | null>): void {
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
    try {
        for (const rel of files) copyEntry(root, dir, rel);
        const modules = join(root, "node_modules");
        if (existsSync(modules) && !existsSync(join(dir, "node_modules"))) symlinkSync(modules, join(dir, "node_modules"));
        applyOverrides(dir, overrides);
    } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
    }
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
