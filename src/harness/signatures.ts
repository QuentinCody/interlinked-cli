// ===========================================
// Signature Scanner — YARA-equivalent regex-based detection
// ===========================================
// Standalone pure-function module — zero harness dependencies, importable from any context.
// Ported from Sondera's YARA rules to TypeScript regex equivalents.
// Used by: taint-tracker, evaluator (output scanning), quality-checks (prompt injection)

// ===========================================
// Types (defined in signatures-patterns.ts, re-exported here for back-compat)
// ===========================================

export type {
	SignatureCategory,
	SignatureRule,
	SignatureSeverity,
} from "./signatures-patterns.js";

import type { SignatureCategory, SignatureRule, SignatureSeverity } from "./signatures-patterns.js";

export interface SignatureMatch {
	category: SignatureCategory;
	rule_id: string;
	severity: SignatureSeverity;
	description: string;
	/** First 120 chars of matched text */
	matched_text: string;
}

export interface SignatureContext {
	matches: SignatureMatch[];
	categories: Set<SignatureCategory>;
	severity: SignatureSeverity;
}

// ===========================================
// Severity ordering
// ===========================================

const SEVERITY_ORDER: Record<SignatureSeverity, number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

export function maxSeverity(a: SignatureSeverity, b: SignatureSeverity): SignatureSeverity {
	return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

// ===========================================
// Pattern tables (imported from sibling module)
// ===========================================

import {
	COMMAND_INJECTION_EXTENDED_RULES,
	CREDENTIAL_ACCESS_RULES,
	EXFILTRATION_RULES,
	INDIRECT_INJECTION_RULES,
	OBFUSCATION_RULES,
	PROMPT_INJECTION_RULES,
	SECRETS_RULES,
	SUPPLY_CHAIN_RULES,
} from "./signatures-patterns.js";

// Re-export pattern arrays so any existing consumer can import them from here
export {
	COMMAND_INJECTION_EXTENDED_RULES,
	CREDENTIAL_ACCESS_RULES,
	EXFILTRATION_RULES,
	INDIRECT_INJECTION_RULES,
	OBFUSCATION_RULES,
	PROMPT_INJECTION_RULES,
	SECRETS_RULES,
	SUPPLY_CHAIN_RULES,
};

// ===========================================
// All Rules Combined
// ===========================================

const ALL_RULES: SignatureRule[] = [
	...PROMPT_INJECTION_RULES,
	...INDIRECT_INJECTION_RULES,
	...OBFUSCATION_RULES,
	...EXFILTRATION_RULES,
	...SECRETS_RULES,
	...CREDENTIAL_ACCESS_RULES,
	...SUPPLY_CHAIN_RULES,
	...COMMAND_INJECTION_EXTENDED_RULES,
];

// ===========================================
// Scanner Functions
// ===========================================

/** Regex metasyntax that a `literal_metachar_safe` signature's tokens never carry. */
const REGEX_METASYNTAX = /[[\]{}\\|]|\(\?/;
/** Bound on dropped regex-source spans per pattern (each retry starts one char later). */
const MAX_SOURCE_SPANS = 256;

/** First match of `pattern` in `content` that is not regex source text.
 *  For a `literal_metachar_safe` rule a span carrying metasyntax is skipped and
 *  the search resumes ONE character later, so a real token that starts inside
 *  a dropped span is still found (fail safe). Other rules: plain first match. */
function firstTokenMatch(rule: SignatureRule, pattern: RegExp, content: string): RegExpExecArray | null {
	if (!rule.literal_metachar_safe) return pattern.exec(content);
	const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "") + "g");
	for (let tries = 0; tries < MAX_SOURCE_SPANS; tries++) {
		const m = re.exec(content);
		if (m === null || !REGEX_METASYNTAX.test(m[0])) return m;
		re.lastIndex = m.index + 1;
	}
	return pattern.exec(content);
}

/** Scan content against all signature rules, optionally filtered by category */
export function scanForSignatures(
	content: string,
	categories?: SignatureCategory[],
): SignatureContext {
	if (!content || content.length === 0) {
		return { matches: [], categories: new Set(), severity: "low" };
	}

	const categorySet = categories ? new Set(categories) : null;
	const rules = categorySet ? ALL_RULES.filter((r) => categorySet.has(r.category)) : ALL_RULES;

	const matches: SignatureMatch[] = [];
	const matchedCategories = new Set<SignatureCategory>();
	let highestSeverity: SignatureSeverity = "low";

	for (const rule of rules) {
		for (const pattern of rule.patterns) {
			const match = firstTokenMatch(rule, pattern, content);
			if (match) {
				matches.push({
					category: rule.category,
					rule_id: rule.id,
					severity: rule.severity,
					description: rule.description,
					matched_text: match[0].slice(0, 120),
				});
				matchedCategories.add(rule.category);
				highestSeverity = maxSeverity(highestSeverity, rule.severity);
				break; // One match per rule is enough
			}
		}
	}

	return {
		matches,
		categories: matchedCategories,
		severity: highestSeverity,
	};
}

/** Scan content specifically for prompt injection patterns */
export function scanPromptInjection(content: string): SignatureMatch[] {
	const ctx = scanForSignatures(content, [
		"prompt_injection",
		"indirect_injection",
		"defense_evasion",
	]);
	return ctx.matches;
}

/** Scan content specifically for exfiltration patterns */
export function scanExfiltration(content: string): SignatureMatch[] {
	const ctx = scanForSignatures(content, ["exfiltration", "credential_access"]);
	return ctx.matches;
}

/** Scan content specifically for secret patterns */
export function scanSecrets(content: string): SignatureMatch[] {
	const ctx = scanForSignatures(content, ["secrets_detection"]);
	return ctx.matches;
}

/** Scan content specifically for supply chain attack patterns */
export function scanSupplyChain(content: string): SignatureMatch[] {
	const ctx = scanForSignatures(content, ["supply_chain"]);
	return ctx.matches;
}
