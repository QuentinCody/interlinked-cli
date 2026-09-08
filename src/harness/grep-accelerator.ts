// ===========================================
// Grep Accelerator — PreToolUse index-backed search
// ===========================================
// Intercepts Grep and Bash (rg/grep) tool calls, queries the trigram
// index for candidate files, runs ripgrep on just those files, and
// returns results via the block-and-answer pattern.
//
// The agent sees formatted search results as the block reason — faster
// and more targeted than a full-repo scan. Includes selectivity metadata
// that helps the agent assess result quality.
//
// Scope note: the accelerator only ever handles *plain content searches*.
// `isAccelerationEligible` declines (returns null → native rg/ugrep runs)
// whenever a `glob` or non-default `output_mode` (-l / -c) is set, because
// their output shape can't be reproduced byte-for-byte. `extractSearchParams`
// still READS those fields and the gate still trips on them — that detection
// is the contract. Past the gate they are provably falsy, so the in-process
// and ripgrep paths below are content-mode only (`path:line:content`).

import { isAbsolute, relative } from "node:path";
import type { JsonObject } from "../lib/json-types.js";
import { wireAbsentOptional, wireBoolean, wireObject, wireString } from "../lib/value-validation.js";
import {
	_resetRgPathCache,
	compressGrepOutput,
	findRipgrep,
	matchInProcess,
	type RipgrepResult,
	runRipgrepOnCandidates,
	safeRegExp,
} from "./grep-accelerator-exec.js";
import { decomposePattern, parseGrepCommand } from "./regex-trigrams.js";
import type { TrigramIndex } from "./trigram-index.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

// ===========================================
// File Content Cache
// ===========================================
// Caches file content read during PostToolUse dirty-layer updates.
// The in-process matcher checks this cache first, avoiding redundant
// disk reads for files the agent just edited.

const DEFAULT_CACHE_MAX = 500;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export class FileContentCache {
	private entries = new Map<string, { content: string; ts: number }>();
	private maxEntries: number;
	private ttlMs: number;

	constructor(maxEntries = DEFAULT_CACHE_MAX, ttlMs = DEFAULT_CACHE_TTL_MS) {
		this.maxEntries = maxEntries;
		this.ttlMs = ttlMs;
	}

	/** Cache file content (called from server.ts on PostToolUse file writes) */
	set(relPath: string, content: string): void {
		// Evict oldest if at capacity
		if (this.entries.size >= this.maxEntries) {
			let oldestKey: string | null = null;
			let oldestTs = Number.POSITIVE_INFINITY;
			for (const [key, entry] of this.entries) {
				if (entry.ts < oldestTs) {
					oldestTs = entry.ts;
					oldestKey = key;
				}
			}
			if (oldestKey) this.entries.delete(oldestKey);
		}
		this.entries.set(relPath, { content, ts: Date.now() });
	}

	/** Get cached content if fresh, or null */
	get(relPath: string): string | null {
		const entry = this.entries.get(relPath);
		if (!entry) return null;
		if (Date.now() - entry.ts > this.ttlMs) {
			this.entries.delete(relPath);
			return null;
		}
		return entry.content;
	}

	/** Invalidate a specific file (e.g., on delete) */
	invalidate(relPath: string): void {
		this.entries.delete(relPath);
	}

	/** Number of cached entries */
	get size(): number {
		return this.entries.size;
	}

	/** Clear the entire cache */
	clear(): void {
		this.entries.clear();
	}
}

// ===========================================
// Configuration
// ===========================================

export interface GrepAcceleratorConfig {
	/** Maximum candidate files before falling through to normal grep (default: 500) */
	maxCandidates?: number;
	/** Maximum ratio of candidates/total before falling through (default: 0.3) */
	maxCandidateRatio?: number;
	/** Maximum output lines to return (default: 200) */
	maxOutputLines?: number;
	/** Ripgrep timeout in milliseconds (default: 10000) */
	rgTimeout?: number;
	/** Maximum candidates for in-process JS matching instead of rg spawn (default: 50).
	 *  Used ONLY for fixed-string (-F) patterns, where a JS substring match is
	 *  provably identical to `rg -F`. Regex patterns always go through rg so the
	 *  engine dialect matches the native command exactly. */
	inProcessThreshold?: number;
	/** Whether the index is provably current with disk — HEAD == baseCommit, a
	 *  clean working tree, and no in-memory dirty layer. The daemon computes this
	 *  and passes it in. When false the accelerator declines (returns null) so a
	 *  stale index can never produce a silent false negative — the central
	 *  completeness guarantee of the never-worse-than-native contract. Default
	 *  false: callers MUST opt in by asserting freshness. */
	indexFresh?: boolean;
	/** Minimum total indexed files before substitution is permitted. Below this,
	 *  a native rg/ugrep full scan is already fast enough that the index lookup +
	 *  rg spawn overhead cannot guarantee a net win, so we decline. Default 25000
	 *  — the substitution only pays off at large-monorepo scale (see the timing
	 *  analysis in docs). */
	minFilesForAccel?: number;
}

