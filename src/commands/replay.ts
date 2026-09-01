// ===========================================
// `interlinked replay` — capture instructions + envelope status
// ===========================================
// Operator surface for the G1 inference proxy
// (docs/design/reproducibility/g1-inference-capture.md). `capture` prints how
// to start the proxy and point a runner at it; `status` reports what has been
// captured so far. The Tier-1 assembler/eval subcommands land with unit 4 of
// the campaign (scratch/CAMPAIGN-replay-env.md).

import { join } from "node:path";
import { aggregateLedger, type EvalSummary } from "../harness/replay/eval-aggregator.js";
import { allocRunId, loadLedger } from "../harness/replay/eval-ledger.js";
import { runEvalOverTrace } from "../harness/replay/eval-runner.js";
import { loadEnvelopes, pendingEnvelopePath } from "../harness/replay/inference-store.js";
import { restoreSessionStep } from "../harness/replay/sandbox-restore.js";
import { recordToolchainManifest } from "../harness/replay/toolchain-manifest.js";
import { assembleTrace, loadTrace } from "../harness/replay/trace-assembler.js";
import { c } from "../lib/formatter.js";
import { getOutputMode, output } from "../lib/output.js";

interface ReplayStatus {
	envelope_count:number;
	/** Envelopes whose response contained at least one tool_use block. */
	tool_turn_count: number;
	latest_ts: string | null;
}

/** Summarize the pending capture file. Pure over the store. */
export function collectReplayStatus(replayDir: string): ReplayStatus {
	const envelopes = loadEnvelopes(pendingEnvelopePath(replayDir));
	let toolTurns = 0;
	let latest: string | null = null;
	for (const e of envelopes) {
		if (e.tool_use_ids.length > 0) toolTurns++;
		if (latest === null || e.ts_response > latest) latest = e.ts_response;
	}
	return { envelope_count: envelopes.length, tool_turn_count: toolTurns, latest_ts: latest };
}

/** The exact operator steps to start capturing. Kept as a pure function so
 *  the test pins the load-bearing strings (entry path, dir, env var). */
export function buildCaptureInstructions(cwd: string): string {
	const replayDir = join(cwd, ".interlinked", "replay");
	return [
		"Start the inference-boundary capture proxy (records the EXACT model",
		"input/output — the one signal hooks cannot see):",
		"",
		`  1. node ${join(cwd, "dist", "harness", "replay", "inference-proxy.js")}`,
		"       PORT=8787 by default; ANTHROPIC_REAL_BASE_URL to override upstream.",
		// interlinked-ignore: ubs_hardcoded_localhost — instructional text describing the proxy's deliberate loopback-only bind (see inference-proxy.ts).
		"  2. In the runner's shell:  export ANTHROPIC_BASE_URL=http://127.0.0.1:8787",
		"  3. Work normally. Envelopes land in:",
		`       ${join(replayDir, "inference", "pending.jsonl")}`,
		"",
		"Notes: auth headers are forwarded live and NEVER persisted; envelopes",
		"contain full prompts, stay gitignored, and are never synced. `interlinked",
		"replay status` shows capture counts.",
	].join("\n");
}

/** Consumed by src/registrars/replay.ts (the `interlinked replay` command). */
export function replayCaptureAction(opts: { json?: boolean }): number {
	const cwd = process.cwd();
	output(getOutputMode(opts), { instructions: buildCaptureInstructions(cwd) }, {
		normal: () => buildCaptureInstructions(cwd),
	});
	return 0;
}

/** Consumed by src/registrars/replay.ts (the `interlinked replay` command). */
export function replayAssembleAction(opts: { session: string; json?: boolean }): number {
	const cwd = process.cwd();
	const summary = assembleTrace(cwd, opts.session);
	const steps = loadTrace(cwd, opts.session);
	const withTrees = steps.filter((s) => s.pre_tree !== null).length;
	const data = { ...summary, steps_with_tree: withTrees, session: opts.session };
	const mode = getOutputMode(opts);
	output(mode, data, {
		normal: () =>
			[
				c.bold(`Assembled replay trace for ${opts.session}`),
				`  steps               ${summary.steps}`,
				`  with exact obs      ${summary.steps_with_envelope}  ${c.dim("(G1 envelopes joined by tool_use_id)")}`,
				`  with tree snapshots ${withTrees}`,
				`  trace file          .interlinked/replay/trace/`,
			].join("\n"),
	});
	return 0;
}

