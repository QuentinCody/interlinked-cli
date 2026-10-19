// Decision shadows — state redaction and secret masking (U1, 2026-10-08).
//
// Two faithful ports, so the live shadow asks the model the SAME state shape
// the research runs measured (a different render would void the thresholds):
//
//   * E20 (destructive-command second opinion): `redact` / `bound` / `cmd_of`
//     from scratch/2026-10-08-decisions-orthogonal/common.py and
//     e20-command-risk/build_pools.py — credential-shaped tokens become
//     `[redacted]`, fields are capped with the " …[truncated]" suffix, a
//     non-shell tool input is rendered with Python `json.dumps` separators.
//   * E19 (secret-signature second opinion): `mask` / `maskedContext` /
//     `remaskResidue` from e19-secret-fp/scan.mts — the matched string keeps
//     its first 4 and last 2 characters, ±150 characters of context with every
//     signature match and every ≥24-char high-entropy token masked. The hook
//     path adds `maskCredentialAssignments` before the cut (U1s audit), so a
//     window with a neighbouring credential is MORE masked than E19; a window
//     without one renders byte for byte as E19 (u1-mask-parity.mts, 120/120).
//
// The raw secret never leaves this module: callers receive masked strings
// only, and `residualSecretMatches` lets them refuse a state that still holds
// an unmasked signature match.

import { SECRETS_RULES } from "../signatures-patterns-secrets.js";

// ─── E20: redact + bound (common.py) ────────────────────────────────────────

/** `common.py::_SECRET_PATTERNS`, in order. Two-group entries keep group 1. */
const E20_SECRET_PATTERNS: { re: RegExp; keepPrefix: boolean }[] = [
	{ re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, keepPrefix: false },
	{ re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, keepPrefix: false },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, keepPrefix: false },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g, keepPrefix: false },
	{ re: /\bAKIA[0-9A-Z]{16}\b/g, keepPrefix: false },
	{ re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, keepPrefix: false },
	{ re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, keepPrefix: false },
	{ re: /\bbearer\s+[A-Za-z0-9._-]{20,}/gi, keepPrefix: false },
	{
		re: /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-./+]{12,})/gi,
		keepPrefix: true,
	},
];

/** Replace anything that looks like a credential with `[redacted]`. */
export function redactE20(text: string): string {
	let out = text;
	for (const { re, keepPrefix } of E20_SECRET_PATTERNS) {
		out = out.replace(re, (_m: string, prefix: string) => (keepPrefix ? `${prefix}[redacted]` : "[redacted]"));
	}
	return out;
}

/** Redact, then cap at `cap` characters (`common.py::bound`). */
export function boundE20(text: string | null, cap: number): string | null {
	if (text === null) return null;
	const red = redactE20(text);
	return red.length > cap ? `${red.slice(0, cap - 20)} …[truncated]` : red;
}

/** Python `json.dumps(value, ensure_ascii=False)` rendered only until `limit`
 *  characters exist. Every string is cut to `limit` before escaping, so the
 *  first `limit` characters equal the full render's (a 1 MB Write payload is
 *  never serialized just to keep its first 200 characters). */
export function pyDumpsHead(value: unknown, limit: number): string {
	const parts: string[] = [];
	let size = 0;
	const push = (s: string): boolean => {
		parts.push(s);
		size += s.length;
		return size < limit;
	};
	const walk = (v: unknown): boolean => {
		if (v === null || v === undefined) return push("null");
		if (typeof v === "string") return push(JSON.stringify(v.slice(0, limit)));
		if (typeof v === "number" || typeof v === "boolean") return push(String(v));
		if (Array.isArray(v)) return walkList(v.map((item) => [null, item] as const), "[", "]");
		if (typeof v === "object") return walkList(Object.entries(v), "{", "}");
		return push(JSON.stringify(String(v)));
	};
	const walkList = (entries: readonly (readonly [string | null, unknown])[], open: string, close: string): boolean => {
		if (!push(open)) return false;
		for (const [i, [key, item]] of entries.entries()) {
			if (i > 0 && !push(", ")) return false;
			if (key !== null && !push(`${JSON.stringify(key.slice(0, limit))}: `)) return false;
			if (!walk(item)) return false;
		}
		return push(close);
	};
	walk(value);
	return parts.join("");
}

