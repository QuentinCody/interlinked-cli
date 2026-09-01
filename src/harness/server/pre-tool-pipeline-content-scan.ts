// interlinked-tdd: exempt
// ===========================================
// PreToolUse content-scanner phase helpers
// ===========================================
// Extracted verbatim from pre-tool-pipeline.ts to keep the orchestrator under
// the per-file line cap. Behaviour is byte-identical; these are leaf phase
// helpers (the orchestrator calls them, they do not call back into the main
// file). `buildScanAskOutcome` stays internal to this module.

import { applyAllowlist } from "../content-scanner/allowlist.js";
import { decideFromFindings } from "../content-scanner/policy.js";
import { buildAskReason, writePendingPrompt } from "../content-scanner/redact-preview.js";
import { countPendingReviews } from "../content-scanner/review-files.js";
import type { ScanFinding } from "../content-scanner/types.js";
import { fetchAndScan } from "../content-scanner/web-fetch-proxy.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import type { ServerRuntime } from "./runtime-context.js";

/**
 * Content Scanner WebFetch proxy (3-way human review). PostToolUse `block`
 * cannot substitute the agent's view of `tool_response`, so for WebFetch we
 * intercept at PreToolUse: harness performs the fetch, scans the body, and
 * either passes it through, stashes a review file, or honours a prior decision.
 * Returns a replacement `HarnessDecision` (always a `block`-and-answer envelope)
 * or `null` to fall through to the regular flow. See `web-fetch-proxy.ts`.
 */
export async function runWebFetchProxy(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): Promise<HarnessDecision | null> {
	const CWD = ctx.cwd;
	const log = ctx.log;
	const rules = ctx.rules;
	const isWebFetchTool = event.tool_name === "WebFetch" || event.tool_name === "web_fetch";
	if (
		!(
			preDecision.decision === "allow" &&
			isWebFetchTool &&
			ctx.contentScanner &&
			rules.content_scanner?.enabled &&
			rules.content_scanner.scan_points.external_egress
		)
	) {
		return null;
	}
	const url = (event.tool_input?.url as string) || "";
	const promptField = (event.tool_input?.prompt as string) || "";
	if (!url) return null;
	const proxyResult = await fetchAndScan({
		cwd: CWD,
		url,
		prompt: promptField,
		scanner: ctx.contentScanner,
		compiledAllowlist: ctx.compiledAllowlist,
		config: rules.content_scanner,
		toolName: event.tool_name ?? "WebFetch",
	});
	log(
		`Content scanner: WebFetch proxy → ${proxyResult.kind}` +
			(proxyResult.kind === "review_pending" ? ` (${proxyResult.findingCount} finding(s))` : ""),
	);
	if (proxyResult.kind === "passthrough") {
		return { decision: "block", reason: proxyResult.body, warnings: preDecision.warnings };
	}
	if (proxyResult.kind === "review_pending") {
		ctx.writeReviewPendingMarker(countPendingReviews(CWD));
		return {
			decision: "block",
			reason:
				"Privacy filter flagged this WebFetch response. The body is " +
				`stashed locally for review (${proxyResult.findingCount} finding(s)).\n` +
				"Run `interlinked scanner review` in another terminal to choose " +
				"Allow / Redact / Block, then re-invoke the same WebFetch.",
			warnings: preDecision.warnings,
		};
	}
	if (proxyResult.kind === "decision_resolved") {
		ctx.writeReviewPendingMarker(countPendingReviews(CWD));
		return { decision: "block", reason: proxyResult.body, warnings: preDecision.warnings };
	}
	// proxyResult.kind === "fail_open" — fall through to the regular
	// flow so existing rules still apply. The agent's WebFetch will
	// run normally; PII in the response is then handled by the
	// post-scan path's taint ratchet.
	log(`Content scanner: WebFetch proxy fail_open — ${proxyResult.detail}`);
	return null;
}

/**
 * Build the "ask" outcome for a flagged scan request: group survivors by
 * source, stash the unmasked pending-prompt file, and write the agent-safe
 * reason + (optional) raw-PII system message onto `preDecision`.
 */
