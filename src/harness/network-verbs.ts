// ===========================================
// Network verbs — the one data table of commands that open a connection
// ===========================================
// Before 2026-10-05 three lists disagreed: `NETWORK_VERBS` +
// `PUBLISH_SUBCOMMANDS` in taint-tracker.ts (positional), `NETWORK_VERB` in
// sequence-checks/injection.ts (a word regex that also matched the `https`
// scheme of every URL literal), and the curl/wget word test in
// bash-provenance.ts. This table replaces all three for the network question.
// Each row names its head command, the subcommand paths that make it a network
// call, and why it is here (`source`). Add a verb by adding a row.
//
// A row answers three things for one shell segment:
//   kind     — fetch (pulls remote content), connect (opens a session/transfer),
//              publish (pushes to a remote registry or service);
//   outbound — false only for a proven local peer (loopback URL via the strict
//              parsers in network-loopback.ts, or a Unix domain socket);
//   hosts    — the literal peer hosts the arguments name, plus `hostsUnknown`
//              when the peer cannot be read statically.

import { classifyHost, parseIpv4 } from "./host-class.js";
import { isLoopbackNetworkCommand } from "./network-loopback.js";

export type NetworkKind = "fetch" | "connect" | "publish";

export interface NetworkVerb {
	/** Basename of the command word, lowercase. */
	head: string;
	/** Positional subcommand paths that make the head a network call. Absent:
	 *  every invocation of the head is one. */
	sub?: readonly (readonly string[])[];
	kind: NetworkKind;
	/** Network only when an argument names a remote (`scheme://`, `host:path`,
	 *  `user@host:`). `scp a b` and `git push origin` name no new destination. */
	needsRemote?: boolean;
	/** The first positional argument is the peer host (`ssh host`, `nc host port`). */
	hostArg?: boolean;
	/** A flag letter that means "listen", so the command names no peer. */
	listenFlag?: string;
	/** Flags that consume the next argument (so it is not a positional). */
	valueFlags?: readonly string[];
	/** The service a subcommand talks to when no URL is written. */
	defaultHost?: string;
	/** Why this row exists. */
	source: string;
}

const SSH_VALUE_FLAGS = ["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"];
const NC_VALUE_FLAGS = ["-w", "-p", "-s", "-x", "-X", "-i", "-q", "-e", "-c", "-I", "-O", "-T", "-V"];
const GIT_VALUE_FLAGS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace"];
const GH_VALUE_FLAGS = ["-R", "--repo", "-H", "--header", "-X", "--method", "-f", "-F", "--raw-field", "--field", "-q", "--jq", "-t", "--template", "--hostname", "-p", "--preview", "--input", "--cache"];

const CURL_SOURCE = "HTTP client — member of the original NETWORK_VERBS head set";
const NC_SOURCE = "raw TCP/UDP client — original NETWORK_VERBS member; loopback peer exempt via network-loopback.ts";
const HTTPIE_SOURCE = "HTTPie / xh HTTP clients — previously matched only as the bare words http|https in the trifecta regex";

