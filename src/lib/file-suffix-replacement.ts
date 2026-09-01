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

/** Upper bound on bytes copied while appenders wait. A pathological single
 * record is refused instead of pausing every coding-agent hook indefinitely. */
const MAX_LOCKED_SUFFIX_BYTES = 64 * 1024 * 1024;

export interface FileIdentity {
	dev: string;
	ino: string;
}

export interface PreparedSuffixReplacement {
	source: FileIdentity;
	replacement: FileIdentity;
	temporaryPath: string;
	sourceBytes: number;
	retainedBytes: number;
}

export interface ReplaceFileSuffixOptions {
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

/** Replace a file with its suffix while every participating append writer is
 * excluded. `start` may have been computed before lock acquisition: the end is
 * deliberately re-read under the lock, so appends made meanwhile survive.
 * The callback runs after the complete replacement file exists but before the
 * atomic rename, allowing callers to publish recovery metadata first. */
export function replaceFileWithSuffix(
	path: string,
	start: number,
	options: ReplaceFileSuffixOptions = {},
): PreparedSuffixReplacement {
	return withFileMutationLock(path, () => {
		const source = fileIdentity(path);
		if (options.expectedSource && !sameFileIdentity(source, options.expectedSource)) {
			throw new FileIdentityChangedError(path);
		}
		const sourceStat = statSync(path);
		const sourceBytes = sourceStat.size;
		const sourceMode = sourceStat.mode & 0o7777;
		if (!Number.isSafeInteger(start) || start < 0 || start > sourceBytes) {
			throw new RangeError(`invalid suffix start ${start} for ${sourceBytes}-byte file`);
		}
		if (sourceBytes - start > MAX_LOCKED_SUFFIX_BYTES) {
			throw new RangeError(
				`refusing to hold the append lock while copying ${sourceBytes - start} bytes`,
			);
		}

		const temporaryPath = temporarySuffixPath(path);
		try {
			copyFileRange(path, temporaryPath, start, sourceBytes);
			chmodSync(temporaryPath, sourceMode);
			options.afterInitialCopy?.();
			// A non-participating legacy writer may have appended during the initial
			// copy. Capture that deterministic window too. Participating production
			// writers cannot enter it because the file lock is held.
			const finalBytes = statSync(path).size;
			if (finalBytes < sourceBytes) throw new FileIdentityChangedError(path);
			if (finalBytes > sourceBytes) {
				const appended = readFileRange(
					path,
					sourceBytes,
					finalBytes,
					MAX_MATERIALIZED_RANGE_BYTES,
				);
				appendFileSync(temporaryPath, appended);
			}
			const replacement = fileIdentity(temporaryPath);
			const prepared: PreparedSuffixReplacement = {
				source,
				replacement,
				temporaryPath,
				sourceBytes: finalBytes,
				retainedBytes: finalBytes - start,
			};
			options.beforeReplace?.(prepared);
			renameSync(temporaryPath, path);
			options.afterReplace?.(prepared);
			return prepared;
		} catch (error) {
			unlinkIfPresent(temporaryPath);
			throw error;
		}
	});
}
