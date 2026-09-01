// ===========================================
// Deterministic Trajectory-Analysis Engine — pure helpers (core)
// ===========================================
//
// Pure, deterministic utilities shared by state.ts and the rule files. No IO,
// no network, no randomness, no Date.now. Bash command-shape parsers for the
// security legs live in the sibling `helpers-commands.ts` (a line-cap split);
// this file holds hashing, normalization, anchoring, host/IP classification,
// and the credential-shape detectors.
//
// NOTE ON SECRET PATTERNS: the regexes below match the SHAPE of credentials
// (AKIA…, ghp_…, sk-…, xox…, PEM BEGIN PRIVATE KEY). They are DETECTION
// patterns — what we scan FOR — not real secrets, identical in spirit to
// `signatures-patterns-secrets.ts`.

import { createHash } from "node:crypto";

// ===========================================
// Hashing
// ===========================================

/** Stable hex sha256 of a string. */
export function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

// ===========================================
// Command normalization + family classification
// ===========================================

/**
 * Normalize a command for exact-rerun matching: collapse whitespace, then
 * canonicalize numeric literals (ports, PIDs, line numbers, hex) to a
 * placeholder so a re-run with a drifted number still matches. Paths are
 * normalized via the same numeric-segment collapse (e.g. `/tmp/run-123/x` and
 * `/tmp/run-456/x` match). Case is preserved (commands are case-sensitive).
 */
export function normalizeCommand(cmd: string): string {
	return cmd
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b0x[0-9a-fA-F]+\b/g, "0xN")
		.replace(/\b\d+(?:\.\d+)?\b/g, "N");
}

const TEST_FAMILY_RE =
	/\b(?:vitest|jest|mocha|pytest|rspec|phpunit|ava|jasmine)\b|\b(?:go|cargo|deno)\s+test\b/i;
const TEST_SCRIPT_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/i;
const BUILD_FAMILY_RE =
	/\b(?:tsc|tsgo|tsup|webpack|rollup|esbuild|gradle|mvn)\b|\b(?:vite|cargo|go)\s+build\b/i;
const BUILD_SCRIPT_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i;
const LINT_FAMILY_RE =
	/\b(?:eslint|biome|oxlint|ruff|clippy|rustfmt|prettier|gofmt|golangci-lint|mypy|pyright)\b/i;

/**
 * Classify a command into a verifier family ("test" / "build" / "lint") or
 * fall back to the head verb so unrelated commands never share a family.
 */
export function commandFamily(cmd: string): string {
	if (TEST_FAMILY_RE.test(cmd) || TEST_SCRIPT_RE.test(cmd)) return "test";
	if (BUILD_FAMILY_RE.test(cmd) || BUILD_SCRIPT_RE.test(cmd)) return "build";
	if (LINT_FAMILY_RE.test(cmd)) return "lint";
	const head = cmd.trim().split(/\s+/)[0] ?? "";
	return (head.split("/").pop() ?? head).toLowerCase();
}

/** True iff the command runs a known verifier (test / build / lint). */
export function isVerifyCommand(cmd: string): boolean {
	const f = commandFamily(cmd);
	return f === "test" || f === "build" || f === "lint";
}

// ===========================================
// Content anchoring
// ===========================================

/**
 * Content-anchored region key: sha256 of the trimmed first + last non-empty
 * lines of `oldString`. Survives line-number drift (the region is identified by
 * its boundary content, not its position), so an undo-war on the same logical
 * block keys to the same anchor even as the file grows above/below it.
 */
export function anchorHash(oldString: string): string {
	const lines = oldString
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length === 0) return sha256("\x00empty");
	const first = lines[0] ?? "";
	const last = lines[lines.length - 1] ?? "";
	return sha256(`${first}\x00${last}`);
}

// ===========================================
// File classification
// ===========================================

const SOURCE_CODE_EXT =
	/\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala)$/i;
const NON_CODE_EXT = /\.(?:d\.ts|json|md|markdown|yaml|yml|toml|lock|txt|csv|env)$/i;

/**
 * Source-code file predicate for churn rules that should not count config /
 * docs / data / type-only files (the FP guard "exempt config/docs/data/
 * type-only"). `.d.ts` and dotfiles are excluded.
 */
export function isSourceCodeFile(filePath: string): boolean {
	if (/\.d\.ts$/i.test(filePath)) return false;
	if (NON_CODE_EXT.test(filePath)) return false;
	return SOURCE_CODE_EXT.test(filePath);
}

const TEST_FILE_RE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/**
 * Test-file predicate (companion of `isSourceCodeFile`). Matches `.test.` /
 * `.spec.` TS/JS suffixes, `__tests__/` `tests/` `test/` directories, and
 * Go/Python `_test`/`test_` conventions — used by the verification-discipline
 * rules to tell "wrote code" from "wrote a test".
 */