const DEFAULTS: Required<GrepAcceleratorConfig> = {
	maxCandidates: 500,
	maxCandidateRatio: 0.3,
	maxOutputLines: 200,
	rgTimeout: 10_000,
	inProcessThreshold: 50,
	indexFresh: false,
	minFilesForAccel: 25_000,
};

// ===========================================
// Main Entry Point
// ===========================================

/**
 * Check if a PreToolUse event can be accelerated via the trigram index.
 * Returns a HarnessDecision with results if acceleration is possible,
 * or null to fall through to normal execution.
 */
export function checkGrepAcceleration(
	event: HarnessEvent,
	index: TrigramIndex | null,
	config: GrepAcceleratorConfig = {},
	contentCache?: FileContentCache,
): HarnessDecision | null {
	void contentCache; // Disk reads are deliberate under the freshness gate (see executeMatch).
	if (!index) return null;

	const cfg = { ...DEFAULTS, ...config };
	const toolName = event.tool_name || "";
	const toolInput = event.tool_input || {};

	// Determine if this is a Grep tool call or a Bash grep/rg command
	const searchParams = extractSearchParams(toolName, toolInput);
	if (!searchParams) return null;

	const { pattern, isRegex, caseInsensitive, path, glob, outputMode } = searchParams;

	// Never-worse-than-native gates: decline (run native rg/ugrep) on any
	// uncertainty about staleness, repo size, or output shape. glob / outputMode
	// are consumed HERE only — the gate is the whole reason they're extracted.
	if (!isAccelerationEligible(cfg, index, glob, outputMode)) return null;

	// Decompose pattern into required trigrams
	const decomposition = decomposePattern(pattern, isRegex, caseInsensitive);
	if (!decomposition.hasLiterals) {
		// No extractable literals (pure wildcard like .* or .+)
		return null;
	}

	// Past the eligibility gate glob/outputMode are provably falsy, so the
	// candidate resolver and matcher run in content mode only.
	const candidates = resolveCandidatePaths(index, decomposition, path);

	const totalFiles = index.totalFiles;
	const ratio = totalFiles > 0 ? candidates.length / totalFiles : 1;
	const selectivityPct = totalFiles > 0 ? (candidates.length / totalFiles) * 100 : 0;

	// Decline on zero candidates, or hand back a broad-pattern warning.
	const selectivity = selectivityDecision(candidates, totalFiles, ratio, selectivityPct, cfg);
	if (!selectivity.proceed) return selectivity.decision;

	const rgResult = executeMatch({
		pattern,
		candidates,
		cwd: index.cwd,
		isRegex,
		caseInsensitive,
		cfg,
	});

	return buildAcceleratedDecision(rgResult, candidates, totalFiles, selectivityPct);
}

/**
 * Never-worse-than-native eligibility. Returns false (caller declines so native
 * rg/ugrep runs) when the index isn't provably fresh, the repo is too small for
 * the substitution to pay off, or the output shape (glob / -l / -c) can't be
 * reproduced byte-for-byte.
 *
 * The glob/outputMode decline is load-bearing: it is the ONLY thing keeping the
 * accelerator out of searches whose output shape it cannot reproduce. The
 * downstream paths assume both are unset — do not remove this gate.
 */
function isAccelerationEligible(
	cfg: Required<GrepAcceleratorConfig>,
	index: TrigramIndex,
	glob: string | undefined,
	outputMode: string | undefined,
): boolean {
	if (!cfg.indexFresh) return false;
	if (index.totalFiles < cfg.minFilesForAccel) return false;
	if (glob || outputMode) return false;
	return true;
}

/**
 * Query the index for candidates matching the decomposed pattern, then apply the
 * path filter. Absolute path filters are resolved to relative (the index stores
 * relative paths). Glob filtering lives upstream in the eligibility gate (a
 * glob-bearing search declines), so there is no glob filter here.
 */
function resolveCandidatePaths(
	index: TrigramIndex,
	decomposition: ReturnType<typeof decomposePattern>,
	path: string | undefined,
): string[] {
	const candidateIds = index.query(
		decomposition.requiredTrigrams,
		decomposition.trigramSequences,
	);
	let candidates = [...candidateIds]
		.map((id) => index.files[id] || getFilePath(index, id))
		.filter((p): p is string => p !== undefined);

	if (path && path !== ".") {
		let relPath = path;
		if (isAbsolute(path)) {
			relPath = relative(index.cwd, path);
		}
		const pathPrefix = relPath.endsWith("/") ? relPath : `${relPath}/`;
		candidates = candidates.filter((p) => p === relPath || p.startsWith(pathPrefix));
	}

	return candidates;
}

/** Result of the selectivity gate: proceed to matching, or a terminal decision. */
type SelectivityResult =
	| { proceed: true }
	| { proceed: false; decision: HarnessDecision | null };

/**
 * Gate the candidate set. Declines (null) on zero candidates — the index may be
 * stale/incomplete or the decomposition lossy, so let native grep find matches.
 * Returns an allow+warning decision when the candidate set is too broad to help.
 */
