// interlinked-tdd: exempt — pure detection-pattern DATA (no testable logic)
// ===========================================
// Signature Pattern Tables
// ===========================================
// Pure data module — all SignatureRule arrays used by signatures.ts.
// No harness dependencies; importable from any context.
// Defines SignatureRule + SignatureCategory + SignatureSeverity locally so
// this module has zero imports and cannot form a circular dependency.
/** Categories of security signatures */
export type SignatureCategory =
	| "prompt_injection"
	| "indirect_injection"
	| "exfiltration"
	| "secrets_detection"
	| "credential_access"
	| "obfuscation"
	| "defense_evasion"
	| "command_injection"
	| "supply_chain";

/** Severity levels for signature matches */
export type SignatureSeverity = "critical" | "high" | "medium" | "low";

/** A single compiled signature rule with detection patterns */
export interface SignatureRule {
	id: string;
	category: SignatureCategory;
	severity: SignatureSeverity;
	description: string;
	patterns: RegExp[];
}

// ===========================================
// Prompt Injection Rules
// ===========================================

export const PROMPT_INJECTION_RULES: SignatureRule[] = [
	{
		id: "sig-pi-ignore-instructions",
		category: "prompt_injection",
		severity: "high",
		description: "Ignore/disregard previous instructions pattern",
		patterns: [
			/ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|commands?|rules?)/i,
			/disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|commands?|rules?)/i,
			/forget\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|commands?|rules?)/i,
			/override\s+(all\s+)?(previous|prior|system)\s+(instructions?|prompts?|commands?|rules?)/i,
		],
	},
	{
		id: "sig-pi-role-manipulation",
		category: "prompt_injection",
		severity: "critical",
		description: "Attempt to change AI agent role or identity",
		patterns: [
			// Two-pronged match to reduce false positives on legitimate messages
			// like "you are now a member of the team":
			// (a) suspicious persona word immediately after a/an
			/you\s+are\s+now\s+(a|an)\s+(helpful|evil|unrestricted|unfiltered|uncensored|obedient|compliant|new|different|advanced|special|superior|unlimited|hacker|jailbr\w+)\b/i,
			// (b) any role word followed by a qualifying manipulation clause
			/you\s+are\s+now\s+(a|an)\s+\w+\s+(that|who|which|without|with no|capable of|designed to|programmed to|trained to)\b/i,
			/from\s+now\s+on,?\s+act\s+as/i,
			/pretend\s+(you\s+are|to\s+be)/i,
			/your\s+new\s+role\s+is/i,
			/you\s+are\s+in\s+(developer|debug|god)\s+mode/i,
			/enable\s+(developer|debug|god)\s+mode/i,
			/you\s+are\s+jailbroken/i,
			/you\s+are\s+(an?\s+)?unrestricted/i,
			/you\s+have\s+no\s+(ethical\s+)?limitations/i,
		],
	},
	{
		id: "sig-pi-system-override",
		category: "prompt_injection",
		severity: "critical",
		description: "Attempt to override system prompts or constraints",
		patterns: [
			/reveal\s+your\s+system\s+prompt/i,
			/show\s+me\s+your\s+system\s+prompt/i,
			/print\s+your\s+system\s+instructions/i,
			/remove\s+(all\s+)?(safety\s+)?(constraints?|limitations?|restrictions?)/i,
			/disable\s+(all\s+)?(safety\s+)?(constraints?|limitations?|restrictions?)/i,
			/bypass\s+(all\s+)?(safety\s+)?(constraints?|limitations?|restrictions?)/i,
			/ignore\s+your\s+content\s+policy/i,
			/bypass\s+content\s+filters/i,
			/disable\s+safety\s+features/i,
		],
	},
	{
		id: "sig-pi-tool-abuse",
		category: "prompt_injection",
		severity: "high",
		description: "Prompt injection to abuse agent tools",
		patterns: [
			/use\s+(the\s+)?[\w_]+\s+tool\s+to\s+(delete|drop|truncate|remove|destroy)/i,
			/call\s+(the\s+)?[\w_]+\s+function\s+with\s+admin/i,
			/execute\s+(the\s+)?[\w_]+\s+command\s+as\s+root/i,
			/escalate\s+(to\s+)?admin/i,
			/run\s+as\s+(administrator|root|sudo)/i,
		],
	},
];

// ===========================================
// Indirect Injection Rules
// ===========================================

export const INDIRECT_INJECTION_RULES: SignatureRule[] = [
	{
		id: "sig-ii-document-instructions",
		category: "indirect_injection",
		severity: "critical",
		description: "Indirect prompt injection via document-embedded instructions",
		patterns: [
			/if\s+you\s+are\s+an?\s+AI/i,
			/when\s+processing\s+this\s+document/i,
			/instructions?\s+for\s+the\s+AI\s+assistant/i,
			/if\s+(you|an?\s+AI)\s+(read|process|see)\s+this/i,
			/when\s+(you|an?\s+AI)\s+(read|process|see)\s+this/i,
			/note\s+to\s+(language\s+)?model/i,
			/dear\s+AI\s+assistant/i,
		],
	},
	{
		id: "sig-ii-hidden-markers",
		category: "indirect_injection",
		severity: "high",
		description: "Hidden instruction markers in content",
		patterns: [
			/<!-- AI:/i,
			/\[AI_INSTRUCTION\]/i,
			/\{\{AI_OVERRIDE\}\}/i,
			/<!-- SYSTEM:/i,
			/\[SYSTEM_OVERRIDE\]/i,
		],
	},
];

