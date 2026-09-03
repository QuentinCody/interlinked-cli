// ===========================================
// PreToolUse Evaluation — extracted helpers
// ===========================================
//
// Standalone helpers split out of `pre-tool.ts` to keep the orchestrator
// under the per-file line cap (see large-file-policy.ts). These are moved
// verbatim — the logic is identical to the inline versions; only the module
// boundary changed. `evaluatePreToolUse` (in pre-tool.ts) imports each of
// them back. The git-diff / dirty-dependent / supply-chain / Bash & Read
// guard-block helpers live in the leaf sibling `pre-tool-helpers-guard-blocks.ts`
// and are re-exported from here so external importers keep their existing
// import path.

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { isFeatureEnabled, type SharedConfig } from "../../lib/config.js";
import type { JsonObject } from "../../lib/json-types.js";
import { getOrCreateEngine } from "../check-engine/index.js";
import { checkProjectSetup } from "../generic-checks.js";
import type { GraphPredictionMode } from "../graph-prediction-pre-tool.js";
import { containsSecrets as containsSecretsDetailed, findProjectRoot } from "../quality-checks.js";
import { harnessNow } from "../replay/harness-clock.js";
import { loadGraphForFile } from "../supermodel-graph.js";
import { createTrajectoryDetector, type TrajectoryEvent } from "../trajectory.js";
import type {
	HarnessEvent,
	QualityCheckConfig,
	SessionTrajectory,
} from "../types.js";

export {
	collectDirtyDependentWarning,
	computeFullNewContent,
	type ExfilGuardResult,
	evaluateCurlMcpGuards,
	evaluateExfilGuards,
	evaluateMarkdownFirstCurlGuard,
	evaluateReadGuards,
	type ReadGuardResult,
} from "./pre-tool-helpers-guard-blocks.js";

const DIAGNOSTIC_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs)$/;
const SECRETS_MIN_CHARS = 10;

let _projectSetupChecked = false;
let _projectSetupWarnings: string[] = [];

export function getProjectSetupWarnings(cwd: string): string[] {
	if (_projectSetupChecked) return _projectSetupWarnings;
	_projectSetupChecked = true;
	const issues = checkProjectSetup(cwd);
	if (issues.length === 0) return [];
	_projectSetupWarnings = issues.map((i) => `[interlinked:setup] ${i.message}\n  fix: ${i.fix}`);
	return _projectSetupWarnings;
}

/** Public — invalidate the project-setup-warning cache. Called by the
 *  SessionStart auto-strip after rewriting `.claude/settings*.json`, so
 *  the next PreToolUse re-reads the file and stops emitting warnings
 *  for entries that have just been stripped. Without this, the daemon
 *  would keep serving the stale warning text for the remainder of its
 *  process lifetime. */
export function resetProjectSetupWarningsCache(): void {
	_projectSetupChecked = false;
	_projectSetupWarnings = [];
}

/** Boolean wrapper: delegates to quality-checks.ts signature scanner. */
export function containsSecrets(content: string): boolean {
	if (!content || content.length < SECRETS_MIN_CHARS) return false;
	return containsSecretsDetailed(content).length > 0;
}

/** Phase D.2 trajectory detector entry point. Per session: lazy-instantiates
 *  the detector when any trajectory feature flag is on, then calls observe()
 *  for the current event and filters findings to only the enabled patterns.
 *
 *  Returns the warning strings to push onto the PreToolUse decision's
 *  warnings array. Empty array when the detector is disabled, the event
 *  isn't a recognized hook, or no findings fired. */
