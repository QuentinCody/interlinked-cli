// ===========================================
// scanner review — the two resolution steps of the review loop
// ===========================================
//
// `scannerReviewCommand` runs three stages: pick WHICH pending review to act
// on, work out WHICH decision applies to it, then record that decision. The
// first two stages are extracted here so the command body reads as those
// stages rather than as their guard chains.
//
// Both steps report their own failure through `outputError` (which sets a
// non-zero exit code) and return null; a null return means "already
// reported — return from the command".

import {
	type PendingReviewSummary,
	readReview,
	type ReviewDecision,
	type ReviewPayload,
} from "../harness/content-scanner/review-files.js";
import { type OutputMode, outputError } from "../lib/output.js";
import {
	isPickError,
	pickReview,
	promptForDecision,
	renderReview,
} from "./scanner-render.js";

/** One pending review, resolved to both the key the decision is written under
 *  and the payload the user is shown. */
export interface TargetReview {
	key: string;
	review: ReviewPayload;
}

export interface TargetReviewQuery {
	cwd: string;
	mode: OutputMode;
	reviews: PendingReviewSummary[];
	/** The `--key` flag, or undefined to take the newest pending review. */
	key: string | undefined;
}

/** Pick the review named by `--key` (or the newest one) and read its payload. */
export function resolveTargetReview(query: TargetReviewQuery): TargetReview | null {
	const picked = pickReview(query.reviews, query.key);
	if (picked === null) {
		outputError(query.mode, "no pending reviews matched");
		process.exitCode = 1;
		return null;
	}
	if (isPickError(picked)) {
		outputError(query.mode, picked.error);
		process.exitCode = 1;
		return null;
	}

	const review = readReview(query.cwd, picked.key);
	if (!review) {
		outputError(query.mode, `pending review for key ${picked.key} could not be read`);
		process.exitCode = 1;
		return null;
	}
	return { key: picked.key, review };
}

/**
 * Work out which decision applies: the one a flag already named, otherwise the
 * one the user picks interactively.
 *
 * Machine-readable / non-interactive callers must supply an explicit decision
 * flag. Falling through to renderReview()+promptForDecision() for them would
 * (a) print the ANSI review UI to stdout and contaminate the JSON document,
 * and (b) block forever on stdin.
 */
export async function resolveReviewDecision(
	mode: OutputMode,
	flagPick: ReviewDecision | undefined,
	target: TargetReview,
): Promise<ReviewDecision | "skip" | null> {
	if (flagPick) return flagPick;

	if (mode === "json" || !process.stdin.isTTY) {
		outputError(
			mode,
			"non-interactive scanner review requires an explicit --allow, --redact, or --block flag",
			{
				pending_key: target.key,
				url: target.review.url,
				finding_count: target.review.findings.length,
			},
		);
		return null;
	}

	console.log(renderReview(target.review));
	return await promptForDecision();
}
