// Deliberate-loopback exemptions for `ubs_hardcoded_localhost`.
//
// Loopback is the CORRECT value for several intentional local-only patterns,
// so the check must not block them: a server BIND address (loopback bind is a
// security best practice), an env-var fallback (the exact fix the check
// recommends), loopback DETECTION / comparison, and the address of a local
// process this very file launches or listens as (Chrome DevTools, an OAuth
// callback server). Every rule here is evidence-based — it reads the line, the
// enclosing call, or the file's own launch/bind evidence — never the
// directory. All inputs are comment-stripped lines (strings preserved).

import { nonNull } from "../../../lib/non-null.js";

const LOOPBACK = String.raw`(?:localhost|127\.0\.0\.1)`;
const LOOPBACK_ANY_RE = new RegExp(String.raw`\b${LOOPBACK}\b`);

// --- 1. Server bind / listen addresses -----------------------------------
const BIND_CALL_RE =
	/\.listen\s*\(|\bcreateServer\s*\(|\bserve\s*\(|\bBun\.serve\b|\bListenAndServe\w*\s*\(|\bnet\.Listen\s*\(|\.bind\s*\(|\bTcpListener::bind\b|\buvicorn\.run\s*\(|\bapp\.run\s*\(|\brunserver\b/;
const BIND_FLAG_RE = new RegExp(
	String.raw`(?:--(?:host|hostname|bind|listen|address)(?:[=\s]+|["']\s*,\s*["'])["']?${LOOPBACK}|\s-H\s+["']?${LOOPBACK})`,
);
const BIND_KEY_RE = new RegExp(
	String.raw`^\s*["']?(?:host|hostname|address|addr|bind|bindAddress|bind_addr)["']?\s*[:=]\s*["'\`]${LOOPBACK}`,
	"i",
);
const BIND_NAMED_RE = new RegExp(
	String.raw`\b(?:const|let|var)\s+\w*(?:bind|listen)\w*\s*=\s*["'\`]${LOOPBACK}`,
	"i",
);

function netDepth(text: string): number {
	let d = 0;
	for (const ch of text) {
		if ("({[".includes(ch)) d++;
		else if (")}]".includes(ch)) d--;
	}
	return d;
}

/** True when line `i` sits inside the still-open argument list of a bind call (<= 6 lines up). */
function insideOpenBindCall(lines: string[], i: number): boolean {
	for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
		if (!BIND_CALL_RE.test(nonNull(lines[j]))) continue;
		return netDepth(lines.slice(j, i).join("\n")) > 0;
	}
	return false;
}

const LOOPBACK_DECL_RE = new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*["'\`]${LOOPBACK}["'\`]`);

/** `const host = "127.0.0.1"` whose name the file later passes to a bind call. */
function isDeclaredBindHost(line: string, fileText: string): boolean {
	const name = LOOPBACK_DECL_RE.exec(line)?.[1];
	if (name === undefined) return false;
	const used = new RegExp(String.raw`(?:\.listen\s*\([^)]*\b${name}\b|\b(?:host|hostname|address|bind)\s*:\s*${name}\b)`);
	return used.test(fileText);
}

/** The loopback literal sits inside a bind call's argument list on this line, not before it. */
function isLoopbackBindArgument(line: string): boolean {
	const call = BIND_CALL_RE.exec(line);
	if (call === null) return false;
	return LOOPBACK_ANY_RE.test(line.slice(call.index + call[0].length));
}

function isBindAddressLine(lines: string[], i: number, fileText: string): boolean {
	const line = nonNull(lines[i]);
	if (isDeclaredBindHost(line, fileText)) return true;
	if (BIND_FLAG_RE.test(line) || BIND_NAMED_RE.test(line)) return true;
	if (isLoopbackBindArgument(line)) return true;
	return BIND_KEY_RE.test(line) && insideOpenBindCall(lines, i);
}

// --- 2. Env-var fallbacks -------------------------------------------------
const ENV_FALLBACK_RES: RegExp[] = [
	// `process.env.X ?? "localhost"` is covered by the generic `||`/`??` rule; these are the
	// call-shaped forms: os.environ.get("X", "localhost"), os.getenv, getEnv("X", "..."), Rust.
	new RegExp(String.raw`\b\w*(?:environ|env)\w*(?:\.\w+)*\s*\(\s*["'][^"']+["']\s*,\s*["'\`][^"'\`]*${LOOPBACK}`, "i"),
	new RegExp(String.raw`\benviron(?:\.get)?\s*\(\s*["'][^"']+["']\s*,\s*["'\`][^"'\`]*${LOOPBACK}`),
	new RegExp(String.raw`\benv::var\b.*\.unwrap_or(?:_else)?\s*\(\s*(?:\|\|\s*)?(?:"|String::from\(")[^"]*${LOOPBACK}`),
	new RegExp(String.raw`\bgetenv\b.*["'][^"']*${LOOPBACK}`),
];
const DANGLING_FALLBACK_RE = /(?:\|\||\?\?)\s*$/;

function isEnvFallbackLine(lines: string[], i: number): boolean {
	if (ENV_FALLBACK_RES.some((re) => re.test(nonNull(lines[i])))) return true;
	// `process.env.X ??` on the previous line, literal on this one.
	let prev = i - 1;
	while (prev >= 0 && nonNull(lines[prev]).trim() === "") prev--;
	return prev >= 0 && DANGLING_FALLBACK_RE.test(nonNull(lines[prev]));
}

// --- 3. Loopback detection / comparison -----------------------------------
const DETECTION_RES: RegExp[] = [
	// reversed / switch comparisons: `"localhost" === host`, `case "localhost":`
	new RegExp(String.raw`["'\`]${LOOPBACK}["'\`]\s*(?:[=!]==?|\bin\b)`),
	new RegExp(String.raw`\bcase\s+["'\`]${LOOPBACK}["'\`]\s*:`),
	// set / array membership: `["localhost","127.0.0.1"].includes(h)`, `new Set([...]).has(h)`
	new RegExp(String.raw`\[\s*(?:["'\`][^"'\`]*["'\`]\s*,?\s*)+\]\s*\.\s*(?:includes|indexOf|some|has)\s*\(`),
	new RegExp(String.raw`\bnew\s+Set\s*\(\s*\[\s*(?:["'\`][^"'\`]*["'\`]\s*,?\s*)+\]`),
	new RegExp(String.raw`\b(?:in|IN)\s*[(\[][^)\]]*["']${LOOPBACK}["']`),
	// named helpers / constants: isLoopback(h), LOOPBACK_HOSTS = [...]
	/\b(?:const|let|var)\s+\w*[Ll][Oo][Oo][Pp][Bb][Aa][Cc][Kk]\w*\s*=/,
	/\b(?:is_?[Ll]oopback|is_?[Ll]ocal(?:host|_?[Hh]ost)?|LOOPBACK_\w+|loopback_?[Hh]osts?)\b/,
];
const BARE_ELEMENT_RE = new RegExp(String.raw`^\s*["'\`]${LOOPBACK}["'\`]\s*,?\s*$`);
const LOOPBACK_LIST_OPENER_RE = /(?:loopback|\blocal\w*|\bset\s*\()/i;

/** A list element alone on its line, inside a literal opened by a loopback-named list. */
function isLoopbackListElement(lines: string[], i: number): boolean {
	if (!BARE_ELEMENT_RE.test(nonNull(lines[i]))) return false;
	for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
		const text = nonNull(lines[j]);
		if (BARE_ELEMENT_RE.test(text) || text.trim() === "") continue;
		return /[[(]\s*$/.test(text) && LOOPBACK_LIST_OPENER_RE.test(text);
	}
	return false;
}

function isDetectionLine(lines: string[], i: number): boolean {
	return DETECTION_RES.some((re) => re.test(nonNull(lines[i]))) || isLoopbackListElement(lines, i);
}

// --- 4. Local processes this file itself launches / binds ------------------
const CDP_FLAG_RE = /remote-debugging-port(?:=|["'`]\s*,\s*|\s+)?([^\s"'`,)]*)/g;
const CDP_PATH_RE = /\/json\/(?:version|list|new|activate)\b|webSocketDebuggerUrl|\/devtools\/(?:browser|page)\b/;
const CDP_ATTACH_RE = /\bconnectOverCDP\b|\bpuppeteer\.connect\b|\bbrowserWSEndpoint\b|\bbrowserURL\b/;
const PORT_IN_URL_RE = new RegExp(String.raw`${LOOPBACK}(?::(\$\{[^}]+\}|\d+))?`);

/** Ports (`${EXPR}` or digits) the file hands to `--remote-debugging-port`. */
function cdpLaunchPorts(text: string): Set<string> {
	const ports = new Set<string>();
	for (const m of text.matchAll(CDP_FLAG_RE)) {
		const arg = m[1] ?? "";
		const tpl = /\$\{([^}]+)\}/.exec(arg);
		ports.add(tpl ? `\${${tpl[1]}}` : arg.replace(/[^\d]/g, ""));
	}
	ports.delete("");
	return ports;
}

function launchesDevtools(text: string): boolean {
	return text.includes("remote-debugging-port");
}

function isDevtoolsEndpointLine(line: string, fileText: string): boolean {
	// Attaching to a debugging endpoint IS addressing a local browser.
	if (CDP_ATTACH_RE.test(line)) return true;
	if (!launchesDevtools(fileText) && !CDP_ATTACH_RE.test(fileText)) return false;
	if (CDP_PATH_RE.test(line)) return true;
	const port = PORT_IN_URL_RE.exec(line)?.[1];
	return port !== undefined && cdpLaunchPorts(fileText).has(port);
}

const ENV_SOURCE_RE = /\b(?:process\.env|import\.meta\.env|Deno\.env|os\.environ|os\.getenv|getenv|env::var)\b/;
const LOOPBACK_LISTEN_RE = new RegExp(String.raw`\.listen\s*\([^)]*["'\`]${LOOPBACK}["'\`]`);

/** `${PORT}` where `const PORT = ... process.env ...` is declared in this file (override exists). */
function isEnvDerivedPort(line: string, fileText: string): boolean {
	const m = new RegExp(String.raw`${LOOPBACK}:\$\{\s*([\w.]+)\s*\}`).exec(line);
	const name = m?.[1];
	if (name === undefined) return false;
	if (ENV_SOURCE_RE.test(name)) return true;
	const decl = new RegExp(String.raw`\b(?:const|let|var)\s+${name.replace(/\./g, "\\.")}\s*(?::[^=]+)?=([^\n;]*)`).exec(fileText);
	return decl !== null && ENV_SOURCE_RE.test(decl[1] ?? "");
}

/** The file binds its own loopback server; a loopback URL it builds with a port variable (or no port) addresses that server. */
function isSelfServerUrl(line: string, fileText: string): boolean {
	if (!LOOPBACK_LISTEN_RE.test(fileText)) return false;
	const m = PORT_IN_URL_RE.exec(line);
	const port = m?.[1];
	return port === undefined || port.startsWith("${");
}

function isOwnedLocalProcessLine(line: string, fileText: string): boolean {
	return (
		isDevtoolsEndpointLine(line, fileText) ||
		isEnvDerivedPort(line, fileText) ||
		isSelfServerUrl(line, fileText)
	);
}

/**
 * True when the matched loopback line is a deliberate local-only pattern:
 * bind address, env-var fallback, loopback detection, or the address of a
 * local process this file launches/binds. `fileText` is the comment-stripped file.
 */
export function isIntentionalLoopbackLine(lines: string[], i: number, fileText: string): boolean {
	if (!LOOPBACK_ANY_RE.test(nonNull(lines[i]))) return false;
	return (
		isBindAddressLine(lines, i, fileText) ||
		isEnvFallbackLine(lines, i) ||
		isDetectionLine(lines, i) ||
		isOwnedLocalProcessLine(nonNull(lines[i]), fileText)
	);
}
