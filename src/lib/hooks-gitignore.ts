// interlinked-tdd: exempt
// ===========================================
// .gitignore Management
// ===========================================
// Ensures `.gitignore` carries entries for the local files Interlinked
// writes under `.interlinked/`. Extracted out of `hooks.ts` so the main
// hooks module stays focused on hook install/uninstall orchestration.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_SCAN_OUTPUTS } from "../harness/source-scan-scope.js";

const GITIGNORE_ENTRIES = [
    ...SOURCE_SCAN_OUTPUTS,
	".interlinked/config.local.json",
	".interlinked/activity.jsonl",
	".interlinked/collection.jsonl",
	".interlinked/recurrences.jsonl",
	".interlinked/realtime-retry.jsonl",
	".interlinked/sync-errors.jsonl",
	".interlinked/sync-state.json",
	".interlinked/hook-runtime.json",
	".interlinked/sessions/",
	".interlinked/failures/",
	".interlinked/checkpoints.json",
	".interlinked/guard-cache.json",
	".interlinked/guard-rules.local.json",
	".interlinked/harness.sock",
	".interlinked/harness.pid",
	".interlinked/pending-quality-warnings.json",
	".interlinked/quality-warning-spool/",
	".interlinked/index/",
	".interlinked/semantic.local.json",
	".interlinked/error-history.jsonl",
	// Personal guard stand-down marker + the append-only guard audit log. The
	// TEAM marker (`guard-disabled.json`, no `.local`) is committed on purpose
	// (PR-visible), so it is deliberately NOT listed here.
	".interlinked/guard-disabled.local.json",
	".interlinked/guard-events.jsonl",
	// Sponsor opt-in runtime: row-3 status, cached signed feed, impression beacons.
	".interlinked/sponsor.status",
	".interlinked/sponsor-feed.json",
	".interlinked/sponsor-beacons.jsonl",
	// Daemon-owned observations and execution output must not self-generate
	// workspace changes on every hook. Keep shared policy/ratchet files out of
	// this list; tracked files remain observable under Git's ordinary semantics.
	".interlinked/capture-receipts.jsonl",
	".interlinked/capture-capabilities.jsonl",
	".interlinked/capture/",
	".interlinked/check-results.jsonl",
	".interlinked/check-executions.jsonl",
	".interlinked/costs.jsonl",
	".interlinked/harness-protocol.json",
	".interlinked/hook-coverage.json",
	".interlinked/hook-translations.jsonl",
	".interlinked/logs/",
	".interlinked/metrics/executions.jsonl",
	".interlinked/reservation-events.jsonl",
	".interlinked/thinking-cursor.json",
	".interlinked/timeline-cursor.json",
	".interlinked/timeline.jsonl",
	".interlinked/warning-occurrences.jsonl",
	".interlinked/stop-digest.jsonl",
	".interlinked/test-runs/",
    ".interlinked/contract-runs/",
];

const DATA_GITIGNORE_ENTRIES = new Set([
	".interlinked/activity.jsonl",
	".interlinked/collection.jsonl",
	".interlinked/recurrences.jsonl",
	".interlinked/realtime-retry.jsonl",
	".interlinked/sync-errors.jsonl",
	".interlinked/sync-state.json",
	".interlinked/hook-runtime.json",
	".interlinked/sessions/",
	".interlinked/failures/",
	".interlinked/checkpoints.json",
	".interlinked/quality-warning-spool/",
]);

/**
 * Ensure .gitignore contains entries for Interlinked CLI local files.
 * Skips data-related entries when data dir is outside the repo.
 * Returns true if modifications were made.
 */
export function ensureGitignore(cwd: string): boolean {
	const gitignorePath = join(cwd, ".gitignore");
	let content = "";

	if (existsSync(gitignorePath)) {
		content = readFileSync(gitignorePath, "utf-8");
	}

	const envDataDir = process.env.INTERLINKED_DATA_DIR?.trim();
	const isExternalData = Boolean(envDataDir) && !envDataDir?.startsWith(cwd);

	const lines = content.split("\n");
	const missingEntries: string[] = [];

	for (const entry of GITIGNORE_ENTRIES) {
		if (isExternalData && DATA_GITIGNORE_ENTRIES.has(entry)) continue;
		const alreadyPresent = lines.some(
			(line) => line.trim() === entry || line.trim() === entry.replace(/\/$/, ""),
		);
		if (!alreadyPresent) {
			missingEntries.push(entry);
		}
	}

	if (missingEntries.length === 0) return false;

	const additions: string[] = [];
	if (!content.includes("# Interlinked CLI") && !content.includes("# Interlinked")) {
		additions.push("");
		additions.push("# Interlinked CLI (local agent config)");
	}
	additions.push(...missingEntries);

	const newContent = `${content.trimEnd()}\n${additions.join("\n")}\n`;
	writeFileSync(gitignorePath, newContent);
	return true;
}
