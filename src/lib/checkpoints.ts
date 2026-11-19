// ===========================================
// Git Checkpoints — Snapshot & Rewind System
// ===========================================
// Uses git stash for active checkpoints and a metadata branch for archives.
// Checkpoint metadata stored in .interlinked/checkpoints.json.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type CheckpointSnapshotPlan,
	checkpointStateExclusions,
	checkpointStatePaths,
	findCheckpointSnapshot,
	isGitObjectId,
	prepareCheckpointSnapshot,
	restoreCheckpointSnapshot,
} from "./checkpoints-restoration.js";
import { getDataDir } from "./config.js";
import { gitArgs, gitArgsRaw, gitShell } from "./git-shell.js";
import { isJsonObject, type JsonObject } from "./json-types.js";
import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireObject, wireOptional, wireString } from "./value-validation.js";

// ===========================================
// Types
// ===========================================

export interface Checkpoint {
	id: string;
	session_id: string;
	agent: string;
	message: string;
	timestamp: string;
	base_commit: string;
	trigger: "manual" | "session_start" | "session_end" | "task_complete" | "periodic";
	files_changed: string[];
	stash_ref?: string | undefined;
	restorable: boolean;
	metadata?: JsonObject | undefined;
}

interface CreateCheckpointOpts {
	sessionId: string;
	agent: string;
	message: string;
	trigger: Checkpoint["trigger"];
	cwd?: string;
	metadata?: JsonObject;
}

const isCheckpoint = wireObject<Checkpoint>({
	id: wireString, session_id: wireString, agent: wireString, message: wireString,
	timestamp: wireString, base_commit: wireString,
	trigger: wireLiteral("manual", "session_start", "session_end", "task_complete", "periodic"),
	files_changed: wireArray(wireString), stash_ref: wireAbsentOptional(wireOptional(wireString)),
	restorable: wireBoolean, metadata: wireAbsentOptional(wireOptional(isJsonObject)),
});

interface RewindResult {
	success: boolean;
	files_restored: string[];
	warning?: string | undefined;
}

interface CompareResult {
	files_added: string[];
	files_modified: string[];
	files_deleted: string[];
	diff_summary: string;
}

// ===========================================
// Helpers
// ===========================================

function generateId(): string {
	return randomBytes(6).toString("hex"); // 12 hex chars
}

function getCheckpointsPath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "checkpoints.json");
}

/**
 * Check whether `cwd` sits inside a git repository.
 *
 * Deliberately NOT the `isGitRepo` in `git-utils.ts`: this one probes through
 * the same shell runner that every other checkpoint command uses, so the whole
 * module spawns git one way. The `git-utils` twin runs the argv/execFileSync
 * path. The two read alike but commit to different process-spawn mechanisms.
 */
function isGitRepo(cwd: string): boolean {
	try {
		gitShell("rev-parse --git-dir", cwd);
		return true;
	} catch (_err) {
		/* intentional: non-zero exit from rev-parse means we are not inside a git repo */
		return false;
	}
}

function readCheckpointsFile(cwd: string): Checkpoint[] {
	const path = getCheckpointsPath(cwd);
	if (!existsSync(path)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!wireArray(isCheckpoint)(parsed)) throw new Error("Expected an array of complete checkpoint records");
		return parsed;
	} catch (cause) {
		throw new Error(`Cannot load checkpoint metadata at ${path}; repair the invalid or unreadable file before continuing`, { cause });
	}
}

