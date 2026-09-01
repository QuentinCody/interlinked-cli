import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const TRANSACTION_VERSION = 1;
const LOCK_RELATIVE_PATH = join(".interlinked", "transactions", "commit.lock");

type FileKind = "missing" | "file" | "directory" | "symlink" | "other";

interface FileSnapshot {
	kind: FileKind;
	mode: number | null;
	sha256: string | null;
	content: Buffer | null;
}

interface PreparedWrite {
	path: string;
	content: Buffer | null;
	mode: number | null;
	baseline: FileSnapshot;
}

interface GatedWriteSpec {
	/** Absolute path, or a path relative to repoRoot. */
	path: string;
	/** Bytes to write; null deletes the target. */
	content: string | Uint8Array | null;
	/** Exact permission bits for a written file. Defaults to the prior mode or 0666. */
	mode?: number;
}

interface GatedWriteTransaction {
	readonly id: string;
	readonly repoRoot: string;
	readonly writes: readonly PreparedWrite[];
}

export class GatedWriteConflictError extends Error {
	readonly paths: readonly string[];

	constructor(paths: readonly string[]) {
		super(
			`Transactional write aborted; no files changed. Re-read and re-gate: ${paths.join(", ")}`,
		);
		this.name = "GatedWriteConflictError";
		this.paths = [...paths];
	}
}

export class GatedWriteLockError extends Error {
	readonly lockPath: string;

	constructor(lockPath: string, detail: string, options?: ErrorOptions) {
		super(`Transactional write lock unavailable at ${lockPath}: ${detail}`, options);
		this.name = "GatedWriteLockError";
		this.lockPath = lockPath;
	}
}

/** Public so command handlers can distinguish partial rollback from clean aborts. */
class GatedWriteRollbackError extends Error {
	readonly failures: readonly string[];

	constructor(cause: unknown, failures: readonly string[]) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`Transactional write failed (${reason}); guarded rollback incomplete: ${failures.join("; ")}`, {
			cause,
		});
		this.name = "GatedWriteRollbackError";
		this.failures = [...failures];
	}
}

interface StagedWrite {
	write: PreparedWrite;
	tempPath: string | null;
}

interface HeldLock {
	path: string;
	token: string;
}

function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function errorCode(error: unknown): unknown {
	if (typeof error !== "object" || error === null) return undefined;
	return Reflect.get(error, "code");
}

function snapshot(path: string): FileSnapshot {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return { kind: "missing", mode: null, sha256: null, content: null };
		}
		throw error;
	}
	const mode = stat.mode & 0o7777;
	if (stat.isFile()) {
		const content = readFileSync(path);
		return { kind: "file", mode, sha256: sha256(content), content };
	}
	if (stat.isDirectory()) return { kind: "directory", mode, sha256: null, content: null };
	if (stat.isSymbolicLink()) return { kind: "symlink", mode, sha256: null, content: null };
	return { kind: "other", mode, sha256: null, content: null };
}

function sameState(a: FileSnapshot, b: FileSnapshot): boolean {
	return a.kind === b.kind && a.mode === b.mode && a.sha256 === b.sha256;
}

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function canonicalTarget(repoRoot: string, input: string): string {
	const lexical = isAbsolute(input) ? resolve(input) : resolve(repoRoot, input);
	const realParent = realpathSync(dirname(lexical));
	const target = join(realParent, basename(lexical));
	if (!isInside(repoRoot, target)) {
		throw new Error(`Transactional target escapes the Git worktree: ${input}`);
	}
	return target;
}

function desiredMode(spec: GatedWriteSpec, baseline: FileSnapshot): number | null {
	if (spec.content === null) return null;
	if (spec.mode !== undefined) return spec.mode & 0o7777;
	return baseline.kind === "file" ? baseline.mode : 0o666 & ~process.umask();
}

