// ===========================================
// Secret Detection & Scrubbing
// ===========================================
// Dual-layer detection: pattern matching + Shannon entropy.
// Used in hook scripts (patterns only) and pre-sync gate (full).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";
import type { JsonObject } from "./json-types.js";

// ===========================================
// Types
// ===========================================

interface ScrubResult {
	text: string;
	found: number;
	types: string[];
}

interface ScrubConfig {
	enabled?: boolean;
	extra_patterns?: string[];
	ignore_patterns?: string[];
	entropy_threshold?: number;
	entropy_min_length?: number;
}

// ===========================================
// Patterns
// ===========================================

interface SecretPattern {
	name: string;
	regex: RegExp;
}

const BUILTIN_PATTERNS: SecretPattern[] = [
	{ name: "aws_key", regex: /AKIA[0-9A-Z]{16}/g },
	{
		name: "aws_secret",
		regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/g,
	},
	{ name: "github_token", regex: /gh[psor]_[A-Za-z0-9_]{36,}/g },
	{ name: "github_pat", regex: /github_pat_[A-Za-z0-9_]{22,}/g },
	// OpenAI-style sk- keys + 64-char hex secrets — parity with the hook's
	// inline SECRET_PATTERNS, which caught these but BUILTIN_PATTERNS missed.
	{ name: "openai_key", regex: /sk-[A-Za-z0-9_-]{20,}/g },
	{ name: "hex_secret", regex: /\b[0-9a-fA-F]{64}\b/g },
	{ name: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
	{ name: "private_key", regex: /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
	{
		name: "connection_string",
		regex: /(?:mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s"']{10,}/g,
	},
	{
		name: "generic_secret",
		regex: /(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-/.+]{16,}["']?/gi,
	},
	{ name: "slack_token", regex: /xox[bpors]-[A-Za-z0-9-]{10,}/g },
	{ name: "stripe_key", regex: /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
	{ name: "sendgrid_key", regex: /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}/g },
	{ name: "npm_token", regex: /npm_[A-Za-z0-9]{36,}/g },
];

// ===========================================
// Shannon Entropy
// ===========================================

function shannonEntropy(str: string): number {
	if (str.length === 0) return 0;

	const freq = new Map<string, number>();
	for (const char of str) {
		freq.set(char, (freq.get(char) || 0) + 1);
	}

	let entropy = 0;
	const len = str.length;
	for (const count of freq.values()) {
		const p = count / len;
		entropy -= p * Math.log2(p);
	}

	return entropy;
}

// Common patterns that look high-entropy but aren't secrets
const ENTROPY_ALLOW_LIST = [
	/^[A-Za-z0-9+/]+=*$/, // base64 padding (common in hashes)
	/^\d+\.\d+\.\d+/, // version numbers
	/^[a-f0-9]{32,}$/, // hex hashes (md5, sha256)
	/^[A-Za-z]+[A-Z][a-z]/, // camelCase identifiers
];

function isLikelySecret(token: string, threshold: number, minLength: number): boolean {
	if (token.length < minLength) return false;

	// Skip common non-secret patterns
	for (const pattern of ENTROPY_ALLOW_LIST) {
		if (pattern.test(token)) return false;
	}

	return shannonEntropy(token) > threshold;
}

// ===========================================
// Scrubbing
// ===========================================

/**
 * Load scrub config from .interlinked/scrub.json.
 */
export function loadScrubConfig(cwd?: string): ScrubConfig {
	const configPath = join(getConfigDir(cwd), "scrub.json");
	if (!existsSync(configPath)) {
		return { enabled: true };
	}
	try {
		return JSON.parse(readFileSync(configPath, "utf-8")) as ScrubConfig;
	} catch (_err) {
		/* intentional: malformed scrub.json — fall back to default-enabled config */
		return { enabled: true };
	}
}

/**
 * Scrub secrets from text using pattern matching and entropy detection.
 */
export function scrubSecrets(text: string, opts?: ScrubConfig): ScrubResult {
	if (!text) return { text, found: 0, types: [] };

	const config = opts || {};
	if (config.enabled === false) return { text, found: 0, types: [] };

	const foundTypes: string[] = [];
	let found = 0;
	const note = (name: string) => {
		if (!foundTypes.includes(name)) foundTypes.push(name);
		found++;
	};

	const shouldIgnore = buildIgnoreChecker(config.ignore_patterns);
	const allPatterns = buildAllPatterns(config.extra_patterns);
	let scrubbed = applyPatternScrub(text, allPatterns, shouldIgnore, note);
	scrubbed = applyEntropyScrub(scrubbed, config, note);

	return { text: scrubbed, found, types: foundTypes };
}

/**
 * Compile ignore patterns and return a predicate for whether a match should
 * be skipped. These come from user-authored scrub.json under the caller's
 * control, not from untrusted input — dynamic RegExp is deliberate here.
 */
function buildIgnoreChecker(ignorePatternsSrc: string[] | undefined): (match: string) => boolean {
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	const ignorePatterns = (ignorePatternsSrc || []).map((p) => new RegExp(p, "g"));
	return (match: string) =>
		ignorePatterns.some((p) => {
			p.lastIndex = 0;
			return p.test(match);
		});
}

/**
 * Combine the built-in patterns with any user-supplied `extra_patterns`.
 * `extra_patterns` is user-authored scrub config, not untrusted input —
 * dynamic RegExp is deliberate.
 */
function buildAllPatterns(extraPatternsSrc: string[] | undefined): SecretPattern[] {
	const allPatterns = [...BUILTIN_PATTERNS];
	if (!extraPatternsSrc) return allPatterns;
	for (const p of extraPatternsSrc) {
		try {
			// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
			allPatterns.push({ name: "custom", regex: new RegExp(p, "g") });
		} catch (_err) {
			/* intentional: user-supplied pattern failed to compile — skip it silently */
		}
	}
	return allPatterns;
}

/** Layer 1: replace every non-ignored pattern match with a redaction marker. */
function applyPatternScrub(
	text: string,
	allPatterns: SecretPattern[],
	shouldIgnore: (match: string) => boolean,
	note: (name: string) => void,
): string {
	let scrubbed = text;
	for (const pattern of allPatterns) {
		pattern.regex.lastIndex = 0;
		let match: RegExpExecArray | null = pattern.regex.exec(scrubbed);
		while (match !== null) {
			if (shouldIgnore(match[0])) {
				match = pattern.regex.exec(scrubbed);
				continue;
			}
			scrubbed =
				scrubbed.slice(0, match.index) +
				`[REDACTED:${pattern.name}]` +
				scrubbed.slice(match.index + match[0].length);
			note(pattern.name);
			// Reset lastIndex since string changed
			pattern.regex.lastIndex = match.index + `[REDACTED:${pattern.name}]`.length;
			match = pattern.regex.exec(scrubbed);
		}
	}
	return scrubbed;
}

/** Layer 2: entropy detection over whitespace/delimiter-split tokens. */
function applyEntropyScrub(
	text: string,
	config: ScrubConfig,
	note: (name: string) => void,
): string {
	const threshold = config.entropy_threshold || 4.5;
	const minLength = config.entropy_min_length || 20;

	let scrubbed = text;
	// Split on whitespace and common delimiters, check each token
	const tokens = scrubbed.split(/[\s"'`=:,;{}[\]()]+/);
	for (const token of tokens) {
		if (token.includes("[REDACTED:")) continue; // Already scrubbed
		if (isLikelySecret(token, threshold, minLength)) {
			scrubbed = scrubbed.replace(token, "[REDACTED:entropy]");
			note("entropy");
		}
	}
	return scrubbed;
}

// ===========================================
// PII Redaction (canonical source)
// ===========================================
// Applied ONLY to natural-language fields (prompt/thinking); secrets are
// scrubbed on every string field. These patterns are the SINGLE SOURCE OF
// TRUTH — the self-contained `.mjs` hook (REDACTION_CHUNK) mirrors them, and
// `__tests__/redaction-parity.test.ts` behaviorally pins the two implementations
// identical so they can't drift. Digit classes use [0-9] and literal dots use
// [.] to match the mirror exactly (the .mjs template avoids extra backslashes).

interface PiiPattern {
	name: string;
	regex: RegExp;
	skip?: RegExp;
}

const PII_PATTERNS: PiiPattern[] = [
	{ name: "ssn", regex: /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/g },
	{ name: "cc", regex: /\b[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}\b/g },
	{ name: "cc", regex: /\b[0-9]{4}[ -]?[0-9]{6}[ -]?[0-9]{5}\b/g },
	{
		name: "email",
		regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/g,
		skip: /noreply|example[.](?:com|org|net)|test[.]com|localhost/i,
	},
	{ name: "phone", regex: /\b[(]?[0-9]{3}[)]?[-. ][0-9]{3}[-. ][0-9]{4}\b/g },
	{
		name: "ip",
		regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)[.]){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
		skip: /^(?:0[.]|10[.]|127[.]|169[.]254[.]|192[.]168[.]|172[.](?:1[6-9]|2[0-9]|3[01])[.]|255[.])/,
	},
];

/**
 * Redact PII from natural-language text. Behavioral mirror of the hook's
 * inline `redactPii` (pinned by redaction-parity.test.ts). Used at egress for
 * the prompt/thinking fields only — never on tool I/O (avoids mangling code/logs).
 */
export function redactPii(text: string): ScrubResult {
	if (!text) return { text, found: 0, types: [] };
	let scrubbed = text;
	const types: string[] = [];
	let found = 0;
	for (const { name, regex, skip } of PII_PATTERNS) {
		regex.lastIndex = 0;
		scrubbed = scrubbed.replace(regex, (m) => {
			if (skip?.test(m)) return m;
			if (!types.includes(name)) types.push(name);
			found++;
			return `[REDACTED:${name}]`;
		});
	}
	return { text: scrubbed, found, types };
}

// ===========================================
// Egress payload scrub (single entry point for every egress path)
// ===========================================
// Secrets on every string carrier; PII on natural-language fields. The realtime
// POST, batch sync (both via the .mjs mirror), `interlinked sync`, and the
// daemon server-bridge all route their server-bound payloads through this one
// contract — so no egress path can silently skip a redaction layer. This is the
// cloud-boundary scrub the two-tier model (raw local / redacted egress) relies on.

/** String fields scrubbed for secrets at egress. Mirrors the hook's SCRUB_FIELDS. */
const EGRESS_SECRET_FIELDS = [
	"tool_input_summary",
	"tool_input_json",
	"tool_response_json",
	"prompt",
	"last_assistant_message",
	"error_message",
	"error_detail",
	"custom_instructions",
	"permission_suggestions",
	"thinking",
	"stderr",
	"stdout",
] as const;

/** Natural-language fields additionally scrubbed for PII. Mirrors the hook's PII_FIELDS. */
const EGRESS_PII_FIELDS = ["prompt", "thinking"] as const;

export interface EgressScrubStats {
	found: number;
	types: string[];
}

/**
 * Scrub a server-bound payload IN PLACE: secrets on every string field, PII on
 * the natural-language fields. Call on EVERY egress payload.
 */
export function scrubEgressPayload(
	payload: JsonObject,
	config?: ScrubConfig,
): EgressScrubStats {
	const cfg = config ?? loadScrubConfig();
	const types: string[] = [];
	let found = 0;
	const note = (r: ScrubResult) => {
		found += r.found;
		for (const t of r.types) if (!types.includes(t)) types.push(t);
	};
	for (const field of EGRESS_SECRET_FIELDS) {
		const value = payload[field];
		if (typeof value === "string" && value) {
			const r = scrubSecrets(value, cfg);
			if (r.found > 0) {
				payload[field] = r.text;
				note(r);
			}
		}
	}
	for (const field of EGRESS_PII_FIELDS) {
		const value = payload[field];
		if (typeof value === "string" && value) {
			const r = redactPii(value);
			if (r.found > 0) {
				payload[field] = r.text;
				note(r);
			}
		}
	}
	return { found, types };
}

/**
 * Quick check if text contains any secrets.
 */
export function containsSecrets(text: string): boolean {
	if (!text) return false;
	for (const pattern of BUILTIN_PATTERNS) {
		pattern.regex.lastIndex = 0;
		if (pattern.regex.test(text)) return true;
	}
	return false;
}

// ===========================================
// Stats
// ===========================================

const scrubStats = { total_scrubbed: 0, by_type: {} as Record<string, number> };

export function recordScrub(types: string[]): void {
	scrubStats.total_scrubbed++;
	for (const t of types) {
		scrubStats.by_type[t] = (scrubStats.by_type[t] || 0) + 1;
	}
}
