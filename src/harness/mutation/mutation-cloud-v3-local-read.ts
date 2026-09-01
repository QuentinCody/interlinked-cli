// =====================================================================
// Mutation cloud v3 — confined, descriptor-bound local input reads
// =====================================================================

import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface BoundedLocalRead {
	root: string;
	path: string;
	maxBytes: number;
	label: string;
}

interface ConfinedReadHooks {
	/** Deterministic pre-open replacement seam used by security tests. */
	afterPathValidated?: (path: string) => void;
	/** Deterministic race-injection seam used by the local security tests. */
	afterDescriptorValidated?: (path: string) => void;
}

interface ConfinedCandidate {
	realRoot: string;
	requested: string;
	resolvedTarget: string;
	path: string;
	initial: BigIntStats;
}

function isInside(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (!fromRoot.startsWith("../") && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function confinedCandidate(input: BoundedLocalRead): ConfinedCandidate {
	const realRoot = realpathSync(input.root);
	const requested = resolve(realRoot, input.path);

	// Resolve both the complete path (to preserve the existing confinement
	// check for an outward-pointing symlink) and its parent. Opening through
	// the canonical parent prevents a parent-directory swap from redirecting
	// the descriptor outside the repository.
	const resolvedTarget = realpathSync(requested);
	if (!isInside(realRoot, resolvedTarget)) {
		throw new Error(`${input.label} must resolve inside the repository root`);
	}
	const realParent = realpathSync(dirname(requested));
	if (!isInside(realRoot, realParent)) {
		throw new Error(`${input.label} must resolve inside the repository root`);
	}
	const path = join(realParent, basename(requested));
	const initial = lstatSync(path, { bigint: true });
	if (initial.isSymbolicLink()) throw new Error(`${input.label} must not be a symbolic link`);
	if (!initial.isFile()) throw new Error(`${input.label} must be a regular file`);
	return { realRoot, requested, resolvedTarget, path, initial };
}

function noFollowFlag(): number {
	// Node exposes O_NOFOLLOW on supported POSIX hosts. Windows does not
	// implement it, so the descriptor/path identity checks below provide the
	// portable fail-closed fallback instead of passing an unsupported flag.
	// SAFETY: @types/node declares O_NOFOLLOW unconditionally, but it is
	// genuinely absent on some non-Windows builds — read it through an
	// unknown-typed indirection so the runtime-optional fallback below stays
	// reachable instead of being typed away by the (dishonest) .d.ts.
	const noFollow = (constants as Record<string, unknown>).O_NOFOLLOW as number | undefined;
	return process.platform === "win32" ? 0 : (noFollow ?? 0);
}

function errorCode(error: unknown): string | null {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: null;
}

function openDescriptor(path: string, label: string): number {
	try {
		return openSync(path, constants.O_RDONLY | noFollowFlag());
	} catch (error) {
		if (errorCode(error) === "ELOOP") {
			throw new Error(`${label} must not be a symbolic link`, { cause: error });
		}
		throw error;
	}
}

function checkedLimit(input: BoundedLocalRead): bigint {
	if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 || input.maxBytes >= Number.MAX_SAFE_INTEGER) {
		throw new Error(`${input.label} has an invalid local byte limit`);
	}
	return BigInt(input.maxBytes);
}

function assertInitialDescriptor(input: BoundedLocalRead, status: BigIntStats): void {
	if (!status.isFile()) throw new Error(`${input.label} must be a regular file`);
	if (status.size > checkedLimit(input)) {
		throw new Error(`${input.label} exceeds the ${input.maxBytes}-byte local limit`);
	}
}

function readBoundedDescriptor(fd: number, input: BoundedLocalRead, expectedSize: bigint): Uint8Array {
	// One extra byte distinguishes an exact-cap file from a concurrently grown
	// one without materializing both a chunk list and a concatenated copy.
	const bytes = Buffer.allocUnsafe(Number(expectedSize) + 1);
	let total = 0;
	while (total < bytes.byteLength) {
		const count = readSync(fd, bytes, total, bytes.byteLength - total, null);
		if (count === 0) break;
		total += count;
		if (total > input.maxBytes) {
			throw new Error(`${input.label} exceeds the ${input.maxBytes}-byte local limit`);
		}
	}
	return bytes.subarray(0, total);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
	const hasStableNodeIdentity = left.dev !== 0n || left.ino !== 0n || right.dev !== 0n || right.ino !== 0n;
	return hasStableNodeIdentity
		? left.dev === right.dev && left.ino === right.ino
		: left.birthtimeNs === right.birthtimeNs && left.ctimeNs === right.ctimeNs;
}

function descriptorUnchanged(before: BigIntStats, after: BigIntStats): boolean {
	return sameIdentity(before, after) &&
		before.mode === after.mode &&
		before.nlink === after.nlink &&
		before.size === after.size &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs;
}

interface StableReadInput {
	candidate: ConfinedCandidate;
	label: string;
	before: BigIntStats;
	after: BigIntStats;
}

function changedError(label: string, cause?: unknown): Error {
	return new Error(`${label} changed while it was being read`, cause === undefined ? undefined : { cause });
}

function currentPathStatus(input: StableReadInput): BigIntStats {
	try {
		return lstatSync(input.candidate.path, { bigint: true });
	} catch (error) {
		throw changedError(input.label, error);
	}
}

function assertRequestedPathStable(input: StableReadInput): void {
	let resolvedAfter: string;
	let requestedStatus: BigIntStats;
	try {
		resolvedAfter = realpathSync(input.candidate.requested);
		requestedStatus = lstatSync(resolvedAfter, { bigint: true });
	} catch (error) {
		throw changedError(input.label, error);
	}
	if (!isInside(input.candidate.realRoot, resolvedAfter) || resolvedAfter !== input.candidate.resolvedTarget) {
		throw changedError(input.label);
	}
	if (!requestedStatus.isFile() || !sameIdentity(input.before, requestedStatus)) {
		throw changedError(input.label);
	}
}

function assertStableRead(input: StableReadInput): void {
	if (!input.after.isFile() || !descriptorUnchanged(input.before, input.after)) {
		throw changedError(input.label);
	}
	const current = currentPathStatus(input);
	if (!current.isFile() || !sameIdentity(input.before, current)) {
		throw changedError(input.label);
	}
	assertRequestedPathStable(input);
}

/**
 * Read one repository-confined regular file through exactly one descriptor.
 * The pathname is never used as the data source after open: the descriptor is
 * bounded and validated before/after the read, then matched back to the path.
 */
export function readConfinedFileBytes(
	input: BoundedLocalRead,
	hooks: ConfinedReadHooks = {},
): Uint8Array {
	const candidate = confinedCandidate(input);
	hooks.afterPathValidated?.(candidate.path);
	const fd = openDescriptor(candidate.path, input.label);
	try {
		const before = fstatSync(fd, { bigint: true });
		assertInitialDescriptor(input, before);
		if (!descriptorUnchanged(candidate.initial, before)) throw changedError(input.label);
		hooks.afterDescriptorValidated?.(candidate.path);
		const bytes = readBoundedDescriptor(fd, input, before.size);
		const after = fstatSync(fd, { bigint: true });
		assertStableRead({ candidate, label: input.label, before, after });
		if (BigInt(bytes.byteLength) !== before.size) {
			throw new Error(`${input.label} changed while it was being read`);
		}
		return bytes;
	} finally {
		closeSync(fd);
	}
}

export function readConfinedFileText(input: BoundedLocalRead): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(readConfinedFileBytes(input));
}