export function runTrajectoryDetector(
	event: HarnessEvent,
	session: SessionTrajectory,
	sharedConfig: SharedConfig | null,
): string[] {
	const enabledPatterns = new Set<import("../trajectory.js").TrajectoryFinding["pattern"]>();
	if (isFeatureEnabled("harness.trajectory.tool_loop", sharedConfig)) {
		enabledPatterns.add("tool_loop");
	}
	if (isFeatureEnabled("harness.trajectory.destructive_sequence", sharedConfig)) {
		enabledPatterns.add("destructive_sequence");
	}
	if (isFeatureEnabled("harness.trajectory.unbackedoff_retry", sharedConfig)) {
		enabledPatterns.add("unbackedoff_retry");
	}
	if (isFeatureEnabled("harness.trajectory.silent_stall", sharedConfig)) {
		enabledPatterns.add("silent_stall");
	}
	if (enabledPatterns.size === 0) return [];

	if (!session.trajectoryDetector) {
		session.trajectoryDetector = createTrajectoryDetector();
	}

	const tsString = event.timestamp;
	const tsMs = tsString ? Date.parse(tsString) : Number.NaN;
	const trajectoryEvent: TrajectoryEvent = {
		ts_ms: Number.isFinite(tsMs) ? tsMs : harnessNow(),
		hook_event:
			event.hook_event === "PostToolUse" || event.hook_event === "PostToolUseFailure"
				? event.hook_event
				: "PreToolUse",
		tool_name: event.tool_name || "",
		tool_input: event.tool_input,
	};

	const findings = session.trajectoryDetector.observe(trajectoryEvent);
	if (findings.length === 0) return [];

	return findings
		.filter((f) => enabledPatterns.has(f.pattern))
		.map((f) => f.message);
}

/** Read the graph-prediction protocol mode from shared config. Defaults
 *  to "shadow" — telemetry-only, no challenge fires. Phase 4 of the
 *  rollout flips the default to "soft_gate" or "enforced". */
export function readGraphPredictionMode(config: SharedConfig | null): GraphPredictionMode {
	const harness = config?.harness as JsonObject | undefined;
	const block = harness?.graph_prediction as JsonObject | undefined;
	const mode = block?.mode;
	if (mode === "shadow" || mode === "soft_gate" || mode === "enforced") return mode;
	return "shadow";
}

/** Graph-prediction is OFF unless a repo opts in with
 *  `harness.graph_prediction.enabled: true`. Disabled by default (user, 2026-06-08):
 *  we no longer require a Supermodel `.graph` shard prediction before an edit. */
export function isGraphPredictionEnabled(config: SharedConfig | null): boolean {
	const block = (config?.harness as JsonObject | undefined)?.graph_prediction as
		| JsonObject
		| undefined;
	return block?.enabled === true;
}

/** Formats the HIGH-risk variant of the Supermodel graph warning. Split out
 *  of `getSupermodelGraphWarning` to keep that function's cognitive
 *  complexity under the per-function cap — behavior is unchanged. */
function formatHighRiskGraphWarning(
	relPath: string,
	direct: number,
	transitive: number,
	domains: string[],
	affects: string[],
): string {
	const domainsClause =
		domains.length > 0 ? ` across domains ${domains.join(" · ")}` : "";
	const affectsClause =
		affects.length > 0
			? ` Affects: ${affects.slice(0, 5).join(" · ")}${affects.length > 5 ? " · …" : ""}.`
			: "";
	return (
		`[interlinked:supermodel-graph] ${relPath}: ` +
		`HIGH-risk edit per .graph shard: ${direct} dependent file(s), ${transitive} transitive${domainsClause}.` +
		`${affectsClause} Confirm this is intentional.`
	);
}

/** Read-only consumer of Supermodel-emitted `.graph.*` shards. Returns one
 *  warning string when a HIGH or MEDIUM impact section is present for the
 *  edited file; returns null on LOW, missing shards, parse failures, or any
 *  I/O error. The shard file IS the API — we never call Supermodel's service
 *  or generate shards ourselves. See `docs/integrations/supermodel.md`. */
export function getSupermodelGraphWarning(filePath: string, cwd?: string): string | null {
	const graph = loadGraphForFile(filePath, cwd);
	if (!graph || !graph.impact) return null;
	const { risk, domains, direct, transitive, affects } = graph.impact;
	if (risk === "LOW") return null;

	const relPath = cwd
		? relative(cwd, graph.sourcePath) || graph.sourcePath
		: graph.sourcePath;

	if (risk === "HIGH") {
		return formatHighRiskGraphWarning(relPath, direct, transitive, domains, affects);
	}

	const domainsClause =
		domains.length > 0 ? ` across ${domains.join(" · ")}` : "";
	const affectsClause =
		affects.length > 0
			? ` Affects: ${affects.slice(0, 3).join(" · ")}${affects.length > 3 ? " · …" : ""}.`
			: "";
	return (
		`[interlinked:supermodel-graph] ${relPath}: ` +
		`${direct} dependent file(s)${domainsClause}.${affectsClause}`
	);
}

