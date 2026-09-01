// ===========================================
// Content Scanner — UserPromptSubmit scan
// ===========================================
//
// Runs the ML content scanner over a user's prompt and returns a full-length
// redacted copy with each detected span replaced by `<LABEL>`. The hook uses
// this copy for its activity.jsonl write, so raw PII from prompts never
// reaches disk when the scanner is enabled.
//
// Contrast with `post-scan.ts`: post-scan ratchets session sensitivity and
// warns; it does NOT block the read. This module does something different
// — it never blocks, never warns, and never ratchets. It just masks the
// stored copy of the prompt. Users are always allowed to submit whatever
// they typed; we just don't store the raw version.

import type { GuardRulesConfig, OutputScanningConfig } from "../types.js";
import { filterFindingsByScore } from "./policy.js";
import type { ContentScanner, ScanFinding } from "./types.js";

const DEFAULT_SCAN_TIMEOUT_MS = 1500;

export interface PromptScanResult {
	/** Full-length prompt with every detected span replaced by `<LABEL>`. */
	redacted: string;
	/** Surviving findings (post min_score filter). Empty when no masking happened. */
	findings: ScanFinding[];
}

/**
 * Scan a user prompt. Returns `undefined` when the scanner is disabled,
 * unavailable, the prompt is empty, or no findings survive scoring. Fail-open
 * on scanner errors so a transient sidecar crash never drops the turn.
 */
export async function scanUserPrompt(
	prompt: string,
	rules: GuardRulesConfig,
	scanner: ContentScanner | undefined,
): Promise<PromptScanResult | undefined> {
	if (!scanner) return undefined;
	const cfg = rules.content_scanner;
	if (!cfg?.enabled || !cfg.scan_points.user_prompt) return undefined;
	if (!prompt || prompt.length === 0) return undefined;

	// SAFETY: GuardRulesConfig declares `output_scanning` as required, but a
	// hand-built or partially-merged rules object can omit it in practice
	// (proven by tests elsewhere that delete this field and expect no
	// throw) — cast to the honest optional shape so the chain below reflects
	// reality instead of the (unenforced) declared type.
	const outputScanning = rules.output_scanning as OutputScanningConfig | undefined;
	const scanLimit = cfg.max_scan_bytes || outputScanning?.max_scan_bytes || 100_000;
	const text = prompt.slice(0, scanLimit);

	let findings: ScanFinding[];
	try {
		findings = await scanner.scan({
			text,
			source: "UserPromptSubmit.prompt",
			signal: AbortSignal.timeout(cfg.local.scan_timeout_ms || DEFAULT_SCAN_TIMEOUT_MS),
		});
	} catch {
		return undefined;
	}

	const kept = filterFindingsByScore(findings, cfg);
	if (kept.length === 0) return undefined;

	return { redacted: maskSpans(prompt, kept, scanLimit), findings: kept };
}

// Text beyond scanLimit is left unmasked because the scanner never saw it.
function maskSpans(original: string, spans: ScanFinding[], scanLimit: number): string {
	const sorted = [...spans].sort((a, b) => b.start - a.start);
	let result = original;
	for (const span of sorted) {
		if (span.start >= scanLimit) continue;
		const end = Math.min(span.end, scanLimit);
		const placeholder = `<${span.label.toUpperCase()}>`;
		result = result.slice(0, span.start) + placeholder + result.slice(end);
	}
	return result;
}
