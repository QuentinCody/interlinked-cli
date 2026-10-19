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

// Regex-source spans (review 3b item 5) used to be skipped at match time for
// the userinfo-shaped rules. Since E19 (2026-10-08) those rules spell out the
// RFC 3986 userinfo alphabet, which cannot contain regex metasyntax, so a plain
// first match is the whole mechanism.

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
			const match = pattern.exec(content);
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
