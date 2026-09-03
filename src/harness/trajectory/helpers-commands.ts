// ===========================================
// Deterministic Trajectory-Analysis Engine — Bash command-shape parsers
// ===========================================
//
// Pure parsers for the security-family legs (download/exec, harness-disable,
// git-hook triggers, DNS lookups, authorized_keys writes, guarded ops). Split
// out of helpers.ts to keep both files under the per-file line cap. No IO, no
// network, no Date.now.

import {
	hasEgressVerb,
	isEgressCommandToExternalHost,
	isExternalHost,
	splitSegments,
} from "./helpers.js";

const SCRIPT_EXT = /\.(?:sh|bash|zsh|py|rb|pl|php|ps1|js|mjs|cjs|ts)$/i;

// ===========================================
// Download → execute
// ===========================================

/** A remote download leg parsed from a curl/wget invocation. */
export interface RemoteDownload {
	/** Local path the artifact was saved to, or null (e.g. `-O` / piped). */
	localPath: string | null;
	host: string;
	urlPath: string;
	/** Whether the URL or local path looked like an executable script. */
	isScript: boolean;
}

/** Parse one segment for an external-host curl/wget download, or null if it isn't one. */
function parseRemoteDownloadSegment(seg: string): RemoteDownload | null {
	if (!/\b(?:curl|wget)\b/i.test(seg)) return null;
	const urlM = /\bhttps?:\/\/([^/\s'"]+)(\/[^\s'"]*)?/i.exec(seg);
	if (!urlM || !urlM[1]) return null;
	const host = urlM[1];
	const urlPath = urlM[2] ?? "";
	if (!isExternalHost(host)) return null;
	let localPath: string | null = null;
	const oM =
		/\s-o\s+([^\s|;&'"]+)/.exec(seg) ?? /\s--output[=\s]+([^\s|;&'"]+)/.exec(seg);
	if (oM?.[1]) localPath = oM[1];
	const redirM = /\s>\s*([^\s|;&'"]+)/.exec(seg);
	if (!localPath && redirM?.[1]) localPath = redirM[1];
	if (!localPath && /\s-O\b/.test(seg)) {
		const base = urlPath.split("/").pop();
		if (base) localPath = base;
	}
	const isScript = SCRIPT_EXT.test(urlPath) || (localPath != null && SCRIPT_EXT.test(localPath));
	return { localPath, host, urlPath, isScript };
}

/** Parse external-host curl/wget downloads (to a local path) out of a command. */
export function parseRemoteScriptDownloads(cmd: string): RemoteDownload[] {
	const out: RemoteDownload[] = [];
	for (const seg of splitSegments(cmd)) {
		const parsed = parseRemoteDownloadSegment(seg);
		if (parsed) out.push(parsed);
	}
	return out;
}

/** Match an execution of a concrete path (`bash /p`, `python ./p`, `/p`, `./p`). */
export function extractExecutedPath(cmd: string): string | null {
	const m1 = /\b(?:bash|sh|zsh|python3?|node|ruby|perl|php)\s+(\.?\/[^\s|;&]+)/i.exec(cmd);
	if (m1?.[1]) return m1[1];
	const m2 = /(?:^|[;|&])\s*((?:\.\/|\/)[^\s|;&]+)/.exec(cmd);
	if (m2?.[1]) return m2[1];
	return null;
}

/** Detect an inline `curl|wget <external-url> | bash/sh/python` fetch-and-run. */
export function inlineFetchExec(cmd: string): { host: string } | null {
	if (
		!/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh|python3?|node|ruby|perl|php)\b/i.test(
			cmd,
		)
	) {
		return null;
	}
	const urlM = /\bhttps?:\/\/([^/\s'"]+)/i.exec(cmd);
	const host = urlM?.[1] ?? "";
	if (!isExternalHost(host)) return null;
	return { host };
}

// ===========================================
// Exec / egress sink (git-hook + lifecycle backdoor bodies)
// ===========================================

/** True iff a written file body contains an exec / egress / reverse-shell sink. */
export function hasExecOrEgressSink(content: string): boolean {
	if (hasEgressVerb(content)) return true;
	if (/\bcurl\b|\bwget\b|\bnc\b|\bncat\b/.test(content)) return true;
	if (/\/dev\/tcp\//.test(content)) return true;
	if (/\b(?:bash|sh|zsh)\s+-c\b/.test(content)) return true;
	if (/\beval\b/.test(content) && /base64\s+-d|atob\(|fromCharCode|\\x[0-9a-f]{2}/i.test(content)) {
		return true;
	}
	if (/\bnode\s+-e\b/.test(content) && /require\(['"](?:http|https|net|child_process)['"]\)|\bfetch\(/.test(content)) {
		return true;
	}
	if (/\bpython3?\s+-c\b/.test(content) && /socket|urllib|requests|subprocess|os\.system/.test(content)) {
		return true;
	}
	return false;
}

// ===========================================
// Harness self-blinding
// ===========================================

/**
 * Detect a non-sanctioned harness-disable Bash command (rm/unlink the socket,
 * kill the daemon). Returns null for the documented `INTERLINKED_DISABLE_*`
 * bypass and the blessed `interlinked harness stop|restart|clean|status|start`
 * subcommands (deliberate, sanctioned operations).
 */
export function parseHarnessDisable(cmd: string): { how: string } | null {
	if (/\bINTERLINKED_DISABLE_\w+/.test(cmd)) return null;
	if (/\binterlinked\s+harness\s+(?:stop|restart|clean|status|start)\b/i.test(cmd)) return null;
	if (/\b(?:rm|unlink)\b[^\n;|&]*harness\.sock/.test(cmd)) return { how: "removed harness socket" };
	if (/\b(?:kill|pkill|killall)\b[^\n;|&]*(?:interlinked|harness)/i.test(cmd)) {
		return { how: "killed harness process" };
	}
	return null;
}

/** Detect an edit to a guard-rules config that grows the `disabled_rules` list. */
export function editAddsDisabledRule(oldStr: string, newStr: string): boolean {
	if (!/disabled_rules/.test(newStr)) return false;
	const quoted = (s: string) => (s.match(/"[^"]+"/g) ?? []).length;
	return !/disabled_rules/.test(oldStr) || quoted(newStr) > quoted(oldStr);
}

// ===========================================
// Git hook triggers + commit/add
// ===========================================

/** The hook a git verb in the command would trigger, or null. */
export function triggersGitHook(cmd: string): string | null {
	for (const seg of splitSegments(cmd)) {
		if (!/\bgit\b/.test(seg)) continue;
		if (/\bgit\s+commit\b/.test(seg)) return "pre-commit";
		if (/\bgit\s+push\b/.test(seg)) return "pre-push";
		if (/\bgit\s+merge\b/.test(seg)) return "post-merge";
		if (/\bgit\s+(?:checkout|switch)\b/.test(seg)) return "post-checkout";
		if (/\bgit\s+rebase\b/.test(seg)) return "pre-rebase";
		if (/\bgit\s+am\b/.test(seg)) return "applypatch-msg";
	}
	return null;
}

/** True iff the command stages or commits via git. */
export function isGitAddOrCommit(cmd: string): boolean {
	return /\bgit\s+(?:add|commit)\b/.test(cmd);
}

/** Whitespace-split a command segment into tokens, treating single/double-quoted
 *  runs as one token (quotes stripped) so a quoted `-m` message stays one arg. */
function tokenizeArgs(seg: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m = re.exec(seg);
	while (m !== null) {
		out.push(m[1] ?? m[2] ?? m[3] ?? "");
		m = re.exec(seg);
	}
	return out;
}

/** Positional PATH args of a `git add`/`git commit` segment — the git verb,
 *  flags, and the `-m`/`-F`/`--message`/`--file` VALUE are dropped, so a filename
 *  that appears only inside a commit message is never treated as a staged path. */
function gitPathArgs(seg: string): string[] {
	const tokens = tokenizeArgs(seg);
	const start = tokens.indexOf("git");
	const out: string[] = [];
	for (let i = start >= 0 ? start + 2 : 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!t || t === "--") continue;
		if (t === "-m" || t === "--message" || t === "-F" || t === "--file") {
			i++; // drop the flag's value too
			continue;
		}
		if (t.startsWith("-")) continue; // any other flag (incl. -a, -am, --amend)
		out.push(t);
	}
	return out;
}

/** True iff a git add/commit SEGMENT names `filePath` as a positional path arg,
 *  matched by exact-path or basename equality (so `.env` does NOT match `.env.example`). */
function segStagesNamedPath(seg: string, filePath: string, base: string): boolean {
	if (!/\bgit\s+(?:add|commit)\b/.test(seg)) return false;
	return gitPathArgs(seg).some((arg) => arg === filePath || (arg.split("/").pop() ?? arg) === base);
}

/** True iff a `git add`/`commit` segment stages the WHOLE worktree/index:
 *  `commit -a`/`-am` (a single-dash flag containing `a`) or `add .`/`-A`/`--all`.
 *  Token-based (no nested-quantifier regex; a flag inside a quoted `-m` message is
 *  one token and never counts). */
function segStagesEverything(seg: string): boolean {
	const isCommit = /\bgit\s+commit\b/.test(seg);
	const isAdd = /\bgit\s+add\b/.test(seg);
	for (const t of tokenizeArgs(seg)) {
		if (isCommit && t.startsWith("-") && !t.startsWith("--") && t.includes("a")) return true;
		if (isAdd && (t === "." || t === "-A" || t === "--all")) return true;
	}
	return false;
}

/** True iff a git add/commit would include `filePath` (named, `add .`/`-A`, or `commit -a`). */
export function commitReferencesPath(cmd: string, filePath: string): boolean {
	const base = filePath.split("/").pop() ?? filePath;
	return splitSegments(cmd).some(
		(seg) => segStagesEverything(seg) || segStagesNamedPath(seg, filePath, base),
	);
}

// ===========================================
// Churn / reset disruptors
// ===========================================

const INSTALL_RE =
	/\b(?:npm|pnpm|yarn|bun|pip|pip3|pipx|poetry|uv|cargo|gem|bundle|go|brew|apt|apt-get)\b\s+(?:install|add|get)\b/i;
const GIT_RESET_RE = /\bgit\s+(?:checkout|switch|stash|reset|restore|pull|merge|rebase|clean)\b/i;
const ENV_SET_RE = /\bexport\s+\w+=|\bsource\s+\S|\.\s+\S+\.(?:sh|bash|zsh|env)\b/;

/** Install / git-checkout / env-set — events that legitimately reset churn loops. */
export function isDisruptCommand(cmd: string): boolean {
	return INSTALL_RE.test(cmd) || GIT_RESET_RE.test(cmd) || ENV_SET_RE.test(cmd);
}

// ===========================================
// DNS exfil
// ===========================================

/** Parse a dig/nslookup/host/drill lookup's leftmost label + base domain. */
export function parseDnsQuery(cmd: string): { baseDomain: string; label: string } | null {
	for (const seg of splitSegments(cmd)) {
		const m =
			/\b(?:dig|nslookup|host|drill)\s+(?:@\S+\s+)?(?:[+-]\S+\s+)*([a-zA-Z0-9][a-zA-Z0-9.-]+)/.exec(
				seg,
			);
		if (!m?.[1]) continue;
		const fqdn = m[1].replace(/\.$/, "");
		const parts = fqdn.split(".");
		if (parts.length < 2) continue;
		return { label: parts[0] ?? "", baseDomain: parts.slice(1).join(".") };
	}
	return null;
}

/**
 * High-entropy DNS label: ≥20 chars, ≥12 distinct chars, and NOT pure fixed-
 * length hex (the latter suppresses hashed-host / CDN cache-key lookups per the
 * catalog's "hex fixed-length suppression").
 */
export function isHighEntropyLabel(label: string): boolean {
	if (label.length < 20) return false;
	if (/^[0-9a-f]+$/i.test(label)) return false;
	return new Set(label).size >= 12;
}

// ===========================================
// Secret reads + ssh keys + env/config + guarded ops
// ===========================================

const READ_VERBS_RE = /\b(?:cat|less|more|head|tail|grep|rg|strings|xxd|base64|od)\b/;

/** True iff the command reads a credential path or dumps the environment. */
export function commandReadsSecretPath(cmd: string): boolean {
	if (/\b(?:env|printenv)\b/.test(cmd)) return true;
	if (!READ_VERBS_RE.test(cmd)) return false;
	return /(?:^|\s|\/)\.env(?:\.[\w.-]+)?(?:\s|$)|\.ssh\/id_(?:rsa|ed25519|ecdsa)|\.aws\/credentials|\.pgpass|\.netrc|secrets?\.(?:json|ya?ml|env)/i.test(
		cmd,
	);
}

/** True iff content holds an OpenSSH public key line. */
export function containsSshPublicKey(content: string): boolean {
	return (
		/\bssh-(?:rsa|ed25519|ecdsa)\s+AAAA[0-9A-Za-z+/]/.test(content) ||
		/\becdsa-sha2-nistp\d+\s+AAAA[0-9A-Za-z+/]/.test(content)
	);
}

const HOME_PREFIX = /^(?:~\/|\$\{?HOME\}?\/|\/home\/[^/]+\/|\/Users\/[^/]+\/|\/root\/)/;
const FIXTURE_MARK =
	/(?:^|\/)(?:tmp|fixtures?|__tests__|testdata|node_modules|dist|build)(?:\/|$)/i;

/**
 * Home-confined `~/.ssh/authorized_keys` path. Excludes project / tmp / fixture
 * / CI-bootstrap paths (the catalog's "real-$HOME-only confinement"), decided
 * purely from path shape — no process.env read in rule logic.
 */
export function isAuthorizedKeysPath(filePath: string): boolean {
	if (!/\.ssh\/authorized_keys2?$/.test(filePath)) return false;
	if (FIXTURE_MARK.test(filePath)) return false;
	return HOME_PREFIX.test(filePath);
}

/** Parse a Bash append/tee into a home-confined authorized_keys file. */
export function commandAppendsAuthorizedKeys(cmd: string): { path: string } | null {
	const m = /(?:>>?|tee\s+(?:-a\s+)?)\s*([^\s|;&'"]*\.ssh\/authorized_keys2?)/.exec(cmd);
	const path = m?.[1];
	if (path && isAuthorizedKeysPath(path)) return { path };
	return null;
}

/** True iff `filePath` is a tracked env/config file where a committed secret matters. */
export function isEnvConfigFile(filePath: string): boolean {
	return (
		/(?:^|\/)\.env(?:\.[\w.-]+)?$/i.test(filePath) ||
		/(?:^|\/)\.(?:npmrc|netrc|pgpass)$/i.test(filePath) ||
		/\.(?:env|ini|cfg|conf|properties|toml)$/i.test(filePath) ||
		/(?:^|\/)config\.(?:json|ya?ml|js|ts)$/i.test(filePath)
	);
}

const DESTRUCTIVE_RE =
	/\brm\s+-[a-z]*r[a-z]*f?\b|\bgit\s+push\b[^\n;|&]*--force|\bgit\s+reset\s+--hard\b|\bdd\b/i;

/** A sensitive op the harness would normally evaluate (egress / destructive / git / secret read). */
export function isGuardedOp(cmd: string): boolean {
	return (
		isEgressCommandToExternalHost(cmd) ||
		DESTRUCTIVE_RE.test(cmd) ||
		isGitAddOrCommit(cmd) ||
		/\bgit\s+push\b/.test(cmd) ||
		commandReadsSecretPath(cmd)
	);
}
