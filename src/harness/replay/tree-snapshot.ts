// ===========================================
// G2 per-tool-call working-tree snapshots
// ===========================================
// Captures the COMPLETE working tree (tracked + index + untracked-not-
// ignored) as a git tree object at tool-call boundaries, via a persistent
// per-session temp index — probe-measured ~50 ms warm / ~330 ms cold on this
// repo, real index/worktree/refs untouched, ignores honored (which keeps
// `.interlinked/` and its live socket out), sockets silently skipped by git
// (docs/design/reproducibility/g2-tree-snapshots.md).
//
// GC safety (probe-verified: `git gc --prune=now` reaps unanchored trees):
// every snapshot becomes a commit parented on the previous snapshot commit,
// and ONE ref per session — refs/interlinked/replay/<session> — keeps the
// whole chain reachable. A ref on the latest TREE would not protect earlier
// trees (trees don't reference each other).
//
// Contract: never throws — every failure logs and returns null (capture must
// never break the daemon pipeline). Gated by INTERLINKED_REPLAY_TREE_SNAPSHOTS=1
// until the config knob lands (scratch/CAMPAIGN-replay-env.md deviations).

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import { sanitizeSessionId } from "../session-paths.js";
import { recordStateSnapshot } from "./state-archive.js";

export interface TreeSnapshotRecord {
	schema: "tree-snapshot.v1";
	session_id: string;
	seq: number | null;
	tool_use_id: string | null;
	phase: "pre" | "post";
	backend: "git";
	tree: string;
	commit: string;
	ts: string;
}

function isSnapshotPhase(value: unknown): value is "pre" | "post" {
	return value === "pre" || value === "post";
}

/** Validate one snapshot-index line. Exported for direct testing. */
export function parseTreeSnapshotRecord(value: unknown): TreeSnapshotRecord | null {
	if (!isJsonObject(value)) return null;
	if (value.schema !== "tree-snapshot.v1") return null;
	if (value.backend !== "git") return null;
	if (!isSnapshotPhase(value.phase)) return null;
	const { session_id, tree, commit, ts } = value;
	if (typeof session_id !== "string" || typeof tree !== "string") return null;
	if (typeof commit !== "string" || typeof ts !== "string") return null;
	const seq = value.seq ?? null;
	if (seq !== null && typeof seq !== "number") return null;
	const toolUseId = value.tool_use_id ?? null;
	if (toolUseId !== null && typeof toolUseId !== "string") return null;
	return {
		schema: "tree-snapshot.v1",
		session_id,
		seq,
		tool_use_id: toolUseId,
		phase: value.phase,
		backend: "git",
		tree,
		commit,
		ts,
	};
}

const REF_PREFIX = "refs/interlinked/replay/";

/** Ident for the synthetic snapshot commits — never depends on repo config. */
const SNAPSHOT_IDENT = {
	GIT_AUTHOR_NAME: "interlinked-replay",
	GIT_AUTHOR_EMAIL: "replay@interlinked.local",
	GIT_COMMITTER_NAME: "interlinked-replay",
	GIT_COMMITTER_EMAIL: "replay@interlinked.local",
} as const;

export function snapshotIndexPath(cwd: string): string {
	return join(cwd, ".interlinked", "replay", "snapshots", "index.jsonl");
}

function indexCachePath(cwd: string, safeSession: string): string {
	return join(cwd, ".interlinked", "replay", "snapshots", "index-cache", `${safeSession}.gitindex`);
}

function git(cwd: string, args: string[], extraEnv?: Record<string, string>): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, ...extraEnv },
	}).trim();
}

/** The previous snapshot commit for the chain, or null on the first one. */
function chainParent(cwd: string, ref: string): string | null {
	try {
		return git(cwd, ["rev-parse", "-q", "--verify", ref]);
	} catch (err) {
		void err; // no ref yet — first snapshot of the session
		return null;
	}
}

/** Capture one snapshot. Warm path is a stat-cache `add .` + `write-tree` on
 *  the session's persistent temp index (~50 ms measured); the cold first call
 *  seeds the index from HEAD. Returns the appended record, or null on any
 *  failure (fail-open — see module header). */