function selectivityDecision(
	candidates: string[],
	totalFiles: number,
	ratio: number,
	selectivityPct: number,
	cfg: Required<GrepAcceleratorConfig>,
): SelectivityResult {
	if (candidates.length === 0) {
		return { proceed: false, decision: null };
	}

	if (candidates.length > cfg.maxCandidates || ratio > cfg.maxCandidateRatio) {
		return {
			proceed: false,
			decision: {
				decision: "allow",
				warnings: [
					`[interlinked:index] Pattern matches ${candidates.length}/${totalFiles} files (${(ratio * 100).toFixed(1)}%) — broad pattern, consider narrowing your search.`,
				],
				grep_stats: {
					candidates: candidates.length,
					total_files: totalFiles,
					selectivity_pct: selectivityPct,
					match_count: 0,
					accelerated: false,
				},
			},
		};
	}

	return { proceed: true };
}

interface ExecuteMatchOptions {
	pattern: string;
	candidates: string[];
	cwd: string;
	isRegex: boolean;
	caseInsensitive: boolean;
	cfg: Required<GrepAcceleratorConfig>;
}

/**
 * Run the match with native-identical semantics. Fixed-string (-F) patterns use
 * the in-process matcher for small candidate sets (a JS substring scan == `rg
 * -F`), falling back to rg if JS regex compilation fails. Regex patterns ALWAYS
 * use rg's real engine — only rg guarantees the same matches as the native cmd.
 */
function executeMatch(opts: ExecuteMatchOptions): RipgrepResult | null {
	const { pattern, candidates, cwd, isRegex, caseInsensitive, cfg } = opts;
	if (!isRegex && candidates.length <= cfg.inProcessThreshold) {
		const inProcess = matchInProcess({
			pattern,
			candidates,
			cwd,
			caseInsensitive,
			maxOutputLines: cfg.maxOutputLines,
		});
		// Fall back to rg if JS regex compilation fails
		if (inProcess !== null) return inProcess;
	}
	return runRipgrepOnCandidates(pattern, candidates, cwd, isRegex, caseInsensitive, cfg);
}

/**
 * Validate the rg result and build the final block decision. Declines (null)
 * when rg was unavailable/errored, the result was truncated (native returns ALL
 * matches), or there were zero matches (native prints nothing on exit 1).
 */
function buildAcceleratedDecision(
	rgResult: RipgrepResult | null,
	candidates: string[],
	totalFiles: number,
	selectivityPct: number,
): HarnessDecision | null {
	if (rgResult === null) return null;
	if (rgResult.truncated) return null;
	if (rgResult.matchCount === 0) return null;

	return {
		decision: "block",
		// Non-zero, non-truncated content output → just the file-grouped body.
		// (The match-count==0 / truncated headers that formatResults used to add
		// are unreachable here — both are declined above.)
		reason: compressGrepOutput(rgResult.output),
		grep_stats: {
			candidates: candidates.length,
			total_files: totalFiles,
			selectivity_pct: selectivityPct,
			match_count: rgResult.matchCount,
			accelerated: true,
		},
	};
}

// ===========================================
// Search Parameter Extraction
// ===========================================

interface SearchParams {
	pattern: string;
	isRegex: boolean;
	caseInsensitive: boolean;
	path?: string | undefined;
	glob?: string | undefined;
	outputMode?: string | undefined;
}

const isGrepInput = wireObject<{
	pattern: string;
	"-i"?: boolean;
	path?: string;
	glob?: string;
	output_mode?: string;
}>({
	pattern: wireString,
	"-i": wireAbsentOptional(wireBoolean),
	path: wireAbsentOptional(wireString),
	glob: wireAbsentOptional(wireString),
	output_mode: wireAbsentOptional(wireString),
});

function extractSearchParams(toolName: string, toolInput: JsonObject): SearchParams | null {
	// Claude Code's Grep tool
	if (toolName === "Grep") {
		if (!isGrepInput(toolInput) || !toolInput.pattern) return null;
		// glob / output_mode are read so isAccelerationEligible can decline on
		// them (output shape it can't reproduce). They are intentionally never
		// threaded past that gate.
		return {
			pattern: toolInput.pattern,
			isRegex: true, // Claude Code's Grep uses regex
			caseInsensitive: toolInput["-i"] ?? false,
			path: toolInput.path,
			glob: toolInput.glob,
			outputMode: toolInput.output_mode,
		};
	}

	// Bash/Shell tool — check for rg/grep commands
	if (
		toolName === "Bash" ||
		toolName === "Shell" ||
		toolName === "shell" ||
		toolName === "run_command"
	) {
		const command = typeof toolInput.command === "string" ? toolInput.command : "";
		return parseGrepCommand(command);
	}

	return null;
}

// ===========================================
// Helpers
// ===========================================

/** Get file path from dirty new files */
function getFilePath(_index: TrigramIndex, _id: number): string | undefined {
	// The public `files` array only covers base files.
	// For dirty files, the caller should handle this.
	// In practice, query() returns IDs that are resolved by queryCandidatePaths().
	return undefined;
}

// Re-export the matching/execution helpers from their sibling so this
// module's public entry point is unchanged after the split.
export { _resetRgPathCache, compressGrepOutput, findRipgrep, safeRegExp };
