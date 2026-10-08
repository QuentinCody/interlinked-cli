// ===========================================
// Public fetch stages — curl / wget / yt-dlp reading the public internet
// ===========================================
// A secret-shaped value in content fetched from a PUBLIC, UNAUTHENTICATED
// URL is not a confidential leak: the bytes are already public. This module
// decides whether one shell stage is such a fetch, and which files it wrote.
//
// Fail-safe for the taint gate: anything it does not model (authentication,
// cookies, config files, server-chosen names, recursion, resume, variable
// URLs, private hosts, scheme-less positionals) makes the stage NOT a public
// fetch, so the caller keeps ratcheting as before.

import { posix } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { classifyHost } from "../host-class.js";
import { isOutboundNetworkCommand } from "../taint-tracker.js";
import { commandHead, hasUnresolvedVar } from "./bash-stage-parse.js";

type Role = "out" | "outdir" | "url" | "header" | "unsafe" | "unmodeled" | "remote" | "remoteAll" | "value";

interface ToolSpec {
	/** Short flags that take a value (the rest of the cluster, or the next token). */
	shortValue: string;
	/** Long flags that take a value. */
	longValue: ReadonlySet<string>;
	roles: Readonly<Record<string, Role>>;
	/** Tool-specific multi-letter single-dash flags (wget `-nc`). */
	words?: ReadonlySet<string>;
}

const CURL: ToolSpec = {
	shortValue: "AbcCdDeEFHKmoPQrtTuUwxXyYz",
	longValue: new Set([
		"--output", "--output-dir", "--header", "--user", "--cookie", "--cookie-jar", "--data", "--data-raw", "--data-binary",
		"--data-urlencode", "--form", "--url", "--request", "--user-agent", "--referer", "--max-time", "--connect-timeout",
		"--retry", "--config", "--cert", "--key", "--proxy", "--oauth2-bearer", "--netrc-file", "--aws-sigv4", "--proxy-user",
		"--range", "--upload-file", "--write-out", "--continue-at", "--dump-header", "--limit-rate", "--resolve", "--connect-to",
		"--cacert", "--capath", "--json", "--data-ascii", "--form-string", "--unix-socket", "--abstract-unix-socket",
	]),
	roles: {
		"-o": "out", "--output": "out", "--output-dir": "outdir", "--url": "url", "-H": "header", "--header": "header",
		"-O": "remote", "--remote-name": "remote", "--remote-name-all": "remoteAll", "-J": "unmodeled",
		"--remote-header-name": "unmodeled", "-C": "unmodeled", "--continue-at": "unmodeled",
		"-u": "unsafe", "--user": "unsafe", "-b": "unsafe", "--cookie": "unsafe", "-E": "unsafe", "--cert": "unsafe",
		"--key": "unsafe", "-K": "unsafe", "--config": "unsafe", "-U": "unsafe", "--proxy-user": "unsafe", "-n": "unsafe",
		"--netrc": "unsafe", "--netrc-file": "unsafe", "--netrc-optional": "unsafe", "--oauth2-bearer": "unsafe",
		"--aws-sigv4": "unsafe", "--negotiate": "unsafe", "--ntlm": "unsafe", "--digest": "unsafe", "--anyauth": "unsafe",
		"--basic": "unsafe", "--delegation": "unsafe", "--resolve": "unsafe", "--connect-to": "unsafe",
		"--unix-socket": "unsafe", "--abstract-unix-socket": "unsafe",
		// A request body makes the response request-dependent: an echo server
		// returns the uploaded bytes, which may be a local file (review 3b #4).
		"-d": "unsafe", "--data": "unsafe", "--data-raw": "unsafe", "--data-binary": "unsafe", "--data-ascii": "unsafe",
		"--data-urlencode": "unsafe", "-F": "unsafe", "--form": "unsafe", "--form-string": "unsafe", "-T": "unsafe",
		"--upload-file": "unsafe", "--json": "unsafe",
	},
};