export const NETWORK_VERB_TABLE: readonly NetworkVerb[] = [
	{ head: "curl", kind: "fetch", source: CURL_SOURCE },
	{ head: "wget", kind: "fetch", source: CURL_SOURCE },
	{ head: "http", kind: "fetch", source: HTTPIE_SOURCE },
	{ head: "https", kind: "fetch", source: HTTPIE_SOURCE },
	{ head: "xh", kind: "fetch", source: HTTPIE_SOURCE },
	{ head: "yt-dlp", kind: "fetch", source: "video/page downloader — session c698b9a9 (2026-10-05) ran it under taint; no list named it" },
	{ head: "ssh", kind: "connect", hostArg: true, valueFlags: SSH_VALUE_FLAGS, source: "remote shell — original NETWORK_VERBS member" },
	{ head: "sftp", kind: "connect", hostArg: true, valueFlags: SSH_VALUE_FLAGS, source: "file transfer over ssh — original NETWORK_VERBS member" },
	{ head: "telnet", kind: "connect", hostArg: true, source: "remote terminal — original NETWORK_VERBS member" },
	{ head: "ftp", kind: "connect", hostArg: true, source: "file transfer — original NETWORK_VERBS member" },
	{ head: "nc", kind: "connect", hostArg: true, listenFlag: "l", valueFlags: NC_VALUE_FLAGS, source: NC_SOURCE },
	{ head: "ncat", kind: "connect", hostArg: true, listenFlag: "l", valueFlags: NC_VALUE_FLAGS, source: NC_SOURCE },
	{ head: "netcat", kind: "connect", hostArg: true, listenFlag: "l", valueFlags: NC_VALUE_FLAGS, source: NC_SOURCE },
	{ head: "socat", kind: "connect", source: "socket relay — original NETWORK_VERBS member; peer addresses are not parsed" },
	{ head: "scp", kind: "connect", needsRemote: true, valueFlags: ["-c", "-F", "-i", "-J", "-l", "-o", "-P", "-S"], source: "copy over ssh — a remote only when an operand is host:path" },
	{ head: "rsync", kind: "connect", needsRemote: true, valueFlags: ["-e", "--rsh", "--rsync-path"], source: "sync tool — remote only when an operand is host:path, host::module or rsync://" },
	{ head: "npm", sub: [["publish"]], kind: "publish", defaultHost: "registry.npmjs.org", source: "registry publish — original PUBLISH_SUBCOMMANDS" },
	{ head: "npm", sub: [["view"], ["info"], ["show"]], kind: "fetch", defaultHost: "registry.npmjs.org", source: "registry metadata query — leg-2 source in bash-provenance.ts" },
	{ head: "pnpm", sub: [["publish"]], kind: "publish", defaultHost: "registry.npmjs.org", source: "registry publish — original PUBLISH_SUBCOMMANDS" },
	{ head: "yarn", sub: [["publish"]], kind: "publish", defaultHost: "registry.npmjs.org", source: "registry publish — original PUBLISH_SUBCOMMANDS" },
	{ head: "cargo", sub: [["publish"]], kind: "publish", defaultHost: "crates.io", source: "registry publish — original PUBLISH_SUBCOMMANDS" },
	{ head: "pip", sub: [["upload"]], kind: "publish", defaultHost: "upload.pypi.org", source: "original PUBLISH_SUBCOMMANDS entry" },
	{ head: "pip", sub: [["download"]], kind: "fetch", defaultHost: "pypi.org", source: "package download without install (2026-10-05)" },
	{ head: "pip3", sub: [["download"]], kind: "fetch", defaultHost: "pypi.org", source: "package download without install (2026-10-05)" },
	{ head: "twine", sub: [["upload"]], kind: "publish", defaultHost: "upload.pypi.org", source: "registry publish — original PUBLISH_SUBCOMMANDS" },
	{ head: "gem", sub: [["push"]], kind: "publish", defaultHost: "rubygems.org", source: "registry publish — original PUBLISH_SUBCOMMANDS" },
	{ head: "gh", sub: [["api"]], kind: "fetch", valueFlags: GH_VALUE_FLAGS, defaultHost: "api.github.com", source: "raw GitHub API call — leg-2 source in bash-provenance.ts" },
	{ head: "gh", sub: [["issue", "view"], ["pr", "view"], ["gist", "view"]], kind: "fetch", valueFlags: GH_VALUE_FLAGS, defaultHost: "api.github.com", source: "attacker-authored body fetch — leg-2 source in bash-provenance.ts" },
	{ head: "gh", sub: [["gist", "create"]], kind: "publish", valueFlags: GH_VALUE_FLAGS, defaultHost: "gist.github.com", source: "public-by-default gist — exfil_to_public_writeable surface" },
	{ head: "glab", sub: [["api"], ["issue", "view"], ["mr", "view"]], kind: "fetch", valueFlags: GH_VALUE_FLAGS, defaultHost: "gitlab.com", source: "GitLab CLI fetches — leg-2 source in bash-provenance.ts" },
	{ head: "git", sub: [["clone"], ["fetch"], ["pull"], ["ls-remote"]], kind: "fetch", needsRemote: true, valueFlags: GIT_VALUE_FLAGS, source: "git transfer to an explicit URL or host:path (a configured remote name names no new destination)" },
	{ head: "git", sub: [["push"]], kind: "publish", needsRemote: true, valueFlags: GIT_VALUE_FLAGS, source: "git push to an explicit URL or host:path" },
];

