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
// Also the server constructors that take their listen address as an argument
// (Python `HTTPServer((host, port), H)` / socketserver, JDK
// `HttpServer.create(addr, 0)`, Go `&http.Server{Addr: …}`) and a webpack
// `devServer: {` block (2026-10-21 adversarial review).
const BIND_CALL_RE =
	/\.listen\s*\(|\bcreateServer\s*\(|\bserve\s*\(|\bBun\.serve\b|\bListenAndServe\w*\s*\(|\bnet\.Listen\s*\(|\.bind\s*\(|\bTcpListener::bind\b|\buvicorn\.run\s*\(|\bapp\.run\s*\(|\brunserver\b|\b(?:Threading)?(?:HTTP|TCP|UDP)Server\s*\(|\bHttpServer\.create\s*\(|\bhttp\.Server\s*\{|\bdevServer\s*:\s*\{/;
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
	// Go 1.22 `cmp.Or(os.Getenv("X"), "localhost:8080")`: the first non-zero value wins.
	new RegExp(String.raw`\bcmp\.Or\s*\(.*\bos\.(?:Getenv|LookupEnv)\b.*["\`][^"\`]*${LOOPBACK}`),
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
	// `case "localhost":`, Go multi-value `case "localhost", "127.0.0.1":`
	new RegExp(String.raw`\bcase\s+(?:["'][^"']*["']\s*,\s*)*["'\`]${LOOPBACK}["'\`]\s*[,:]`),
	// Rust / Python match arms and a TS union type: `"localhost" | "127.0.0.1" =>`
	new RegExp(String.raw`["'\`]${LOOPBACK}["'\`]\s*(?:\|(?!\|)|=>)`),
	new RegExp(String.raw`^\s*(?:export\s+)?type\s+\w+(?:<[^>]*>)?\s*=`),
	/\bmatches!\s*\(/,
	// set / array membership: `["localhost","127.0.0.1"].includes(h)`, `new Set([...]).has(h)`
	new RegExp(String.raw`\[\s*(?:["'\`][^"'\`]*["'\`]\s*,?\s*)+\]\s*\.\s*(?:includes|indexOf|some|has)\s*\(`),
	new RegExp(String.raw`\bnew\s+Set\s*\(\s*\[\s*(?:["'\`][^"'\`]*["'\`]\s*,?\s*)+\]`),
	new RegExp(String.raw`\b(?:in|IN)\s*[(\[][^)\]]*["']${LOOPBACK}["']`),
	// named helpers / constants: isLoopback(h), LOOPBACK_HOSTS = [...]
	/\b(?:const|let|var)\s+\w*[Ll][Oo][Oo][Pp][Bb][Aa][Cc][Kk]\w*\s*=/,
	/\b(?:is_?[Ll]oopback|is_?[Ll]ocal(?:host|_?[Hh]ost)?|LOOPBACK_\w+|loopback_?[Hh]osts?)\b/,
	// Django host allowlists: membership lists the framework tests the request against
	/^\s*(?:ALLOWED_HOSTS|INTERNAL_IPS)\s*\+?=/,
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
// A port read back from a server this file bound (`server.address().port`,
// `listen(0)` + address) is the file's OWN loopback server, not a baked peer.
const PORT_SOURCE_RE = new RegExp(String.raw`${ENV_SOURCE_RE.source}|\.address\s*\(\s*\)`);
const LOOPBACK_LISTEN_RE = new RegExp(String.raw`\.listen\s*\([^)]*["'\`]${LOOPBACK}["'\`]`);

/** `${PORT}` where `const PORT = ... process.env ...` (or `.address()`) is declared in this file. */
function isEnvDerivedPort(line: string, fileText: string): boolean {
	const m = new RegExp(String.raw`${LOOPBACK}:\$\{\s*([\w.]+)\s*\}`).exec(line);
	const name = m?.[1];
	if (name === undefined) return false;
	if (ENV_SOURCE_RE.test(name)) return true;
	const decl = new RegExp(String.raw`\b(?:const|let|var)\s+${name.replace(/\./g, "\\.")}\s*(?::[^=]+)?=([^\n;]*)`).exec(fileText);
	return decl !== null && PORT_SOURCE_RE.test(decl[1] ?? "");
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

// --- 5. Declared defaults, display-only lines, parse bases ------------------
// (2026-10-21 adversarial review.) Each shape below is one a reader accepts
// on sight: the literal is a default the caller overrides, text that is only
// printed, a base that `new URL` discards, or a MySQL account name.
const LOOPBACK_LITERAL = String.raw`["'\`][^"'\`]*${LOOPBACK}`;
const TWO_ARG_DEFAULT = String.raw`\(\s*["'][^"']+["']\s*,\s*${LOOPBACK_LITERAL}`;
const IDIOM_RES: RegExp[] = [
	// `opts.get("host", "localhost")`, `ENV.fetch("X", "localhost")`, `props.getProperty(...)`
	new RegExp(String.raw`\.(?:get|getOrDefault|getProperty|fetch|dig)\s*${TWO_ARG_DEFAULT}`),
	// `.orElse("…")`, `.unwrap_or_else(|_| "…")`, `.getOrElse("…")`, `.value_or("…")`
	new RegExp(
		String.raw`\.(?:orElse|or_else|unwrap_or(?:_else|_default)?|getOrElse|value_or|ifBlank|ifEmpty)\s*\((?:\s*\|[^|]*\|)?\s*${LOOPBACK_LITERAL}`,
	),
	// commander `.option(flags, desc, default)` / `.requiredOption(...)` / `.default("…")`,
	// Typer / click `typer.Option("…")` (the first positional is the default)
	new RegExp(String.raw`\.(?:[Oo]ption|requiredOption)\s*\([^)]*${LOOPBACK_LITERAL}`),
	// Go `flag.String("addr", "localhost:8080", "…")` / `StringVar` and the pflag / cobra forms
	new RegExp(String.raw`\b(?:flag|pflag|Flags\(\)|PersistentFlags\(\))\.String(?:Var)?P?\s*\([^)]*${LOOPBACK_LITERAL}`),
	// Spring / Micronaut `@Value("${api.url:http://localhost:8080}")` — the text after `:` is the default
	new RegExp(String.raw`@Value\s*\(\s*"\$\{[^}:]+:[^}"]*${LOOPBACK}`),
	// Go struct tag `envDefault:"localhost:8080"` (caarlos0/env)
	new RegExp(String.raw`\benvDefault\s*:\s*"[^"]*${LOOPBACK}`),
	new RegExp(String.raw`\.default\s*\(\s*${LOOPBACK_LITERAL}`),
	// `new URL(relative, "http://localhost")` — the base host only makes a relative path parseable
	new RegExp(String.raw`\bnew\s+URL\s*\([^,]+,\s*["'\`]https?://${LOOPBACK}/?["'\`]`),
	// MySQL account specifier `'user'@'localhost'` is an account name, not an endpoint
	new RegExp(String.raw`["']@["']${LOOPBACK}["']`),
];

// A log / print call: the literal after the opener is displayed, never dialed.
const DISPLAY_CALL_RE =
	/\b(?:console\.\w+|logger?\.\w+|print(?:ln)?!?|fmt\.Print\w*|log\.Print\w*|System\.out\.print\w*|puts|echo)\s*[(\s]/;

function isDisplayOnlyLine(line: string): boolean {
	const call = DISPLAY_CALL_RE.exec(line);
	if (call === null) return false;
	const before = line.slice(0, call.index);
	return !LOOPBACK_ANY_RE.test(before) && LOOPBACK_ANY_RE.test(line.slice(call.index));
}

// A parameter default in a signature: `def __init__(self, host="localhost")`,
// `function create(host = "localhost")`, `fun connect(host: String = "…")`,
// `(host = "localhost") =>`. A call-site keyword argument (`Redis(host="…")`)
// has no signature keyword and stays in scope.
const SIGNATURE_RE =
	/^\s*(?:(?:export|default|async|pub|public|private|protected|static|override|final|open|fn)\s+)*(?:def|fun|func|function|constructor|__construct)\b[^(]*\(([^)]*)/;
const ARROW_PARAMS_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::[^=]*)?=>/;
const PARAM_DEFAULT_RE = new RegExp(String.raw`\w+\s*(?::\s*[\w?]+)?\s*=\s*${LOOPBACK_LITERAL}`);

function isSignatureDefaultLine(line: string): boolean {
	const params = SIGNATURE_RE.exec(line)?.[1] ?? ARROW_PARAMS_RE.exec(line)?.[1];
	return params !== undefined && PARAM_DEFAULT_RE.test(params);
}

// The same parameter default in a formatter's one-parameter-per-line layout
// (black, prettier, ktlint): the line is a lone `name[: T] = "…",` and the
// innermost still-open `(` above it belongs to a signature opener — `def`,
// `constructor(`, a Kotlin `class X(` primary constructor, an arrow
// `const f = (`. A multi-line CALL (`redis.Redis(\n host="localhost",`) opens
// its paren on a non-signature line and stays in scope.
const PARAM_LINE_RE = new RegExp(
	String.raw`^\s*(?:(?:private|public|protected|readonly|override|val|var|final)\s+)*(?:\??[\w\\]+\s+(?=\$))?\$?\w+\s*(?::[^=]+)?=\s*${LOOPBACK_LITERAL}[^"'\`]*["'\`]\s*,?\s*$`,
);
const SIGNATURE_OPENER_RE =
	/^\s*(?:(?:export|default|async|pub|public|private|protected|internal|static|override|final|open|data|fn)\s+)*(?:(?:def|fun|func|function|constructor|__construct|class)\b|(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\()/;
const PARAM_SCAN_LINES = 12;

function parenDelta(line: string): number {
	let d = 0;
	for (const ch of line) {
		if (ch === "(") d++;
		else if (ch === ")") d--;
	}
	return d;
}

function isMultilineSignatureDefault(lines: string[], i: number): boolean {
	if (!PARAM_LINE_RE.test(nonNull(lines[i]))) return false;
	let depth = 0;
	for (let j = i - 1; j >= 0 && j >= i - PARAM_SCAN_LINES; j--) {
		depth += parenDelta(nonNull(lines[j]));
		if (depth > 0) return SIGNATURE_OPENER_RE.test(nonNull(lines[j]));
	}
	return false;
}

// A pydantic `BaseSettings` field default: the environment overrides the field
// by name, so `api_url: str = "http://localhost:8000"` IS an env var with a
// default. The nearest `class` line above must be the settings class.
const ANNOTATED_FIELD_RE = new RegExp(String.raw`^\s*\w+\s*:\s*[^=]+=\s*${LOOPBACK_LITERAL}`);

function isSettingsFieldDefault(lines: string[], i: number): boolean {
	if (!ANNOTATED_FIELD_RE.test(nonNull(lines[i]))) return false;
	for (let j = i - 1; j >= 0; j--) {
		const line = nonNull(lines[j]);
		if (/^\s*class\s+\w+/.test(line)) return /\bBaseSettings\b/.test(line);
	}
	return false;
}

// `addr = "http://localhost"` directly under an emptiness guard on the same
// name: `if addr == "" {`, `if not url:`, `if (!url)`, `if url is None:`.
const PLAIN_ASSIGN_RE = new RegExp(String.raw`^\s*\$?(\w+)\s*=\s*${LOOPBACK_LITERAL}`);

function isGuardedFallbackAssignment(lines: string[], i: number): boolean {
	const name = PLAIN_ASSIGN_RE.exec(nonNull(lines[i]))?.[1];
	if (name === undefined) return false;
	let prev = i - 1;
	while (prev >= 0 && nonNull(lines[prev]).trim() === "") prev--;
	if (prev < 0) return false;
	const guard = nonNull(lines[prev]);
	if (!/^\s*(?:}\s*)?(?:if|elif|elsif|unless)\b/.test(guard)) return false;
	const emptiness = new RegExp(
		String.raw`!\s*\$?${name}\b|\bnot\s+${name}\b|\b${name}\s*(?:==|===|is)\s*(?:""|''|nil|None|null|undefined)|\b${name}\.(?:is_empty\(\)|nil\?|empty\?)|\bempty\(\s*\$?${name}\s*\)`,
	);
	return emptiness.test(guard);
}

function isDeclaredDefaultOrDisplayLine(lines: string[], i: number): boolean {
	const line = nonNull(lines[i]);
	return (
		IDIOM_RES.some((re) => re.test(line)) ||
		isDisplayOnlyLine(line) ||
		isSignatureDefaultLine(line) ||
		isMultilineSignatureDefault(lines, i) ||
		isSettingsFieldDefault(lines, i) ||
		isGuardedFallbackAssignment(lines, i)
	);
}

/**
 * True when the matched loopback line is a deliberate local-only pattern:
 * bind address, env-var fallback, loopback detection, the address of a local
 * process this file launches/binds, or a declared default / display-only /
 * parse-base idiom. `fileText` is the comment-stripped file.
 */
export function isIntentionalLoopbackLine(lines: string[], i: number, fileText: string): boolean {
	if (!LOOPBACK_ANY_RE.test(nonNull(lines[i]))) return false;
	return (
		isBindAddressLine(lines, i, fileText) ||
		isEnvFallbackLine(lines, i) ||
		isDetectionLine(lines, i) ||
		isOwnedLocalProcessLine(nonNull(lines[i]), fileText) ||
		isDeclaredDefaultOrDisplayLine(lines, i)
	);
}
