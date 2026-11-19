// ===========================================
// interlinked checkpoint — Git checkpoint management
// ===========================================

import {
	archiveCheckpoints,
	compareCheckpoints,
	createCheckpoint,
	getCheckpoint,
	listCheckpoints,
	pruneCheckpoints,
} from "../lib/checkpoints.js";
import { c, header, kvLine, relativeTime, table } from "../lib/formatter.js";
import { readLocalSessions } from "../lib/local-activity.js";
import { nonNull } from "../lib/non-null.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export function checkpointCommand(
	messageOrSubcmd?: string,
	opts?: {
		agent?: string;
		since?: string;
		limit?: string;
		json?: boolean;
	},
): void {
	const mode = getOutputMode(opts || {});

	// If no argument or the argument looks like a message (not a subcommand)
	if (
		!messageOrSubcmd ||
		!["list", "show", "compare", "prune", "archive"].includes(messageOrSubcmd)
	) {
		createManualCheckpoint(messageOrSubcmd || "Manual checkpoint", mode, opts);
		return;
	}

	// Should not reach here — subcommands are registered separately
	outputError(mode, `Unknown subcommand: ${messageOrSubcmd}`);
}

function createManualCheckpoint(
	message: string,
	mode: ReturnType<typeof getOutputMode>,
	opts?: { agent?: string },
): void {
	try {
		// Find the most recent active session for context
		const sessions = readLocalSessions();
		const active = sessions.find((s) => s.phase === "ACTIVE");
		const sessionId = active?.session_id || "manual";
		const agent = opts?.agent || active?.agent || "unknown";

		const checkpoint = createCheckpoint({
			sessionId,
			agent,
			message,
			trigger: "manual",
		});

		output(mode, checkpoint, {
			json: () => checkpoint,
			normal: () => {
				const lines: string[] = [];
				lines.push(c.green(`Checkpoint created: ${c.bold(checkpoint.id)}`));
				lines.push(kvLine("Message", message));
				lines.push(kvLine("Agent", checkpoint.agent));
				lines.push(kvLine("Base commit", checkpoint.base_commit.slice(0, 8)));
				lines.push(kvLine("Files", String(checkpoint.files_changed.length)));
				lines.push(
					kvLine("Restorable", checkpoint.restorable ? c.green("yes") : c.dim("no")),
				);
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

export function checkpointListCommand(opts: {
	agent?: string;
	since?: string;
	limit?: string;
	json?: boolean;
}): void {
	const mode = getOutputMode(opts);

	try {
		const sinceMs = opts.since ? parseSinceDuration(opts.since) : undefined;
		const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;

		const checkpoints = listCheckpoints({
			...(opts.agent !== undefined ? { agent: opts.agent } : {}),
			...(sinceMs !== undefined ? { since: sinceMs } : {}),
			...(limit !== undefined ? { limit } : {}),
		});

		output(mode, checkpoints, {
			json: () => ({ checkpoints }),
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Checkpoints"));

				if (checkpoints.length === 0) {
					lines.push(c.dim("  No checkpoints found"));
					return lines.join("\n");
				}

				const rows = checkpoints.map((cp) => [
					cp.id,
					cp.agent,
					cp.trigger,
					String(cp.files_changed.length),
					cp.restorable ? c.green("yes") : c.dim("no"),
					relativeTime(cp.timestamp),
					cp.message.length > 30 ? `${cp.message.slice(0, 30)}...` : cp.message,
				]);

				lines.push(
					table(
						["ID", "Agent", "Trigger", "Files", "Restorable", "When", "Message"],
						rows,
					),
				);
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

export function checkpointShowCommand(id: string, opts: { json?: boolean }): void {
	const mode = getOutputMode(opts);

	try {
		const checkpoint = getCheckpoint(id);
		if (!checkpoint) {
			outputError(mode, `Checkpoint not found: ${id}`);
			return;
		}

		output(mode, checkpoint, {
			json: () => checkpoint,
			normal: () => {
				const lines: string[] = [];
				lines.push(header(`Checkpoint ${checkpoint.id}`));
				lines.push(kvLine("Message", checkpoint.message));
				lines.push(kvLine("Agent", checkpoint.agent));
				lines.push(kvLine("Session", checkpoint.session_id));
				lines.push(kvLine("Trigger", checkpoint.trigger));
				lines.push(kvLine("Created", checkpoint.timestamp));
				lines.push(kvLine("Base commit", checkpoint.base_commit));
				lines.push(
					kvLine("Restorable", checkpoint.restorable ? c.green("yes") : c.dim("no")),
				);

				if (checkpoint.files_changed.length > 0) {
					lines.push(
						`\n${c.bold("Files changed")} (${checkpoint.files_changed.length}):`,
					);
					for (const f of checkpoint.files_changed.slice(0, 30)) {
						lines.push(`  ${c.dim(f)}`);
					}
					if (checkpoint.files_changed.length > 30) {
						lines.push(c.dim(`  ... and ${checkpoint.files_changed.length - 30} more`));
					}
				}

				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

export function checkpointCompareCommand(id1: string, id2: string, opts: { json?: boolean }): void {
	const mode = getOutputMode(opts);

	try {
		const result = compareCheckpoints(id1, id2);

		output(mode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header(`Compare ${id1} → ${id2}`));
				lines.push(kvLine("Added", String(result.files_added.length)));
				lines.push(kvLine("Modified", String(result.files_modified.length)));
				lines.push(kvLine("Deleted", String(result.files_deleted.length)));
				if (result.diff_summary) {
					lines.push(`\n${c.dim(result.diff_summary)}`);
				}
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

export function checkpointPruneCommand(opts: {
	olderThan?: string;
	keepLatest?: string;
	json?: boolean;
}): void {
	const mode = getOutputMode(opts);

	try {
		const olderThan = parseRetentionOption(opts.olderThan, "--older-than");
		const keepLatest = parseRetentionOption(opts.keepLatest, "--keep-latest");
		const removed = pruneCheckpoints({
			...(olderThan !== undefined ? { older_than_days: olderThan } : {}),
			...(keepLatest !== undefined ? { keep_latest: keepLatest } : {}),
		});

		output(
			mode,
			{ removed },
			{
				json: () => ({ removed }),
				normal: () =>
					removed > 0
						? `${c.green(`Pruned ${removed} checkpoint(s)`)}`
						: c.dim("No checkpoints to prune"),
			},
		);
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

function parseRetentionOption(value: string | undefined, flag: string): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) {
		throw new Error(`${flag} must be a positive safe integer`);
	}
	return number;
}

export function checkpointArchiveCommand(opts: { json?: boolean }): void {
	const mode = getOutputMode(opts);

	try {
		const result = archiveCheckpoints();

		output(mode, result, {
			json: () => result,
			normal: () =>
				result.archived > 0
					? `${c.green(`Archived ${result.archived} checkpoint(s)`)} (stashes dropped, metadata preserved)`
					: c.dim("No checkpoints to archive"),
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

function parseSinceDuration(s: string): number {
	const match = s.match(/^(\d+)\s*(s|m|h|d)$/);
	if (!match) return Date.now() - 86400000; // default 1 day
	const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
	return Date.now() - Number.parseInt(nonNull(match[1]), 10) * nonNull(multipliers[nonNull(match[2])]);
}