const WGET: ToolSpec = {
	shortValue: "OPeioaUtTwQlDXARBI",
	longValue: new Set([
		"--output-document", "--directory-prefix", "--execute", "--input-file", "--output-file", "--append-output", "--user",
		"--password", "--http-user", "--http-password", "--header", "--load-cookies", "--save-cookies", "--user-agent",
		"--tries", "--timeout", "--certificate", "--private-key", "--config", "--post-data", "--post-file", "--body-data",
		"--body-file", "--method", "--referer", "--ftp-user", "--ftp-password", "--proxy-user", "--proxy-password", "--wait",
		"--level",
	]),
	words: new Set(["-nc", "-nd", "-nH", "-np", "-nv"]),
	roles: {
		"-O": "out", "--output-document": "out", "-P": "outdir", "--directory-prefix": "outdir", "--header": "header",
		"-e": "unsafe", "--execute": "unsafe", "-i": "unsafe", "--input-file": "unsafe", "--user": "unsafe",
		"--password": "unsafe", "--http-user": "unsafe", "--http-password": "unsafe", "--ftp-user": "unsafe",
		"--ftp-password": "unsafe", "--ask-password": "unsafe", "--use-askpass": "unsafe", "--load-cookies": "unsafe",
		"--certificate": "unsafe", "--private-key": "unsafe", "--config": "unsafe", "--proxy-user": "unsafe",
		"--proxy-password": "unsafe", "--post-data": "unsafe", "--post-file": "unsafe", "--body-data": "unsafe",
		"--body-file": "unsafe", "-r": "unmodeled", "--recursive": "unmodeled", "-m": "unmodeled", "--mirror": "unmodeled",
		"-p": "unmodeled", "--page-requisites": "unmodeled", "-nc": "unmodeled", "--no-clobber": "unmodeled",
		"-N": "unmodeled", "--timestamping": "unmodeled", "-c": "unmodeled", "--continue": "unmodeled",
		"--content-disposition": "unmodeled", "-x": "unmodeled", "--force-directories": "unmodeled",
	},
};

const YTDLP: ToolSpec = {
	shortValue: "oPupafrRNIS",
	longValue: new Set([
		"--output", "--paths", "--username", "--password", "--batch-file", "--format", "--cookies", "--cookies-from-browser",
		"--exec", "--config-locations", "--netrc-location", "--netrc-cmd", "--video-password", "--ap-username",
		"--ap-password", "--load-info-json", "--user-agent", "--referer", "--add-header", "--proxy", "--limit-rate", "--retries",
	]),
	roles: {
		"-o": "out", "--output": "out", "-P": "unmodeled", "--paths": "unmodeled", "--add-header": "header",
		"-u": "unsafe", "--username": "unsafe", "-p": "unsafe", "--password": "unsafe", "-a": "unsafe",
		"--batch-file": "unsafe", "--cookies": "unsafe", "--cookies-from-browser": "unsafe", "--exec": "unsafe",
		"--config-locations": "unsafe", "-n": "unsafe", "--netrc": "unsafe", "--netrc-location": "unsafe",
		"--netrc-cmd": "unsafe", "--video-password": "unsafe", "--ap-username": "unsafe", "--ap-password": "unsafe",
		"--load-info-json": "unsafe",
	},
};

const SPECS: Readonly<Record<string, ToolSpec>> = { curl: CURL, wget: WGET, "yt-dlp": YTDLP, "youtube-dl": YTDLP };

interface Opt {
	role: Role | undefined;
	value: string | undefined;
}

interface Scan {
	opts: Opt[];
	positionals: string[];
}

/** Parse one short-flag cluster (`-sLo file`); returns how many extra argv tokens it consumed. */
function scanCluster(tok: string, next: string | undefined, spec: ToolSpec, opts: Opt[]): number {
	for (let k = 1; k < tok.length; k++) {
		const flag = `-${tok[k]}`;
		if (!spec.shortValue.includes(nonNull(tok[k]))) {
			opts.push({ role: spec.roles[flag], value: undefined });
			continue;
		}
		const rest = tok.slice(k + 1);
		opts.push({ role: spec.roles[flag] ?? "value", value: rest !== "" ? rest : next });
		return rest !== "" ? 0 : 1;
	}
	return 0;
}

