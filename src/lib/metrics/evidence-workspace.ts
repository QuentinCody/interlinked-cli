import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const EXCLUDED = new Set([".git", ".interlinked", ".codex", ".claude", ".agents", ".cache"]);
const MAX_FILES = 200_000, MAX_BYTES = 4 * 1024 ** 3;
export interface CopyWorkspaceOptions { source: string; destination: string; deadline: number; signal?: AbortSignal; }

async function copyLink(source: string, target: string, root: string): Promise<void> {
    const resolved = relative(root, await realpath(source));
    if (resolved === ".." || resolved.startsWith("../") || isAbsolute(resolved)) throw new Error(`External symlink cannot be isolated: ${relative(root, source)}`);
    const link = await readlink(source);
    if (isAbsolute(link)) throw new Error("Absolute symlinks require a prepared isolated runner workspace");
    await symlink(link, target);
}

interface CopyProgress { queue: string[]; count: number; bytes: number; root: string; }
async function copyEntry(path: string, options: CopyWorkspaceOptions, progress: CopyProgress): Promise<void> {
    if (options.signal?.aborted || Date.now() >= options.deadline) throw new Error("Workspace copy cancelled or exceeded time budget");
    const source = join(progress.root, path), target = resolve(options.destination, path), stat = await lstat(source);
    progress.bytes += stat.size;
    if (++progress.count > MAX_FILES || progress.bytes > MAX_BYTES) throw new Error("Workspace exceeds isolation copy bound (200k entries / 4 GiB)");
    await mkdir(dirname(target), { recursive: true });
    if (stat.isDirectory()) { await mkdir(target, { recursive: true }); progress.queue.push(path); return; }
    if (stat.isSymbolicLink()) { await copyLink(source, target, progress.root); return; }
    if (!stat.isFile()) throw new Error(`Unsupported workspace input: ${path}`);
    await copyFile(source, target, constants.COPYFILE_FICLONE);
}

export async function copyEvidenceWorkspace(options: CopyWorkspaceOptions): Promise<void> {
    const progress: CopyProgress = { queue: [""], root: await realpath(options.source), count: 0, bytes: 0 };
    for (let index = 0; index < progress.queue.length; index++) {
        const directory = progress.queue[index] ?? "";
        for (const child of await readdir(join(progress.root, directory), { withFileTypes: true })) {
            if (!EXCLUDED.has(child.name)) await copyEntry(join(directory, child.name), options, progress);
        }
    }
}