/** Minimum external caller sites before the call-graph context line fires.
 *  A function with a single caller is under the noise floor — not a
 *  blast-radius signal worth a PreToolUse line. Tunable from telemetry; see
 *  `docs/plans/08-supermodel-graph-provider.md` §3a. */
const SUPERMODEL_CALL_MIN_CALLERS = 2;
/** Cap on functions listed in the call-graph context line. */
const SUPERMODEL_CALL_FN_CAP = 5;

/** Plan 08 §3a — read-only consumer of the `[calls]` section of a Supermodel
 *  `.graph.*` shard. Returns a function-level context line naming which
 *  functions defined in the edited file have external callers, ranked by
 *  caller count; null when the shard carries no `[calls]` section or has
 *  fewer than `SUPERMODEL_CALL_MIN_CALLERS` caller sites. The caller gates
 *  this behind a firing `[impact]` line, so plan 07's "LOW edits are silent"
 *  guarantee holds — no new noise surface on routine edits. */
export function getSupermodelCallContext(filePath: string, cwd?: string): string | null {
	const graph = loadGraphForFile(filePath, cwd);
	if (!graph?.calls) return null;
	const { callers } = graph.calls;
	if (callers.length < SUPERMODEL_CALL_MIN_CALLERS) return null;

	// Group caller sites by the function they target — callers[].fn is
	// defined in THIS file; a function with more caller sites is the
	// higher-risk edit, so rank by count.
	const byFn = new Map<string, number>();
	for (const c of callers) {
		byFn.set(c.fn, (byFn.get(c.fn) ?? 0) + 1);
	}
	const ranked = [...byFn.entries()].sort((a, b) => b[1] - a[1]);
	const shown = ranked
		.slice(0, SUPERMODEL_CALL_FN_CAP)
		.map(([fn, n]) => `${fn} (${n} caller${n === 1 ? "" : "s"})`)
		.join(", ");
	const more =
		ranked.length > SUPERMODEL_CALL_FN_CAP
			? ` (+${ranked.length - SUPERMODEL_CALL_FN_CAP} more)`
			: "";

	const relPath = cwd
		? relative(cwd, graph.sourcePath) || graph.sourcePath
		: graph.sourcePath;
	return (
		`[interlinked:supermodel-graph] ${relPath}: call graph per .graph shard — ` +
		`${callers.length} caller site(s) into ${byFn.size} function(s): ${shown}${more}. ` +
		"Changing these signatures ripples to every caller."
	);
}

/** Return already-cached diagnostics as advisory context BEFORE an edit.
 *  This path must never discover or spawn tsc/biome: PreToolUse owns the
 *  daemon's latency-critical deterministic phase. A cold cache is silent;
 *  async PostTool checks repopulate evidence after the write. */
export function getPreToolUseDiagnostics(
	filePath: string,
	cwd: string,
	qualityChecks: Record<string, QualityCheckConfig> | undefined,
): string[] {
	if (!filePath || !DIAGNOSTIC_EXTENSIONS.test(filePath) || !existsSync(filePath)) return [];
	if (!qualityChecks) return [];
	const checkCwd = findProjectRoot(filePath, cwd) || cwd;
	const relPath = relative(checkCwd, filePath) || filePath;
	const engine = getOrCreateEngine(checkCwd);
	const results = engine.getCachedDiagnostics(filePath);
	if (results.length === 0) return [];
	const diagnostics = results.slice(0, 10).map((r) => {
		const prefix = r.tool === "biome" ? "biome: " : "";
		return `${prefix}${r.file}(${r.line}): ${r.message}`;
	});
	return [
		`[interlinked:diagnostics] ${relPath} has ${diagnostics.length} existing issue${diagnostics.length === 1 ? "" : "s"}:`,
		...diagnostics.map((d) => `  ${d}`),
		"→ Fix these while editing this file.",
	];
}
