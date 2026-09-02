// ===========================================
// T1 eval runner — teacher-forced comparison over an assembled trace
// ===========================================
// Walks a session's replay-trace steps; for each step whose EXACT observation
// was captured (G1 envelope joined by tool_use_id), replays that observation
// into the candidate model and scores the proposed action against the
// recorded reference action — action-match + structural distance — writing
// one ledger row per evaluated step. Off-policy: the next step always uses
// the REFERENCE's recorded observation, never the candidate's output
// (docs/design/reproducibility/tier1-teacher-forced-eval.md).
//
// The candidate call is injectable so tests run without a network; the
// default is the real candidate-runner. Envelope-less steps are skipped and
// COUNTED — degraded coverage stays visible.

import {
	type CandidateRunResult,
	type RunCandidateArgs,
	runCandidate,
} from "./candidate-runner.js";
import { appendLedgerRow, type LedgerRow } from "./eval-ledger.js";
import { envelopeForToolUseId, loadEnvelopes } from "./inference-store.js";
import { actionMatch } from "./scorers/action-match.js";
import { scoreEditActions } from "./scorers/ast-edit-diff.js";
import { loadTrace, perSessionEnvelopePath } from "./trace-assembler.js";

type CandidateRunnerFn = (args: RunCandidateArgs) => Promise<CandidateRunResult>;

interface EvalRunArgs {
	cwd: string;
	sessionId: string;
	candidateModel: string;
	runId: string;
	/** Candidate endpoint; defaults to the real API. A local server (vLLM
	 *  behind an Anthropic-compatible shim, etc.) slots in here. */
	baseUrl?: string;
	apiKey?: string;
	keepThinking?: boolean;
	/** Max steps to evaluate (cost control). */
	limit?: number;
	now?: () => string;
	log?: (msg: string) => void;
	runner?: CandidateRunnerFn;
}

interface EvalRunSummary {
	run_id: string;
	evaluated: number;
	skipped_no_envelope: number;
	failed: number;
}

interface EvalRunDefaults {
	runner: CandidateRunnerFn;
	now: () => string;
	limit: number;
	log: (msg: string) => void;
}

function resolveEvalDefaults(args: EvalRunArgs): EvalRunDefaults {
	return {
		runner: args.runner ?? runCandidate,
		now: args.now ?? (() => new Date().toISOString()),
		limit: args.limit ?? Number.POSITIVE_INFINITY,
		log: args.log ?? ((): void => undefined),
	};
}

function buildLedgerRow(
	args: EvalRunArgs,
	step: ReturnType<typeof loadTrace>[number],
	toolUseId: string | null,
	envelope: NonNullable<ReturnType<typeof envelopeForToolUseId>>,
	result: CandidateRunResult,
	now: () => string,
): LedgerRow {
	const refAction = {
		tool: step.action?.tool ?? null,
		input: step.action?.input ?? null,
	};
	return {
		schema: "replay-eval.v1",
		run_id: args.runId,
		ts: now(),
		mode: "off_policy",
		reference: {
			session_id: args.sessionId,
			seq: step.key.seq,
			tool_use_id: toolUseId,
			model: typeof envelope.request.model === "string" ? envelope.request.model : null,
		},
		candidate: { model: args.candidateModel, decode: "default" },
		scores: {
			action_match: actionMatch(refAction, result.proposed),
			structural: scoreEditActions(refAction, result.proposed),
		},
		reference_tool: refAction.tool,
	};
}

function formatEvalStepError(step: ReturnType<typeof loadTrace>[number], err: unknown): string {
	return `eval step seq=${step.key.seq ?? "?"} failed: ${err instanceof Error ? err.message : String(err)}`;
}

export async function runEvalOverTrace(args: EvalRunArgs): Promise<EvalRunSummary> {
	const steps = loadTrace(args.cwd, args.sessionId);
	const envelopes = loadEnvelopes(perSessionEnvelopePath(args.cwd, args.sessionId));
	const { runner, now, limit, log } = resolveEvalDefaults(args);

	let evaluated = 0;
	let skipped = 0;
	let failed = 0;
	for (const step of steps) {
		if (evaluated >= limit) break;
		const toolUseId = step.key.tool_use_id;
		const envelope = toolUseId ? envelopeForToolUseId(envelopes, toolUseId) : null;
		if (!envelope) {
			skipped++;
			continue;
		}
		try {
			const result = await runner({
				envelope,
				model: args.candidateModel,
				baseUrl: args.baseUrl ?? "https://api.anthropic.com",
				apiKey: args.apiKey,
				keepThinking: args.keepThinking ?? false,
			});
			const row = buildLedgerRow(args, step, toolUseId, envelope, result, now);
			appendLedgerRow(args.cwd, row);
			evaluated++;
		} catch (err) {
			failed++;
			log(formatEvalStepError(step, err));
		}
	}
	return { run_id: args.runId, evaluated, skipped_no_envelope: skipped, failed };
}
