// ===========================================
// Supermodel analyses — dead-code consumer (plan-08 §3d)
// ===========================================
// Wraps `supermodel dead-code --output json`: the Supermodel CLI's
// repo-wide unreachable-function analysis (call-graph reachability +
// entry-point detection + transitive propagation, with confidence
// levels).
//
// Unlike the per-file `.graph.*` shards — read locally and instantly by
// supermodel-graph.ts — `dead-code` is a CLOUD API call: it uploads the
// repository archive, requires an API key, and can take minutes (the
// CLI's own default timeout is 7200s). So this is NOT a harness check.
// It is a `verify`-tier, on-demand, opt-in integration: it runs only
// when the `supermodel` CLI is installed and degrades silently
// otherwise. Surfacing it through `interlinked verify` is the connector
// step — see `docs/plans/08-supermodel-graph-provider.md` §3d.
//
// Determinism note: the dead-code RANKING (confidence, framework
// entry-point handling) is Supermodel's; we consume it verbatim — the
// playbook lesson is "don't re-derive a precise analysis with a
// less-precise one." The only logic here is shelling out (argv array,
// no shell) and parsing — both deterministic.

import { execFileSync } from "node:child_process";

/** One unreachable-function candidate from `supermodel dead-code`. */
export interface DeadCodeCandidate {
	file: string;
	name: string;
	line: number;
	confidence: "high" | "medium" | "low";
	reason: string;
}

/** Parsed `supermodel dead-code --output json` result. */
interface DeadCodeAnalysis {
	candidates: DeadCodeCandidate[];
	totalDeclarations: number;
}

/** Default ceiling for the cloud analysis. The CLI's own default is
 *  7200s; a `verify`-tier integration wants a tighter bound — the CLI
 *  caches by git fingerprint, so only a cold first run is slow. */
const DEFAULT_DEAD_CODE_TIMEOUT_MS = 300_000;
/** stdout ceiling — a large repo's analysis can be sizeable. */
const DEAD_CODE_MAX_BUFFER = 16 * 1024 * 1024;
/** Default cap on findings surfaced to the agent. */
const DEFAULT_FINDING_CAP = 20;
/** Timeout for the local `supermodel version` availability probe. */
const CLI_VERSION_CHECK_TIMEOUT_MS = 5000;

/** Raw, untyped shapes for parsing `supermodel dead-code` JSON. Every
 *  field is `unknown` and validated at runtime by parseDeadCodeJson — the
 *  named shapes document the expected payload without trusting it. */
interface RawDeadCodeResult {
	deadCodeCandidates?: unknown;
	metadata?: unknown;
}
interface RawCandidate {
	file?: unknown;
	name?: unknown;
	line?: unknown;
	confidence?: unknown;
	reason?: unknown;
}
interface RawMetadata {
	totalDeclarations?: unknown;
}

export interface RunDeadCodeOptions {
	minConfidence?: "high" | "medium" | "low";
	limit?: number;
	timeoutMs?: number;
	/** Binary name — overridable for tests; production always uses "supermodel". */
	binary?: string;
}

/**
 * Parse the JSON emitted by `supermodel dead-code --output json`. Tolerant:
 * returns null on unparseable input or a missing candidate array, and skips
 * individual malformed candidates rather than failing the whole parse.
 * Never throws.
 */
export function parseDeadCodeJson(stdout: string): DeadCodeAnalysis | null {
	if (!stdout || stdout.trim() === "") return null;
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const obj = raw as RawDeadCodeResult;
	if (!Array.isArray(obj.deadCodeCandidates)) return null;

	const candidates: DeadCodeCandidate[] = [];
	for (const entry of obj.deadCodeCandidates) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as RawCandidate;
		if (typeof e.file !== "string" || typeof e.name !== "string") continue;
		const conf = e.confidence;
		const confidence: DeadCodeCandidate["confidence"] =
			conf === "high" || conf === "medium" || conf === "low" ? conf : "low";
		candidates.push({
			file: e.file,
			name: e.name,
			line: typeof e.line === "number" ? e.line : 0,
			confidence,
			reason: typeof e.reason === "string" ? e.reason : "",
		});
	}

	let totalDeclarations = 0;
	const meta = obj.metadata;
	if (typeof meta === "object" && meta !== null) {
		const td = (meta as RawMetadata).totalDeclarations;
		if (typeof td === "number") totalDeclarations = td;
	}

	return { candidates, totalDeclarations };
}

/**
 * True when the `supermodel` CLI responds to `supermodel version`. The
 * dead-code integration is opt-in: an absent CLI means the check is
 * silently skipped. `version` is a local command — no cloud round-trip.
 */
export function isSupermodelCliAvailable(binary = "supermodel"): boolean {
	try {
		execFileSync(binary, ["version"], {
			stdio: "ignore",
			timeout: CLI_VERSION_CHECK_TIMEOUT_MS,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Run `supermodel dead-code --output json` in `cwd` and return the parsed
 * analysis. Returns null when the CLI is unavailable, the invocation fails
 * (no API key, network error, timeout), or the output is unparseable — the
 * integration is advisory and degrades silently. Uses the argv-array form
 * (no shell), so repo paths cannot inject.
 */
export function runSupermodelDeadCode(
	cwd: string,
	opts: RunDeadCodeOptions = {},
): DeadCodeAnalysis | null {
	const args = ["dead-code", "--output", "json"];
	if (opts.minConfidence) args.push("--min-confidence", opts.minConfidence);
	if (typeof opts.limit === "number" && opts.limit > 0) {
		args.push("--limit", String(opts.limit));
	}
	let stdout: string;
	try {
		stdout = execFileSync(opts.binary ?? "supermodel", args, {
			cwd,
			encoding: "utf-8",
			timeout: opts.timeoutMs ?? DEFAULT_DEAD_CODE_TIMEOUT_MS,
			maxBuffer: DEAD_CODE_MAX_BUFFER,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
	return parseDeadCodeJson(stdout);
}

/**
 * Format a dead-code analysis into agent-facing finding lines, highest
 * confidence first, capped. Returns [] when there are no candidates.
 */
export function formatDeadCodeFindings(
	analysis: DeadCodeAnalysis,
	opts: { max?: number } = {},
): string[] {
	if (analysis.candidates.length === 0) return [];
	const rank: Record<DeadCodeCandidate["confidence"], number> = {
		high: 0,
		medium: 1,
		low: 2,
	};
	const ranked = [...analysis.candidates].sort(
		(a, b) => rank[a.confidence] - rank[b.confidence],
	);
	const max = opts.max ?? DEFAULT_FINDING_CAP;
	const lines = ranked
		.slice(0, max)
		.map(
			(c) =>
				`[interlinked:supermodel-dead-code] ${c.file}:${c.line} ${c.name} ` +
				`(${c.confidence} confidence) — ${c.reason}`,
		);
	if (ranked.length > max) {
		lines.push(
			`[interlinked:supermodel-dead-code] …and ${ranked.length - max} more candidate(s).`,
		);
	}
	return lines;
}
