import type { HarnessDecision, HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";
import { deliverNovelAdvisories } from "./advisory-delivery.js";
import {
	beginPostToolWarningSpool,
	completePostToolWarningSpool,
} from "./post-tool-warning-spool.js";

export const POST_TOOL_PIPELINE_FAILURE_WARNING =
	"[interlinked:post-tool-pipeline] [proven] NOT CHECKED: PostToolUse checks failed before producing a verdict; run 'interlinked verify' before treating this edit as clean.";

function latePostToolMessages(
	decision: HarnessDecision | undefined,
	pipelineFailed: boolean,
): string[] {
	if (pipelineFailed) return [POST_TOOL_PIPELINE_FAILURE_WARNING];
	if (!decision) return [];
	const messages: string[] = [];
	if (decision.decision === "block" && decision.reason) messages.push(decision.reason);
	if (decision.warnings) messages.push(...decision.warnings);
	return [...new Set(messages)];
}

/** Run one request inside its request-owned late-warning spool lifecycle. */
export async function withPostToolWarningSpool(
	ctx: ServerRuntime,
	event: HarnessEvent,
	execute: () => Promise<HarnessDecision>,
): Promise<HarnessDecision> {
	const spool = beginPostToolWarningSpool(ctx.interlinkedDir, event);
	if (spool.requested && !spool.ownsMarker) {
		ctx.log(`Quality warning spool unavailable for delivery ${spool.token} (non-fatal)`);
	}
	let decision: HarnessDecision | undefined;
	let pipelineFailed = false;
	try {
		decision = await execute();
		return decision;
	} catch (error) {
		pipelineFailed = true;
		throw error;
	} finally {
		try {
			// The spool is a delivery surface, not the raw evidence store. Keep
			// its novelty state separate so preparing a fallback cannot consume
			// the synchronous response's first advisory.
			const visible = decision ? deliverNovelAdvisories(ctx, event, decision, "late") : undefined;
			completePostToolWarningSpool(
				spool,
				latePostToolMessages(visible, pipelineFailed),
			);
		} catch (error) {
			ctx.log(`Quality warning spool error: ${error}`);
		}
	}
}
