import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFileRange } from "./bounded-file-io.js";
import { isJsonObject } from "./json-types.js";

type RotatingLogName = "activity" | "collection" | "timeline";
const MAX_ROTATION_FENCE_MANIFEST_BYTES = 4 * 1024 * 1024;

/** Persistent fence published before a compactor can replace the live path. */
export function fileRotationFencePath(
	livePath: string,
	log: RotatingLogName,
): string {
	return join(dirname(livePath), "archive", `.pending-${log}-rotation.json`);
}

export class PendingFileRotationError extends Error {
	constructor(readonly livePath: string, readonly fencePath: string) {
		super(`refusing to replace ${livePath} while rotation recovery is pending at ${fencePath}`);
		this.name = "PendingFileRotationError";
	}
}

export class UnverifiableFileRotationStateError extends Error {
	constructor(readonly manifestPath: string, detail: string, options?: ErrorOptions) {
		super(`refusing whole-file replacement: cannot verify ${manifestPath}: ${detail}`, options);
		this.name = "UnverifiableFileRotationStateError";
	}
}

function rotationManifestPath(livePath: string, log: RotatingLogName): string {
	const archiveDir = join(dirname(livePath), "archive");
	return join(archiveDir, log === "activity" ? "manifest.json" : `manifest-${log}.json`);
}

function manifestHasPendingRotation(path: string): boolean {
	const bytes = statSync(path).size;
	if (bytes > MAX_ROTATION_FENCE_MANIFEST_BYTES) {
		throw new UnverifiableFileRotationStateError(
			path,
			`${bytes} bytes exceeds ${MAX_ROTATION_FENCE_MANIFEST_BYTES}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			readFileRange(path, 0, bytes, MAX_ROTATION_FENCE_MANIFEST_BYTES).toString("utf8"),
		);
	} catch (error) {
		throw new UnverifiableFileRotationStateError(path, "malformed JSON", { cause: error });
	}
	if (!isJsonObject(parsed) || !Array.isArray(parsed.segments)) {
		throw new UnverifiableFileRotationStateError(path, "missing segments array");
	}
	for (const segment of parsed.segments) {
		if (!isJsonObject(segment)) {
			throw new UnverifiableFileRotationStateError(path, "contains a malformed segment row");
		}
		if (Object.hasOwn(segment, "pending_live_drop")) return true;
	}
	return false;
}

/** Whole-file replacers call this while holding the live file's mutation lock.
 * Appenders deliberately do not: recovery includes appends made after a crash. */
export function assertNoPendingFileRotation(
	livePath: string,
	log: RotatingLogName,
): void {
	const fencePath = fileRotationFencePath(livePath, log);
	if (existsSync(fencePath)) throw new PendingFileRotationError(livePath, fencePath);
	const manifestPath = rotationManifestPath(livePath, log);
	if (existsSync(manifestPath) && manifestHasPendingRotation(manifestPath)) {
		throw new PendingFileRotationError(livePath, manifestPath);
	}
}
