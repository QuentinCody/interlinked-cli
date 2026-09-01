import type { JsonObject } from "../lib/json-types.js";

// ===========================================
// Tool Result Checks — PostToolUse feedback on tool responses
// ===========================================
// Operates on `tool_response` payloads, not file content. Three checks:
//   1. Silent-failure lint: tool returned 200/success but body signals error
//      ({"success": false}, {"error": ...}, etc.) — anti-pattern flagged in
//      CLAUDE.md. Common with MCP tools and JSON-returning Bash calls.
//   2. Context-bloat warning: tool_response exceeded a char budget — nudge
//      toward narrower reads or summarization.
//   3. Consecutive same-tool failures: N failures in a row without a success
//      surfaces a "try a different approach" hint on the Nth.
//
// All three are non-blocking; they emit `additionalContext`-style strings for
// server.ts to append to postDecision.warnings.

const DEFAULT_BLOAT_CHAR_THRESHOLD = 32_000; // ~8K tokens at 4 chars/token
const DEFAULT_CONSECUTIVE_THRESHOLD = 3;

export interface SilentFailureHit {
	/** Which field shape matched (for the warning message). */
	pattern: string;
	/** Short extract of the offending value, truncated. */
	detail: string;
}

interface BloatHit {
	chars: number;
	approx_tokens: number;
}

/**
 * Parse a raw tool_response into candidate JSON objects to inspect.
 *
 * Handles three shapes we see in practice:
 *   - Plain string (Bash stdout, Read file contents): attempt JSON.parse if it
 *     looks like JSON, otherwise skip.
 *   - Object (native tool responses): inspect directly.
 *   - MCP tool result: {"content": [{"type": "text", "text": "..."}]} — unwrap
 *     each text block and re-parse.
 */
function extractJsonCandidates(toolResponse: unknown): JsonObject[] {
	const out: JsonObject[] = [];

	const tryParse = (s: string): void => {
		const trimmed = s.trim();
		if (!trimmed.startsWith("{")) return;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				out.push(parsed as JsonObject);
			}
		} catch (e) {
			void e;
		}
	};

	if (typeof toolResponse === "string") {
		tryParse(toolResponse);
		return out;
	}
	if (!toolResponse || typeof toolResponse !== "object") return out;

	if (!Array.isArray(toolResponse)) {
		out.push(toolResponse as JsonObject);

		// MCP content blocks
		const content = (toolResponse as JsonObject).content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (block && typeof block === "object") {
					const text = (block as JsonObject).text;
					if (typeof text === "string") tryParse(text);
				}
			}
		}
	}

	return out;
}

/**
 * Check if a tool_response signals failure despite being reported as successful.
 * Returns the first hit found, or null.
 *
 * Positive signals (trigger the warning):
 *   - success: false / ok: false
 *   - error: <non-empty string> / error: <non-null object>
 *   - error_code: <non-empty string>
 *   - errors: <non-empty array>
 *
 * Anti-false-positive rules: `error: null`, `error: ""`, and `errors: []` are
 * considered shapes where the tool is explicitly communicating success.
 */
export function checkSilentFailure(toolResponse: unknown): SilentFailureHit | null {
	const candidates = extractJsonCandidates(toolResponse);
	for (const obj of candidates) {
		const hit = inspectObject(obj);
		if (hit) return hit;
	}
	return null;
}

function inspectObject(obj: JsonObject): SilentFailureHit | null {
	if (obj.success === false) {
		return { pattern: "success: false", detail: stringifyShort(obj) };
	}
	if (obj.ok === false) {
		return { pattern: "ok: false", detail: stringifyShort(obj) };
	}
	if (typeof obj.error === "string" && obj.error.length > 0) {
		return { pattern: "error: <string>", detail: obj.error.slice(0, 200) };
	}
	if (obj.error && typeof obj.error === "object" && !Array.isArray(obj.error)) {
		const inner = obj.error as JsonObject;
		if (Object.keys(inner).length > 0) {
			return { pattern: "error: <object>", detail: stringifyShort(inner) };
		}
	}
	if (typeof obj.error_code === "string" && obj.error_code.length > 0) {
		return { pattern: "error_code", detail: obj.error_code.slice(0, 200) };
	}
	if (Array.isArray(obj.errors) && obj.errors.length > 0) {
		return { pattern: "errors: [...]", detail: stringifyShort(obj.errors[0]) };
	}
	return null;
}

function stringifyShort(v: unknown): string {
	try {
		return JSON.stringify(v).slice(0, 200);
	} catch {
		return String(v).slice(0, 200);
	}
}

/**
 * Check if a tool_response exceeds a character budget. Returns size info if
 * over threshold, or null.
 */
export function checkContextBloat(
	toolResponse: unknown,
	thresholdChars: number = DEFAULT_BLOAT_CHAR_THRESHOLD,
): BloatHit | null {
	let chars: number;
	if (typeof toolResponse === "string") {
		chars = toolResponse.length;
	} else if (toolResponse == null) {
		return null;
	} else {
		try {
			chars = JSON.stringify(toolResponse).length;
		} catch {
			return null;
		}
	}
	if (chars < thresholdChars) return null;
	return { chars, approx_tokens: Math.round(chars / 4) };
}

/**
 * Return a warning message for the Nth consecutive failure of the same tool.
 * Fires at threshold and on every subsequent failure — the model should keep
 * seeing the nudge until it either succeeds or changes approach.
 */
export function consecutiveFailureWarning(
	count: number,
	toolName: string,
	threshold: number = DEFAULT_CONSECUTIVE_THRESHOLD,
): string | null {
	if (count < threshold) return null;
	return (
		`[interlinked:consecutive-errors] ${toolName} has failed ${count} times in a row. ` +
		"Try a different approach: read upstream context, verify your assumptions, or " +
		"escalate rather than retrying the same call."
	);
}

/**
 * Format a silent-failure hit as a warning string for postDecision.warnings.
 */
export function formatSilentFailureWarning(toolName: string, hit: SilentFailureHit): string {
	return (
		`[interlinked:silent-failure] ${toolName} returned a successful response whose body ` +
		`signals failure (${hit.pattern}). Treat this as an error — do not assume success. ` +
		`Detail: ${hit.detail}`
	);
}

/**
 * Format a context-bloat hit as a warning string for postDecision.warnings.
 */
export function formatBloatWarning(toolName: string, hit: BloatHit): string {
	return (
		`[interlinked:context-bloat] ${toolName} returned ${hit.chars.toLocaleString()} chars ` +
		`(~${hit.approx_tokens.toLocaleString()} tokens). Consider narrower reads, a targeted grep, ` +
		"or summarizing before further work to avoid burning context."
	);
}

export const TOOL_RESULT_CHECK_DEFAULTS = {
	bloat_char_threshold: DEFAULT_BLOAT_CHAR_THRESHOLD,
	consecutive_threshold: DEFAULT_CONSECUTIVE_THRESHOLD,
};