function renderSummary(summary: EvalSummary): string {
	const lines = [
		c.bold(`Eval ${summary.run_id}`) + c.dim(`  candidate=${summary.candidate_model}`),
		`  steps scored        ${summary.steps}`,
		`  action match        ${(summary.action_match_rate * 100).toFixed(1)}%`,
		`  structural scored   ${summary.structural.scored}  mean=${summary.structural.mean_normalized}  p50=${summary.structural.p50_normalized}  p90=${summary.structural.p90_normalized}`,
	];
	for (const [tool, stats] of Object.entries(summary.by_tool)) {
		lines.push(`    ${tool.padEnd(12)} steps=${stats.steps}  match=${(stats.action_match_rate * 100).toFixed(1)}%`);
	}
	return lines.join("\n");
}

/** Consumed by src/registrars/replay.ts (the `interlinked replay` command). */
export async function replayEvalAction(opts: {
	session: string;
	candidate: string;
	baseUrl?: string;
	limit?: string;
	keepThinking?: boolean;
	json?: boolean;
}): Promise<number> {
	const cwd = process.cwd();
	// Command boundary: the ONLY place eval reads the environment.
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey && !opts.baseUrl) {
		console.error(
			"replay eval: set ANTHROPIC_API_KEY (cloud candidate) or pass --base-url (local candidate).",
		);
		return 1;
	}
	const runId = allocRunId(opts.candidate, () => new Date().toISOString());
	const summary = await runEvalOverTrace({
		cwd,
		sessionId: opts.session,
		candidateModel: opts.candidate,
		runId,
		...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
		...(apiKey !== undefined ? { apiKey } : {}),
		...(opts.keepThinking !== undefined ? { keepThinking: opts.keepThinking } : {}),
		...(opts.limit !== undefined ? { limit: Number(opts.limit) } : {}),
		log: (msg) => console.error(`  ${c.dim(msg)}`),
	});
	const aggregate = aggregateLedger(loadLedger(cwd, runId));
	const data = { ...summary, aggregate };
	output(getOutputMode(opts), data, {
		normal: () =>
			[
				renderSummary(aggregate),
				`  evaluated=${summary.evaluated}  no-envelope=${summary.skipped_no_envelope}  failed=${summary.failed}`,
				c.dim(`  ledger: .interlinked/replay/eval/${runId}/ledger.jsonl`),
			].join("\n"),
	});
	return summary.failed > 0 && summary.evaluated === 0 ? 1 : 0;
}

/** Consumed by src/registrars/replay.ts (the `interlinked replay` command). */
export function replayReportAction(opts: {
	run: string;
	compare?: string;
	json?: boolean;
}): number {
	const cwd = process.cwd();
	const primary = aggregateLedger(loadLedger(cwd, opts.run));
	const comparison = opts.compare ? aggregateLedger(loadLedger(cwd, opts.compare)) : null;
	const data = comparison ? { primary, comparison } : { primary };
	output(getOutputMode(opts), data, {
		normal: () => {
			const parts = [renderSummary(primary)];
			if (comparison) {
				parts.push("", renderSummary(comparison));
				const delta = (primary.action_match_rate - comparison.action_match_rate) * 100;
				parts.push("", `  Δ action match (primary − comparison): ${delta.toFixed(1)} points`);
			}
			return parts.join("\n");
		},
	});
	return 0;
}

/** Consumed by src/registrars/replay.ts (the `interlinked replay` command). */
export function replayRestoreAction(opts: {
	session: string;
	seq: string;
	dest: string;
	json?: boolean;
}): number {
	const cwd = process.cwd();
	try {
		const summary = restoreSessionStep({
			cwd,
			sessionId: opts.session,
			seq: Number(opts.seq),
			destDir: opts.dest,
		});
		const manifest = recordToolchainManifest(cwd);
		const data = { ...summary, dest: opts.dest, toolchain: manifest.tools };
		output(getOutputMode(opts), data, {
			normal: () =>
				[
					c.bold(`Restored ${opts.session} @ seq ${opts.seq}`),
					`  tree                ${summary.tree.slice(0, 12)}`,
					`  harness state       ${summary.state_found ? `restored (${summary.baselines_written} baseline file(s))` : "not archived for this seq"}`,
					`  dest                ${opts.dest}`,
					c.dim("  toolchain manifest recorded — pin the sandbox to it for rollouts"),
				].join("\n"),
		});
		return 0;
	} catch (err) {
		console.error(`replay restore: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

export function replayStatusAction(opts: { json?: boolean }): number {
	const replayDir = join(process.cwd(), ".interlinked", "replay");
	const status = collectReplayStatus(replayDir);
	output(getOutputMode(opts), status, {
		normal: () => {
			const lines = [
				c.bold("Replay capture status"),
				`  envelopes      ${status.envelope_count}`,
				`  tool turns     ${status.tool_turn_count}`,
				`  latest         ${status.latest_ts ?? "—"}`,
			];
			if (status.envelope_count === 0) {
				lines.push(`  ${c.dim("nothing captured yet — run `interlinked replay capture`")}`);
			}
			return lines.join("\n");
		},
	});
	return 0;
}
