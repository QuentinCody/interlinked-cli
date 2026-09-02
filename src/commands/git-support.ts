// ===========================================
// interlinked git — shared types, server access, and rendering helpers
// ===========================================

import { execSync } from "node:child_process";
import { c, header, kvLine } from "../lib/formatter.js";
import { getCommitMessage, getHeadSha, parseInterlinkedTrailers } from "../lib/git-utils.js";
import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";

// ===========================================
// Types
// ===========================================

export interface GitContextResult {
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
export interface ServerGitContext {
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
export interface ServerPushResult {
	checkpoint_id: number;
	trailers: string[];
	trailers_text: string;
	notes: JsonObject;
	notes_json: string;
	instructions: string;
}

export interface LinkCheckpointResult {
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
// git context — server access + rendering
// ===========================================

/** Classify a server-context fetch failure into the label shown to the user. */
function serverContextErrorLabel(e: unknown): string {
	if (!(e instanceof Error)) return "unreachable";
	return e.message.includes("Not authenticated") ? "not authenticated" : "unreachable";
}

/** Map a non-null get_git_context response onto the result's `server` shape. */
function serverContextFrom(serverResult: ServerGitContext): GitContextResult["server"] {
	if (serverResult.latest_checkpoint) {
		const cp = serverResult.latest_checkpoint;
		return {
			checkpoint: `#${cp.id} — "${cp.summary || ""}"`,
			agent: cp.agent,
			trailers: serverResult.trailers,
		};
	}
	if (serverResult.bridge_events?.length) {
		const evt = serverResult.bridge_events[0];
		return {
			checkpoint: nonNull(evt).checkpoint_id
				? `#${nonNull(evt).checkpoint_id} — "${nonNull(evt).checkpoint_summary || ""}"`
				: undefined,
			agent: nonNull(evt).agent_name || undefined,
			trailers: serverResult.trailers,
		};
	}
	return {
		trailers: serverResult.trailers,
	};
}

/**
 * Fetch server context for `git context` (graceful degradation): the mapped
 * `server` block, an error block when the fetch or mapping throws, or
 * undefined when the server returned nothing.
 */
export async function resolveServerContext(
	commit: string | undefined,
): Promise<GitContextResult["server"] | undefined> {
	try {
		const { getClient } = await import("../lib/api-client.js");
		const client = getClient();
		const serverResult = await client.callTool<ServerGitContext | null>("get_git_context", {
			...(commit ? { commit_sha: commit } : {}),
		});
		if (!serverResult) return undefined;
		return serverContextFrom(serverResult);
	} catch (e) {
		return { error: serverContextErrorLabel(e) };
	}
}

/** Normal-mode rendering of `git context`. */
export function formatGitContextOutput(result: GitContextResult): string {
	const lines: string[] = [];
	lines.push(header("Git Context"));
	lines.push(kvLine("Branch", result.branch || c.dim("detached HEAD"), 18));
	lines.push(kvLine("HEAD", result.head || c.dim("unknown"), 18));

	const attribution = result.attribution;
	if (attribution) {
		lines.push(
			kvLine(
				"Attribution",
				`${attribution.agent_percentage}% agent (${attribution.agent_lines}/${attribution.total_lines} lines)`,
				18,
			),
		);
	}

	if (Object.keys(result.trailers).length > 0) {
		lines.push("");
		lines.push(c.bold("  Local Trailers"));
		for (const [key, value] of Object.entries(result.trailers)) {
			lines.push(kvLine(key, value, 28));
		}
	}

	lines.push(...formatServerContextLines(result.server));

	return lines.join("\n");
}

// ===========================================
// git link-checkpoint — apply + rendering
// ===========================================

/** Extracted so the caller can spread it without introducing explicit
 *  `undefined` values, which `exactOptionalPropertyTypes` rejects. */
export function serverPushResultPatch(
	serverResult: ServerPushResult | null,
): Pick<LinkCheckpointResult, "trailers" | "notes" | "notes_json"> {
	if (!serverResult) return {};
	return {
		trailers: serverResult.trailers,
		notes: serverResult.notes,
		notes_json: serverResult.notes_json,
	};
}

/**
 * Resolve the checkpoint id to link: the parsed `--checkpoint` value, or the
 * server's latest checkpoint when the flag is absent. Throws when the id is
 * malformed or cannot be determined.
 */
export async function resolveCheckpointId(
	checkpointOpt: string | undefined,
	fetchLatest: () => Promise<ServerGitContext | null>,
): Promise<number> {
	let checkpointId: number | undefined;
	if (checkpointOpt) {
		checkpointId = Number.parseInt(checkpointOpt, 10);
		if (Number.isNaN(checkpointId)) {
			throw new Error(`Invalid checkpoint ID: ${checkpointOpt}. Must be a number.`);
		}
	} else {
		try {
			const ctx = await fetchLatest();
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
	return checkpointId;
}

/** True when a server trailer line carries a key not already on the commit. */
function isMissingTrailer(trailer: string, existingTrailers: Record<string, string>): boolean {
	const colonIdx = trailer.indexOf(":");
	if (colonIdx <= 0) return false;
	const key = trailer.slice(0, colonIdx).trim();
	return !(key in existingTrailers);
}

/** Amend HEAD's message with the sanitized new trailer lines. */
function amendWithTrailers(cwd: string, currentMsg: string, newTrailerLines: string[]): void {
	// Sanitize trailer values to prevent shell injection
	const sanitizedTrailers = newTrailerLines.map((t) => sanitizeShellArg(t)).join("\n");
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

/** Attach the checkpoint notes JSON to a commit, tolerating unusual git states. */
function attachCheckpointNotes(cwd: string, commitSha: string, notesJson: string): void {
	try {
		// Use -F - to pipe content via stdin (no shell injection)
		execSync(`git notes add -f -F - ${commitSha}`, {
			cwd,
			encoding: "utf-8",
			timeout: 10000,
			input: notesJson,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		// Notes may fail in unusual git states
	}
}

/**
 * Apply the server's trailers and notes to HEAD, updating `result.commit_sha`
 * (notes must target the post-amend SHA) and `result.applied` in place.
 */
export function applyCheckpointToHead(
	serverResult: ServerPushResult,
	cwd: string,
	commitSha: string,
	result: LinkCheckpointResult,
): void {
	try {
		// Server returns trailers as string[] like ["Interlinked-Checkpoint: 42", "Interlinked-Agent: Worker"]
		const currentMsg = getCommitMessage("HEAD", cwd) || "";
		const existingTrailers = parseInterlinkedTrailers(currentMsg);

		// Filter out trailers already present
		const newTrailerLines = serverResult.trailers.filter((t) =>
			isMissingTrailer(t, existingTrailers),
		);

		if (newTrailerLines.length > 0) {
			amendWithTrailers(cwd, currentMsg, newTrailerLines);
		}

		// Re-capture HEAD after potential amend (finding 3: notes must target new SHA)
		const newHead = getHeadSha(cwd, false);
		result.commit_sha = newHead || commitSha;

		// Apply git notes if provided (use notes_json, target the post-amend SHA)
		if (serverResult.notes_json && result.commit_sha) {
			attachCheckpointNotes(cwd, result.commit_sha, serverResult.notes_json);
		}

		result.applied = true;
	} catch {
		result.applied = false;
		// Fall through to show the result without --apply
	}
}

/** Trailing guidance block of `git link-checkpoint`'s normal-mode output. */
function linkCheckpointFooterLines(applied: boolean | undefined, apply: boolean): string[] {
	if (applied) {
		return [
			"",
			c.green("  Trailers and notes applied to HEAD."),
			c.yellow("  Warning: HEAD was amended. Only use on unpushed commits."),
		];
	}
	if (apply) {
		return ["", c.yellow("  Failed to apply trailers. See output above.")];
	}
	return [
		"",
		c.dim("  Use --apply to add trailers and notes to HEAD."),
		c.dim("  Warning: --apply amends HEAD. Only use on unpushed commits."),
	];
}

/** Normal-mode rendering of `git link-checkpoint`. */
export function formatLinkCheckpointOutput(result: LinkCheckpointResult, apply: boolean): string {
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

	lines.push(...linkCheckpointFooterLines(result.applied, apply));

	return lines.join("\n");
}