/** `build_pools.py::cmd_of`: the shell command, or the tool input as JSON. */
export function commandOf(toolInput: unknown, limit = 1_000_000): string {
	if (typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)) {
		const command: unknown = Reflect.get(toolInput, "command");
		if (Array.isArray(command)) return command.map(String).join(" ");
		if (typeof command === "string") return command;
		if (command !== undefined && command !== null) return String(command);
		return pyDumpsHead(toolInput, limit);
	}
	return typeof toolInput === "string" ? toolInput : pyDumpsHead(toolInput, limit);
}

// ─── E19: mask + maskedContext (scan.mts) ──────────────────────────────────

/** Characters of masked context kept on each side of the highlighted match. */
export const SECRET_CONTEXT_CHARS = 150;
/** Extra raw characters scanned around the window so a neighbour cut by the
 *  window edge is still recognised (and masked) whole. */
const SECRET_WINDOW_MARGIN = 400;

const SECRET_PATS: { rule: string; re: RegExp }[] = SECRETS_RULES.flatMap((r) =>
	r.patterns.map((p) => ({ rule: r.id, re: new RegExp(p.source, p.flags.includes("g") ? p.flags : `${p.flags}g`) })),
);
/** Long high-entropy tokens (key bodies, neighbouring secrets). `=` only as
 *  trailing padding, so `KEY_NAME=value` keeps its readable key name. */
const LONG_TOKEN = /[A-Za-z0-9+/_-]{24,}={0,2}/g;

/** First 4 and last 2 characters kept, the middle replaced by `…`. */
export function maskToken(s: string): string {
	if (s.length <= 8) return `${s.slice(0, 2)}…`;
	return `${s.slice(0, 4)}…${s.slice(-2)}`;
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
	if (!s) return 0;
	const counts = new Map<string, number>();
	for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let h = 0;
	for (const c of counts.values()) {
		const p = c / s.length;
		h -= p * Math.log2(p);
	}
	return h;
}

type Span = [number, number];

function maskSpans(win: string, target: Span): Span[] {
	const spans: Span[] = [];
	for (const p of SECRET_PATS) {
		for (const m of win.matchAll(p.re)) spans.push([m.index, m.index + m[0].length]);
	}
	for (const m of win.matchAll(LONG_TOKEN)) {
		const t = m[0];
		if (/[0-9]/.test(t) && /[A-Za-z]/.test(t) && shannonEntropy(t) >= 3.5) spans.push([m.index, m.index + t.length]);
	}
	spans.push(target);
	spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	const merged: Span[] = [];
	for (const s of spans) {
		const last = merged[merged.length - 1];
		if (last && s[0] < last[1]) last[1] = Math.max(last[1], s[1]);
		else merged.push([s[0], s[1]]);
	}
	return merged;
}

/**
 * The E19 `masked_context` for the match at [start, end) of `text`, plus the
 * hook-path hardening (`maskCredentialAssignments`) applied to each side
 * BEFORE the ±150 cut. Hardening only the cut lost every key the cut removed
 * (`…SWORD=Sup3rS3cretValue9x` left the value raw; U1s audit, 48 of 142
 * sweep variants). A window edge that splits a line masks that line too.
 * With no credential in the window the output equals the E19 render.
 */