export function isTestFile(filePath: string): boolean {
	return TEST_FILE_RE.test(filePath);
}

/** Tools that produce a file edit on disk. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
export function isEditEvent(event: { tool: string }): boolean {
	return EDIT_TOOLS.has(event.tool);
}
export function isBashEvent(event: { tool: string }): boolean {
	return event.tool === "Bash";
}

// ===========================================
// Egress verbs + host / IP classification
// ===========================================

/** Verbs whose invocation opens an outbound connection. */
export const EGRESS_VERBS: ReadonlySet<string> = new Set([
	"curl", "wget", "nc", "ncat", "netcat", "scp", "sftp", "rsync", "ssh",
	"telnet", "ftp", "socat", "http", "https", "httpie",
]);

/** Shell prefixes to skip when finding a segment's head verb. */
const PREFIX_SKIP = /^(?:sudo|env|nohup|time|exec|command|builtin|\w+=.*)$/;

/** Split a command into pipeline / sequence segments. */
export function splitSegments(cmd: string): string[] {
	return cmd
		.split(/\n|;|&&|\|\||[|&]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** The head verb of each segment (basename, lowercased, prefixes stripped). */
export function commandHeads(cmd: string): string[] {
	const heads: string[] = [];
	for (const seg of splitSegments(cmd)) {
		const toks = seg.split(/\s+/).filter((t) => t.length > 0);
		let i = 0;
		while (i < toks.length && PREFIX_SKIP.test(toks[i] ?? "")) i++;
		const head = toks[i];
		if (head) heads.push((head.split("/").pop() ?? head).toLowerCase());
	}
	return heads;
}

/** True iff some segment's head verb is an egress verb. */
export function hasEgressVerb(cmd: string): boolean {
	return commandHeads(cmd).some((h) => EGRESS_VERBS.has(h));
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Valid dotted-quad with every octet in 0-255. */
function isIPv4(tok: string): boolean {
	const m = IPV4_RE.exec(tok);
	if (!m) return false;
	return m.slice(1, 5).every((o) => Number(o) <= 255);
}

/**
 * True for loopback / private / link-local IPv4, decided NUMERICALLY by octet
 * ranges — deliberately not by matching any loopback hostname or literal IP
 * string. Covers 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16-31/12, 192.168/16.
 */
export function isPrivateOrLoopbackIPv4(ip: string): boolean {
	const m = IPV4_RE.exec(ip);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	if ([a, b, Number(m[3]), Number(m[4])].some((o) => o > 255)) return false;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

/** Internal / reserved TLD suffixes that are never "external". */
const INTERNAL_TLD = /\.(?:local|internal|test|localhost|invalid|lan|home|corp)$/i;
/** Trailing labels that are file extensions, not real TLDs (e.g. `backup.tar.gz`). */
const FILE_EXT_TAIL =
	/\.(?:gz|sh|py|js|ts|mjs|cjs|json|txt|tar|zip|md|png|jpg|jpeg|gif|svg|pdf|csv|log|tmp|bak|html|css|xml|yml|yaml|toml|lock|class|jar|war|exe|dll|so|dylib|wasm)$/i;

/**
 * True iff a host token denotes an external destination: a public IPv4, or a
 * dotted public domain. Bare hostnames (no dot — e.g. a loopback alias) and
 * private/loopback IPv4 and internal-TLD / file-extension tokens are NOT
 * external. The loopback case falls out of the rules numerically/structurally;
 * no loopback hostname string is hardcoded.
 */
export function isExternalHost(host: string): boolean {
	const h = host.toLowerCase().replace(/\.$/, "");
	if (isIPv4(h)) return !isPrivateOrLoopbackIPv4(h);
	if (!h.includes(".")) return false;
	if (INTERNAL_TLD.test(h)) return false;
	if (FILE_EXT_TAIL.test(h)) return false;
	return /\.[a-z]{2,}$/.test(h);
}

/** Extract candidate host tokens from a command (URLs, user@host, IPv4, domains). */
export function extractHosts(cmd: string): string[] {
	const hosts: string[] = [];
	for (const m of cmd.matchAll(/\bhttps?:\/\/([^/\s:'"]+)/gi)) {
		if (m[1]) hosts.push(m[1]);
	}
	// Bounded for the same reason as the domain pattern below, and this one was
	// the worse of the two: an unbounded `[\w.-]+` before a MANDATORY `@` makes
	// every start offset scan to end-of-input when no `@` follows — measured at
	// 16x per 4x of input, 1.67s on a 32KB command. Bounds are RFC 5321's own
	// limits (64-char local part, 255-char domain), so no real address that
	// matched before stops matching.
	for (const m of cmd.matchAll(/\b[\w.-]{1,64}@([a-zA-Z0-9.-]{1,255})/g)) {
		if (m[1]) hosts.push(m[1]);
	}
	for (const m of cmd.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) {
		if (m[0]) hosts.push(m[0]);
	}
	// Both repetitions are BOUNDED. The unbounded form `(?:[a-zA-Z0-9-]+\.)+`
	// was quadratic — measured at exactly 4x per doubling, 1.35s on 32KB of
	// "a-a." — and this runs on every PreToolUse Bash command, so the cost lands
	// on the guard path. The bounds are DNS's own limits (63 chars per label)
	// plus a label depth well past any real hostname, so no host that matched
	// before stops matching; a tighter depth (12) was rejected because it
	// silently matched a SHIFTED window of a deep name rather than the name.
	for (const m of cmd.matchAll(/\b(?:[a-zA-Z0-9-]{1,63}\.){1,32}[a-zA-Z]{2,}\b/g)) {
		if (m[0]) hosts.push(m[0]);
	}
	return hosts;
}

/** True iff the command is an egress verb targeting at least one external host. */
export function isEgressCommandToExternalHost(cmd: string): boolean {
	if (!hasEgressVerb(cmd)) return false;
	return extractHosts(cmd).some(isExternalHost);
}

// ===========================================
// Secret-literal detection (credential SHAPES, not real secrets)
// ===========================================

/** A matched credential-shaped literal. */
interface SecretLiteralMatch {
	kind: string;
	token: string;
	/** Whether this shape is high-confidence enough to gate a block on. */
	high: boolean;
}

// Detection patterns. `high` marks the near-zero-FP structured shapes the
// catalog permits a block on (PEM headers / AKIA / GitHub PAT). sk-ant- is
// listed before sk- so the Anthropic key resolves to its high-confidence kind.
const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp; high: boolean }> = [
	{ kind: "private_key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, high: true },
	{ kind: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/, high: true },
	{ kind: "github_pat", re: /\bgh[posr]_[0-9A-Za-z]{36}\b/, high: true },
	{ kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, high: true },
	{ kind: "slack_token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, high: false },
	{ kind: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/, high: false },
];

/** First credential-shaped literal in `content`, or null. */
export function detectSecretLiteral(content: string): SecretLiteralMatch | null {
	for (const p of SECRET_PATTERNS) {
		const m = p.re.exec(content);
		if (m) return { kind: p.kind, token: m[0], high: p.high };
	}
	return null;
}

/** Every credential-shaped literal in `content` (deduped by token). */
export function detectAllSecretLiterals(content: string): SecretLiteralMatch[] {
	const out: SecretLiteralMatch[] = [];
	const seen = new Set<string>();
	for (const p of SECRET_PATTERNS) {
		for (const m of content.matchAll(new RegExp(p.re.source, `${p.re.flags}g`))) {
			const token = m[0];
			if (!token || seen.has(token)) continue;
			seen.add(token);
			out.push({ kind: p.kind, token, high: p.high });
		}
	}
	return out;
}

/** True iff `content` contains any credential-shaped literal. */
export function looksLikeSecretLiteral(content: string): boolean {
	return detectSecretLiteral(content) !== null;
}

/**
 * True iff `content` contains a HIGH-confidence credential shape (PEM private
 * key header / AKIA access key / GitHub PAT / Anthropic key). This is the only
 * subset the catalog permits `session_secret_persistence` to BLOCK on; the
 * structured prefix + fixed charset/length is the near-zero-FP signal.
 */
export function looksLikeHighConfidenceSecret(content: string): boolean {
	return SECRET_PATTERNS.some((p) => p.high && p.re.test(content));
}

// ===========================================
// Secret PATH classification
// ===========================================

const SECRET_PATH_RES: ReadonlyArray<RegExp> = [
	/(?:^|\/)\.env(?:\.[\w.-]+)?$/i,
	/(?:^|\/)\.ssh\/(?:id_(?:rsa|ed25519|ecdsa|dsa)|authorized_keys)\b/,
	/(?:^|\/)\.aws\/credentials\b/,
	/(?:^|\/)\.config\/gcloud\//,
	/(?:^|\/)\.kube\/config\b/,
	/(?:^|\/)\.docker\/config\.json\b/,
	/(?:^|\/)\.npmrc$/,
	/(?:^|\/)\.netrc$/,
	/(?:^|\/)\.pgpass$/,
	/(?:^|\/)(?:credentials|secrets?)(?:\.(?:json|ya?ml|env))?$/i,
];

/** True iff `filePath` is a structured credential path. */
export function isSecretPath(filePath: string): boolean {
	return SECRET_PATH_RES.some((re) => re.test(filePath));
}
