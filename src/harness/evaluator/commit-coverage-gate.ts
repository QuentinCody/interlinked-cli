// ===========================================
// PreToolUse Bash gate — coverage of the STAGED bytes at `git commit` (WARN-only)
// ===========================================
// The strict per-file coverage ratchet runs at pre-push, after the commit. It
// can only say "this file dropped below its baseline" minutes later, in an
// export. This gate names the same drop at commit time, when evidence for the
// staged bytes already exists: a coverage run that read exactly those bytes
// (`coverage-source-binding.ts`). Unmeasured bytes are reported as NOT
// MEASURED, never as a pass.
//
// CALLING CONVENTION: WARN-only, the same as `runCommitShippabilityGate`. It
// appends to `preDecision.warnings`, never blocks, never throws.
//
// Limits (stated, not hidden):
//   - A match binds the SOURCE bytes only; the run's tests may differ from the
//     staged tests. The pre-push ratchet stays the gate; this is its early echo.
//   - Every metric present in both the measurement and the baseline is
//     compared, at the report's 2-decimal resolution, with no allowance.
//   - The index is judged, as for the other commit gates.

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { hashBytes } from "../../lib/metrics/inventory.js";
import { baselineKeyFor, COVERAGE_METRICS } from "../coverage-metric-names.js";
import { normalizeReportPct } from "../coverage-ratchet-compare.js";
import { type CoverageBaselineFileEntry, loadBaseline } from "../coverage-ratchet.js";
import { type CoverageMetrics, type CoverageSourceIndex, measuredCoverage, recentCoverageSources } from "../coverage-source-binding.js";
import { isCappableFile } from "../large-file-policy.js";
import { receiptStorePath } from "../test-run-receipt.js";
import type { HarnessDecision, HarnessEvent } from "../types.js";
import { resolveRepoRoot } from "./commit-git-io.js";
import { parseGitCommit } from "./commit-parse.js";
import { readToolString } from "./tool-input-values.js";

const TAG = "[interlinked:commit-coverage]";
const MAX_FILES = 50;
const MAX_REPORTED = 5;
const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const CODE_FILE = /\.(?:ts|tsx|js|mjs|cjs|mts|cts|jsx)$/;
const MEASURE_COMMAND = "interlinked tests run --all --coverage";

interface StagedSource {
	path: string;
	sha256: string;
}

interface GateContext {
	indexes: readonly CoverageSourceIndex[];
	baseline: Record<string, CoverageBaselineFileEntry>;
}

function git(root: string, args: string[]): Buffer {
	return execFileSync("git", ["-C", root, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"] });
}

/** Added or modified staged code files that the line cap governs (product code, not tests or generated files), with their staged sha256. */
function stagedSources(root: string): StagedSource[] {
	const names = git(root, ["diff", "--cached", "--name-only", "--diff-filter=AM", "-z"]).toString("utf8").split("\0").filter(Boolean);
	const sources: StagedSource[] = [];
	for (const path of names.filter((name) => CODE_FILE.test(name)).slice(0, MAX_FILES)) {
		const bytes = git(root, ["show", `:${path}`]);
		if (isCappableFile({ filePath: path, content: bytes.toString("utf8"), root })) sources.push({ path, sha256: hashBytes(bytes) });
	}
	return sources;
}

/** `lines 70% < baseline 90%` for each metric the measurement holds below its baseline. */
function metricDrops(metrics: CoverageMetrics, prior: CoverageBaselineFileEntry | undefined): string[] {
	if (!prior) return [];
	const drops: string[] = [];
	for (const metric of COVERAGE_METRICS) {
		const current = metrics[metric];
		const floor = prior[baselineKeyFor(metric)];
		if (current === undefined || floor === undefined) continue;
		if (normalizeReportPct(current) < normalizeReportPct(floor)) drops.push(`${metric} ${current}% < baseline ${floor}%`);
	}
	return drops;
}

function judge(context: GateContext, sources: StagedSource[]): { drops: string[]; unmeasured: string[] } {
	const drops: string[] = [];
	const unmeasured: string[] = [];
	for (const source of sources) {
		const match = measuredCoverage(context.indexes, source);
		if (!match) {
			unmeasured.push(source.path);
			continue;
		}
		const below = metricDrops(match.metrics, context.baseline[source.path]);
		if (below.length > 0) drops.push(`${TAG} ${source.path}: ${below.join(", ")} on these exact bytes (run ${match.runId}); the pre-push coverage ratchet will refuse this.`);
	}
	return { drops, unmeasured };
}

function shown(paths: string[]): string {
	const head = paths.slice(0, MAX_REPORTED).join(", ");
	return paths.length > MAX_REPORTED ? `${head} and ${paths.length - MAX_REPORTED} more` : head;
}

function collectLines(root: string): string[] {
	const sources = stagedSources(root);
	if (sources.length === 0) return [];
	const context: GateContext = { indexes: recentCoverageSources(receiptStorePath(root)), baseline: loadBaseline(join(root, ".interlinked")).files };
	const { drops, unmeasured } = judge(context, sources);
	const lines = drops.slice(0, MAX_REPORTED);
	if (drops.length > MAX_REPORTED) lines.push(`${TAG} and ${drops.length - MAX_REPORTED} more file(s) below baseline.`);
	if (unmeasured.length > 0) {
		lines.push(`${TAG} NOT MEASURED: no coverage run read the staged bytes of ${unmeasured.length} source file(s): ${shown(unmeasured)}. Measure before pushing: ${MEASURE_COMMAND}`);
	}
	return lines;
}

function commitLines(event: HarnessEvent): string[] {
	const parse = parseGitCommit(readToolString(event.tool_input?.command));
	if (!parse?.isCommit) return [];
	const baseCwd = event.cwd || process.cwd();
	const root = resolveRepoRoot(parse.cwd ? resolve(baseCwd, parse.cwd) : baseCwd);
	return root ? collectLines(root) : [];
}

/** Pipeline entry: appends coverage warnings for a real `git commit`; a no-op otherwise. Never blocks, never throws. */
export function runCommitCoverageGate(event: HarnessEvent, preDecision: HarnessDecision): void {
	if (preDecision.decision !== "allow" || event.tool_name !== "Bash") return;
	let lines: string[];
	try {
		lines = commitLines(event);
	} catch {
		lines = [`${TAG} NOT CHECKED: git or the coverage store could not be read.`];
	}
	if (lines.length > 0) preDecision.warnings = [...(preDecision.warnings ?? []), ...lines];
}
