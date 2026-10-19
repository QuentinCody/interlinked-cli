// interlinked-tdd: exempt — pure detection-pattern DATA (no testable logic)
// ===========================================
// Signature Pattern Tables — Secrets & Credential Access family
// ===========================================
// Extracted leaf cluster of signatures-patterns.ts (SECRETS_RULES +
// CREDENTIAL_ACCESS_RULES). Pure data; the only import is the type, erased
// at runtime, so no circular dependency forms with the parent module.
import type { SignatureRule } from "./signatures-patterns.js";

// ===========================================
// Secrets Detection Rules
// ===========================================

export const SECRETS_RULES: SignatureRule[] = [
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
			// userinfo is spelled out as the RFC 3986 §3.2.1 alphabet (unreserved /
			// pct-encoded / sub-delims), bounded, so a match can never run across
			// quotes, whitespace or diff hunks (E19: 27 of 66 real-world hits were
			// `[^@]+` spans of 200–10,000 chars through unrelated text).
			/mongodb(\+srv)?:\/\/[A-Za-z0-9._~%!$&'()*+,;=-]{1,128}:[A-Za-z0-9._~%!$&'()*+,;=-]{1,256}@/,
			/postgres(ql)?:\/\/[A-Za-z0-9._~%!$&'()*+,;=-]{1,128}:[A-Za-z0-9._~%!$&'()*+,;=-]{1,256}@/,
			/mysql:\/\/[A-Za-z0-9._~%!$&'()*+,;=-]{1,128}:[A-Za-z0-9._~%!$&'()*+,;=-]{1,256}@/,
			/redis:\/\/:[A-Za-z0-9._~%!$&'()*+,;=-]{1,256}@/,
		],
	},
	{
		id: "sig-secret-generic-password",
		category: "secrets_detection",
		severity: "high",
		description: "Hardcoded password in structured data",
		patterns: [
			// A value that starts with `$` or carries `{`/`}` is a shell / template
			// expansion (`"${TOKEN%%?expires=*}"`), not a literal (E19: 8 hits).
			/"password"\s*:\s*"(?!\$)[^\s"{}]{8,}"/i,
			/PASSWORD\s*=\s*["'](?!\$)[^\s"'{}]{8,}["']/,
			/SECRET\s*=\s*["'](?!\$)[^\s"'{}]{8,}["']/,
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
			// Catches https://user:pass@host but excludes DB connection strings (already covered).
			// userinfo is the RFC 3986 alphabet: a `"` or `{` in the span is JSON text
			// (`"@context":"https://schema.org","@type"` — 22 of 104 E19 hits) or a
			// `${TOKEN}@` template, never a credential.
			/https?:\/\/[A-Za-z0-9._~%!$&'()*+,;=-]{1,128}:[A-Za-z0-9._~%!$&'()*+,;=-]{4,256}@(?!localhost|127\.0\.0\.1)/,
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

export const CREDENTIAL_ACCESS_RULES: SignatureRule[] = [
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
