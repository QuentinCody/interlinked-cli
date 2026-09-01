// ===========================================
// G2 per-step harness-state archive
// ===========================================
// The tree snapshot deliberately excludes `.interlinked/`, and nothing else
// retains harness state historically: `<id>.live.json` is overwritten every
// event and DELETED at SessionEnd (server/lifecycle-persist.ts), and the
// ratchet water-line files are mostly gitignored, so neither is recoverable
// from tree snapshots. This module archives, per step: the serialized live
// snapshot + the six baseline files — content-addressed so unchanged-state
// steps dedup to a single blob (the common case). Tier 2's restore reads
// THIS, never `live.json` (docs/design/reproducibility/g2-tree-snapshots.md).
//
// Contract: recordStateSnapshot never throws (fail-open, logs); the loader
// is for explicit restore/test paths.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { isJsonObject, type JsonObject } from "../../lib/json-types.js";
import { WATER_LINE_BASENAMES } from "../evaluator/water-line-files.js";
import { sanitizeSessionId } from "../session-paths.js";

/** The ratchet water-line files (audited 2026-07-24: only large-files +
 *  untested-files are git-tracked; the rest are gitignored or absent — which
 *  is exactly why they must ride the state archive, not the tree).
 *
 *  Derived from the shared guard set: this list used to be a hand-copy that
 *  had fallen three files behind (mutation-manifest, skipped-tests-baseline,
 *  check-evidence-baseline), so a Tier-2 restore rebuilt a PARTIAL water-line
 *  state. Deriving it means the archive cannot drift from the guards again. */
export const BASELINE_FILES: readonly string[] = WATER_LINE_BASENAMES;

interface HarnessStateSnapshot {
	schema: "state-snapshot.v1";
	live_snapshot: JsonObject | null;
	/** File content, or null when the file did not exist at capture time
	 *  (recorded explicitly — never silently missing). */
	baselines: Record<string, string | null>;
}

function isBaselinesRecord(value: unknown): value is Record<string, string | null> {
	return (
		isJsonObject(value) && Object.values(value).every((v) => v === null || typeof v === "string")
	);
}

/** Validate a decompressed state-archive blob. Exported for direct testing —
 *  `loadStateSnapshot` is the only production caller. */
export function parseHarnessStateSnapshot(value: unknown): HarnessStateSnapshot | null {
	if (!isJsonObject(value)) return null;
	if (value.schema !== "state-snapshot.v1") return null;
	const liveSnapshot = value.live_snapshot ?? null;
	if (liveSnapshot !== null && !isJsonObject(liveSnapshot)) return null;
	if (!isBaselinesRecord(value.baselines)) return null;
	return {
		schema: "state-snapshot.v1",
		live_snapshot: liveSnapshot,
		baselines: value.baselines,
	};
}

interface PointerRow {
	seq: number | null;
	sha: string;
	ts: string;
}

/** Validate one pointer-index line. Exported for direct testing. */
export function parsePointerRow(value: unknown): PointerRow | null {
	if (!isJsonObject(value)) return null;
	const { sha, ts } = value;
	if (typeof sha !== "string" || typeof ts !== "string") return null;
	const seq = value.seq ?? null;
	if (seq !== null && typeof seq !== "number") return null;
	return { seq, sha, ts };
}

function stateDir(cwd: string): string {
	return join(cwd, ".interlinked", "replay", "state");
}

function pointerPath(cwd: string, sessionId: string): string {
	const safe = sanitizeSessionId(sessionId) || "unknown-session";
	return join(stateDir(cwd), `${safe}.jsonl`);
}

/** Archive the harness state for one step. Fail-open: logs and returns on
 *  any error — this sits on the daemon's per-event path. */
export function recordStateSnapshot(opts: {
	cwd: string;
	sessionId: string;
	seq: number | null | undefined;
	liveSnapshot: JsonObject | null;
	log: (msg: string) => void;
}): void {
	try {
		const baselines: Record<string, string | null> = {};
		for (const name of BASELINE_FILES) {
			const path = join(opts.cwd, ".interlinked", name);
			baselines[name] = existsSync(path) ? readFileSync(path, "utf-8") : null;
		}
		const state: HarnessStateSnapshot = {
			schema: "state-snapshot.v1",
			live_snapshot: opts.liveSnapshot,
			baselines,
		};
		const canonical = JSON.stringify(state);
		const sha = createHash("sha256").update(canonical).digest("hex");

		const blobsDir = join(stateDir(opts.cwd), "blobs");
		mkdirSync(blobsDir, { recursive: true });
		const blobPath = join(blobsDir, `${sha}.json.gz`);
		if (!existsSync(blobPath)) writeFileSync(blobPath, gzipSync(canonical));

		const row: PointerRow = {
			seq: opts.seq ?? null,
			sha,
			ts: new Date().toISOString(),
		};
		appendFileSync(pointerPath(opts.cwd, opts.sessionId), `${JSON.stringify(row)}\n`);
	} catch (err) {
		opts.log(
			`state snapshot failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Load the archived state for an exact (session, seq). Returns the LAST
 *  matching row's blob (later rows win when a seq repeats), or null. */
export function loadStateSnapshot(
	cwd: string,
	sessionId: string,
	seq: number,
): HarnessStateSnapshot | null {
	const path = pointerPath(cwd, sessionId);
	if (!existsSync(path)) return null;
	let sha: string | null = null;
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = parsePointerRow(JSON.parse(line));
			if (row && row.seq === seq) sha = row.sha;
		} catch (err) {
			void err; // torn/foreign line — skipping is this reader's contract
		}
	}
	if (!sha) return null;
	const blobPath = join(stateDir(cwd), "blobs", `${sha}.json.gz`);
	if (!existsSync(blobPath)) return null;
	try {
		return parseHarnessStateSnapshot(
			JSON.parse(gunzipSync(readFileSync(blobPath)).toString("utf-8")),
		);
	} catch (err) {
		void err; // corrupt blob — treat as absent rather than throwing on restore probes
		return null;
	}
}
