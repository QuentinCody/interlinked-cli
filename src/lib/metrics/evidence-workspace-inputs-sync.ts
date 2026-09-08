import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { hashBytes } from "./inventory.js";
import { assertWorkspaceActive, EVIDENCE_WORKSPACE_EXCLUDED, MAX_WORKSPACE_BYTES, MAX_WORKSPACE_FILES } from "./evidence-workspace.js";
import { sameWorkspaceState, workspaceSnapshot, type EvidenceWorkspaceSnapshot, type WorkspaceInput, type WorkspaceInputOptions } from "./evidence-workspace-state.js";

interface SnapshotContext { root: string; options: WorkspaceInputOptions; count: number; bytes: number; buffer: Buffer; }

function fileHash(path: string, before: BigIntStats, context: SnapshotContext): string {
    const descriptor = openSync(path, "r");
    try {
        if (!sameWorkspaceState(before, fstatSync(descriptor, { bigint: true }))) throw new Error("Workspace input changed before hashing");
        const hash = createHash("sha256");
        for (let position = 0; position < Number(before.size);) {
            assertWorkspaceActive(context.options);
            const length = Math.min(context.buffer.length, Number(before.size) - position);
            const bytesRead = readSync(descriptor, context.buffer, 0, length, position);
            if (!bytesRead) throw new Error("Workspace input shortened while hashing");
            hash.update(context.buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        if (!sameWorkspaceState(before, fstatSync(descriptor, { bigint: true })) || !sameWorkspaceState(before, lstatSync(path, { bigint: true }))) throw new Error("Workspace input changed while hashing");
        return hash.digest("hex");
    } finally { closeSync(descriptor); }
}

function inputAt(path: string, context: SnapshotContext): WorkspaceInput {
    assertWorkspaceActive(context.options);
    const absolute = join(context.root, path), stat = lstatSync(absolute, { bigint: true });
    context.bytes += Number(stat.size);
    if (++context.count > MAX_WORKSPACE_FILES || context.bytes > MAX_WORKSPACE_BYTES) throw new Error("Workspace exceeds isolation hash bound (200k entries / 4 GiB)");
    const mode = Number(stat.mode & 0o777n);
    if (stat.isDirectory()) return { path, kind: "directory", hash: "", mode };
    if (stat.isSymbolicLink()) {
        const destination = relative(context.root, realpathSync(absolute));
        if (destination === ".." || destination.startsWith("../") || isAbsolute(destination)) throw new Error(`External workspace symlink: ${path}`);
        const link = readlinkSync(absolute);
        if (isAbsolute(link)) throw new Error("Absolute workspace symlink cannot be isolated");
        return { path, kind: "symlink", hash: hashBytes(link), mode: 0 };
    }
    if (!stat.isFile()) throw new Error(`Unsupported workspace input: ${path}`);
    return { path, kind: "file", hash: fileHash(absolute, stat, context), mode };
}

/** Streaming and deadline-bounded freshness validation for synchronous status and scoring APIs. */
export function captureWorkspaceInputsSync(root: string, options: WorkspaceInputOptions): EvidenceWorkspaceSnapshot {
    assertWorkspaceActive(options);
    const context: SnapshotContext = { root: realpathSync(root), options, count: 0, bytes: 0, buffer: Buffer.allocUnsafe(64 * 1024) };
    const inputs: WorkspaceInput[] = [], directories = [""];
    const artifact = options.artifact === undefined ? undefined : resolve(context.root, options.artifact);
    for (let index = 0; index < directories.length; index++) {
        const directory = directories[index] ?? "";
        assertWorkspaceActive(options);
        for (const child of readdirSync(join(context.root, directory))) {
            const path = join(directory, child);
            if (EVIDENCE_WORKSPACE_EXCLUDED.has(child) || resolve(context.root, path) === artifact) continue;
            const input = inputAt(path, context);
            inputs.push(input);
            if (input.kind === "directory") directories.push(path);
        }
    }
    const snapshot = workspaceSnapshot(inputs);
    assertWorkspaceActive(options);
    return snapshot;
}