/** Parse one argv token into `scan`; returns how many extra tokens it consumed. */
function scanToken(tok: string, next: string | undefined, spec: ToolSpec, scan: Scan): number {
	const eq = tok.indexOf("=");
	if (tok.startsWith("--") && eq > 0) {
		scan.opts.push({ role: spec.roles[tok.slice(0, eq)] ?? "value", value: tok.slice(eq + 1) });
		return 0;
	}
	if (tok.startsWith("--") || spec.words?.has(tok)) {
		const takes = spec.longValue.has(tok);
		scan.opts.push({ role: spec.roles[tok] ?? (takes ? "value" : undefined), value: takes ? next : undefined });
		return takes ? 1 : 0;
	}
	if (tok.startsWith("-") && tok.length > 1) return scanCluster(tok, next, spec, scan.opts);
	scan.positionals.push(tok);
	return 0;
}

function scanOptions(argv: readonly string[], spec: ToolSpec): Scan {
	const scan: Scan = { opts: [], positionals: [] };
	for (let i = 1; i < argv.length; i++) i += scanToken(nonNull(argv[i]), argv[i + 1], spec, scan);
	return scan;
}

const AUTH_HEADER =
	/^\s*(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth[\w-]*|x-goog-api-key|private-token|x-csrf-token|x-access-token)\s*:/i;
const URL_TOKEN = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface FetchTargets {
	/** Files the fetch wrote (relative to the stage's working directory). */
	targets: string[];
	/** Argument values naming outputs, excluded from the stage's input operands. */
	consumed: string[];
	/** True when some fetched body goes to stdout. */
	stdout: boolean;
	/** False when the written file set cannot be known (server-chosen name, recursion, resume, …). */
	ok: boolean;
}

interface FetchAnalysis extends FetchTargets {
	head: string;
	urls: string[];
	unsafe: boolean;
	positionalsAreUrls: boolean;
}

/** Last path segment of a URL ("" when none); null when the URL has a query
 *  string (tools differ on whether the query lands in the file name). */