/**
 * Capture every target before the expensive content gate runs. The returned
 * transaction is committed later with one worktree-scoped lock and a CAS of
 * all targets against these baselines.
 */
export function captureGatedWriteBaseline(
	repoRoot: string,
	specs: readonly GatedWriteSpec[],
): GatedWriteTransaction {
	const root = realpathSync(resolve(repoRoot));
	const seen = new Set<string>();
	const writes = specs.map((spec): PreparedWrite => {
		const path = canonicalTarget(root, spec.path);
		if (seen.has(path)) throw new Error(`Duplicate transactional target: ${path}`);
		seen.add(path);
		const baseline = snapshot(path);
		if (baseline.kind !== "missing" && baseline.kind !== "file") {
			throw new Error(`Transactional target must be a regular file or missing: ${path}`);
		}
		return {
			path,
			content:
				spec.content === null
					? null
					: Buffer.from(
							typeof spec.content === "string" ? spec.content : new Uint8Array(spec.content),
						),
			mode: desiredMode(spec, baseline),
			baseline,
		};
	});
	return { id: randomUUID(), repoRoot: root, writes };
}

/** Worktree-scoped lock path used by cooperating transactional commands. */
export function gatedWriteLockPath(repoRoot: string): string {
	return join(realpathSync(resolve(repoRoot)), LOCK_RELATIVE_PATH);
}

function uniqueTempPath(opts: {
	path: string;
	transactionId: string;
	purpose: "tx" | "rollback";
}): string {
	return join(
		dirname(opts.path),
		`.${basename(opts.path)}.interlinked-${opts.purpose}-${opts.transactionId}-${randomUUID()}.tmp`,
	);
}

function stageWrites(transaction: GatedWriteTransaction): StagedWrite[] {
	const staged: StagedWrite[] = [];
	try {
		for (const write of transaction.writes) {
			if (write.content === null) {
				staged.push({ write, tempPath: null });
				continue;
			}
			const tempPath = uniqueTempPath({
				path: write.path,
				transactionId: transaction.id,
				purpose: "tx",
			});
			writeFileSync(tempPath, write.content, { flag: "wx", mode: 0o600 });
			if (write.mode !== null) chmodSync(tempPath, write.mode);
			staged.push({ write, tempPath });
		}
		return staged;
	} catch (error) {
		cleanupTemps(staged);
		throw error;
	}
}

function cleanupTemps(staged: readonly StagedWrite[]): void {
	for (const entry of staged) {
		if (entry.tempPath === null || !existsSync(entry.tempPath)) continue;
		try {
			unlinkSync(entry.tempPath);
		} catch (cleanupError) {
			void cleanupError;
			// The primary transaction result is more actionable than temp cleanup.
		}
	}
}

function acquireLock(repoRoot: string): HeldLock {
	const path = join(repoRoot, LOCK_RELATIVE_PATH);
	mkdirSync(dirname(path), { recursive: true });
	const token = randomUUID();
	let fd: number;
	try {
		fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	} catch (error) {
		const detail = errorCode(error) === "EEXIST"
			? "another transaction owns it; retry only after that transaction finishes"
			: error instanceof Error
				? error.message
				: String(error);
		throw new GatedWriteLockError(path, detail, { cause: error });
	}
	try {
		writeFileSync(
			fd,
			JSON.stringify({
				version: TRANSACTION_VERSION,
				pid: process.pid,
				token,
				createdAtMs: Math.floor(performance.timeOrigin + performance.now()),
			}),
			"utf-8",
		);
	} catch (error) {
		closeSync(fd);
		try {
			unlinkSync(path);
		} catch (cleanupError) {
			void cleanupError;
			// The lock write error remains primary.
		}
		throw error;
	}
	closeSync(fd);
	return { path, token };
}

function readLockToken(path: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const token = Reflect.get(parsed, "token");
		return typeof token === "string" ? token : undefined;
	} catch {
		return undefined;
	}
}

