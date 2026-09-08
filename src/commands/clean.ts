// ===========================================
// interlinked clean — Remove stale data
// ===========================================

import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { findTailStartForLines } from "../lib/bounded-file-io.js";
import { fileIdentity, replaceFileWithSuffix } from "../lib/file-suffix-replacement.js";
import { assertNoPendingFileRotation } from "../lib/file-rotation-fence.js";
import { c, divider, header } from "../lib/formatter.js";
import { nonNull } from "../lib/non-null.js";
import { getOutputMode, output } from "../lib/output.js";

interface StaleItem {
	type: "session_file" | "orphaned_hook" | "large_activity_log" | "stale_session";
	path: string;
	detail: string;
	age?: string;
	cleanup_outcome?: "truncated" | "refused";
}

interface ClientSettingsEntry {
	name: string;
	path: string;
	format: "json" | "toml";
}

/** Result of scanning one directory / checking one source for stale data. */
interface StaleScanResult {
	staleItems: StaleItem[];
	removed: string[];
}

const ACTIVITY_TAIL_LINES = 10000;

/** Retain the configured activity tail under the shared append/rotation lock. */
function truncateActivityTail(activityPath: string, beforeReplace: () => void): void {
	const source = fileIdentity(activityPath);
	const tailStart = findTailStartForLines(activityPath, ACTIVITY_TAIL_LINES);
	replaceFileWithSuffix(activityPath, tailStart, {
		expectedSource: source,
		beforeReplace: () => {
			assertNoPendingFileRotation(activityPath, "activity");
			beforeReplace();
		},
	});
}

function resetActivitySyncState(syncStatePath: string): void {
	writeFileSync(
		syncStatePath,
		`${JSON.stringify({
			synced_through_bytes: 0,
			last_sync_at: null,
			reset_at: new Date().toISOString(),
			reason: "activity_log_truncated",
		})}\n`,
	);
}