/** Commands that never open a socket. For the egress legs (trifecta leg 3, the
 *  lockdown mirror) a segment whose head is NOT here, is not a network verb,
 *  and is not a scanned inline program counts as external when it is handed a
 *  public URL — its code is not readable (review 3b, 2026-10-05). Kept OUT on
 *  purpose: awk/gawk (`/inet/tcp`), find (`-exec`), xargs, git, gh, open,
 *  source, make, every interpreter and every package manager. */
export const LOCAL_TOOLS: ReadonlySet<string> = new Set([
	"rg", "grep", "egrep", "fgrep", "ugrep", "sed", "jq", "echo", "printf", "cat", "head", "tail", "cut", "sort", "uniq",
	"wc", "tee", "tr", "mkdir", "ls", "cp", "mv", "touch", "test", "[", "[[", "true", "false", ":", "basename", "dirname",
	"realpath", "readlink", "date", "column", "diff", "cmp", "sha1sum", "sha256sum", "sha512sum", "shasum", "md5", "md5sum",
	"base64", "xxd", "od", "file", "stat", "textutil", "pbcopy", "pbpaste", "cd", "pwd", "export", "read", "printenv",
	"nl", "paste", "fold", "rev", "comm", "join", "less", "more", "rm", "ln", "chmod",
]);

/** What network-intent knows about one shell segment when it asks the table. */
export interface VerbContext {
	head: string;
	args: string[];
	/** The raw segment text (quotes intact) for the dynamic-text rule. */
	text: string;
	/** `VAR=value` tokens that preceded the head. */
	prefixes: string[];
	/** The head ran under `xargs`, so some arguments are unseen. */
	viaXargs: boolean;
}

export interface VerbNetwork {
	kind: NetworkKind;
	outbound: boolean;
	hosts: string[];
	hostsUnknown: boolean;
}

