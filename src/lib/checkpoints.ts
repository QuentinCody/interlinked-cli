// ===========================================
// Git Checkpoints — Snapshot & Rewind System
// ===========================================
// Uses git stash for active checkpoints and a metadata branch for archives.
// Checkpoint metadata stored in .interlinked/checkpoints.json.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "./config.js";
import { gitShell } from "./git-shell.js";
import type { JsonObject } from "./json-types.js";

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
		return JSON.parse(readFileSync(path, "utf-8")) as Checkpoint[];
	} catch (_err) {
		/* intentional: corrupt/missing checkpoints.json treated as empty list */
		return [];
	}
}

function writeCheckpointsFile(checkpoints: Checkpoint[], cwd: string): void {
	const path = getCheckpointsPath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(checkpoints, null, 2)}\n`);
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

	const id = generateId();
	const baseCommit = gitShell("rev-parse HEAD", cwd);

	// Get files with uncommitted changes
	let filesChanged: string[] = [];
	try {
		const diffOutput = gitShell("diff --name-only HEAD", cwd);
		const untrackedOutput = gitShell("ls-files --others --exclude-standard", cwd);
		filesChanged = [
			...diffOutput.split("\n").filter(Boolean),
			...untrackedOutput.split("\n").filter(Boolean),
		];
	} catch (_err) {
		/* intentional: empty repo or no changes — filesChanged stays empty */
	}

	// Create the stash with a structured message
	const stashMeta = JSON.stringify({
		id,
		session_id: opts.sessionId,
		agent: opts.agent,
		trigger: opts.trigger,
	});
	const stashMessage = `interlinked:checkpoint:${id}:${stashMeta}`;

	let stashRef: string | undefined;
	try {
		// Include untracked files in the stash
		gitShell(`stash push --include-untracked -m "${stashMessage}"`, cwd);
		// Get the stash ref
		stashRef = gitShell("stash list -1 --format=%H", cwd);
		// Immediately pop the stash to restore working tree
		// (we want to capture state, not remove it)
		gitShell("stash pop", cwd);
	} catch (_err) {
		/* intentional: stash failed (usually no changes) — record the checkpoint as metadata-only */
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

/**
 * Find the stash matching this checkpoint id and apply it.
 * Returns true if a matching stash was found and applied.
 */
function applyMatchingStash(cwd: string, id: string): boolean {
	try {
		const stashList = gitShell("stash list --format=%gd:%s", cwd);
		const stashLines = stashList.split("\n").filter(Boolean);
		for (const line of stashLines) {
			if (line.includes(`interlinked:checkpoint:${id}:`)) {
				const stashRef = line.split(":")[0];
				gitShell(`stash apply ${stashRef}`, cwd);
				return true;
			}
		}
	} catch (_err) {
		/* intentional: stash may have been dropped or list failed — applied stays false, warning reported to caller */
	}
	return false;
}

/**
 * Rewind working tree to a checkpoint state.
 * Finds the stash matching the checkpoint and applies it.
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

	if (!isGitRepo(cwd)) {
		throw new Error("Not a git repository.");
	}

	// Check for uncommitted changes
	let hasChanges = false;
	try {
		const status = gitShell("status --porcelain", cwd);
		hasChanges = status.length > 0;
	} catch (_err) {
		/* intentional: status failed — proceed as if tree is clean */
	}

	if (hasChanges && !opts?.force) {
		throw new Error(
			"Working tree has uncommitted changes. Use --force to discard them, or commit first.",
		);
	}

	// If force, reset working tree
	if (hasChanges && opts?.force) {
		gitShell("checkout -- .", cwd);
		gitShell("clean -fd", cwd);
	}

	// Reset to the base commit of the checkpoint
	const currentHead = gitShell("rev-parse HEAD", cwd);
	if (currentHead !== checkpoint.base_commit) {
		try {
			gitShell(`checkout ${checkpoint.base_commit}`, cwd);
		} catch (_err) {
			/* intentional: checkout failed — continue to stash apply below with current HEAD */
		}
	}

	// Find and apply the stash matching this checkpoint
	const applied = applyMatchingStash(cwd, id);

	const warning = applied
		? undefined
		: "Stash not found — restored to base commit only. File changes may be missing.";

	return {
		success: true,
		files_restored: checkpoint.files_changed,
		warning,
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

	const fromFiles = new Set(from.files_changed);
	const toFiles = new Set(to.files_changed);

	const added = to.files_changed.filter((f) => !fromFiles.has(f));
	const deleted = from.files_changed.filter((f) => !toFiles.has(f));
	const modified = to.files_changed.filter((f) => fromFiles.has(f));

	let diffSummary = "";
	try {
		diffSummary = gitShell(`diff --stat ${from.base_commit}..${to.base_commit}`, resolvedCwd);
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

	// Sort newest first to count active stashes
	const sorted = [...checkpoints].sort(
		(a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
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
