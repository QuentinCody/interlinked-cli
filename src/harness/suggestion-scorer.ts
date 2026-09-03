// ===========================================
// Suggestion Scorer — non-deterministic heuristics only
// ===========================================
// Scores ONLY regex-based heuristic findings (sql patterns, perf hints, etc.)
// Deterministic checks (tsc, biome, strong_typing, structural) are always
// shown as-is — they don't need scoring because they're facts, not suggestions.
//
// The harness PostToolUse output has two tiers:
//   1. Deterministic findings: always shown, no scoring (tsc, biome, exports, imports)
//   2. Scored suggestions: top 1-3 above threshold from regex heuristics

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FileSuppressions, type InlineSuppressions, isSuppressed } from "./suppressions.js";
import type { SessionTrajectory } from "./types.js";

// ===========================================
// Types
// ===========================================

export interface Finding {
	/** Check identifier (e.g., "typescript", "biome_lint", "sql-injection") */
	check: string;
	/** 1-based line number (0 if unknown) */
	line: number;
	/** Human-readable message */
	message: string;
	/** Source category for display grouping */
	source: "security" | "performance" | "quality";
}

interface ScoredFinding extends Finding {
	score: number;
}

// ===========================================
// Base severity per check (static, deterministic)
// ===========================================

// Only non-deterministic heuristics are scored.
// Deterministic checks (tsc, biome, structural) bypass scoring entirely.
const BASE_SEVERITY: Record<string, number> = {
	// Security (regex)
	"sql-injection": 0.85,
	"recursive-walker-lstat": 0.7,
	secrets_in_source: 0.75,
	// Type safety (regex, but high-value)
	"strong-typing": 0.65,
	// Performance (regex)
	"perf-query-in-loop": 0.7,
	"perf-await-in-loop": 0.5,
	// Quality (regex)
	"unreachable-code": 0.4,
	// silent-promise-swallow is async-side silent-catch — unhandled rejections
	// crash Node. Score above default threshold so verify --suggestions
	// surfaces it without --threshold=0.
	"silent-promise-swallow": 0.7,
	"silent-catch": 0.3,
};

const DEFAULT_LIMIT = 3;
const DEFAULT_THRESHOLD = 0.5;

// ===========================================
// Hot path detection (perf scoring)
// ===========================================

function hotPathLikelihood(filePath: string): number {
	if (/\/test\/|\.test\.|\.spec\.|\/__tests__\//.test(filePath)) return 0;
	if (/scripts\/|migration/.test(filePath)) return 0.1;
	if (/schema\//.test(filePath)) return 0.2;
	if (/ui\//.test(filePath)) return 0.6;
	if (/codemode\//.test(filePath)) return 0.8;
	if (/tools\/handlers\//.test(filePath)) return 0.9;
	return 0.5;
}

// ===========================================
// Scoring
// ===========================================

type ScoreFindingsOpts = {
	filePath: string;
	session?: SessionTrajectory;
	editStartLine?: number;
	editEndLine?: number;
	inlineSuppressions: InlineSuppressions;
	fileSuppressions: FileSuppressions;
	limit?: number;
	threshold?: number;
};

/**
 * Score one finding, or return null if it is suppressed.
 * Extracted from scoreFindings' loop body — same logic, same order.
 */
function scoreSingleFinding(finding: Finding, opts: ScoreFindingsOpts): ScoredFinding | null {
	// Suppression check — always wins
	if (
		isSuppressed(finding.check, finding.line, opts.inlineSuppressions, opts.fileSuppressions)
	) {
		return null;
	}

	const baseSeverity = BASE_SEVERITY[finding.check] ?? 0.5;

	// File relevance: did the agent write this file in this session?
	// When no session (e.g., verify command), default to 1.0 — we're intentionally scanning.
	const fileRelevance = opts.session
		? opts.session.files_written.has(opts.filePath)
			? 1.0
			: 0.5
		: 1.0;

	// Edit proximity: is the finding near the edited region?
	let editProximity = 0.75; // default if we don't know the edit region
	if (finding.line > 0 && opts.editStartLine && opts.editEndLine) {
		const dist = Math.min(
			Math.abs(finding.line - opts.editStartLine),
			Math.abs(finding.line - opts.editEndLine),
		);
		if (dist < 20) {
			editProximity = 1.0;
		} else if (dist < 50) {
			editProximity = 0.7;
		} else {
			editProximity = 0.5;
		}
	}

	// Hot path boost for perf checks
	let perfBoost = 1.0;
	if (finding.check.startsWith("perf-")) {
		perfBoost = hotPathLikelihood(opts.filePath);
	}

	const score = baseSeverity * fileRelevance * editProximity * perfBoost;

	return { ...finding, score };
}

/**
 * Score, rank, and filter findings from all sources into the top N.
 * Suppressions are checked and respected (suppressed findings score 0).
 */
export function scoreFindings(findings: Finding[], opts: ScoreFindingsOpts): ScoredFinding[] {
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

	const scored: ScoredFinding[] = [];

	for (const finding of findings) {
		const result = scoreSingleFinding(finding, opts);
		if (result) scored.push(result);
	}

	// Sort descending, take top N above threshold
	scored.sort((a, b) => b.score - a.score);
	return scored.filter((s) => s.score >= threshold).slice(0, limit);
}

// ===========================================
// Output formatting
// ===========================================

/**
 * Format scored findings as warning strings for the harness response.
 */
export function formatScoredFindings(findings: ScoredFinding[]): string[] {
	if (findings.length === 0) return [];

	const lines: string[] = [];
	for (const f of findings) {
		const lineRef = f.line > 0 ? ` (line ${f.line})` : "";
		lines.push(`[interlinked:finding ${f.score.toFixed(2)}] ${f.message}${lineRef}`);
	}
	return lines;
}

// ===========================================
// Telemetry
// ===========================================

/**
 * Write suggestion telemetry for all findings (shown and unshown).
 * Append-only JSONL, non-blocking, non-fatal.
 */
export function writeTelemetry(
	allFindings: Finding[],
	shownFindings: ScoredFinding[],
	opts: {
		interlinkedDir: string;
		sessionId: string;
		agentName: string;
		filePath: string;
		threshold: number;
	},
): void {
	try {
		const telemetryPath = join(opts.interlinkedDir, "suggestion-telemetry.jsonl");
		const dir = dirname(telemetryPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const shownSet = new Set(shownFindings.map((f) => `${f.check}:${f.line}`));
		const ts = new Date().toISOString();

		const lines: string[] = [];
		for (const f of allFindings) {
			const key = `${f.check}:${f.line}`;
			const shown = shownSet.has(key);
			const scored = shownFindings.find((s) => s.check === f.check && s.line === f.line);
			lines.push(
				JSON.stringify({
					ts,
					session_id: opts.sessionId,
					agent_name: opts.agentName,
					file: opts.filePath,
					check: f.check,
					line: f.line,
					score: scored?.score ?? 0,
					shown,
					outcome: null, // determined on next PostToolUse
					threshold: opts.threshold,
					message: f.message.slice(0, 200),
				}),
			);
		}

		if (lines.length > 0) {
			appendFileSync(telemetryPath, `${lines.join("\n")}\n`);
		}
	} catch (err) {
		void err; /* intentional: telemetry is non-fatal — it should never block the agent */
	}
}
