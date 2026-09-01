// ===========================================
// Content Scanner — PostToolUse Read/Grep scan
// ===========================================
//
// Runs the ML content scanner over the return payload of a Read/Grep tool
// call. On detection:
//   - Ratchets session sensitivity (`Confidential`, or `HighlyConfidential`
//     for `secret`/`account_number`), so existing taint-aware rules (no
//     network after taint, step-budget tightening, etc.) fire downstream.
//   - Records the tool-call step in `session.pii_detected_steps` for future
//     PreToolUse gating patterns to consume.
//   - Returns a human-readable warning listing the detected categories.
//
// Never blocks — we're already post-read; the damage of *reading* PII is
// limited to what the model then *does*. The taint ratchet is how we stop
// that downstream.

import { ratchetSensitivity } from "../taint-tracker.js";
import type {
	GuardRulesConfig,
	HarnessEvent,
	OutputScanningConfig,
	SensitivityLevel,
	SessionTrajectory,
	TaintTrackingConfig,
} from "../types.js";
import { applyAllowlist, type CompiledEntry } from "./allowlist.js";
import { decideFromFindings, filterFindingsByScore } from "./policy.js";
import type { ContentScanner, ScanFinding } from "./types.js";

// ===========================================
// Applicability — kept out of the main helper so the condition is readable.
// ===========================================

const READ_TOOLS = new Set([
	"Read",
	"ReadFile",
	"read_file",
	"FileRead",
	"view",
	"Grep",
	"grep",
	"Glob",
]);

/** Label set that escalates to `HighlyConfidential` on detection. Everything else → `Confidential`. */
const HIGHLY_CONFIDENTIAL_LABELS = new Set(["secret", "account_number"]);

/** Default scanner timeout when the config doesn't specify one. Mirrors
 *  `web-fetch-proxy.DEFAULT_SCAN_TIMEOUT_MS` so behaviour is consistent. */
const DEFAULT_SCAN_TIMEOUT_MS = 1500;

/** Default per-scan body cap when neither `content_scanner.max_scan_bytes`
 *  nor `output_scanning.max_scan_bytes` is set. */
const DEFAULT_MAX_SCAN_BYTES = 100_000;

/** Threshold below which a serialized `tool_response` is too small to be
 *  worth scanning (e.g., literal `""` serializes to 2 chars; `null` to 4).
 *  Keeps the scanner from waking up on empty responses. */
const MIN_SERIALIZED_LENGTH = 2;

/** Tag returned by `typeof` for primitive strings. Pulled out of the
 *  type-guard body so the conditional reads as `=== TYPEOF_STRING_TAG`,
 *  not `=== "string"` (which the linter rightly flags as a magic literal). */
const TYPEOF_STRING_TAG = "string" as const;

/** Type guard so the kind discriminator stays out of the main flow. */
function isString(v: unknown): v is string {
	return typeof v === TYPEOF_STRING_TAG;
}

/** Returns the text to scan, or `undefined` when the event doesn't carry scannable content. */
function extractReadResponseText(event: HarnessEvent): string | undefined {
	const response = event.tool_response;
	if (response === undefined || response === null) return undefined;
	if (isString(response)) return response.length > 0 ? response : undefined;
	// Some tools return structured objects (e.g., Grep returns a stringifiable list).
	// Serialize defensively — the scanner just needs text, and JSON.stringify is
	// stable enough for PII detection against quoted values.
	try {
		const serialized = JSON.stringify(response);
		return serialized.length > MIN_SERIALIZED_LENGTH ? serialized : undefined;
	} catch (jsonErr) {
		// Circular references, BigInt, etc. — not scannable, drop silently.
		void jsonErr;
		return undefined;
	}
}

// ===========================================
// Public API
// ===========================================

export interface PostScanResult {
	warnings: string[];
	findings: ScanFinding[];
	/** New sensitivity level, or `undefined` if no ratchet occurred. */
	ratcheted_to?: SensitivityLevel | undefined;
}

/** Options bag for `runPostToolScan`. Bundled because there were already
 *  four positional arguments and adding `compiledAllowlist` pushed it past
 *  the readability threshold for positional calls. */
