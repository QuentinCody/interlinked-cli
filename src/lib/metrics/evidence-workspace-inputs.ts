import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { hashBytes } from "./inventory.js";
import { assertWorkspaceActive, EVIDENCE_WORKSPACE_EXCLUDED, MAX_WORKSPACE_BYTES, MAX_WORKSPACE_FILES } from "./evidence-workspace.js";
import { sameWorkspaceState, workspaceSnapshot, type EvidenceWorkspaceSnapshot, type WorkspaceInput, type WorkspaceSnapshotOptions } from "./evidence-workspace-state.js";
export type { EvidenceWorkspaceSnapshot, WorkspaceSnapshotOptions } from "./evidence-workspace-state.js";

interface SnapshotContext { root: string; options: WorkspaceSnapshotOptions; count: number; bytes: number; buffer: Buffer; }

async function fileHash(path: string, before: BigIntStats, context: SnapshotContext): Promise<string> {
    const handle = await open(path, "r");
    try {
        if (!sameWorkspaceState(before, await handle.stat({ bigint: true }))) throw new Error("Workspace input changed before hashing");
        const hash = createHash("sha256");
        for (let position = 0; position < Number(before.size);) {
            assertWorkspaceActive(context.options);
            const length = Math.min(context.buffer.length, Number(before.size) - position);
            const { bytesRead } = await handle.read(context.buffer, 0, length, position);
            if (!bytesRead) throw new Error("Workspace input shortened while hashing");
            hash.update(context.buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        if (!sameWorkspaceState(before, await handle.stat({ bigint: true })) || !sameWorkspaceState(before, await lstat(path, { bigint: true }))) throw new Error("Workspace input changed while hashing");
        return hash.digest("hex");
    } finally { await handle.close(); }
}

async function inputAt(path: string, context: SnapshotContext): Promise<WorkspaceInput> {
    assertWorkspaceActive(context.options);
    const absolute = join(context.root, path), stat = await lstat(absolute, { bigint: true });
    context.bytes += Number(stat.size);
    if (++context.count > MAX_WORKSPACE_FILES || context.bytes > MAX_WORKSPACE_BYTES) throw new Error("Workspace exceeds isolation hash bound (200k entries / 4 GiB)");
    const mode = Number(stat.mode & 0o777n);
    if (stat.isDirectory()) return { path, kind: "directory", hash: "", mode };
    if (stat.isSymbolicLink()) {
        const destination = relative(context.root, await realpath(absolute));
        if (destination === ".." || destination.startsWith("../") || isAbsolute(destination)) throw new Error(`External workspace symlink: ${path}`);
        const link = await readlink(absolute);
        if (isAbsolute(link)) throw new Error("Absolute workspace symlink cannot be isolated");
        return { path, kind: "symlink", hash: hashBytes(link), mode: 0 };
    }
    if (!stat.isFile()) throw new Error(`Unsupported workspace input: ${path}`);
    return { path, kind: "file", hash: await fileHash(absolute, stat, context), mode };
}

async function snapshotContext(root: string, options: WorkspaceSnapshotOptions): Promise<SnapshotContext> {
    assertWorkspaceActive(options);
    return { root: await realpath(root), options, count: 0, bytes: 0, buffer: Buffer.allocUnsafe(64 * 1024) };
}

/** The copy policy defines runtime inputs, including ignored files and installed dependencies. */
export async function captureWorkspaceInputs(root: string, options: WorkspaceSnapshotOptions): Promise<EvidenceWorkspaceSnapshot> {
    const context = await snapshotContext(root, options), inputs: WorkspaceInput[] = [], directories = [""];
    const artifact = resolve(context.root, options.artifact);
    for (let index = 0; index < directories.length; index++) {
        const directory = directories[index] ?? "";
        assertWorkspaceActive(options);
        for (const child of await readdir(join(context.root, directory))) {
            const path = join(directory, child);
            if (EVIDENCE_WORKSPACE_EXCLUDED.has(child) || resolve(context.root, path) === artifact) continue;
            const input = await inputAt(path, context);
            inputs.push(input);
            if (input.kind === "directory") directories.push(path);
        }
    }
    const snapshot = workspaceSnapshot(inputs);
    assertWorkspaceActive(options);
    return snapshot;
}

/** Newly produced outputs are allowed; every original runtime input must remain unchanged. */
export async function changedWorkspaceInputs(root: string, snapshot: EvidenceWorkspaceSnapshot, options: WorkspaceSnapshotOptions): Promise<string[]> {
    const context = await snapshotContext(root, options), issues: string[] = [];
    for (const before of snapshot.inputs) {
        const after = await inputAt(before.path, context);
        if (before.kind !== after.kind || before.hash !== after.hash || before.mode !== after.mode) issues.push(`Runner changed runtime input: ${before.path}`);
    }
    assertWorkspaceActive(options);
    return issues;
}
