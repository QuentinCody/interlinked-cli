// ===========================================
// T2 restore — materialize a fork point
// ===========================================
// Restores everything a divergent rollout needs at step N of a recorded
// session (docs/design/reproducibility/tier2-onpolicy-env.md):
//   1. the working tree — G2's chain-anchored tree snapshot for that seq;
//   2. the harness state — the per-step state archive's live snapshot +
//      baseline water-line files, written back under the sandbox's
//      .interlinked/ so a daemon started there sees the same ratchets;
//   3. the reservation cache — rebuilt from reservation-events.jsonl through
//      `replayTransitions` (its FIRST production consumption; the log lacks
//      seq until the G3 deferred item lands, so the cutoff is the step's ts).
// Restore is an EXPLICIT operation: it throws loudly, unlike the fail-open
// capture paths.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import {
	type ReservationCache,
	type ReservationTxn,
	replayTransitions,
} from "../reservations-state-machine.js";
import { loadStateSnapshot } from "./state-archive.js";
import { loadSnapshotIndex, restoreTree } from "./tree-snapshot.js";

interface RestoreSummary {
	tree: string;
	state_found: boolean;
	baselines_written: number;
}

/** Materialize session step `seq` into `destDir`: tree + archived state. */
export function restoreSessionStep(opts: {
	cwd: string;
	sessionId: string;
	seq: number;
	destDir: string;
}): RestoreSummary {
	const rows = loadSnapshotIndex(opts.cwd).filter(
		(r) => r.session_id === opts.sessionId && r.seq === opts.seq,
	);
	// Prefer the PRE snapshot (the world the model was looking at); fall back
	// to post when only that phase was captured for the seq.
	const row = rows.find((r) => r.phase === "pre") ?? rows[0];
	if (!row) {
		throw new Error(
			`no tree snapshot for session=${opts.sessionId} seq=${opts.seq} — was the daemon running with INTERLINKED_REPLAY_TREE_SNAPSHOTS=1?`,
		);
	}
	restoreTree(opts.cwd, row.tree, opts.destDir);

	const state = loadStateSnapshot(opts.cwd, opts.sessionId, opts.seq);
	let baselinesWritten = 0;
	if (state) {
		const interlinkedDir = join(opts.destDir, ".interlinked");
		mkdirSync(interlinkedDir, { recursive: true });
		writeFileSync(
			join(interlinkedDir, "restored-live-snapshot.json"),
			JSON.stringify(state.live_snapshot ?? {}, null, 2),
		);
		for (const [name, content] of Object.entries(state.baselines)) {
			if (content === null) continue;
			writeFileSync(join(interlinkedDir, name), content);
			baselinesWritten++;
		}
	}
	return { tree: row.tree, state_found: state !== null, baselines_written: baselinesWritten };
}

function grantTxnForLogEvent(row: JsonObject, file: string, agent: string): ReservationTxn | null {
	if (!file || !agent) return null;
	const ts = typeof row.ts === "string" ? row.ts : "";
	const expires = typeof row.expires_at === "string" ? row.expires_at : ts;
	return row.cohort === "remote"
		? { kind: "grant_remote", file, agent, reservedAt: ts, expiresAt: expires }
		: { kind: "grant_local", file, agent, reservedAt: ts, expiresAt: expires };
}

function txnForLogEvent(row: JsonObject): ReservationTxn | null {
	const file = typeof row.file === "string" ? row.file : "";
	const agent = typeof row.agent_name === "string" ? row.agent_name : "";
	switch (row.action) {
		case "grant":
			return grantTxnForLogEvent(row, file, agent);
		case "release":
			return file && agent ? { kind: "release", file, agent } : null;
		case "release_all":
			return agent ? { kind: "release_all", agent } : null;
		default:
			return null; // conflict rows record contention, not state change
	}
}

/** Rebuild the reservation cache as of an ISO-timestamp cutoff (inclusive)
 *  by replaying the event log through the state machine. */
export function rebuildReservationCacheAt(cwd: string, cutoffTs: string): ReservationCache {
	const path = join(cwd, ".interlinked", "reservation-events.jsonl");
	if (!existsSync(path)) return new Map();
	const txns: ReservationTxn[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = JSON.parse(line);
			if (!isJsonObject(row)) continue;
			if (typeof row.ts !== "string" || row.ts > cutoffTs) continue;
			const txn = txnForLogEvent(row);
			if (txn) txns.push(txn);
		} catch (err) {
			void err; // torn/foreign line — skipping is this reader's contract
		}
	}
	return replayTransitions(txns);
}
