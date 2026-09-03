// ===========================================
// Content Scanner — WebFetch proxy (3-way human review)
// ===========================================
//
// PostToolUse `decision: "block"` does NOT replace the agent's view of
// `tool_response` — Claude Code shows the reason alongside the original
// content. To actually substitute what the model sees we have to intercept
// at PreToolUse, where `decision: "block"` short-circuits the tool entirely
// and the `reason` becomes the agent's view of the result. This file is the
// proxy that does the substitution for WebFetch:
//
//   1. Look up a prior decision file keyed on (url, prompt). If present,
//      consume it and return the corresponding variant (allow / redact /
//      block). The agent sees the chosen content as the tool result.
//
//   2. Otherwise, perform the fetch ourselves, run the body through the
//      scanner, then through the allowlist (closing the FP gap from
//      73e1c1f), and branch on whether anything survived:
//
//      - 0 surviving findings → `passthrough` with the raw body (no review
//        UI, no friction; the body becomes the tool result).
//      - >0 findings → write a review record under
//        `.interlinked/scanner/pending/<key>.review.json` and return
//        `review_pending` so the caller emits a "run interlinked scanner
//        review, then re-invoke" message to the agent. The user reviews
//        out-of-band (no hook-timeout pressure) and writes a decision file;
//        the next invocation of the same WebFetch lands in path 1.
//
//   3. On any fetch error (network, non-2xx, abort), return `fail_open` so
//      the caller falls through to the normal flow rather than wedging the
//      agent on a transient failure.
//
// Buffer cap: bodies are truncated to `config.max_scan_bytes` (default
// 100 KB). Larger pages take a tail-of-page hit, but the alternative is
// blowing up the agent's context window with megabyte-sized fetches.

import { applyAllowlist, type CompiledEntry } from "./allowlist.js";
import {
	cacheKey,
	consumeDecision,
	readDecision,
	readReview,
	writeReview,
} from "./review-files.js";
import type { ContentScanner, ContentScannerConfig, ScanFinding } from "./types.js";
// The SSRF-guarded fetch cluster lives in a sibling module (leaf, node-builtins
// only) so this proxy stays under the per-file line cap. `fetchAndScan` uses
// `assertSafeFetchTarget` + `fetchBody`; the rest are re-exported for callers
// and tests that import them from this module's path (no behaviour change).
import {
	assertSafeFetchTarget,
	fetchBody,
} from "./web-fetch-proxy-ssrf-fetch.js";

export type {
	PinnedFetchResponse,
	VettedTarget,
} from "./web-fetch-proxy-ssrf-fetch.js";
export {
	isBlockedAddress,
	makePinnedLookup,
	pinnedFetch,
	SsrfBlockedError,
} from "./web-fetch-proxy-ssrf-fetch.js";
// Re-export `assertSafeFetchTarget` + `fetchBody` (used locally above) and the
// remaining SSRF symbols so importers of this module's path keep resolving them.
export { assertSafeFetchTarget, fetchBody };

/** Fallback when the config doesn't specify a scan timeout. Mirrors
 *  `runPostToolScan`'s default so behaviour stays consistent across paths. */
const DEFAULT_SCAN_TIMEOUT_MS = 1500;

// ===========================================
// Result shape
// ===========================================

type ProxyResult =
	| { kind: "passthrough"; body: string }
	| { kind: "review_pending"; reviewPath: string; key: string; findingCount: number }
	| { kind: "decision_resolved"; decision: "allow" | "redact" | "block"; body: string }
	| { kind: "fail_open"; detail: string };

export interface FetchAndScanArgs {
	cwd: string;
	url: string;
	prompt: string;
	scanner: ContentScanner;
	compiledAllowlist: CompiledEntry[];
	config: ContentScannerConfig;
	toolName: string;
	/** Override the default DNS-pinned fetcher. Tests inject a deterministic
	 *  stub here to avoid the network. Production callers omit it; the
	 *  default uses `pinnedFetch` with `assertSafeFetchTarget` per hop. */
	fetcher?: (url: string) => Promise<string>;
}

// ===========================================
// Public entry point
// ===========================================