function buildScanAskOutcome(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
	scanReq: NonNullable<HarnessDecision["_contentScan"]>,
	keptFindings: ScanFinding[],
	verdict: { reason?: string },
): void {
	const CWD = ctx.cwd;
	// Hand off to Claude Code's built-in confirmation UI via the "ask"
	// decision. Reason has three parts:
	//   (1) category summary from decideFromFindings  — agent-safe
	//   (2) per-source preview with PII → <CATEGORY>   — agent-safe
	//   (3) pointer to a LOCAL-ONLY file with the full unmasked content
	//       — user opens from another terminal; never sent to Anthropic.
	// Group only the SURVIVORS for the pending-prompt + ask-reason —
	// allowlist-suppressed findings are FPs the operator already
	// declared safe, so we mustn't echo them back through the UI.
	const findingsBySource = new Map<string, ScanFinding[]>();
	for (const f of keptFindings) {
		const bucket = findingsBySource.get(f.source) ?? [];
		bucket.push(f);
		findingsBySource.set(f.source, bucket);
	}
	const pendingPromptPath = writePendingPrompt({
		cwd: CWD,
		request: scanReq,
		findingsBySource,
		toolName: event.tool_name ?? "unknown",
	});
	preDecision.decision = "ask";
	const askOutputs = buildAskReason({
		policySummary: verdict.reason ?? "privacy-filter detected sensitive content.",
		request: scanReq,
		findingsBySource,
		pendingPromptPath,
	});
	preDecision.reason = askOutputs.reason;
	// Raw flagged values are surfaced here only — Claude Code's
	// `systemMessage` is shown to the user but NOT included in the
	// model's context window (hooks reference). This is the sole
	// agent-safe channel for raw PII.
	if (askOutputs.systemMessage) preDecision.system_message = askOutputs.systemMessage;
}

/**
 * Content Scanner: run ML PII detection on the scan request (if present).
 * Runs when the evaluator attached a _contentScan bundle AND the scanner is
 * enabled. Iterates per-part, aggregates findings, applies the allowlist, and
 * promotes the decision to "ask" when the policy says so. Fail-open on any
 * per-part error (network, spawn, timeout).
 */
export async function runContentScanRequest(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): Promise<void> {
	const log = ctx.log;
	const rules = ctx.rules;
	if (
		!(
			preDecision.decision === "allow" &&
			preDecision._contentScan &&
			ctx.contentScanner &&
			rules.content_scanner?.enabled
		)
	) {
		return;
	}
	const scanReq = preDecision._contentScan;
	const maxBytes = rules.content_scanner.max_scan_bytes || 100_000;
	// `content_scanner` is declared optional on GuardRulesConfig, and callers
	// that build one directly (rather than through `loadRules()`, which
	// always fills every sub-field from DEFAULT_CONFIG) can supply it with
	// `local` omitted — only relevant for the "local" runtime. `local` stays
	// required on the shared `ContentScannerConfig` type (every OTHER reader
	// — opf-local.ts, prompt-scan.ts, post-scan.ts, web-fetch-proxy.ts —
	// dereferences it unconditionally and is genuinely always fed a
	// `loadRules()`-built config), so the honest widening is local to this
	// one defensive read rather than the shared interface.
	// SAFETY: only relaxes `local` to optional; every other field keeps its
	// declared shape.
	const contentScannerLocal = rules.content_scanner as
		| (Omit<NonNullable<GuardRulesConfig["content_scanner"]>, "local"> & {
				local?: { scan_timeout_ms?: number };
		  })
		| undefined;
	const timeoutMs = contentScannerLocal?.local?.scan_timeout_ms || 1500;
	const findings: ScanFinding[] = [];
	for (const part of scanReq.parts) {
		try {
			const partFindings = await ctx.contentScanner.scan({
				text: part.text.slice(0, maxBytes),
				source: part.source,
				signal: AbortSignal.timeout(timeoutMs),
			});
			findings.push(...partFindings);
		} catch (scanErr) {
			log(
				`Content scanner scan failed (fail-open): ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
			);
		}
	}
	// Allowlist pass — drop known false positives (noreply@*, snake_case
	// identifiers misread as private_person, RFC test domains, etc.)
	// before the policy decides. Suppressed entries don't reach the
	// permission UI, the systemMessage, or the pending-prompt file.
	const allowlistResult = applyAllowlist(findings, ctx.compiledAllowlist);
	const keptFindings = allowlistResult.kept;
	if (allowlistResult.suppressed.length > 0) {
		log(`Content scanner: allowlist suppressed ${allowlistResult.suppressed.length} finding(s)`);
	}
	const verdict = decideFromFindings(keptFindings, rules.content_scanner);
	log(
		`Content scanner: ${event.tool_name} (${scanReq.hook}) — ${scanReq.parts.length} part(s), ${findings.length} finding(s) (${keptFindings.length} after allowlist), decision=${verdict.decision}`,
	);
	if (verdict.decision === "ask") {
		buildScanAskOutcome(ctx, event, preDecision, scanReq, keptFindings, verdict);
	}
}
