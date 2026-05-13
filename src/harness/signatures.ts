// ===========================================
// Signature Scanner — YARA-equivalent regex-based detection
// ===========================================
// Standalone pure-function module — zero harness dependencies, importable from any context.
// Ported from Sondera's YARA rules to TypeScript regex equivalents.
// Used by: taint-tracker, evaluator (output scanning), quality-checks (prompt injection)

// ===========================================
// Types
// ===========================================

type SignatureCategory =
	| "prompt_injection"
	| "indirect_injection"
	| "exfiltration"
	| "secrets_detection"
	| "credential_access"
	| "obfuscation"
	| "defense_evasion"
	| "command_injection"
	| "supply_chain";

type SignatureSeverity = "critical" | "high" | "medium" | "low";

interface SignatureMatch {
	category: SignatureCategory;
	rule_id: string;
	severity: SignatureSeverity;
	description: string;
	/** First 120 chars of matched text */
	matched_text: string;
}

interface SignatureContext {
	matches: SignatureMatch[];
	categories: Set<SignatureCategory>;
	severity: SignatureSeverity;
}

interface SignatureRule {
	id: string;
	category: SignatureCategory;
	severity: SignatureSeverity;
	description: string;
	patterns: RegExp[];
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

function maxSeverity(a: SignatureSeverity, b: SignatureSeverity): SignatureSeverity {
	return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

// ===========================================
// Prompt Injection Rules
// ===========================================

const PROMPT_INJECTION_RULES: SignatureRule[] = [
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

const INDIRECT_INJECTION_RULES: SignatureRule[] = [
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

const OBFUSCATION_RULES: SignatureRule[] = [
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
			/(\u200B.*){5,}/,
			/(\u200C.*){5,}/,
			/(\u200D.*){5,}/,
			/(\uFEFF.*){5,}/,
		],
	},
	{
		id: "sig-obf-rtl-override",
		category: "defense_evasion",
		severity: "high",
		description: "Right-to-left override characters (text direction manipulation)",
		patterns: [/\u202E/, /\u202D/],
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

const EXFILTRATION_RULES: SignatureRule[] = [
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
// Secrets Detection Rules
// ===========================================

const SECRETS_RULES: SignatureRule[] = [
	{
		id: "sig-secret-aws-key",
		category: "secrets_detection",
		severity: "critical",
		description: "AWS Access Key ID",
		patterns: [/AKIA[0-9A-Z]{16}/],
	},
	{
		id: "sig-secret-aws-secret",
		category: "secrets_detection",
		severity: "critical",
		description: "AWS Secret Access Key",
		patterns: [/aws_secret_access_key['"\s]*[:=]['"\s]*[A-Za-z0-9/+]{40}/i],
	},
	{
		id: "sig-secret-gcp-api",
		category: "secrets_detection",
		severity: "critical",
		description: "GCP API Key",
		patterns: [/AIza[0-9A-Za-z_-]{35}/],
	},
	{
		id: "sig-secret-gcp-service-account",
		category: "secrets_detection",
		severity: "critical",
		description: "GCP Service Account JSON key",
		patterns: [/"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----/],
	},
	{
		id: "sig-secret-azure-storage",
		category: "secrets_detection",
		severity: "critical",
		description: "Azure Storage Account Key",
		patterns: [/DefaultEndpointsProtocol=https.*AccountKey=[A-Za-z0-9/+=]{88}/],
	},
	{
		id: "sig-secret-github-pat",
		category: "secrets_detection",
		severity: "critical",
		description: "GitHub Personal Access Token",
		patterns: [
			/ghp_[0-9A-Za-z]{36}/,
			/gho_[0-9A-Za-z]{36}/,
			/ghs_[0-9A-Za-z]{36}/,
			/ghr_[0-9A-Za-z]{36}/,
			/github_pat_[0-9A-Za-z_]{22,}/,
		],
	},
	{
		id: "sig-secret-slack",
		category: "secrets_detection",
		severity: "high",
		description: "Slack token or webhook",
		patterns: [
			/xoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24}/,
			// Slack user tokens have a 24–34 char suffix; widened from a strict
			// {24} match after sanctum-oss's catalog.
			/xoxp-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,34}/,
			/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{24}/,
		],
	},
	{
		id: "sig-secret-stripe",
		category: "secrets_detection",
		severity: "critical",
		description: "Stripe API Key",
		patterns: [/sk_(test|live)_[0-9A-Za-z]{24,}/, /rk_(test|live)_[0-9A-Za-z]{24,}/],
	},
	{
		id: "sig-secret-openai",
		category: "secrets_detection",
		severity: "critical",
		description: "OpenAI API Key",
		patterns: [/sk-[A-Za-z0-9]{20,}/],
	},
	{
		id: "sig-secret-anthropic",
		category: "secrets_detection",
		severity: "critical",
		description: "Anthropic API Key",
		patterns: [/sk-ant-[A-Za-z0-9_-]{20,}/],
	},
	{
		id: "sig-secret-sendgrid",
		category: "secrets_detection",
		severity: "high",
		description: "SendGrid API Key",
		patterns: [/SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/],
	},
	{
		id: "sig-secret-twilio",
		category: "secrets_detection",
		severity: "high",
		description: "Twilio credentials",
		patterns: [/AC[a-f0-9]{32}/, /SK[a-f0-9]{32}/],
	},
	{
		id: "sig-secret-private-key",
		category: "secrets_detection",
		severity: "critical",
		description: "Private cryptographic key",
		patterns: [
			/-----BEGIN RSA PRIVATE KEY-----/,
			/-----BEGIN EC PRIVATE KEY-----/,
			/-----BEGIN PRIVATE KEY-----/,
			/-----BEGIN OPENSSH PRIVATE KEY-----/,
			/-----BEGIN DSA PRIVATE KEY-----/,
			// Reason: detection pattern in the signature table — this is
			// what we scan *for*, not a leaked key.
			// nosemgrep: generic.secrets.security.detected-pgp-private-key-block.detected-pgp-private-key-block
			/-----BEGIN PGP PRIVATE KEY BLOCK-----/,
		],
	},
	{
		id: "sig-secret-jwt",
		category: "secrets_detection",
		severity: "high",
		description: "JWT token",
		patterns: [/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/],
	},
	{
		id: "sig-secret-db-connection",
		category: "secrets_detection",
		severity: "critical",
		description: "Database connection string with credentials",
		patterns: [
			/mongodb(\+srv)?:\/\/[^:]+:[^@]+@/,
			/postgres(ql)?:\/\/[^:]+:[^@]+@/,
			/mysql:\/\/[^:]+:[^@]+@/,
			/redis:\/\/:[^@]+@/,
		],
	},
	{
		id: "sig-secret-generic-password",
		category: "secrets_detection",
		severity: "high",
		description: "Hardcoded password in structured data",
		patterns: [
			/"password"\s*:\s*"[^\s"]{8,}"/i,
			/PASSWORD\s*=\s*["'][^\s"']{8,}["']/,
			/SECRET\s*=\s*["'][^\s"']{8,}["']/,
		],
	},
	{
		id: "sig-secret-oauth-token",
		category: "secrets_detection",
		severity: "high",
		description: "OAuth access or refresh token",
		patterns: [
			// Google OAuth access token
			/\bya29\.[0-9A-Za-z_-]{20,}/,
			// Google OAuth refresh token
			/\b1\/\/[0-9A-Za-z_-]{20,}/,
			// Generic refresh_token in JSON/config
			/"refresh_token"\s*:\s*"[^\s"]{10,}"/,
			// Bearer token in authorization header
			/[Aa]uthorization['":\s]+[Bb]earer\s+[A-Za-z0-9_\-.]{20,}/,
		],
	},
	{
		id: "sig-secret-url-credentials",
		category: "secrets_detection",
		severity: "high",
		description: "Credentials embedded in URL (user:password@host)",
		patterns: [
			// Catches https://user:pass@host but excludes DB connection strings (already covered)
			/https?:\/\/[^:/\s]+:[^@/\s]{4,}@(?!localhost|127\.0\.0\.1)/,
		],
	},
	{
		id: "sig-secret-docker-auth",
		category: "secrets_detection",
		severity: "critical",
		description: "Docker registry authentication config",
		patterns: [/\/.docker\/config\.json\b/, /"auth"\s*:\s*"[A-Za-z0-9+/=]{20,}"/],
	},
	{
		id: "sig-secret-npm-token",
		category: "secrets_detection",
		severity: "critical",
		description: "npm authentication token",
		patterns: [/\/\/registry\.npmjs\.org\/:_authToken=/, /\bnpm_[A-Za-z0-9]{36}\b/],
	},
	// Provider-specific shapes ported from sanctum-oss
	// (reference-repos/sanctum-oss/crates/sanctum-firewall/src/patterns.rs).
	// Mailgun's `key-<32 hex>` was intentionally NOT ported — it FPs on
	// `api-key-<32 hex>` in JSON / env payloads because `\b` matches between
	// `-` and `k`.
	{
		id: "sig-secret-gitlab",
		category: "secrets_detection",
		severity: "critical",
		description: "GitLab Personal Access Token",
		patterns: [/(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20}(?![A-Za-z0-9_-])/],
	},
	{
		id: "sig-secret-slack-app",
		category: "secrets_detection",
		severity: "critical",
		description: "Slack app-level token (workspace admin scope)",
		patterns: [/\bxapp-[0-9]-[A-Z0-9]{10,13}-[0-9]{13}-[A-Za-z0-9]{64}\b/],
	},
	{
		id: "sig-secret-pypi",
		category: "secrets_detection",
		severity: "critical",
		description: "PyPI publication token",
		patterns: [/\bpypi-[A-Za-z0-9_-]{16,}/],
	},
	{
		id: "sig-secret-digitalocean",
		category: "secrets_detection",
		severity: "critical",
		description: "DigitalOcean Personal Access Token",
		patterns: [/\bdop_v1_[a-f0-9]{64}\b/],
	},
	{
		id: "sig-secret-datadog",
		category: "secrets_detection",
		severity: "high",
		description: "Datadog API or APP key",
		patterns: [/\bdd(?:api|app)_[a-z0-9]{32,}\b/],
	},
	{
		id: "sig-secret-azure-sas",
		category: "secrets_detection",
		severity: "critical",
		description: "Azure Shared Access Signature token",
		patterns: [/(?:sv=|se=|sp=)[^&]*&.*\bsig=[A-Za-z0-9%+/=]{20,}/],
	},
	{
		id: "sig-secret-vercel",
		category: "secrets_detection",
		severity: "critical",
		description: "Vercel deploy token",
		patterns: [/\bvercel_[A-Za-z0-9]{24,}\b/],
	},
	{
		id: "sig-secret-docker-hub-pat",
		category: "secrets_detection",
		severity: "critical",
		description: "Docker Hub Personal Access Token",
		patterns: [/\bdckr_pat_[A-Za-z0-9_-]{24,}/],
	},
	{
		id: "sig-secret-vault",
		category: "secrets_detection",
		severity: "critical",
		description: "Hashicorp Vault token",
		patterns: [/\bhvs\.[A-Za-z0-9_-]{24,}/],
	},
	{
		id: "sig-secret-huggingface",
		category: "secrets_detection",
		severity: "high",
		description: "Hugging Face access token",
		patterns: [/\bhf_[A-Za-z0-9]{34,}\b/],
	},
	{
		id: "sig-secret-shopify",
		category: "secrets_detection",
		severity: "critical",
		description: "Shopify Admin/Storefront token",
		patterns: [/\bshp(?:at|ss|pa|ca)_[a-fA-F0-9]{32,}\b/],
	},
	{
		id: "sig-secret-linear",
		category: "secrets_detection",
		severity: "high",
		description: "Linear API key",
		patterns: [/\blin_api_[A-Za-z0-9]{40,}\b/],
	},
	{
		id: "sig-secret-supabase",
		category: "secrets_detection",
		severity: "critical",
		description: "Supabase service-role key",
		patterns: [/\bsbp_[0-9a-fA-F]{40,}\b/],
	},
	{
		id: "sig-secret-planetscale",
		category: "secrets_detection",
		severity: "critical",
		description: "PlanetScale database token",
		patterns: [/(?<![A-Za-z0-9_-])pscale_tkn_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/],
	},
	{
		id: "sig-secret-flyio",
		category: "secrets_detection",
		severity: "critical",
		description: "Fly.io API token",
		patterns: [/(?<![A-Za-z0-9_-])fo1_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/],
	},
	{
		id: "sig-secret-railway",
		category: "secrets_detection",
		severity: "critical",
		description: "Railway API token",
		patterns: [
			/(?<![A-Za-z0-9_-])(?:railway|rlwy)_[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
		],
	},
	{
		id: "sig-secret-render",
		category: "secrets_detection",
		severity: "critical",
		description: "Render API key",
		patterns: [/\brnd_[A-Za-z0-9]{20,}\b/],
	},
	{
		id: "sig-secret-terraform-cloud",
		category: "secrets_detection",
		severity: "critical",
		description: "Terraform Cloud / HCP Atlas token",
		patterns: [/\batlasv1-[A-Za-z0-9]{40,}\b/],
	},
	{
		id: "sig-secret-grafana-sa",
		category: "secrets_detection",
		severity: "high",
		description: "Grafana service-account token",
		patterns: [/\bglsa_[A-Za-z0-9_]{20,}\b/],
	},
	{
		id: "sig-secret-neon",
		category: "secrets_detection",
		severity: "critical",
		description: "Neon Postgres connection string with embedded credentials",
		patterns: [/(?:postgres|postgresql):\/\/[^:]+:[^@]+@[^/]*neon\.tech/],
	},
];

// ===========================================
// Credential Access Rules (sensitive file patterns)
// ===========================================

const CREDENTIAL_ACCESS_RULES: SignatureRule[] = [
	{
		id: "sig-cred-ssh-keys",
		category: "credential_access",
		severity: "critical",
		description: "SSH private key file access",
		patterns: [/\/.ssh\/id_rsa\b/, /\/.ssh\/id_ed25519\b/, /\/.ssh\/id_ecdsa\b/],
	},
	{
		id: "sig-cred-cloud-configs",
		category: "credential_access",
		severity: "critical",
		description: "Cloud provider credential file access",
		patterns: [
			/\/.aws\/credentials\b/,
			/\/.config\/gcloud\/application_default_credentials\.json\b/,
			/\/.azure\/accessTokens\.json\b/,
			/\/.azure\/msal_token_cache\b/,
			/\/.oci\/oci_api_key/,
			/\/.kube\/config\b/,
		],
	},
	{
		id: "sig-cred-env-extraction",
		category: "credential_access",
		severity: "high",
		description: "Environment variable credential extraction",
		patterns: [
			/echo\s+\$\w*(_?KEY|_?TOKEN|_?SECRET|_?PASSWORD)/i,
			/printenv\s+\w*(_?KEY|_?TOKEN|_?SECRET|_?PASSWORD)/i,
		],
	},
];

// ===========================================
// Supply Chain Rules
// ===========================================

const SUPPLY_CHAIN_RULES: SignatureRule[] = [
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

const COMMAND_INJECTION_EXTENDED_RULES: SignatureRule[] = [
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