export async function fetchAndScan(args: FetchAndScanArgs): Promise<ProxyResult> {
	const key = cacheKey(args.url, args.prompt);

	// Path 1: existing user decision short-circuits the fetch entirely.
	const decision = readDecision(args.cwd, key);
	if (decision) {
		const result = applyDecision(args.cwd, key, decision.decision);
		// Always consume the decision after applying it — otherwise repeated
		// WebFetches with the same URL silently reuse the verdict, which is
		// surprising and lets a stale "allow" leak fresh PII.
		consumeDecision(args.cwd, key);
		return result;
	}

	// Path 2: do the fetch ourselves, scan the body.
	let body: string;
	const fetchImpl = args.fetcher ?? fetchBody;
	try {
		// Pre-flight SSRF guard so the rejection runs even when a test (or
		// any other caller) injects a custom `fetcher`. The real fetchBody
		// also validates per hop so redirects can't wriggle past — this
		// up-front check covers the initial URL deterministically.
		await assertSafeFetchTarget(args.url);
		body = await fetchImpl(args.url);
	} catch (fetchErr) {
		return {
			kind: "fail_open",
			detail: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
		};
	}

	const cap = args.config.max_scan_bytes || 100_000;
	const scanText = body.slice(0, cap);
	let findings: ScanFinding[];
	try {
		findings = await args.scanner.scan({
			text: scanText,
			source: `${args.toolName}.tool_response`,
			signal: AbortSignal.timeout(args.config.local.scan_timeout_ms || DEFAULT_SCAN_TIMEOUT_MS),
		});
	} catch (scanErr) {
		// Scanner unavailable — be conservative and fall through. The agent
		// will retry through the normal flow; existing rules still apply.
		const detail = scanErr instanceof Error ? scanErr.message : String(scanErr);
		return { kind: "fail_open", detail };
	}

	// Allowlist pass — drops known false positives (`noreply@*`, RFC-2606
	// test domains, snake_case identifiers, UUIDs) before they trigger a
	// review prompt. Closes the gap left by 73e1c1f, which only wired the
	// allowlist into the PreToolUse Write/Edit/Bash path.
	const surviving = applyAllowlist(findings, args.compiledAllowlist).kept;

	if (surviving.length === 0) {
		return { kind: "passthrough", body };
	}

	// Stash a review record for the user to inspect via the CLI.
	const redactedBody = redactBody(body, surviving);
	const reviewPath = writeReview({
		cwd: args.cwd,
		key,
		url: args.url,
		prompt: args.prompt,
		toolName: args.toolName,
		body,
		redactedBody,
		findings: surviving,
	});

	return {
		kind: "review_pending",
		reviewPath: reviewPath ?? `<${key}.review.json>`,
		key,
		findingCount: surviving.length,
	};
}

// ===========================================
// Decision application
// ===========================================

function applyDecision(
	cwd: string,
	key: string,
	decision: "allow" | "redact" | "block",
): ProxyResult {
	// We need the cached body + findings the user reviewed; otherwise an
	// `allow` would have nothing to return. The decision-file flow always
	// writes a review file before letting the user choose, so a missing
	// review here means the file was tampered with — fall through to
	// fail_open in that case.
	const review = readReview(cwd, key);
	if (!review) {
		return {
			kind: "fail_open",
			detail: `decision file present but review payload missing for key ${key}`,
		};
	}
	switch (decision) {
		case "allow":
			return { kind: "decision_resolved", decision, body: review.body };
		case "redact":
			return { kind: "decision_resolved", decision, body: review.redacted_body };
		case "block":
			return {
				kind: "decision_resolved",
				decision,
				body:
					"Privacy filter — response withheld by user.\n" +
					`Detected categories: ${formatCategories(review.findings)}.\n` +
					"To override, run `interlinked scanner review` and choose Allow.",
			};
	}
}

function formatCategories(findings: ScanFinding[]): string {
	const counts = new Map<string, number>();
	for (const f of findings) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([label, n]) => `${label}(${n})`)
		.join(", ");
}

// ===========================================
// Redaction (full body, not the truncated preview)
// ===========================================

/** Splice every detected span out of the body, replacing it with
 *  `<LABEL>`. Unlike `redact-preview.buildRedactedPreview`, this does NOT
 *  truncate — the agent needs the full structure of the response to do its
 *  job, just with the PII values removed. Splicing from the end keeps
 *  earlier indices valid during iteration. */
function redactBody(body: string, spans: ScanFinding[]): string {
	const sorted = [...spans].sort((a, b) => b.start - a.start);
	let result = body;
	for (const span of sorted) {
		const placeholder = `<${span.label.toUpperCase()}>`;
		result = result.slice(0, span.start) + placeholder + result.slice(span.end);
	}
	return result;
}