// ===========================================
// Obfuscation / Defense Evasion Rules
// ===========================================

export const OBFUSCATION_RULES: SignatureRule[] = [
	{
		id: "sig-obf-base64-injection",
		category: "defense_evasion",
		severity: "high",
		description: "Base64-encoded prompt injection phrases",
		patterns: [
			// "ignore previous" in base64
			/aWdub3JlIHByZXZpb3Vz/,
			// "disregard previous" in base64
			/ZGlzcmVnYXJkIHByZXZpb3Vz/,
			// "forget previous" in base64
			/Zm9yZ2V0IHByZXZpb3Vz/,
			// "system prompt" in base64
			/c3lzdGVtIHByb21wdA/,
			// "system instructions" in base64
			/c3lzdGVtIGluc3RydWN0aW9ucw/,
		],
	},
	{
		id: "sig-obf-zero-width",
		category: "defense_evasion",
		severity: "medium",
		description: "Zero-width character obfuscation (>5 instances)",
		patterns: [
			// Match content with many zero-width chars (5+ of same type)
			/(​.*){5,}/,
			/(‌.*){5,}/,
			/(‍.*){5,}/,
			/(﻿.*){5,}/,
		],
	},
	{
		id: "sig-obf-rtl-override",
		category: "defense_evasion",
		severity: "high",
		description: "Right-to-left override characters (text direction manipulation)",
		patterns: [/‮/, /‭/],
	},
	{
		id: "sig-obf-html-entities",
		category: "defense_evasion",
		severity: "high",
		description: "HTML entity obfuscation in injection attempts",
		patterns: [/&#105;gnore/i, /&#100;isregard/i, /&lt;ignore&gt;/i, /<!\[CDATA\[ignore/i],
	},
];

// ===========================================
// Exfiltration Rules
// ===========================================

export const EXFILTRATION_RULES: SignatureRule[] = [
	{
		id: "sig-exfil-paste-sites",
		category: "exfiltration",
		severity: "high",
		description: "Data exfiltration to paste/upload services",
		patterns: [
			/pastebin\.com/i,
			/paste\.ee/i,
			/hastebin\.com/i,
			/ghostbin\.com/i,
			/dpaste\.com/i,
			/justpaste\.it/i,
			/privatebin\.net/i,
			/rentry\.co/i,
			/transfer\.sh/i,
			/file\.io/i,
			/0x0\.st/i,
		],
	},
	{
		id: "sig-exfil-webhooks",
		category: "exfiltration",
		severity: "high",
		description: "Data exfiltration to webhook/request capture services",
		patterns: [
			/webhook\.site/i,
			/requestbin\.com/i,
			/pipedream\.com/i,
			/hookbin\.com/i,
			/burpcollaborator/i,
			/interact\.sh/i,
		],
	},
	{
		id: "sig-exfil-discord-webhook",
		category: "exfiltration",
		severity: "high",
		description: "Data exfiltration via Discord webhook",
		patterns: [/discord\.com\/api\/webhooks\//i],
	},
	{
		id: "sig-exfil-tunneling",
		category: "exfiltration",
		severity: "high",
		description: "Network tunneling services (suspicious in agent context)",
		patterns: [/ngrok\.io/i, /localtunnel\.me/i, /serveo\.net/i],
	},
	{
		id: "sig-exfil-dns-tunnel",
		category: "exfiltration",
		severity: "high",
		description: "DNS tunneling patterns",
		patterns: [
			/\b(dnscat|iodine|dns2tcp)\b/i,
			/\bnslookup\s+[a-f0-9]{32,}/i,
			/\bdig\s+[a-f0-9]{32,}/i,
		],
	},
	{
		id: "sig-exfil-encode-send",
		category: "exfiltration",
		severity: "high",
		description: "Encoding combined with network send (exfiltration chain)",
		patterns: [
			/base64.*\|\s*(curl|wget|nc)\b/i,
			/\bbtoa\s*\(.*\bfetch\b/i,
			/\.encode\(.*\brequests\.post\b/i,
		],
	},
	{
		id: "sig-exfil-file-read-send",
		category: "exfiltration",
		severity: "critical",
		description: "File read piped to network command",
		patterns: [
			/\bcat\s+[\w/.]+\s*\|\s*(curl|wget|nc)\b/i,
			/\bcat\s+[\w/.]+\s*>\s*\/dev\/tcp\b/i,
		],
	},
	{
		id: "sig-exfil-steganography",
		category: "exfiltration",
		severity: "medium",
		description: "Steganography tools for data hiding",
		patterns: [/\b(steghide|outguess|stegsnow)\b/i],
	},
	{
		id: "sig-exfil-memory-dump",
		category: "credential_access",
		severity: "high",
		description: "Memory/process dump for credential extraction",
		patterns: [
			/\b(memdump|procdump)\b/i,
			/\/proc\/self\/mem\b/,
			/\/proc\/self\/maps\b/,
			/\bgcore\b/,
		],
	},
];

// ===========================================
// Secrets Detection + Credential Access Rules
// ===========================================
// Extracted to ./signatures-patterns-secrets.ts (leaf data cluster) to keep
// this module under the per-file line cap. Re-exported here so existing
// consumers can keep importing them from signatures-patterns.js.
export { CREDENTIAL_ACCESS_RULES, SECRETS_RULES } from "./signatures-patterns-secrets.js";

// ===========================================
// Supply Chain Rules
// ===========================================

export const SUPPLY_CHAIN_RULES: SignatureRule[] = [
	{
		id: "sig-sc-custom-registry",
		category: "supply_chain",
		severity: "high",
		description: "Package installation from non-standard registry",
		patterns: [
			/\bpip3?\s+install\b.*--index-url\s+(?!https:\/\/(pypi|files)\.python)/i,
			/\bnpm\s+(install|i|add)\b.*--registry\s+(?!https:\/\/registry\.npmjs)/i,
			/\byarn\s+add\b.*--registry\s+(?!https:\/\/registry\.yarnpkg)/i,
		],
	},
	{
		id: "sig-sc-lifecycle-injection",
		category: "supply_chain",
		severity: "high",
		description: "Network/exec commands in package lifecycle scripts",
		patterns: [
			/"(preinstall|postinstall|prepare|prepublish)"\s*:\s*"[^"]*\b(curl|wget|nc|bash\s+-c|eval|exec)\b/,
		],
	},
	{
		id: "sig-sc-lifecycle-node-script",
		category: "supply_chain",
		severity: "medium",
		description:
			"Lifecycle script runs a node script — common dropper pattern (ref: axios@1.14.1 used postinstall: node setup.js)",
		patterns: [/"(preinstall|postinstall|install)"\s*:\s*"[^"]*\bnode\s+\S+\.m?js\b/],
	},
	{
		id: "sig-sc-setup-py-injection",
		category: "supply_chain",
		severity: "high",
		description: "Build script injection via setup.py/build scripts",
		patterns: [/\b(subprocess|os\.system|os\.popen)\s*\(.*\b(curl|wget|nc|bash)\b/],
	},
];

// ===========================================
// Command Injection & Code Safety Rules (Extended)
// ===========================================

export const COMMAND_INJECTION_EXTENDED_RULES: SignatureRule[] = [
	{
		id: "sig-ci-prototype-pollution",
		category: "command_injection",
		severity: "high",
		description: "Prototype pollution via __proto__ or constructor.prototype",
		patterns: [
			/__proto__\s*[=[]/,
			/constructor\s*\.\s*prototype/,
			/Object\s*\.\s*assign\s*\(\s*\{\}\s*\.\s*__proto__/,
		],
	},
	{
		id: "sig-ci-open-redirect",
		category: "command_injection",
		severity: "high",
		description: "Open redirect via user-controlled input",
		patterns: [
			/res\.redirect\s*\(\s*req\.(query|params|body)\b/,
			/window\.location\s*=\s*(user|input|param|query|req)/i,
			/location\.href\s*=\s*(user|input|param|query|req)/i,
		],
	},
	{
		id: "sig-ci-unsafe-deserialization",
		category: "command_injection",
		severity: "critical",
		description: "Unsafe deserialization of user input",
		patterns: [
			/\beval\s*\(\s*JSON\.parse/,
			/\byaml\.load\s*\(/,
			/\bpickle\.loads?\s*\(/,
			/\bunserialize\s*\(/,
			/\beval\s*\(\s*atob\s*\(/,
		],
	},
	{
		id: "sig-ci-command-injection",
		category: "command_injection",
		severity: "critical",
		description: "Command injection via string interpolation in shell commands",
		patterns: [
			/\bexec\s*\(\s*`[^`]*\$\{/,
			/\bexecSync\s*\(\s*`[^`]*\$\{/,
			/\bspawn\s*\(\s*`[^`]*\$\{/,
			/\bos\.system\s*\(\s*f"/,
			/\bsubprocess\.(?:run|call|Popen)\s*\(\s*f"/,
		],
	},
	{
		id: "sig-ci-path-traversal",
		category: "command_injection",
		severity: "high",
		description: "Path traversal via user-controlled input in file operations",
		patterns: [
			/path\.join\s*\(\s*.*req\.(query|params|body)/,
			/path\.resolve\s*\(\s*.*req\.(query|params|body)/,
			/readFile(?:Sync)?\s*\(\s*.*req\.(query|params|body)/,
			// Match ../../ in string literals (user-supplied traversal), but exclude
			// module import paths (from "../../...") which are normal relative imports
			/["'`]\.\.\/\.\.\/\.\.\/(?![\w@])/,
		],
	},
];
