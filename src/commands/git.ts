// ===========================================
// interlinked git — Git bridge: metadata, trailers, and notes
// ===========================================

import { readAttributionTrailer } from "../lib/attribution.js";
import {
	getCommitMessage,
	getCurrentBranch,
	getHeadSha,
	isGitRepo,
	parseInterlinkedTrailers,
} from "../lib/git-utils.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import {
	type GitContextResult,
	type LinkCheckpointResult,
	type ServerGitContext,
	type ServerPushResult,
	applyCheckpointToHead,
	formatGitContextOutput,
	formatLinkCheckpointOutput,
	resolveCheckpointId,
	resolveServerContext,
	serverPushResultPatch,
} from "./git-support.js";

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
		const server = await resolveServerContext(opts.commit);
		if (server) {
			result.server = server;
		}

		output(mode, result, {
			json: () => result,
			normal: () => formatGitContextOutput(result),
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// git link-checkpoint
// ===========================================

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
		const checkpointId = await resolveCheckpointId(opts.checkpoint, () =>
			client.callTool<ServerGitContext | null>("get_git_context", {}),
		);

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
			applyCheckpointToHead(serverResult, cwd, commitSha, result);
		}

		output(mode, result, {
			json: () => result,
			normal: () => formatLinkCheckpointOutput(result, Boolean(opts.apply)),
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}