function formatAge(ms: number): string {
	const hours = Math.floor(ms / 3600000);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

/** Human-readable detail text for a stale file, varying only by item type. */
function describeStaleFile(
	itemType: "session_file" | "stale_session",
	age: string,
): string {
	return itemType === "session_file"
		? `Last modified ${age} ago`
		: `Session file last modified ${age} ago`;
}

/**
 * Finds files in `dir` whose mtime is older than 24h and (unless `isDryRun`)
 * deletes them. `extensionFilter`, when given, restricts the scan to files
 * whose name ends with it (e.g. ".json"). Unreadable directories/files are
 * treated as empty/skipped rather than thrown.
 */
function scanStaleFilesInDir(
	dir: string,
	itemType: "session_file" | "stale_session",
	isDryRun: boolean,
	extensionFilter?: string,
): StaleScanResult {
	const staleItems: StaleItem[] = [];
	const removed: string[] = [];
	if (!existsSync(dir)) return { staleItems, removed };

	try {
		const files = readdirSync(dir);
		const staleThreshold = Date.now() - 24 * 60 * 60 * 1000; // 24h

		for (const file of files) {
			if (extensionFilter && !file.endsWith(extensionFilter)) continue;
			const filePath = join(dir, file);
			try {
				const stat = statSync(filePath);
				if (stat.mtimeMs < staleThreshold) {
					const ageMs = Date.now() - stat.mtimeMs;
					const age = formatAge(ageMs);
					staleItems.push({
						type: itemType,
						path: filePath,
						detail: describeStaleFile(itemType, age),
						age,
					});

					if (!isDryRun) {
						unlinkSync(filePath);
						removed.push(filePath);
					}
				}
			} catch (_) {
				/* intentional: skip files we cannot stat (permission/race) */
			}
		}
	} catch (_) {
		/* intentional: directory not readable, treat as empty */
	}

	return { staleItems, removed };
}

/**
 * Checks the activity log's size and, if it exceeds the 50MB threshold,
 * flags it — truncating to the last 10K lines and resetting the sync-state
 * cursor when not a dry run (truncation invalidates byte offsets).
 */
function checkAndTruncateActivityLog(
	activityPath: string,
	syncStatePath: string,
	isDryRun: boolean,
): StaleScanResult {
	const staleItems: StaleItem[] = [];
	const removed: string[] = [];
	if (!existsSync(activityPath)) return { staleItems, removed };

	try {
		const stat = statSync(activityPath);
		const sizeMB = stat.size / (1024 * 1024);
		if (sizeMB > 50) {
			const staleItem: StaleItem = {
				type: "large_activity_log",
				path: activityPath,
				detail: `Activity log is ${sizeMB.toFixed(1)} MB (>50 MB threshold)`,
			};
			staleItems.push(staleItem);

			if (!isDryRun) {
				staleItem.cleanup_outcome = "refused";
				// The suffix stays byte-for-byte intact, avoiding decode/re-encode
				// drift in the retained audit records.
				// Lower the cursor before the atomic live-file rename. A crash can then
				// only replay retained rows; it cannot leave a high cursor that skips them.
				truncateActivityTail(activityPath, () => resetActivitySyncState(syncStatePath));
				staleItem.cleanup_outcome = "truncated";
				removed.push(`${activityPath} (truncated to 10K lines)`);
				removed.push(`${syncStatePath} (sync cursor reset)`);
			}
		}
	} catch (_) {
		/* intentional: activity log unreadable, skip size check */
	}

	return { staleItems, removed };
}

/**
 * Checks whether `client`'s settings file references the interlinked
 * activity hook script at a path that no longer exists on disk. Returns
 * `null` when the settings file is absent/unreadable, doesn't reference the
 * hook, or the referenced script still exists.
 */
function findOrphanedHookEntry(client: ClientSettingsEntry): StaleItem | null {
	if (!existsSync(client.path)) return null;

	try {
		const content = readFileSync(client.path, "utf-8");
		if (content.includes("interlinked-activity")) {
			// Check if the referenced hook script actually exists
			const hookMatch = content.match(/interlinked-activity\.mjs/);
			if (hookMatch) {
				// Try to find the actual script path from the settings
				const scriptPathMatch = content.match(
					/node\s+([^\s"]+interlinked-activity\.mjs)/,
				);
				if (scriptPathMatch) {
					const scriptPath = nonNull(scriptPathMatch[1]);
					if (!existsSync(scriptPath)) {
						return {
							type: "orphaned_hook",
							path: client.path,
							detail: `${client.name}: Hook references missing script at ${scriptPath}`,
						};
					}
				}
			}
		}
	} catch (_) {
		/* intentional: client settings unreadable, skip orphan detection */
	}

	return null;
}

/** Header + per-item lines for the "large activity log" group, or `[]` if empty. */
function formatLargeLogLines(items: StaleItem[], isDryRun: boolean): string[] {
	if (items.length === 0) return [];
	const lines: string[] = [`\n  ${c.bold("Large activity log")}:`];
	for (const item of items) {
		const action = isDryRun
			? c.yellow("would truncate")
			: item.cleanup_outcome === "truncated"
				? c.green("truncated")
				: c.yellow("not truncated");
		lines.push(`    ${action} ${item.detail}`);
	}
	return lines;
}

/**
 * Header + per-item lines for a group of stale file items (hook session
 * files or local session files) — both share identical action-verb
 * formatting; `title` supplies the group's own header text. Returns `[]` if
 * `items` is empty.
 */
function formatStaleFileGroupLines(
	items: StaleItem[],
	isDryRun: boolean,
	title: string,
): string[] {
	if (items.length === 0) return [];
	const lines: string[] = [`\n  ${c.bold(title)} (older than 24h):`];
	for (const item of items) {
		const action = isDryRun ? c.yellow("would remove") : c.green("removed");
		lines.push(`    ${action} ${item.path}`);
		lines.push(`             ${c.dim(item.detail)}`);
	}
	return lines;
}

/** Header + per-item lines for the "orphaned hook entries" group, or `[]` if empty. */
function formatOrphanedHookLines(items: StaleItem[]): string[] {
	if (items.length === 0) return [];
	const lines: string[] = [`\n  ${c.bold("Orphaned hook entries")}:`];
	for (const item of items) {
		lines.push(`    ${c.yellow("found")} ${item.detail}`);
		lines.push(`             ${c.dim("Run 'interlinked enable' to reinstall hooks")}`);
	}
	return lines;
}

/**
 * The trailing summary line(s) printed after the divider: the dry-run
 * "found N item(s)" hint, or the "removed N item(s)" line plus an orphaned-
 * hook nudge when any were found.
 */
function formatCleanSummaryLines(
	isDryRun: boolean,
	totalFound: number,
	totalRemoved: number,
	orphanedHooksCount: number,
): string[] {
	if (isDryRun) {
		return [
			c.dim(`  Found ${totalFound} item(s). Run 'interlinked clean --force' to remove.`),
		];
	}
	const lines: string[] = [c.green(`  Removed ${totalRemoved} item(s).`)];
	if (orphanedHooksCount > 0) {
		lines.push(
			c.dim(
				`  ${orphanedHooksCount} orphaned hook(s) found. Run 'interlinked enable' to fix.`,
			),
		);
	}
	return lines;
}

interface CleanOptions {
	dryRun?: boolean;
	force?: boolean;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

export async function cleanCommand(opts: CleanOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();
	const isDryRun = !opts.force; // Default is dry-run unless --force
	const staleItems: StaleItem[] = [];
	const removedItems: string[] = [];

	// ===========================================
	// 1. Stale session files (older than 24h)
	// ===========================================

	const sessionsDir = join(cwd, ".interlinked", "hooks", "agent-sessions");
	const sessionScan = scanStaleFilesInDir(sessionsDir, "session_file", isDryRun);
	staleItems.push(...sessionScan.staleItems);
	removedItems.push(...sessionScan.removed);

	// ===========================================
	// 2. Activity log size check (>50MB → offer truncation)
	// ===========================================

	const activityPath = join(cwd, ".interlinked", "activity.jsonl");
	const syncStatePath = join(cwd, ".interlinked", "sync-state.json");
	const logScan = checkAndTruncateActivityLog(activityPath, syncStatePath, isDryRun);
	staleItems.push(...logScan.staleItems);
	removedItems.push(...logScan.removed);

	// ===========================================
	// 3. Stale local session files (>24h)
	// ===========================================

	const localSessionsDir = join(cwd, ".interlinked", "sessions");
	const localScan = scanStaleFilesInDir(localSessionsDir, "stale_session", isDryRun, ".json");
	staleItems.push(...localScan.staleItems);
	removedItems.push(...localScan.removed);

	// ===========================================
	// 4. Orphaned hook entries in client settings
	// ===========================================

	const clientSettings: ClientSettingsEntry[] = [
		{ name: "Claude Code", path: join(cwd, ".claude", "settings.json"), format: "json" },
		{ name: "Gemini CLI", path: join(cwd, ".gemini", "settings.json"), format: "json" },
		{ name: "Codex CLI", path: join(cwd, ".codex", "config.toml"), format: "toml" },
	];

	for (const client of clientSettings) {
		const orphan = findOrphanedHookEntry(client);
		if (orphan) staleItems.push(orphan);
	}

	// ===========================================
	// Output
	// ===========================================

	output(mode, staleItems, {
		json: () => ({
			dry_run: isDryRun,
			stale_items: staleItems,
			removed: isDryRun ? [] : removedItems,
			total_found: staleItems.length,
			total_removed: removedItems.length,
		}),
		normal: () => {
			const lines: string[] = [];
			lines.push(header(isDryRun ? "Clean (dry-run)" : "Clean"));

			if (staleItems.length === 0) {
				lines.push(c.green("  No stale data found. Everything looks clean."));
				return lines.join("\n");
			}

			// Group by type
			const sessionFiles = staleItems.filter((i) => i.type === "session_file");
			const orphanedHooks = staleItems.filter((i) => i.type === "orphaned_hook");
			const largeLog = staleItems.filter((i) => i.type === "large_activity_log");
			const staleSessions = staleItems.filter((i) => i.type === "stale_session");

			lines.push(...formatLargeLogLines(largeLog, isDryRun));
			lines.push(
				...formatStaleFileGroupLines(sessionFiles, isDryRun, "Stale hook session files"),
			);
			lines.push(
				...formatStaleFileGroupLines(staleSessions, isDryRun, "Stale local sessions"),
			);
			lines.push(...formatOrphanedHookLines(orphanedHooks));

			lines.push("");
			lines.push(divider());
			lines.push(
				...formatCleanSummaryLines(
					isDryRun,
					staleItems.length,
					removedItems.length,
					orphanedHooks.length,
				),
			);

			return lines.join("\n");
		},
	});
}