function releaseLock(lock: HeldLock): void {
	if (readLockToken(lock.path) !== lock.token) {
		throw new GatedWriteLockError(lock.path, "ownership token changed; refusing to unlink it");
	}
	unlinkSync(lock.path);
}

function proposedState(write: PreparedWrite): FileSnapshot {
	if (write.content === null) {
		return { kind: "missing", mode: null, sha256: null, content: null };
	}
	return { kind: "file", mode: write.mode, sha256: sha256(write.content), content: write.content };
}

function restoreBaseline(write: PreparedWrite, transactionId: string): void {
	if (write.baseline.kind === "missing") {
		if (existsSync(write.path)) unlinkSync(write.path);
		return;
	}
	if (write.baseline.content === null || write.baseline.mode === null) {
		throw new Error(`Missing rollback bytes for ${write.path}`);
	}
	const tempPath = uniqueTempPath({ path: write.path, transactionId, purpose: "rollback" });
	try {
		writeFileSync(tempPath, write.baseline.content, { flag: "wx", mode: 0o600 });
		chmodSync(tempPath, write.baseline.mode);
		renameSync(tempPath, write.path);
	} finally {
		if (existsSync(tempPath)) unlinkSync(tempPath);
	}
}

function rollbackCommitted(
	transaction: GatedWriteTransaction,
	committed: readonly PreparedWrite[],
): string[] {
	const failures: string[] = [];
	for (const write of [...committed].reverse()) {
		try {
			if (!sameState(snapshot(write.path), proposedState(write))) {
				failures.push(`${write.path}: newer content present; rollback refused`);
				continue;
			}
			restoreBaseline(write, transaction.id);
		} catch (error) {
			failures.push(`${write.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return failures;
}

function applyStagedWrite(entry: StagedWrite): void {
	if (entry.write.content === null) {
		if (existsSync(entry.write.path)) unlinkSync(entry.write.path);
		return;
	}
	if (entry.tempPath === null) throw new Error(`Missing staged file for ${entry.write.path}`);
	renameSync(entry.tempPath, entry.write.path);
}

function rollbackFailure(
	transaction: GatedWriteTransaction,
	lock: HeldLock | null,
	committed: readonly PreparedWrite[],
	error: unknown,
): unknown {
	if (lock === null || committed.length === 0) return error;
	const rollbackFailures = rollbackCommitted(transaction, committed);
	return rollbackFailures.length > 0
		? new GatedWriteRollbackError(error, rollbackFailures)
		: error;
}

function releaseFailure(lock: HeldLock | null, failure: unknown): unknown {
	if (lock === null) return failure;
	try {
		releaseLock(lock);
		return failure;
	} catch (error) {
		return failure === undefined ? error : failure;
	}
}

/**
 * Commit a previously gated transaction. The lock is held across the CAS,
 * every rename, and guarded rollback. This prevents lost updates among
 * cooperating Interlinked transactional commands in one Git worktree.
 *
 * It is deliberately not a crash-atomic journal and cannot protect against
 * ordinary editors or shell writers that do not participate in this lock.
 */
export function commitGatedWrites(transaction: GatedWriteTransaction): void {
	const staged = stageWrites(transaction);
	let lock: HeldLock | null = null;
	const committed: PreparedWrite[] = [];
	let failure: unknown;
	try {
		lock = acquireLock(transaction.repoRoot);
		const drifted = transaction.writes
			.filter((write) => !sameState(snapshot(write.path), write.baseline))
			.map((write) => write.path);
		if (drifted.length > 0) throw new GatedWriteConflictError(drifted);
		for (const entry of staged) {
			applyStagedWrite(entry);
			committed.push(entry.write);
		}
	} catch (error) {
		failure = rollbackFailure(transaction, lock, committed, error);
	} finally {
		cleanupTemps(staged);
		failure = releaseFailure(lock, failure);
	}
	if (failure !== undefined) throw failure;
}