function writeCheckpointsFile(checkpoints: Checkpoint[], cwd: string): void {
	const path = getCheckpointsPath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(checkpoints, null, 2)}\n`);
}

function validateBaseCommit(checkpoint: Checkpoint): void {
	if (!isGitObjectId(checkpoint.base_commit)) {
		throw new Error(`Invalid checkpoint base commit for ${checkpoint.id}; expected a full SHA-1 or SHA-256 object ID`);
	}
}

// ===========================================
// Core Functions
// ===========================================

/**
 * Create a new checkpoint by stashing the current working tree state.
 */
export function createCheckpoint(opts: CreateCheckpointOpts): Checkpoint {
	const cwd = opts.cwd || process.cwd();

	if (!isGitRepo(cwd)) {
		throw new Error("Not a git repository. Checkpoints require git.");
	}
	// Validate existing metadata before any stash operation. A damaged ledger
	// must never become an empty history that a later append overwrites.
	readCheckpointsFile(cwd);

	const id = generateId();
	const baseCommit = gitShell("rev-parse HEAD", cwd);

	// Get files with uncommitted changes
	const diffOutput = gitArgsRaw(["diff", "--name-only", "-z", "HEAD"], cwd);
	const untrackedOutput = gitArgsRaw(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
	const statePaths = checkpointStatePaths(cwd);
	const filesChanged = [...diffOutput.split("\0"), ...untrackedOutput.split("\0")].filter((file) =>
		file.length > 0 && !statePaths.some((path) => file === path || file.startsWith(`${path}/`)),
	);

	// Create the stash with a structured message
	const stashMeta = JSON.stringify({
		id,
		session_id: opts.sessionId,
		agent: opts.agent,
		trigger: opts.trigger,
	});
	const stashMessage = `interlinked:checkpoint:${id}:${stashMeta}`;

	let stashRef: string | undefined;
	if (filesChanged.length > 0) {
		// Include untracked files in the stash
		gitArgs(["stash", "push", "--include-untracked", "-m", stashMessage, "--", ".", ...checkpointStateExclusions(cwd)], cwd);
		stashRef = findCheckpointSnapshot(cwd, id);
		if (!stashRef) throw new Error(`Checkpoint snapshot unavailable for ${id}`);
		gitArgs(["update-ref", `refs/interlinked/checkpoints/${id}`, stashRef], cwd);
		// Keep the captured object and restore its index/worktree without popping
		// whichever stash another actor may have pushed in the meantime.
		restoreCheckpointSnapshot(cwd, prepareCheckpointSnapshot(cwd, stashRef, baseCommit));
	}

	const checkpoint: Checkpoint = {
		id,
		session_id: opts.sessionId,
		agent: opts.agent,
		message: opts.message,
		timestamp: new Date().toISOString(),
		base_commit: baseCommit,
		trigger: opts.trigger,
		files_changed: filesChanged,
		stash_ref: stashRef,
		restorable: !!stashRef,
		metadata: opts.metadata,
	};

	// Append to checkpoints file
	const checkpoints = readCheckpointsFile(cwd);
	checkpoints.push(checkpoint);
	writeCheckpointsFile(checkpoints, cwd);

	return checkpoint;
}

/**
 * List checkpoints with optional filters.
 */
export function listCheckpoints(opts?: {
	session?: string;
	agent?: string;
	since?: number;
	limit?: number;
	cwd?: string;
}): Checkpoint[] {
	const cwd = opts?.cwd || process.cwd();
	let checkpoints = readCheckpointsFile(cwd);

	if (opts?.session) {
		checkpoints = checkpoints.filter((c) => c.session_id === opts.session);
	}
	if (opts?.agent) {
		checkpoints = checkpoints.filter((c) => c.agent === opts.agent);
	}
	if (opts?.since) {
		checkpoints = checkpoints.filter((c) => new Date(c.timestamp).getTime() >= opts.since!);
	}

	// Sort newest first
	checkpoints.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	if (opts?.limit && opts.limit > 0) {
		checkpoints = checkpoints.slice(0, opts.limit);
	}

	return checkpoints;
}

/**
 * Get a single checkpoint by ID.
 */
export function getCheckpoint(id: string, cwd?: string): Checkpoint | null {
	const checkpoints = readCheckpointsFile(cwd || process.cwd());
	return checkpoints.find((c) => c.id === id) || null;
}

function resolveCheckpointSnapshot(cwd: string, checkpoint: Checkpoint): CheckpointSnapshotPlan {
	try {
		const snapshot = checkpoint.stash_ref ?? findCheckpointSnapshot(cwd, checkpoint.id);
		if (snapshot === undefined) throw new Error("Missing snapshot object ID");
		return prepareCheckpointSnapshot(cwd, snapshot, checkpoint.base_commit);
	} catch (cause) {
		throw new Error(`Checkpoint snapshot unavailable for ${checkpoint.id}; working tree was preserved`, { cause });
	}
}

/**
 * Rewind working tree to a checkpoint state.
 * Applies a preflighted snapshot while preserving Interlinked-owned state.
 */
export function rewindToCheckpoint(
	id: string,
	opts?: { cwd?: string; force?: boolean },
): RewindResult {
	const cwd = opts?.cwd || process.cwd();
	const checkpoint = getCheckpoint(id, cwd);

	if (!checkpoint) {
		throw new Error(`Checkpoint not found: ${id}`);
	}

	if (!checkpoint.restorable) {
		throw new Error(
			`Checkpoint ${id} is not restorable (archived or no changes were stashed).`,
		);
	}
	validateBaseCommit(checkpoint);

	if (!isGitRepo(cwd)) {
		throw new Error("Not a git repository.");
	}
	gitArgs(["rev-parse", "--verify", "--end-of-options", `${checkpoint.base_commit}^{commit}`], cwd);

	// Check for uncommitted changes
	const hasChanges = gitShell("status --porcelain", cwd).length > 0;

	if (hasChanges && !opts?.force) {
		throw new Error(
			"Working tree has uncommitted changes. Use --force to discard them, or commit first.",
		);
	}
	const snapshot = resolveCheckpointSnapshot(cwd, checkpoint);

	// Detach HEAD without checking out or resetting owned state.
	const currentHead = gitShell("rev-parse HEAD", cwd);
	if (currentHead !== checkpoint.base_commit) {
		gitArgs(["update-ref", "--no-deref", "HEAD", checkpoint.base_commit, currentHead], cwd);
	}
	if ((hasChanges && opts?.force) || currentHead !== checkpoint.base_commit) {
		gitArgs(["restore", "--source", checkpoint.base_commit, "--staged", "--worktree", "--", ".", ...checkpointStateExclusions(cwd)], cwd);
	}
	if (hasChanges && opts?.force) gitArgs(["clean", "-fd", "--", ".", ...checkpointStateExclusions(cwd)], cwd);
	restoreCheckpointSnapshot(cwd, snapshot);

	return {
		success: true,
		files_restored: checkpoint.files_changed,
		warning: undefined,
	};
}

/**
 * Compare two checkpoints.
 */
export function compareCheckpoints(fromId: string, toId: string, cwd?: string): CompareResult {
	const resolvedCwd = cwd || process.cwd();
	const from = getCheckpoint(fromId, resolvedCwd);
	const to = getCheckpoint(toId, resolvedCwd);

	if (!from) throw new Error(`Checkpoint not found: ${fromId}`);
	if (!to) throw new Error(`Checkpoint not found: ${toId}`);
	validateBaseCommit(from);
	validateBaseCommit(to);

	const fromFiles = new Set(from.files_changed);
	const toFiles = new Set(to.files_changed);

	const added = to.files_changed.filter((f) => !fromFiles.has(f));
	const deleted = from.files_changed.filter((f) => !toFiles.has(f));
	const modified = to.files_changed.filter((f) => fromFiles.has(f));

	let diffSummary = "";
	try {
		diffSummary = gitArgs(["diff", "--stat", `${from.base_commit}..${to.base_commit}`, "--"], resolvedCwd);
	} catch (_err) {
		/* intentional: git diff unavailable — fall back to computed file counts */
		diffSummary = `${added.length} added, ${modified.length} modified, ${deleted.length} deleted`;
	}

	return {
		files_added: added,
		files_modified: modified,
		files_deleted: deleted,
		diff_summary: diffSummary,
	};
}

/**
 * Remove old checkpoints. Returns the number removed.
 */
export function pruneCheckpoints(opts?: {
	older_than_days?: number;
	keep_latest?: number;
	cwd?: string;
}): number {
	const cwd = opts?.cwd || process.cwd();
	let checkpoints = readCheckpointsFile(cwd);
	const originalCount = checkpoints.length;

	// Sort newest first
	checkpoints.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

	if (opts?.keep_latest && opts.keep_latest > 0) {
		checkpoints = checkpoints.slice(0, opts.keep_latest);
	}

	if (opts?.older_than_days && opts.older_than_days > 0) {
		const cutoff = Date.now() - opts.older_than_days * 24 * 60 * 60 * 1000;
		checkpoints = checkpoints.filter((c) => new Date(c.timestamp).getTime() >= cutoff);
	}

	writeCheckpointsFile(checkpoints, cwd);

	// Stash cleanup for removed checkpoints is best-effort and skipped here
	// for safety.

	return originalCount - checkpoints.length;
}

/**
 * Archive old stash checkpoints to metadata-only (drop stashes, keep metadata).
 */
export function archiveCheckpoints(opts?: {
	older_than_days?: number;
	max_stash_count?: number;
	cwd?: string;
}): { archived: number } {
	const cwd = opts?.cwd || process.cwd();
	const maxAge = (opts?.older_than_days || 7) * 24 * 60 * 60 * 1000;
	const maxStash = opts?.max_stash_count || 50;
	const cutoff = Date.now() - maxAge;

	const checkpoints = readCheckpointsFile(cwd);
	let archived = 0;

	// Retire the oldest active checkpoints first when capacity is exceeded.
	const sorted = [...checkpoints].sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	);

	let activeStashCount = sorted.filter((c) => c.restorable).length;

	for (const cp of sorted) {
		if (!cp.restorable) continue;

		const isOld = new Date(cp.timestamp).getTime() < cutoff;
		const isBeyondLimit = activeStashCount > maxStash;

		if (isOld || isBeyondLimit) {
			cp.restorable = false;
			cp.stash_ref = undefined;
			archived++;
			activeStashCount--;
		}
	}

	if (archived > 0) {
		writeCheckpointsFile(checkpoints, cwd);
	}

	return { archived };
}

/**
 * Check if an auto-checkpoint should be created based on event type.
 */
export function shouldAutoCheckpoint(
	eventType: string,
	config?: { auto_checkpoint_on?: string[] },
): boolean {
	const triggers = config?.auto_checkpoint_on || ["session_end", "task_complete"];
	const mapping: Record<string, string> = {
		session_start: "session_start",
		session_end: "session_end",
		task_completed: "task_complete",
	};
	return triggers.includes(mapping[eventType] || eventType);
}