export function maskedSecretContext(text: string, start: number, end: number): string {
	const w0 = Math.max(0, start - SECRET_CONTEXT_CHARS - SECRET_WINDOW_MARGIN);
	const w1 = Math.min(text.length, end + SECRET_CONTEXT_CHARS + SECRET_WINDOW_MARGIN);
	const win = text.slice(w0, w1);
	const target: Span = [start - w0, end - w0];
	let out = "";
	let cur = 0;
	let tStart = 0;
	let tEnd = 0;
	for (const [a, b] of maskSpans(win, target)) {
		out += win.slice(cur, a);
		const isTarget = a <= target[0] && b >= target[1];
		if (isTarget) tStart = out.length;
		out += isTarget ? `⟦${maskToken(win.slice(a, b))}⟧` : maskToken(win.slice(a, b));
		if (isTarget) tEnd = out.length;
		cur = b;
	}
	out += win.slice(cur);
	const head = maskCredentialAssignments(w0 > 0 ? maskLeadingFragment(out.slice(0, tStart)) : out.slice(0, tStart));
	const tail = maskCredentialAssignments(w1 < text.length ? maskTrailingFragment(out.slice(tEnd)) : out.slice(tEnd));
	const cut = `${head.slice(Math.max(0, head.length - SECRET_CONTEXT_CHARS))}${out.slice(tStart, tEnd)}${tail.slice(0, SECRET_CONTEXT_CHARS)}`;
	return maskSecretResidue(cut.replace(/\s+/g, " "));
}

/** Masking can splice pieces into a new rule match; mask any match that still
 *  carries no ellipsis (raw text only) until none remains (`remaskResidue`). */
export function maskSecretResidue(s: string): string {
	let out = s;
	for (let round = 0; round < 4; round++) {
		let changed = false;
		for (const p of SECRET_PATS) {
			out = out.replace(p.re, (m) => {
				if (m.includes("…") || m.includes("⟦")) return m;
				changed = true;
				return maskToken(m);
			});
		}
		if (!changed) return out;
	}
	return out;
}

/** Signature matches in `s` that carry no mask marker (raw text). */
export function residualSecretMatches(s: string): number {
	let n = 0;
	for (const p of SECRET_PATS) {
		for (const m of s.matchAll(p.re)) if (!m[0].includes("…") && !m[0].includes("⟦")) n++;
	}
	return n;
}

// ─── Hook-path hardening (U1 review 2026-10-09; U1s audit) ──────────────────
//
// The ±150-char E19 context around a signature hit carries the NEIGHBOURING
// credentials. E19 masked only signature matches and ≥24-char high-entropy
// tokens, so short passwords, URL passwords, header and CLI-flag credentials
// reached the request body raw (U1s audit: 65 of 83 adversarial fixtures,
// scratch/2026-10-08-decisions-orthogonal/u1-audit/). Each pattern below closes
// one leak class. Over-masking (`max_tokens: 4096`) is accepted: the shadow is
// a measurement, a leak is an exfiltration. The live state is therefore MORE
// masked than the E19 cohort was.

/** A value shorter than this keeps no character: maskToken keeps 4+2, i.e.
 *  two thirds of a 9-character password. */
const SHORT_VALUE_CHARS = 12;
const MAX_VALUE_CHARS = 4096;
/** A line cut by the raw window edge is masked whole when it is this short. */
const EDGE_LINE_CHARS = 160;
/** Characters after a credential NAME within which its `value` key is masked. */
const PAIR_REACH = 240;
/** Key names whose assigned value is a credential whatever its shape. */
const CREDENTIAL_KEY = /pass(?:word|wd|phrase)?|pwd|(?:^|[_.-])pw(?:$|[_.-])|secret|token|api[_.-]?key|private[_.-]?key|auth|cred(?:ential)?s?|cookie|session[_.-]?id|bearer/i;
/** `ENCRYPTION_KEY`, `tls.key`, `signingKey`, `APIKEY`, `AWS_ACCESS_KEY_ID`; not `monkey`. */
const KEY_SUFFIX = /(?:[_.-](?:key|Key|KEY)|[a-z0-9]Key|[A-Z0-9]KEY)(?:[_.-]?(?:id|Id|ID))?$/;
/** The two halves of a name/value pair (`- name: DB_PASSWORD` / `value: …`). */
const NAME_KEY = /^(?:name|key|parameter(?:name|key)?|variable|id)$/i;
const VALUE_KEY = /^(?:value|parametervalue|secretvalue|val)$/i;
/** A key and its separator only. The value is parsed on its own, so a value
 *  never swallows the next key (`env: API_TOKEN: x`, `YWRtaW4= password: x`). */
