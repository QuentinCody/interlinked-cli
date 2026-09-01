// ===========================================
// interlinked git — Git bridge: metadata, trailers, and notes
// ===========================================

import { execSync } from "node:child_process";
import { readAttributionTrailer } from "../lib/attribution.js";
import { c, header, kvLine } from "../lib/formatter.js";
import {
	getCommitMessage,
	getCurrentBranch,
	getHeadSha,
	isGitRepo,
	parseInterlinkedTrailers,
} from "../lib/git-utils.js";
import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

// ===========================================
// Types
// ===========================================

interface GitContextResult {
	branch: string | null;
	head: string | null;
	attribution: {
		agent_percentage: number;
		agent_lines: number;
		total_lines: number;
	} | null;
	trailers: Record<string, string>;
	server?: {
		checkpoint?: string | undefined;
		agent?: string | undefined;
		trailers?: string[] | undefined;
		error?: string | undefined;
	};
}

/** Server response from get_git_context (no commit_sha match) */
interface ServerGitContext {
	latest_checkpoint?: {
		id: number;
		agent: string;
		trigger?: string;
		summary?: string;
		created_at?: string;
	};
	trailers?: string[];
	commit_sha?: string;
	message?: string;
	// When commit_sha matches bridge events
	bridge_events?: Array<{
		id: number;
		event_type: string;
		checkpoint_id: number;
		checkpoint_summary?: string;
		agent_name?: string;
		branch_name?: string;
		metadata?: unknown;
		pushed_at?: string;
	}>;
}

/** Server response from push_checkpoint_to_git */
interface ServerPushResult {
	checkpoint_id: number;
	trailers: string[];
	trailers_text: string;
	notes: JsonObject;
	notes_json: string;
	instructions: string;
}

interface LinkCheckpointResult {
	checkpoint_id?: number;
	commit_sha?: string;
	trailers?: string[];
	notes?: JsonObject;
	notes_json?: string;
	applied?: boolean;
	server_error?: string;
}

/**
 * Sanitize a string for safe use in shell arguments.
 * Removes characters that could break out of quoting.
 */