export function recordTreeSnapshot(opts: {
	cwd: string;
	sessionId: string;
	seq: number | null | undefined;
	toolUseId: string | null | undefined;
	phase: "pre" | "post";
	log: (msg: string) => void;
}): TreeSnapshotRecord | null {
	try {
		const safe = sanitizeSessionId(opts.sessionId) || "unknown-session";
		const idx = indexCachePath(opts.cwd, safe);
		mkdirSync(dirname(idx), { recursive: true });
		const indexEnv = { GIT_INDEX_FILE: idx };
		if (!existsSync(idx)) git(opts.cwd, ["read-tree", "HEAD"], indexEnv);
		git(opts.cwd, ["add", "."], indexEnv);
		const tree = git(opts.cwd, ["write-tree"], indexEnv);

		const ref = REF_PREFIX + safe;
		const parent = chainParent(opts.cwd, ref);
		const message = `seq=${opts.seq ?? "?"} tool_use=${opts.toolUseId ?? "-"} phase=${opts.phase}`;
		const commitArgs = parent
			? ["commit-tree", tree, "-p", parent, "-m", message]
			: ["commit-tree", tree, "-m", message];
		const commit = git(opts.cwd, commitArgs, SNAPSHOT_IDENT);
		git(opts.cwd, ["update-ref", ref, commit]);

		const record: TreeSnapshotRecord = {
			schema: "tree-snapshot.v1",
			session_id: opts.sessionId,
			seq: opts.seq ?? null,
			tool_use_id: opts.toolUseId ?? null,
			phase: opts.phase,
			backend: "git",
			tree,
			commit,
			ts: new Date().toISOString(),
		};
		const indexPath = snapshotIndexPath(opts.cwd);
		mkdirSync(dirname(indexPath), { recursive: true });
		appendFileSync(indexPath, `${JSON.stringify(record)}\n`);
		return record;
	} catch (err) {
		opts.log(
			`tree snapshot failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

/** Load every parseable snapshot-index row. Tolerant of torn tail writes. */
export function loadSnapshotIndex(cwd: string): TreeSnapshotRecord[] {
	const path = snapshotIndexPath(cwd);
	if (!existsSync(path)) return [];
	const out: TreeSnapshotRecord[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = parseTreeSnapshotRecord(JSON.parse(line));
			if (parsed) out.push(parsed);
		} catch (err) {
			void err; // torn/foreign line — skipping is this reader's contract
		}
	}
	return out;
}

/** Materialize a captured tree into an (empty) destination directory —
 *  probe-verified byte-identical via `git archive | tar -x`. Throws on
 *  failure: restore is an EXPLICIT operation (Tier 2), not a hook path. */
export function restoreTree(cwd: string, treeSha: string, destDir: string): void {
	mkdirSync(destDir, { recursive: true });
	const tarBuf = execFileSync("git", ["archive", "--format=tar", treeSha], {
		cwd,
		maxBuffer: 1 << 28,
	});
	const result = spawnSync("tar", ["-x", "-C", destDir], { input: tarBuf });
	if (result.status !== 0) {
		throw new Error(`tar extract failed: ${result.stderr.toString()}`);
	}
}

/** Map a hook event name to a snapshot phase; null = not a tool boundary. */
export function phaseForHookEvent(hookEvent: string | undefined): "pre" | "post" | null {
	if (hookEvent === "PreToolUse" || hookEvent === "BeforeTool") return "pre";
	if (hookEvent === "PostToolUse" || hookEvent === "PostToolUseFailure" || hookEvent === "AfterTool")
		return "post";
	return null;
}

/** Event-loop wiring hook: when INTERLINKED_REPLAY_TREE_SNAPSHOTS=1, record
 *  the working-tree snapshot AND the per-step harness-state archive at every
 *  tool boundary. Inert otherwise; always fail-open. */
export function maybeRecordReplaySnapshots(opts: {
	cwd: string;
	sessionId: string;
	seq: number | null;
	toolUseId: string | null;
	phase: "pre" | "post" | null;
	liveSnapshot: JsonObject | null;
	log: (msg: string) => void;
}): void {
	if (process.env.INTERLINKED_REPLAY_TREE_SNAPSHOTS !== "1") return;
	if (opts.phase === null) return;
	recordTreeSnapshot({
		cwd: opts.cwd,
		sessionId: opts.sessionId,
		seq: opts.seq,
		toolUseId: opts.toolUseId,
		phase: opts.phase,
		log: opts.log,
	});
	recordStateSnapshot({
		cwd: opts.cwd,
		sessionId: opts.sessionId,
		seq: opts.seq,
		liveSnapshot: opts.liveSnapshot,
		log: opts.log,
	});
}