function urlBasename(url: string): string | null {
	const m = /^[a-z]+:\/\/[^/?#]*([^?#]*)(\?[^#]*)?/i.exec(url);
	if (!m || m[2] !== undefined) return null;
	return posix.basename(nonNull(m[1]));
}

function valuesOf(opts: readonly Opt[], role: Role): string[] {
	return opts.filter((o) => o.role === role).map((o) => o.value ?? "");
}

function curlTargets(opts: readonly Opt[], urls: readonly string[]): FetchTargets {
	const outs = valuesOf(opts, "out");
	const dir = valuesOf(opts, "outdir").at(-1);
	const remote = opts.some((o) => o.role === "remote");
	const remoteAll = opts.some((o) => o.role === "remoteAll");
	const names = remote || remoteAll ? urls.map(urlBasename) : [];
	const files = [...outs.filter((o) => o !== "-"), ...names.filter((n): n is string => !!n)];
	let ok = !opts.some((o) => o.role === "unmodeled") && !names.some((n) => !n);
	if (remote && !remoteAll && urls.length !== 1) ok = false;
	if (outs.length > 0 && urls.length > 1 && outs.length !== urls.length) ok = false;
	const stdout = outs.includes("-") || (!remoteAll && outs.length + (remote ? 1 : 0) < urls.length);
	return { targets: files.map((f) => (dir ? posix.join(dir, f) : f)), consumed: [...outs, ...(dir ? [dir] : [])], stdout, ok };
}

/** wget's default file name: the URL's last path segment, `index.html` for a bare path. */
function wgetDefaultName(urls: readonly string[]): string | null {
	if (urls.length !== 1) return null;
	const name = urlBasename(nonNull(urls[0]));
	return name === "" ? "index.html" : name;
}

function wgetTargets(opts: readonly Opt[], urls: readonly string[]): FetchTargets {
	const out = valuesOf(opts, "out").at(-1);
	const dir = valuesOf(opts, "outdir").at(-1);
	const fallback = out === undefined ? wgetDefaultName(urls) : null;
	const ok = !opts.some((o) => o.role === "unmodeled") && (out !== undefined || fallback !== null);
	const files = out !== undefined && out !== "-" ? [out] : [];
	if (fallback) files.push(dir ? posix.join(dir, fallback) : fallback);
	const consumed = [...(out ? [out] : []), ...(dir ? [dir] : [])];
	return { targets: files, consumed, stdout: out === "-", ok };
}

function ytdlpTargets(opts: readonly Opt[]): FetchTargets {
	const out = valuesOf(opts, "out").at(-1);
	const ok = !opts.some((o) => o.role === "unmodeled") && !(out ?? "").includes("%(");
	const files = out && out !== "-" && ok ? [out] : [];
	return { targets: files, consumed: out ? [out] : [], stdout: out === "-", ok };
}

const TARGETS_BY_HEAD: Readonly<Record<string, (opts: readonly Opt[], urls: readonly string[]) => FetchTargets>> = {
	curl: curlTargets,
	wget: wgetTargets,
};

function isUnsafeOpt(o: Opt): boolean {
	if (o.role === "unsafe") return true;
	if (o.value !== undefined && hasUnresolvedVar(o.value)) return true;
	// `-H @file` reads headers from a local file the parser cannot see.
	return o.role === "header" && (AUTH_HEADER.test(o.value ?? "") || (o.value ?? "").trimStart().startsWith("@"));
}

function analyzeFetch(argv: readonly string[]): FetchAnalysis | null {
	const head = commandHead(argv[0]);
	const spec = SPECS[head];
	if (!spec) return null;
	const { opts, positionals } = scanOptions(argv, spec);
	const urls = [...positionals.filter((p) => URL_TOKEN.test(p)), ...valuesOf(opts, "url")];
	const targets = TARGETS_BY_HEAD[head]?.(opts, urls) ?? ytdlpTargets(opts);
	return {
		...targets,
		head,
		urls,
		unsafe: opts.some(isUnsafeOpt),
		positionalsAreUrls: positionals.every((p) => URL_TOKEN.test(p)),
	};
}

/** Files a curl / wget / yt-dlp stage writes, or null when the head is not one of them. */
export function fetchTargetsOf(argv: readonly string[]): FetchTargets | null {
	const a = analyzeFetch(argv);
	return a ? { targets: a.targets, consumed: a.consumed, stdout: a.stdout, ok: a.ok } : null;
}

const KEYED_QUERY = /[?&][^=&#]*(?:key|token|auth|secret|sig|password|passwd|session|code)[^=&#]*=/i;
/** `host[:port]` or `[v6][:port]` — the whole authority, nothing left over. */
const AUTHORITY_RE = /^(\[[^\]]*\]|[^:[\]]*)(?::\d*)?$/;

/** An http(s) URL to a public host (host-class.ts), with no credentials in it. */
export function isPublicUrl(url: string): boolean {
	if (hasUnresolvedVar(url) || url.includes("`")) return false;
	const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1];
	if (authority === undefined || authority.includes("@")) return false;
	const host = AUTHORITY_RE.exec(authority)?.[1];
	if (host === undefined || classifyHost(host) !== "public") return false;
	return !KEYED_QUERY.test(url);
}

export interface PublicFetch {
	url: string;
	targets: string[];
	consumed: string[];
	stdout: boolean;
}

/** The stage as a public, unauthenticated fetch, or null. `stageText` is the
 *  raw stage, checked with the shared `isOutboundNetworkCommand` predicate. */
export function publicFetchOf(stageText: string, argv: readonly string[]): PublicFetch | null {
	const a = analyzeFetch(argv);
	if (!a || !a.ok || a.unsafe || !a.positionalsAreUrls || a.urls.length === 0) return null;
	if (a.head !== "yt-dlp" && a.head !== "youtube-dl" && !isOutboundNetworkCommand(stageText)) return null;
	if (!a.urls.every(isPublicUrl)) return null;
	return { url: nonNull(a.urls[0]), targets: a.targets, consumed: a.consumed, stdout: a.stdout };
}
