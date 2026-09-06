// ===========================================
// Per-edit mutation — the daemon-scoped bridge between the two hook windows
// ===========================================
// PreToolUse and PostToolUse are separate hook invocations that share only the
// daemon process. A run that outlived the PreToolUse budget has to be findable
// again in the PostToolUse window, so the handles live here — one store for the
// life of the daemon, reaped on every access.
//
// Correlation is by CONTENT, not by ordering. Two edits to the same file in
// flight at once, or an edit that never landed, must not let one window's
// results be reported against another window's bytes. Hashing the exact overlay
// that was measured makes a mismatch a miss rather than a wrong answer.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createPendingStore, type PendingRun, type PendingStore, reapExpired } from "./pending-runs.js";
import {
	readMutationStateFile,
	writeMutationStateFileAtomic,
} from "./mutation-local-state.js";

/**
 * Identity of the exact text a run measured.
 *
 * Short by design — this is a correlation key inside one process, not a
 * security boundary, and it appears in log lines a human reads.
 */
export function overlayHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

let store: PendingStore | null = null;

// ---- durable registry (2026-08-23, campaign U5) ----
// The in-memory store dies with the daemon, and this repo's daemon restarts
// freely (build-refresh handovers, RSS recycles). A run that outlived the
// PreToolUse budget used to lose its handle in any restart between the two
// windows — the engine's work was discarded. The store is now write-through
// to one JSON file under .interlinked/ (gitignored, so runner topology never
// reaches the public tree) and lazily loaded after a restart. Load/save fail
// soft: a missing or corrupt file only means the old in-memory semantics.
const PENDING_STORE_FILE = "pending-mutation-runs.json";
const MAX_PENDING_ROWS = 256;
const BYTES_PER_KIBIBYTE = 1024;
const MAX_PENDING_STORE_BYTES = MAX_PENDING_ROWS * BYTES_PER_KIBIBYTE;
const MAX_FILE_LENGTH = 4_096;
const MAX_JOB_ID_LENGTH = 256;
const MAX_RUNNER_URL_LENGTH = 2_048;
const PENDING_RUN_KEYS = "file,jobId,overlayHash,runnerUrl,startedAt";
const RUNNER_PROTOCOLS = new Set(["http:", "https:"]);
let storeRoot: string | null = null;
let loadedFromDisk = false;

/** Point the registry at a repo root; enables persistence. Switching to a
 *  DIFFERENT root drops the in-memory rows first — handles from one repo must
 *  not bleed into another's harvest (external review 2026-08-23, finding 7). */
export function initPendingRegistryStore(root: string): void {
	let canonicalRoot: string;
	try {
		canonicalRoot = realpathSync(resolve(root));
	} catch {
		canonicalRoot = resolve(root);
	}
	if (storeRoot === canonicalRoot) return;
	if (storeRoot !== null) store = null;
	storeRoot = canonicalRoot;
	loadedFromDisk = false;
}

function hasPendingRunShape(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join(",") === PENDING_RUN_KEYS
	);
}

/** Exported for direct testing of the length/scheme/credential guard — every
 *  caller inside this module reaches it only through {@link boundedString},
 *  which already filters empty/oversized strings before this runs. */
export function parseRunnerUrl(value: unknown): URL | null {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_RUNNER_URL_LENGTH) {
		return null;
	}
	try {
		const url = new URL(value);
		if (!RUNNER_PROTOCOLS.has(url.protocol)) return null;
		if (url.username !== "" || url.password !== "") return null;
		return url;
	} catch {
		return null;
	}
}

function boundedString(value: unknown, maxLength: number): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength
		? value
		: null;
}

function parseContentIdentity(record: Record<string, unknown>): Pick<PendingRun, "file" | "overlayHash"> | null {
	const file = boundedString(record.file, MAX_FILE_LENGTH);
	const overlayHash = boundedString(record.overlayHash, 16);
	if (file === null || overlayHash === null || !/^[0-9a-f]{16}$/.test(overlayHash)) return null;
	return { file, overlayHash };
}

function parseRemoteIdentity(record: Record<string, unknown>): Pick<PendingRun, "jobId" | "runnerUrl"> | null {
	const jobId = boundedString(record.jobId, MAX_JOB_ID_LENGTH);
	const runnerUrl = boundedString(record.runnerUrl, MAX_RUNNER_URL_LENGTH);
	if (jobId === null || runnerUrl === null || parseRunnerUrl(runnerUrl) === null) return null;
	return { jobId, runnerUrl };
}

function parseStartedAt(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parsePendingRun(value: unknown): PendingRun | null {
	if (!hasPendingRunShape(value)) return null;
	const content = parseContentIdentity(value);
	const remote = parseRemoteIdentity(value);
	const startedAt = parseStartedAt(value.startedAt);
	if (content === null || remote === null || startedAt === null) return null;
	return { ...content, ...remote, startedAt };
}

function loadStoreOnce(target: PendingStore): void {
	if (loadedFromDisk || storeRoot === null) return;
	loadedFromDisk = true;
	try {
		const content = readMutationStateFile(storeRoot, PENDING_STORE_FILE, MAX_PENDING_STORE_BYTES);
		if (content === null) return;
		const parsed: unknown = JSON.parse(content);
		if (!Array.isArray(parsed) || parsed.length > MAX_PENDING_ROWS) return;
		for (const row of parsed) {
			const pending = parsePendingRun(row);
			if (pending !== null) target.runs.push(pending);
		}
	} catch (err) {
		// Corrupt/unreadable ⇒ in-memory-only semantics; never a gate.
		void err;
	}
}

/** Write the current handles through to disk. Call after a mutation (record or
 *  claim). Fail-soft: persistence is best-effort evidence, never a gate. */
export function commitPendingRegistry(): void {
	if (storeRoot === null || store === null) return;
	try {
		writeMutationStateFileAtomic(storeRoot, PENDING_STORE_FILE, JSON.stringify(store.runs));
	} catch (err) {
		void err;
	}
}

/** The process-wide store, created on first use and reaped on every access so
 *  an abandoned run cannot accumulate for the life of a long daemon. After a
 *  daemon restart the store rehydrates from disk (expired rows reaped on the
 *  same access), so a run in flight across the restart stays claimable. */
export function pendingRegistry(now: number = Date.now()): PendingStore {
	if (store === null) {
		store = createPendingStore();
		loadStoreOnce(store);
	}
	reapExpired(store, now);
	return store;
}

/** Drop everything. Tests only — a shared singleton would otherwise leak state
 *  across cases and make failures depend on execution order. */
export function resetPendingRegistry(): void {
	store = null;
	storeRoot = null;
	loadedFromDisk = false;
}