export interface PostScanArgs {
	event: HarnessEvent;
	session: SessionTrajectory | undefined;
	rules: GuardRulesConfig;
	scanner: ContentScanner | undefined;
	/** Compiled allowlist applied between detection and policy. Closes the
	 *  FP gap from 73e1c1f, where the suppression layer was wired into the
	 *  PreToolUse Write/Edit/Bash branch but not into post-scan. Pass `[]`
	 *  to disable suppression (useful in tests; production wires the
	 *  harness's compiled list through). */
	compiledAllowlist: CompiledEntry[];
}

/**
 * Run the content scanner over a PostToolUse Read/Grep event. Fail-open on
 * any error. The caller owns the session object; we mutate it when findings
 * are present.
 */
export async function runPostToolScan(args: PostScanArgs): Promise<PostScanResult> {
	const { event, session, rules, scanner, compiledAllowlist } = args;
	const empty: PostScanResult = { warnings: [], findings: [] };
	if (!scanner) return empty;
	const cfg = rules.content_scanner;
	if (!cfg?.enabled || !cfg.scan_points.read_grep_taint) return empty;
	const toolName = event.tool_name ?? "";
	if (!READ_TOOLS.has(toolName)) return empty;

	const text = extractReadResponseText(event);
	if (!text) return empty;

	// SAFETY: GuardRulesConfig declares `output_scanning` as required, but
	// tests (and possibly other partial-config callers) construct `rules`
	// objects that omit it — widened locally so the optional chain reflects
	// what actually reaches this function at runtime.
	const outputScanning = rules.output_scanning as OutputScanningConfig | undefined;
	const scanLimit = cfg.max_scan_bytes || outputScanning?.max_scan_bytes || DEFAULT_MAX_SCAN_BYTES;
	let findings: ScanFinding[];
	try {
		findings = await scanner.scan({
			text: text.slice(0, scanLimit),
			source: `${toolName}.tool_response`,
			signal: AbortSignal.timeout(cfg.local.scan_timeout_ms || DEFAULT_SCAN_TIMEOUT_MS),
		});
	} catch (scanErr) {
		// fail-open — surface the reason to the operator log so a chronic
		// failure mode (sidecar dead, model not loaded) is visible.
		void scanErr;
		return empty;
	}

	if (findings.length === 0) return empty;
	// Score floor first (cheap), then allowlist (drops known FPs that the
	// model nominally meets the score floor for). Doing them in this order
	// matches the PreToolUse path in server.ts.
	const scoreKept = filterFindingsByScore(findings, cfg);
	if (scoreKept.length === 0) return empty;
	const keptFindings = applyAllowlist(scoreKept, compiledAllowlist).kept;
	if (keptFindings.length === 0) return empty;

	// Policy reuses the PreToolUse decision to compute the human-readable
	// summary — same label taxonomy and ordering guarantees.
	const verdict = decideFromFindings(keptFindings, cfg);
	const summary =
		verdict.reason ??
		`BLOCKED: privacy-filter detected sensitive content [${keptFindings.length} span(s)].`;

	// Pick sensitivity level — `secret`/`account_number` → HighlyConfidential.
	const ratchetLevel: SensitivityLevel = keptFindings.some((f) =>
		HIGHLY_CONFIDENTIAL_LABELS.has(f.label),
	)
		? "HighlyConfidential"
		: "Confidential";

	const filePath = (event.tool_input?.file_path as string) || `<${toolName}-response>`;
	let ratcheted: SensitivityLevel | undefined;
	// SAFETY: GuardRulesConfig declares `taint_tracking` as required, but
	// tests (and possibly other partial-config callers) construct `rules`
	// objects that omit it — widened locally so the guard below reflects
	// what actually reaches this function at runtime.
	const taintTracking = rules.taint_tracking as TaintTrackingConfig | undefined;
	if (session && taintTracking?.enabled) {
		const changed = ratchetSensitivity(session, filePath, ratchetLevel, taintTracking);
		if (changed) ratcheted = ratchetLevel;
		// Record the step even when the ratchet was a no-op (already at or above
		// the target level) — PreToolUse gating patterns care about detection
		// events, not just monotone changes.
		session.pii_detected_steps.push(session.tool_call_count);
	}

	const warning =
		`[interlinked:content-scanner] ${toolName} returned sensitive content ` +
		`(session sensitivity → ${ratchetLevel}). ${summary.replace(/^BLOCKED: /, "")}`;

	return { warnings: [warning], findings: keptFindings, ratcheted_to: ratcheted };
}
