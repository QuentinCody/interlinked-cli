import type { BigIntStats } from "node:fs";
import { hashBytes } from "./inventory.js";

export interface WorkspaceInput { path: string; kind: "file" | "directory" | "symlink"; hash: string; mode: number; }
export interface EvidenceWorkspaceSnapshot { hash: string; inputs: WorkspaceInput[]; }
export interface WorkspaceSnapshotOptions { deadline: number; signal?: AbortSignal; artifact: string; }
const STATE_KEYS = ["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs"] as const;

export function sameWorkspaceState(left: BigIntStats, right: BigIntStats): boolean {
    return STATE_KEYS.every(key => left[key] === right[key]);
}

/** Both synchronous consumers and asynchronous execution use exactly this representation. */
export function workspaceSnapshot(inputs: WorkspaceInput[]): EvidenceWorkspaceSnapshot {
    inputs.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return { hash: hashBytes(JSON.stringify(["copied-runtime-inputs-v1", inputs])), inputs };
}