/** A URL `scheme://[user@]host`; the host stops at the first non-host character. */
const URL_HOST_RE = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"]*@)?(\[[0-9A-Fa-f:.]*\]|[A-Za-z0-9.-]*)([$`{]?)/gi;
/** A `[user@]host:` remote operand (scp, rsync, git ssh URL). */
const REMOTE_OPERAND_RE = /^(?:[^\s@/:]+@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9$][\w.${}-]*):(?!\/\/)/;
const VALID_HOST_RE = /^(?:\[[0-9A-Fa-f:.]+\]|(?=[A-Za-z0-9.-]*[A-Za-z.])[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.?)$/;
const PROXY_PREFIX_RE = /^(?:https?_proxy|all_proxy|CURL_HOME|HOME|XDG_CONFIG_HOME|WGETRC)=/i;
const DYNAMIC_TEXT_RE = /[$`\\]/;

/** Literal URL hosts in `text`; `unknown` when a host is templated (`${h}`, `$H`). */
export function hostsInText(text: string): { hosts: string[]; unknown: boolean } {
	const hosts: string[] = [];
	let unknown = false;
	for (const m of text.matchAll(URL_HOST_RE)) {
		const host = (m[1] ?? "").replace(/\.$/, "").toLowerCase();
		if (m[2]) unknown = true;
		if (host === "") continue;
		if (VALID_HOST_RE.test(host) || parseIpv4(host) !== null) hosts.push(host);
		else unknown = true;
	}
	return { hosts, unknown };
}

/** True unless `host` is proven non-routable (loopback, private, link-local,
 *  … in every encoding; host-class.ts). An unreadable host stays external. */
export function isPublicHost(host: string): boolean {
	return classifyHost(host) !== "private";
}

/** Positional arguments, skipping flags and the values that flags consume. */
function positionals(args: readonly string[], valueFlags: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (!arg.startsWith("-") || arg === "-") out.push(arg);
		else if (valueFlags.includes(arg)) i++;
	}
	return out;
}

function matchesSub(row: NetworkVerb, words: readonly string[]): boolean {
	if (!row.sub) return true;
	return row.sub.some((path) => path.every((word, i) => words[i] === word));
}

function findRow(head: string, args: readonly string[]): NetworkVerb | undefined {
	return NETWORK_VERB_TABLE.find((row) => row.head === head && matchesSub(row, positionals(args, row.valueFlags ?? [])));
}

/** The peer host of a `[user@]host` word, or null when it is not a host. */
function hostOfWord(word: string): string | null {
	const host = (word.includes("@") ? word.slice(word.lastIndexOf("@") + 1) : word).toLowerCase();
	return VALID_HOST_RE.test(host) ? host : null;
}

/** Hosts named by remote operands (`user@host:path`); null when none exists. */
function remoteOperandHosts(args: readonly string[]): { hosts: string[]; unknown: boolean } | null {
	const hosts: string[] = [];
	let unknown = false;
	let found = false;
	for (const arg of args) {
		if (arg.startsWith("-")) continue;
		const m = REMOTE_OPERAND_RE.exec(arg);
		if (m) {
			found = true;
			const host = hostOfWord(m[1] ?? "");
			if (host) hosts.push(host);
			else unknown = true;
		} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
			found = true;
		}
	}
	return found ? { hosts, unknown } : null;
}

function isListening(row: NetworkVerb, args: readonly string[]): boolean {
	const letter = row.listenFlag;
	return letter !== undefined && args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));
}

/** curl / nc talking to a Unix domain socket never leaves the machine. */
function usesUnixSocket(head: string, args: readonly string[]): boolean {
	if (head === "curl") return args.some((a) => /^--(?:abstract-)?unix-socket(?:=|$)/.test(a));
	if (["nc", "ncat", "netcat"].includes(head)) return args.some((a) => /^-[A-Za-z]*U[A-Za-z]*$/.test(a));
	return false;
}

function isOutbound(ctx: VerbContext): boolean {
	if (usesUnixSocket(ctx.head, ctx.args)) return false;
	if (ctx.viaXargs || DYNAMIC_TEXT_RE.test(ctx.text)) return true;
	if (ctx.prefixes.some((token) => PROXY_PREFIX_RE.test(token))) return true;
	return !isLoopbackNetworkCommand(ctx.head, ctx.args);
}

/** Hosts from the arguments, before the default-host and unknown rules. */
function collectHosts(row: NetworkVerb, args: readonly string[], remote: { hosts: string[]; unknown: boolean } | null): { hosts: string[]; unknown: boolean } {
	const fromUrls = hostsInText(args.join(" "));
	const hosts = [...fromUrls.hosts, ...(remote?.hosts ?? [])];
	let unknown = fromUrls.unknown || (remote?.unknown ?? false);
	if (row.hostArg && !isListening(row, args)) {
		const first = positionals(args, row.valueFlags ?? [])[0];
		const host = first === undefined ? null : hostOfWord(first);
		if (host) hosts.push(host);
		else if (hosts.length === 0) unknown = true;
	}
	return { hosts: [...new Set(hosts)], unknown };
}

/** Classify one segment's head against the table; null when it is not a network verb. */
export function classifyVerb(ctx: VerbContext): VerbNetwork | null {
	const row = findRow(ctx.head, ctx.args);
	if (!row) return null;
	const remote = row.needsRemote ? remoteOperandHosts(ctx.args) : null;
	if (row.needsRemote && remote === null) return null;
	const found = collectHosts(row, ctx.args, remote);
	if (found.hosts.length === 0 && !found.unknown && row.defaultHost) found.hosts.push(row.defaultHost);
	const dynamic = ctx.viaXargs || DYNAMIC_TEXT_RE.test(ctx.text);
	const listening = isListening(row, ctx.args);
	const hostsUnknown = dynamic || found.unknown || (found.hosts.length === 0 && !listening);
	return { kind: row.kind, outbound: isOutbound(ctx), hosts: found.hosts, hostsUnknown };
}
