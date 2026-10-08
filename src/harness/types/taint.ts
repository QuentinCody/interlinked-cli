// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Sensitivity / Taint Tracking Types
// ===========================================

export type SensitivityLevel = "Public" | "Internal" | "Confidential" | "HighlyConfidential";

/**
 * Taint provenance — orthogonal to {@link SensitivityLevel}. The sensitivity
 * axis answers "HOW SENSITIVE is this data?" (Public..HighlyConfidential);
 * provenance answers "WHERE DID IT COME FROM?" (trusted local vs untrusted
 * external). The two axes are independent — a `.md` file fetched from the
 * web is `document_content` provenance but `Public` sensitivity; a `.env`
 * read off disk is `local_read` provenance but `Confidential` sensitivity.
 *
 * The provenance axis is what gates the "external action on untrusted data"
 * guard (`checkProvenanceTaintToExternalAction` in evaluator/taint-guards.ts).
 */
export type TaintProvenance =
	| "fetched_external" // WebFetch, WebSearch tool results
	| "mcp_remote" // mcp__*__* tool result (remote MCP server, untrusted)
	| "document_content" // Read of doc-shaped file (.md, .pdf, .txt, .rst, .adoc)
	| "user_provided" // UserPromptSubmit body
	| "local_read"; // Read of code-shaped file; default fallback

export interface TaintSource {
	file: string;
	level: SensitivityLevel;
	at_step: number;
	/**
	 * Provenance class — where the data originated. Distinct from `level`,
	 * which records sensitivity. Older snapshots without this field hydrate
	 * to "local_read" (the safe default — no extra ask gate fires on
	 * pre-existing taint sources after upgrade). Population logic lives in
	 * {@link ../taint-tracker}.
	 */
	provenance: TaintProvenance;
	/**
	 * True when this source RAISED the session level (set by
	 * `ratchetSensitivity`). The block reason names the latest escalated
	 * source at the current level as the one that set it. Absent on older
	 * snapshots and on audit-only sources (provenance records, public-origin
	 * secret hits), which never moved the level.
	 */
	escalated?: boolean;
	/**
	 * Human-readable cause, e.g. `sig-secret-gcp-api from \`rg -o … page.html\``.
	 * Command excerpts are capped at 120 chars with secret values redacted.
	 */
	detail?: string;
	/** The actor (`actorKeyOf`) whose level this source raised. Absent on
	 *  older snapshots and on sources applied to every actor. */
	actor?: string;
}

export interface TaintTrackingConfig {
	enabled: boolean;
	/** File patterns → sensitivity level mappings */
	file_sensitivity: Array<{ glob: string; level: SensitivityLevel }>;
	/** Step limits per sensitivity level */
	step_limits: Record<SensitivityLevel, number>;
	/** Block outbound network at this level and above */
	network_block_at: SensitivityLevel;
}

// ===========================================
// Output Scanning Configuration
// ===========================================

export interface OutputScanningConfig {
	enabled: boolean;
	/** Scan Bash output for leaked secrets */
	scan_bash_secrets: boolean;
	/** Scan WebFetch results for prompt injection */
	scan_web_injection: boolean;
	/** Scan file read results for indirect injection */
	scan_file_injection: boolean;
	/** Maximum bytes to scan per response (default: 100KB) */
	max_scan_bytes: number;
}