function sanitizeShellArg(value: string): string {
	// Remove shell metacharacters and control chars
	return value.replace(/[`$\\!"'\n\r\t\0]/g, "");
}

/**
 * Render a list of "Key: Value" trailer strings (server response shape) as
 * indented display lines, splitting each on its first colon; a trailer with
 * no colon renders as a raw indented line. Shared by gitContextCommand's and
 * gitLinkCheckpointCommand's normal-mode trailer sections.
 */
function formatTrailerLines(trailerList: string[]): string[] {
	const lines: string[] = [];
	for (const trailer of trailerList) {
		const colonIdx = trailer.indexOf(":");
		if (colonIdx > 0) {
			lines.push(
				kvLine(trailer.slice(0, colonIdx).trim(), trailer.slice(colonIdx + 1).trim(), 28),
			);
		} else {
			lines.push(`    ${trailer}`);
		}
	}
	return lines;
}

/**
 * Render the "Server Context" section of `git context`'s normal-mode output:
 * a blank separator, then either the fetch error or the checkpoint/agent/
 * trailers block. Returns [] when there is no server result at all.
 */
function formatServerContextLines(server: GitContextResult["server"]): string[] {
	if (!server) return [];
	const lines: string[] = [""];
	if (server.error) {
		lines.push(kvLine("Server", c.yellow(server.error), 18));
		return lines;
	}
	lines.push(c.bold("  Server Context"));
	if (server.checkpoint) {
		lines.push(kvLine("Checkpoint", server.checkpoint, 18));
	}
	if (server.agent) {
		lines.push(kvLine("Agent", server.agent, 18));
	}
	if (server.trailers && server.trailers.length > 0) {
		lines.push(...formatTrailerLines(server.trailers));
	}
	return lines;
}

// ===========================================
// git context
// ===========================================

export async function gitContextCommand(opts: { commit?: string; json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		if (!isGitRepo(cwd)) {
			throw new Error("Not a git repository. Run this command from within a git repo.");
		}

		const ref = opts.commit || "HEAD";
		const branch = getCurrentBranch(cwd);
		const head = getHeadSha(cwd, true);
		const attribution = readAttributionTrailer(ref, cwd);
		const commitMsg = getCommitMessage(ref, cwd);
		const trailers = commitMsg ? parseInterlinkedTrailers(commitMsg) : {};

		const result: GitContextResult = {
			branch,
			head,
			attribution: attribution
				? {
						agent_percentage: attribution.agent_percentage,
						agent_lines: attribution.agent_lines,
						total_lines: attribution.total_lines,
					}
				: null,
			trailers,
		};

		// Try server context (graceful degradation)
		try {
			const { getClient } = await import("../lib/api-client.js");
			const client = getClient();
			const serverResult = await client.callTool<ServerGitContext | null>("get_git_context", {
				...(opts.commit ? { commit_sha: opts.commit } : {}),
			});

			if (serverResult) {
				if (serverResult.latest_checkpoint) {
					const cp = serverResult.latest_checkpoint;
					result.server = {
						checkpoint: `#${cp.id} — "${cp.summary || ""}"`,
						agent: cp.agent,
						trailers: serverResult.trailers,
					};
				} else if (serverResult.bridge_events?.length) {
					const evt = serverResult.bridge_events[0];
					result.server = {
						checkpoint: nonNull(evt).checkpoint_id
							? `#${nonNull(evt).checkpoint_id} — "${nonNull(evt).checkpoint_summary || ""}"`
							: undefined,
						agent: nonNull(evt).agent_name || undefined,
						trailers: serverResult.trailers,
					};
				} else {
					result.server = {
						trailers: serverResult.trailers,
					};
				}
			}
		} catch (e) {
			result.server = {
				error:
					e instanceof Error
						? e.message.includes("Not authenticated")
							? "not authenticated"
							: "unreachable"
						: "unreachable",
			};
		}

		output(mode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Git Context"));
				lines.push(kvLine("Branch", branch || c.dim("detached HEAD"), 18));
				lines.push(kvLine("HEAD", head || c.dim("unknown"), 18));

				if (attribution) {
					lines.push(
						kvLine(
							"Attribution",
							`${attribution.agent_percentage}% agent (${attribution.agent_lines}/${attribution.total_lines} lines)`,
							18,
						),
					);
				}

				if (Object.keys(trailers).length > 0) {
					lines.push("");
					lines.push(c.bold("  Local Trailers"));
					for (const [key, value] of Object.entries(trailers)) {
						lines.push(kvLine(key, value, 28));
					}
				}

				lines.push(...formatServerContextLines(result.server));

				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// git link-checkpoint
// ===========================================

/** Extracted so the caller can spread it without introducing explicit
 *  `undefined` values, which `exactOptionalPropertyTypes` rejects. */
function serverPushResultPatch(
	serverResult: ServerPushResult | null,
): Pick<LinkCheckpointResult, "trailers" | "notes" | "notes_json"> {
	if (!serverResult) return {};
	return {
		trailers: serverResult.trailers,
		notes: serverResult.notes,
		notes_json: serverResult.notes_json,
	};
}

export async function gitLinkCheckpointCommand(opts: {
	checkpoint?: string;
	commit?: string;
	apply?: boolean;
	json?: boolean;
}): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		if (!isGitRepo(cwd)) {
			throw new Error("Not a git repository. Run this command from within a git repo.");
		}

		const commitSha = opts.commit || getHeadSha(cwd, false);
		const branch = getCurrentBranch(cwd);

		if (!commitSha) {
			throw new Error("Could not determine commit SHA. Is there at least one commit?");
		}

		const { getClient } = await import("../lib/api-client.js");
		const client = getClient();

		// If no checkpoint specified, get latest from server
		let checkpointId: number | undefined;
		if (opts.checkpoint) {
			checkpointId = Number.parseInt(opts.checkpoint, 10);
			if (Number.isNaN(checkpointId)) {
				throw new Error(`Invalid checkpoint ID: ${opts.checkpoint}. Must be a number.`);
			}
		} else {
			try {
				const ctx = await client.callTool<ServerGitContext | null>("get_git_context", {});
				checkpointId = ctx?.latest_checkpoint?.id;
			} catch {
				// Will be handled below
			}
		}

		if (!checkpointId) {
			throw new Error(
				"No checkpoint ID specified and could not fetch latest from server. Use --checkpoint <id>.",
			);
		}

		// Call push_checkpoint_to_git (checkpoint_id is a number per schema)
		const serverResult = await client.callTool<ServerPushResult | null>("push_checkpoint_to_git", {
			checkpoint_id: checkpointId,
			commit_sha: commitSha,
			...(branch ? { branch_name: branch } : {}),
		});

		const result: LinkCheckpointResult = {
			checkpoint_id: checkpointId,
			commit_sha: commitSha,
			...serverPushResultPatch(serverResult),
			applied: false,
		};

		// Apply trailers and notes if requested
		if (opts.apply && serverResult?.trailers) {
			try {
				// Server returns trailers as string[] like ["Interlinked-Checkpoint: 42", "Interlinked-Agent: Worker"]
				const currentMsg = getCommitMessage("HEAD", cwd) || "";
				const existingTrailers = parseInterlinkedTrailers(currentMsg);

				// Filter out trailers already present
				const newTrailerLines = serverResult.trailers.filter((t) => {
					const colonIdx = t.indexOf(":");
					if (colonIdx <= 0) return false;
					const key = t.slice(0, colonIdx).trim();
					return !(key in existingTrailers);
				});

				if (newTrailerLines.length > 0) {
					// Sanitize trailer values to prevent shell injection
					const sanitizedTrailers = newTrailerLines
						.map((t) => sanitizeShellArg(t))
						.join("\n");
					const newMsg = `${currentMsg.trimEnd()}\n\n${sanitizedTrailers}`;
					// Use git commit --amend with -F - to pipe message via stdin (no shell injection)
					execSync("git commit --amend -F -", {
						cwd,
						encoding: "utf-8",
						timeout: 10000,
						input: newMsg,
						stdio: ["pipe", "pipe", "pipe"],
					});
				}

				// Re-capture HEAD after potential amend (finding 3: notes must target new SHA)
				const newHead = getHeadSha(cwd, false);
				result.commit_sha = newHead || commitSha;

				// Apply git notes if provided (use notes_json, target the post-amend SHA)
				if (serverResult.notes_json && result.commit_sha) {
					try {
						// Use -F - to pipe content via stdin (no shell injection)
						execSync(`git notes add -f -F - ${result.commit_sha}`, {
							cwd,
							encoding: "utf-8",
							timeout: 10000,
							input: serverResult.notes_json,
							stdio: ["pipe", "pipe", "pipe"],
						});
					} catch {
						// Notes may fail in unusual git states
					}
				}

				result.applied = true;
			} catch {
				result.applied = false;
				// Fall through to show the result without --apply
			}
		}

		output(mode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Link Checkpoint"));
				lines.push(kvLine("Checkpoint", `#${result.checkpoint_id}`, 14));
				lines.push(kvLine("Commit", result.commit_sha || "unknown", 14));

				if (result.trailers && result.trailers.length > 0) {
					lines.push("");
					lines.push(c.bold("  Trailers"));
					lines.push(...formatTrailerLines(result.trailers));
				}

				if (result.notes_json) {
					lines.push("");
					lines.push(kvLine("Notes", c.dim("(JSON attached)"), 14));
				}

				if (result.applied) {
					lines.push("");
					lines.push(c.green("  Trailers and notes applied to HEAD."));
					lines.push(
						c.yellow("  Warning: HEAD was amended. Only use on unpushed commits."),
					);
				} else if (opts.apply) {
					lines.push("");
					lines.push(c.yellow("  Failed to apply trailers. See output above."));
				} else {
					lines.push("");
					lines.push(c.dim("  Use --apply to add trailers and notes to HEAD."));
					lines.push(
						c.dim("  Warning: --apply amends HEAD. Only use on unpushed commits."),
					);
				}

				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}