const KEY_SEP = /(\\?["']?)([A-Za-z_][A-Za-z0-9_.-]{0,63})\1?[ \t]*(?:=>|:=|\?=|\+=|=|:)[ \t]*/g;
const QUOTES = new Set(['\\"', "\\'", '"', "'", "`"]);
const AUTH_SCHEME = /^(?:basic|bearer|token|digest|negotiate|ntlm|apikey|ssws)$/i;
/** YAML block scalar, heredoc or triple-quote opener. */
const BLOCK_OPENER = /^(?:[|>][-+]?|<<-?["']?[A-Za-z_]+["']?|"""|''')(?=\s|$)/;
const NEXT_YAML_KEY = /\s(?:-\s|[A-Za-z_][\w.-]*:(?=\s|$))/;
const MASK_SHAPED = /^[^\s…⟦⟧]{0,4}…[^\s…⟦⟧]{0,2}$/;
const PLACEHOLDER = /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{[^{}]*\}\}|<[^<>]*>|true|false|null|none|nil|yes|no)$/i;
/** `-u user:pass`, `--user 'user:pass'` (curl, wget, httpie). */
const CLI_USER_PASS = /(?:^|\s)(?:-u|--user|-a|--auth)(?:[ \t]+|=)(["']?)[^\s:"'@]{1,64}:/g;
/** `--password x`, `--api-token x`: a flag and a separate value. */
const CLI_FLAG = /(?:^|\s)--?([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*)[ \t]+(?=[^\s-])/g;
/** Password arguments without a credential-named spelling: mysql `-pX`,
 *  `docker login -p X`, `sshpass -p X`, `htpasswd -b f user X`, `net use /user:u X`,
 *  `.netrc`, pgpass `host:port:db:user:X`, prose `password is X` (digit or symbol). */
const UNNAMED_VALUE = new RegExp(
	[
		String.raw`\b(?:mysql(?:dump|admin)?|mariadb)\b[^\n]*?\s-p(?=\S)`,
		String.raw`\b(?:docker|podman|nerdctl|helm|oras)\s+(?:registry\s+)?login\b[^\n]*?\s-p[ \t]+`,
		String.raw`\bsshpass\s+-p[ \t]*`,
		String.raw`\bhtpasswd\s+-\w*b\w*\s+\S+\s+\S+\s+`,
		String.raw`\bnet\s+use\b[^\n]*?\/user:\S+\s+`,
		String.raw`\bmachine\s+\S+(?:\s+login\s+\S+)?\s+password\s+`,
		String.raw`(?:^|\s)[^\s:]+:(?:\d{1,5}|\*):[^\s:]+:[^\s:]+:(?=\S)`,
		String.raw`\b(?:password|passwd|passphrase|pwd|pw|passcode|secret)\s+(?:is|was)\s+(?=["']?[^\s"']*[0-9!@#$%^&*])`,
	].join("|"),
	"gi",
);
/** A credential name, then a value without a separator: a `vault kv get` / table
 *  row (two or more spaces) or a legacy Dockerfile `ENV KEY value`. */
const NAMED_SPACED = /(?:^|\n)[ \t]*([A-Za-z_][\w.-]*)[ \t]{2,}(?=\S)|\bENV[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+(?=[^\s=])/g;
const XML_ELEMENT = /<([A-Za-z_][\w.-]*)>([^<]{1,512})<\/\1>/g;
/** Temporary and role AWS key ids (the signature table covers AKIA only). */
const AWS_KEY_ID = /\b(?:ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|APKA|ABIA|ACCA)[0-9A-Z]{16}\b/g;
/** The short last body line of a PEM key (full lines are ≥24-char tokens). */
const PEM_TAIL = /[A-Za-z0-9+\/]{4,}={0,2}(?=(?:\s|\\n)*-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)/g;
/** `scheme://user:PASSWORD@` for any scheme, or `scheme://TOKEN@` (letters and digits, ≥16). */
const URL_USERINFO = /\b[A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/(?:[^\s:@\/?#"'<>]{0,128}:([^\s@\/?#"'<>]{1,256})|([A-Za-z0-9._~%-]{16,256}))@/g;
const EDGE_RUN_START = /^[^\s,;"'{}[\]()<>]+/;
const EDGE_RUN_END = /[^\s,;"'{}[\]()<>]+$/;

function isCredentialName(name: string): boolean {
	return CREDENTIAL_KEY.test(name) || KEY_SUFFIX.test(name);
}

/** A raw value of four or more characters that is not a mask, the target or a placeholder. */
function needsMask(v: string): boolean {
	return v.length >= 4 && !v.includes("⟦") && !v.includes("⟧") && !MASK_SHAPED.test(v) && !PLACEHOLDER.test(v);
}

/** Nothing kept under SHORT_VALUE_CHARS, across whitespace, or across a `&` / `;`
 *  joint (`password=Jdbc!Pw9&useSSL=true` would keep the password's first 4);
 *  else first 4 + last 2. */
function maskValue(v: string): string {
	const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(v);
	const core = m?.[2] ?? v;
	if (!needsMask(core)) return v;
	const masked = core.length < SHORT_VALUE_CHARS || /[\s&;]/.test(core) ? "…" : maskToken(core);
	return `${m?.[1] ?? ""}${masked}${m?.[3] ?? ""}`;
}

/** [start, end) of a quoted body that starts at `p`; unclosed ⇒ end of line. */
function quotedSpan(s: string, p: number, close: string): Span {
	const lim = Math.min(s.length, p + MAX_VALUE_CHARS);
	const end = s.indexOf(close, p);
	if (end >= 0 && end <= lim) return [p, end];
	const nl = s.indexOf("\n", p);
	return [p, nl >= 0 && nl < lim ? nl : lim];
}

/** [start, end) of a block value after its opener: to the heredoc / triple-quote
 *  closer, or for YAML `|` / `>` to the next `key:` or list item. */
function blockSpan(s: string, p: number, opener: string): Span {
	const lim = Math.min(s.length, p + MAX_VALUE_CHARS);
	const closer = opener.startsWith("<<") ? opener.replace(/^<<-?["']?|["']$/g, "") : opener.length === 3 ? opener : "";
	if (closer) {
		const end = s.indexOf(closer, p);
		return [p, end >= 0 && end < lim ? end : lim];
	}
	const next = NEXT_YAML_KEY.exec(s.slice(p, lim));
	return [p, next ? p + next.index : lim];
}

/** [start, end) of the value that starts at `p`. After an auth scheme word
 *  (`Basic`, `Bearer`, `token`) the value is the credential that follows it. */
function valueSpan(s: string, p: number): Span | null {
	const head = s.slice(p, p + MAX_VALUE_CHARS);
	const block = BLOCK_OPENER.exec(head);
	if (block) return blockSpan(s, p + block[0].length, block[0]);
	const q = head.startsWith("\\") ? head.slice(0, 2) : head.slice(0, 1);
	if (QUOTES.has(q)) return quotedSpan(s, p + q.length, q);
	const run = /^[^\s"'`]+/.exec(head)?.[0];
	if (!run) return null;
	const next = AUTH_SCHEME.test(run) ? /^[ \t]+([^\s"'`]+)/.exec(head.slice(run.length)) : null;
	if (!next) return [p, p + run.length];
	const end = p + run.length + next[0].length;
	return [end - (next[1] ?? "").length, end];
}

/** Values of credential-named keys, and of a `value` key that follows a credential name. */
function keyedValueSpans(s: string): Span[] {
	const spans: Span[] = [];
	let pairUntil = -1;
	for (const m of s.matchAll(KEY_SEP)) {
		const key = m[2] ?? "";
		const at = m.index + m[0].length;
		const span = valueSpan(s, at);
		const value = span ? s.slice(span[0], span[1]).trim() : "";
		if (isCredentialName(key) || (VALUE_KEY.test(key) && m.index <= pairUntil)) {
			if (span) spans.push(span);
			pairUntil = value === "" || value.startsWith("{") ? at + PAIR_REACH : -1;
		} else if (NAME_KEY.test(key)) {
			pairUntil = isCredentialName(value) ? at + PAIR_REACH : -1;
		}
	}
	return spans;
}

/** CLI credentials, unnamed password arguments and separator-less rows. */
function argumentSpans(s: string): Span[] {
	const spans: Span[] = [];
	const push = (span: Span | null): void => {
		if (span) spans.push(span);
	};
	for (const m of s.matchAll(CLI_USER_PASS)) {
		const at = m.index + m[0].length;
		push(m[1] ? quotedSpan(s, at, m[1]) : valueSpan(s, at));
	}
	for (const m of s.matchAll(CLI_FLAG)) if (isCredentialName(m[1] ?? "")) push(valueSpan(s, m.index + m[0].length));
	for (const m of s.matchAll(UNNAMED_VALUE)) push(valueSpan(s, m.index + m[0].length));
	for (const m of s.matchAll(NAMED_SPACED)) if (isCredentialName(m[1] ?? m[2] ?? "")) push(valueSpan(s, m.index + m[0].length));
	return spans;
}

/** Credentials recognised by shape: AWS key ids, PEM tails, URL userinfo, XML elements. */
function shapeSpans(s: string): Span[] {
	const spans: Span[] = [];
	for (const re of [AWS_KEY_ID, PEM_TAIL]) for (const m of s.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
	for (const m of s.matchAll(URL_USERINFO)) {
		const secret = m[1] ?? m[2] ?? "";
		const end = m.index + m[0].length - 1;
		if (m[1] !== undefined || (/[0-9]/.test(secret) && /[A-Za-z]/.test(secret))) spans.push([end - secret.length, end]);
	}
	for (const m of s.matchAll(XML_ELEMENT)) {
		const at = m.index + (m[1] ?? "").length + 2;
		if (isCredentialName(m[1] ?? "")) spans.push([at, at + (m[2] ?? "").length]);
	}
	return spans;
}

/** Replace each span with its mask. A span inside a masked span is skipped;
 *  a span left unmasked (placeholder, mask, target) lets nested spans decide. */
function applySpans(s: string, spans: Span[]): string {
	spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	let out = "";
	let cur = 0;
	for (const [a, b] of spans) {
		const start = Math.max(a, cur);
		if (start >= b) continue;
		const raw = s.slice(start, b);
		const masked = maskValue(raw);
		if (masked === raw) continue;
		out += s.slice(cur, start) + masked;
		cur = b;
	}
	return out + s.slice(cur);
}

/** The line (or run) a raw window edge cut through has lost its key: mask it. */
function maskLeadingFragment(s: string): string {
	const nl = s.indexOf("\n");
	const len = nl >= 0 && nl <= EDGE_LINE_CHARS ? nl : (EDGE_RUN_START.exec(s)?.[0].length ?? 0);
	return needsMask(s.slice(0, len).trim()) ? `…${s.slice(len)}` : s;
}

function maskTrailingFragment(s: string): string {
	const nl = s.lastIndexOf("\n");
	const len = nl >= 0 && s.length - nl <= EDGE_LINE_CHARS ? s.length - nl - 1 : (EDGE_RUN_END.exec(s)?.[0].length ?? 0);
	return needsMask(s.slice(s.length - len).trim()) ? `${s.slice(0, s.length - len)}…` : s;
}

/**
 * Hook-path hardening beyond the E19 render: mask every credential in `s`
 * that no signature and no ≥24-char token rule covers — credential-named
 * assignments (quoted, escaped, block and heredoc values; name/value pairs),
 * URL userinfo, auth-header and CLI-flag credentials, separator-less rows,
 * AWS key ids, PEM tails and XML elements. Values under 12 characters keep no
 * character. Masks, the ⟦target⟧, placeholders and booleans are left alone.
 */
export function maskCredentialAssignments(s: string): string {
	return applySpans(s, [...keyedValueSpans(s), ...argumentSpans(s), ...shapeSpans(s)]);
}

/** The match `scanForSignatures` reported for `ruleId`: first pattern in rule
 *  order, first occurrence. Null for an unknown rule or no match. */
export function firstSecretMatch(text: string, ruleId: string): { start: number; end: number; raw: string } | null {
	const rule = SECRETS_RULES.find((r) => r.id === ruleId);
	if (!rule) return null;
	for (const pattern of rule.patterns) {
		const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
		const m = re.exec(text);
		if (m) return { start: m.index, end: m.index + m[0].length, raw: m[0] };
	}
	return null;
}
