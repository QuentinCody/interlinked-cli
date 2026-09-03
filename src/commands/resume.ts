// ===========================================
// interlinked resume — Resume from a checkpoint with full context
// ===========================================

import { getCheckpoint, listCheckpoints, rewindToCheckpoint } from "../lib/checkpoints.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { readLocalSessions } from "../lib/local-activity.js";
import { nonNull } from "../lib/non-null.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

/** Max time (ms) to wait for `get_work_context` server fetch before falling back to local. */
const SERVER_CONTEXT_TIMEOUT_MS = 3000;

function checkpointFilesChangedLines(filesChanged: string[]): string[] {
	const lines: string[] = [];
	if (filesChanged.length > 0) {
		lines.push("");
		lines.push(c.bold("Files at checkpoint:"));
		for (const f of filesChanged.slice(0, 10)) {
			lines.push(`  ${c.dim(f)}`);
		}
		if (filesChanged.length > 10) {
			lines.push(c.dim(`  ... and ${filesChanged.length - 10} more`));
		}
	}
	return lines;
}

export async function resumeCommand(
	checkpointId?: string,
	opts?: { agent?: string; json?: boolean },
): Promise<void> {
	const mode = getOutputMode(opts || {});

	try {
		// If no ID specified, find the most recent checkpoint
		let targetId = checkpointId;
		if (!targetId) {
			const recent = listCheckpoints({
				...(opts?.agent !== undefined ? { agent: opts.agent } : {}),
				limit: 1,
			});
			if (recent.length === 0) {
				outputError(
					mode,
					"No checkpoints found. Create one with: interlinked checkpoint <message>",
				);
				return;
			}
			targetId = nonNull(recent[0]).id;
		}

		const checkpoint = getCheckpoint(targetId);
		if (!checkpoint) {
			outputError(mode, `Checkpoint not found: ${targetId}`);
			return;
		}

		// Get session context
		const sessions = readLocalSessions();
		const session = sessions.find((s) => s.session_id === checkpoint.session_id);

		// Try to rewind (non-destructive — only if restorable)
		let rewindResult = null;
		if (checkpoint.restorable) {
			try {
				const rewindOpts = { force: false };
				rewindResult = rewindToCheckpoint(targetId, rewindOpts);
			} catch (_) {
				/* intentional: working tree dirty, skip rewind and show context only */
			}
		}

		// Try to fetch server context
		let serverContext = null;
		try {
			const { getClient } = await import("../lib/api-client.js");
			const client = getClient();
			if (client.isAuthenticated()) {
				serverContext = await Promise.race([
					client.callTool("get_work_context", {
						agent_name: checkpoint.agent,
					}),
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error("timeout")), SERVER_CONTEXT_TIMEOUT_MS),
					),
				]).catch(() => null);
			}
		} catch (_) {
			/* intentional: server unreachable, continue with local context only */
		}

		const data = {
			checkpoint,
			session,
			rewindResult,
			serverContext,
		};

		output(mode, data, {
			json: () => data,
			normal: () => {
				const lines: string[] = [];
				lines.push(header(`Resume from ${checkpoint.id}`));
				lines.push(kvLine("Agent", checkpoint.agent));
				lines.push(kvLine("Message", checkpoint.message));
				lines.push(kvLine("Trigger", checkpoint.trigger));
				lines.push(kvLine("Created", checkpoint.timestamp));
				lines.push(kvLine("Base commit", checkpoint.base_commit.slice(0, 8)));

				if (rewindResult) {
					lines.push(
						kvLine(
							"Rewind",
							rewindResult.success
								? c.green("restored")
								: c.yellow("skipped (uncommitted changes)"),
						),
					);
				} else if (checkpoint.restorable) {
					lines.push(kvLine("Rewind", c.yellow("skipped (uncommitted changes)")));
				} else {
					lines.push(kvLine("Rewind", c.dim("not available (archived)")));
				}

				if (session) {
					lines.push("");
					lines.push(c.bold("Session Context:"));
					lines.push(kvLine("Tools used", String(session.tool_count)));
					if (session.files_touched.length > 0) {
						lines.push(kvLine("Files", session.files_touched.slice(0, 5).join(", ")));
					}
				}

				lines.push(...checkpointFilesChangedLines(checkpoint.files_changed));

				if (serverContext) {
					lines.push("");
					lines.push(c.bold("Server Context:"));
					lines.push(c.dim(`  ${JSON.stringify(serverContext).slice(0, 200)}`));
				}

				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}
