// ===========================================
// Append-safe suffix replacement
// ===========================================

import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	copyFileRange,
	MAX_MATERIALIZED_RANGE_BYTES,
	readFileRange,
} from "./bounded-file-io.js";
import { withFileMutationLock } from "./file-mutation-lock.js";

/** Bulk suffix copying happens before locking; only this bounded catch-up waits. */
const MAX_LOCKED_CATCHUP_BYTES = MAX_MATERIALIZED_RANGE_BYTES;

export interface FileIdentity {
	dev: string;
	ino: string;
}

interface PreparedSuffixReplacement {
	source: FileIdentity;
	replacement: FileIdentity;
	temporaryPath: string;
	sourceBytes: number;
	retainedBytes: number;
}

interface ReplaceFileSuffixOptions {
	expectedSource?: FileIdentity;
	afterInitialCopy?: (() => void) | undefined;
	beforeReplace?: ((prepared: PreparedSuffixReplacement) => void) | undefined;
	afterReplace?: ((prepared: PreparedSuffixReplacement) => void) | undefined;
}

export class FileIdentityChangedError extends Error {
	constructor(readonly path: string) {
		super(`append-only file identity changed before rotation: ${path}`);
		this.name = "FileIdentityChangedError";
	}
}

export function fileIdentity(path: string): FileIdentity {
	const stat = statSync(path, { bigint: true });
	return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function temporarySuffixPath(path: string): string {
	return join(dirname(path), `.${basename(path)}.rotate-${process.pid}-${randomUUID()}.tmp`);
}

function isMissingFileError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function unlinkIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
}

interface SuffixSnapshot {
    path: string; start: number; bytes: number; mode: number; source: FileIdentity;
}

function snapshotSuffix(path: string, start: number, options: ReplaceFileSuffixOptions): SuffixSnapshot {
    const source = fileIdentity(path);
    if (options.expectedSource && !sameFileIdentity(source, options.expectedSource)) throw new FileIdentityChangedError(path);
    const stat = statSync(path);
    if (!Number.isSafeInteger(start) || start < 0 || start > stat.size) throw new RangeError(`invalid suffix start ${start} for ${stat.size}-byte file`);
    return { path, start, bytes: stat.size, mode: stat.mode & 0o7777, source };
}

/** Called only under the append lock; a replacement/truncation invalidates the prepared copy. */
function catchUpSuffix(snapshot: SuffixSnapshot, temporaryPath: string): number {
    const { path, source, bytes } = snapshot;
    if (!sameFileIdentity(fileIdentity(path), source)) throw new FileIdentityChangedError(path);
    const finalBytes = statSync(path).size;
    if (finalBytes < bytes) throw new FileIdentityChangedError(path);
    const delta = finalBytes - bytes;
    if (delta > MAX_LOCKED_CATCHUP_BYTES) throw new RangeError(`refusing to hold the append lock while copying ${delta} catch-up bytes`);
    if (delta > 0) appendFileSync(temporaryPath, readFileRange(path, bytes, finalBytes, MAX_LOCKED_CATCHUP_BYTES));
    return finalBytes;
}

function commitSuffix(snapshot: SuffixSnapshot, temporaryPath: string, options: ReplaceFileSuffixOptions): PreparedSuffixReplacement {
    return withFileMutationLock(snapshot.path, () => {
        const finalBytes = catchUpSuffix(snapshot, temporaryPath);
        const prepared: PreparedSuffixReplacement = {
            source: snapshot.source, replacement: fileIdentity(temporaryPath), temporaryPath,
            sourceBytes: finalBytes, retainedBytes: finalBytes - snapshot.start,
        };
        options.beforeReplace?.(prepared);
        renameSync(temporaryPath, snapshot.path);
        options.afterReplace?.(prepared);
        return prepared;
    });
}

/** Prepare the immutable prefix of the suffix without excluding appenders, then
 * recheck identity and catch up under the lock before publishing recovery metadata
 * and atomically replacing the path. Append-only writers remain available during bulk I/O. */
export function replaceFileWithSuffix(
	path: string,
	start: number,
	options: ReplaceFileSuffixOptions = {},
): PreparedSuffixReplacement {
    const snapshot = snapshotSuffix(path, start, options);
    const temporaryPath = temporarySuffixPath(path);
    try {
        copyFileRange(path, temporaryPath, start, snapshot.bytes);
        chmodSync(temporaryPath, snapshot.mode);
        options.afterInitialCopy?.();
        return commitSuffix(snapshot, temporaryPath, options);
    } catch (error) {
        unlinkIfPresent(temporaryPath);
        throw error;
    }
}
