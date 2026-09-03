// ===========================================
// Code Attribution — Track AI vs Human Code
// ===========================================
// Per-file pool heuristic: compare git diff stat before and after agent runs.

import { gitShell } from "./git-shell.js";
import { nonNull } from "./non-null.js";

// ===========================================
// Types
// ===========================================

interface Attribution {
	agent_lines: number;
	human_lines: number;
	total_lines: number;
	agent_percentage: number;
	per_file: Record<string, { agent: number; human: number }>;
}

export interface PreRunSnapshot {
	timestamp: string;
	files: Record<string, number>; // file -> lines changed since HEAD
}

// ===========================================
// Helpers
// ===========================================

function getDiffStat(cwd: string): Record<string, number> {
	const files: Record<string, number> = {};
	try {
		const output = gitShell("diff --numstat HEAD", cwd);
		if (!output) return files;
		for (const line of output.split("\n")) {
			const parts = line.split("\t");
			if (parts.length >= 3) {
				const added = Number.parseInt(nonNull(parts[0]), 10) || 0;
				const deleted = Number.parseInt(nonNull(parts[1]), 10) || 0;
				const file = parts[2];
				if (file) files[file] = added + deleted;
			}
		}

		// Also include untracked files
		const untracked = gitShell("ls-files --others --exclude-standard", cwd);
		for (const file of untracked.split("\n").filter(Boolean)) {
			try {
				const wc = gitShell(`diff --no-index /dev/null "${file}" -- | wc -l`, cwd);
				files[file] = Number.parseInt(wc, 10) || 1;
			} catch (_err) {
				/* intentional: wc failure — fall back to assuming 1 added line */
				files[file] = 1;
			}
		}
	} catch (_err) {
		/* intentional: no changes or not a git repo — return empty diff stats */
	}
	return files;
}

// ===========================================
// Core Functions
// ===========================================

/**
 * Capture the current diff state before an agent run.
 */
export function snapshotPreRun(cwd?: string): PreRunSnapshot {
	const resolvedCwd = cwd || process.cwd();
	return {
		timestamp: new Date().toISOString(),
		files: getDiffStat(resolvedCwd),
	};
}

/**
 * Calculate attribution by comparing pre-run snapshot with current state.
 * Lines that appeared during the agent session are attributed to the agent.
 * Lines that existed before are attributed to the human.
 */
export function calculateAttribution(snapshot: PreRunSnapshot, cwd?: string): Attribution {
	const resolvedCwd = cwd || process.cwd();
	const currentFiles = getDiffStat(resolvedCwd);

	const perFile: Record<string, { agent: number; human: number }> = {};
	let totalAgent = 0;
	let totalHuman = 0;

	// Files that exist now
	for (const [file, currentLines] of Object.entries(currentFiles)) {
		const preLines = snapshot.files[file] || 0;
		const agentLines = Math.max(0, currentLines - preLines);
		const humanLines = preLines;

		perFile[file] = { agent: agentLines, human: humanLines };
		totalAgent += agentLines;
		totalHuman += humanLines;
	}

	// Files that were in pre-run but no longer changed (human reverted agent changes)
	for (const [file, preLines] of Object.entries(snapshot.files)) {
		if (!(file in currentFiles)) {
			perFile[file] = { agent: 0, human: preLines };
			totalHuman += preLines;
		}
	}

	const total = totalAgent + totalHuman;

	return {
		agent_lines: totalAgent,
		human_lines: totalHuman,
		total_lines: total,
		agent_percentage: total > 0 ? Math.round((totalAgent / total) * 100) : 0,
		per_file: perFile,
	};
}

/**
 * Read attribution trailer from a commit.
 */
export function readAttributionTrailer(commitSha?: string, cwd?: string): Attribution | null {
	const resolvedCwd = cwd || process.cwd();
	const ref = commitSha || "HEAD";

	try {
		const msg = gitShell(`log -1 --format=%B ${ref}`, resolvedCwd);
		const match = msg.match(
			/Interlinked-Attribution:\s*(\d+)%\s*agent\s*\((\d+)\/(\d+)\s*lines?\)/,
		);
		if (!match) return null;

		const agentPct = Number.parseInt(nonNull(match[1]), 10);
		const agentLines = Number.parseInt(nonNull(match[2]), 10);
		const totalLines = Number.parseInt(nonNull(match[3]), 10);

		return {
			agent_lines: agentLines,
			human_lines: totalLines - agentLines,
			total_lines: totalLines,
			agent_percentage: agentPct,
			per_file: {},
		};
	} catch (_err) {
		/* intentional: commit missing or attribution trailer unreadable — caller gets null */
		return null;
	}
}
