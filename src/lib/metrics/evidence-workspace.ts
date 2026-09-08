import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const EVIDENCE_WORKSPACE_EXCLUDED = new Set([".git", ".interlinked", ".codex", ".claude", ".agents", ".cache"]);
export const MAX_WORKSPACE_FILES = 200_000, MAX_WORKSPACE_BYTES = 4 * 1024 ** 3;
export interface CopyWorkspaceOptions { source: string; destination: string; deadline: number; signal?: AbortSignal; }

export function assertWorkspaceActive(options: Pick<CopyWorkspaceOptions, "deadline" | "signal">): void {
    if (options.signal?.aborted || Date.now() >= options.deadline) throw new Error("Workspace copy or hashing cancelled or exceeded time budget");
}

async function copyLink(source: string, target: string, root: string): Promise<void> {
    const resolved = relative(root, await realpath(source));
    if (resolved === ".." || resolved.startsWith("../") || isAbsolute(resolved)) throw new Error(`External symlink cannot be isolated: ${relative(root, source)}`);
    const link = await readlink(source);
    if (isAbsolute(link)) throw new Error("Absolute symlinks require a prepared isolated runner workspace");
    await symlink(link, target);
}

interface CopyProgress { queue: string[]; directories: Array<{ path: string; mode: number }>; count: number; bytes: number; root: string; }
async function copyEntry(path: string, options: CopyWorkspaceOptions, progress: CopyProgress): Promise<void> {
    assertWorkspaceActive(options);
    const source = join(progress.root, path), target = resolve(options.destination, path), stat = await lstat(source);
    progress.bytes += stat.size;
    if (++progress.count > MAX_WORKSPACE_FILES || progress.bytes > MAX_WORKSPACE_BYTES) throw new Error("Workspace exceeds isolation copy bound (200k entries / 4 GiB)");
    await mkdir(dirname(target), { recursive: true });
    if (stat.isDirectory()) { await mkdir(target, { recursive: true }); progress.queue.push(path); progress.directories.push({ path: target, mode: stat.mode & 0o777 }); return; }
    if (stat.isSymbolicLink()) { await copyLink(source, target, progress.root); return; }
    if (!stat.isFile()) throw new Error(`Unsupported workspace input: ${path}`);
    await copyFile(source, target, constants.COPYFILE_FICLONE);
}

export async function copyEvidenceWorkspace(options: CopyWorkspaceOptions): Promise<void> {
    assertWorkspaceActive(options);
    const progress: CopyProgress = { queue: [""], directories: [], root: await realpath(options.source), count: 0, bytes: 0 };
    for (let index = 0; index < progress.queue.length; index++) {
        assertWorkspaceActive(options);
        const directory = progress.queue[index] ?? "";
        for (const child of await readdir(join(progress.root, directory), { withFileTypes: true })) {
            if (!EVIDENCE_WORKSPACE_EXCLUDED.has(child.name)) await copyEntry(join(directory, child.name), options, progress);
        }
    }
    for (const directory of progress.directories.reverse()) {
        assertWorkspaceActive(options);
        await chmod(directory.path, directory.mode);
    }
    assertWorkspaceActive(options);
}

/** Only call for the disposable mkdtemp tree. Links are removed without changing their targets. */
export async function removeEvidenceWorkspace(workspace: string): Promise<void> {
    const directories = [workspace];
    for (const directory of directories) {
        const stat = await lstat(directory).catch(error => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        });
        if (!stat?.isDirectory()) continue;
        await chmod(directory, (stat.mode & 0o777) | 0o700);
        for (const child of await readdir(directory, { withFileTypes: true })) {
            if (child.isDirectory()) directories.push(join(directory, child.name));
        }
    }
    await rm(workspace, { recursive: true, force: true });
}
