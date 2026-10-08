// ===========================================
// Interpreter network APIs — does an inline program open a connection?
// ===========================================
// The network-intent predicate (network-intent.ts) asks this module about the
// PROGRAM an interpreter receives inline (`python3 - <<EOF`, `node -e '…'`).
// The answer is a per-language table of network APIs. A URL STRING ALONE IS
// NOT NETWORK: before 2026-10-05 the lethal-trifecta leg 3 counted any public
// URL literal as "about to make an external network call", and blocked a python
// program that only parsed an XML namespace URI. Conversely a program that
// calls `urlopen(os.environ['U'])` has no URL literal and passed every gate.
//
// Patterns prefer IMPORT and CALL forms over bare names so prose in a string
// ("handled 3 requests.") or a dependency lookup (`deps.axios`) does not match.
// Add an API by adding a row to its language.

import { isLoopbackHost } from "./network-loopback.js";
import { hostsInText } from "./network-verbs.js";

/** One network API of one language. */
export interface NetworkApi {
	name: string;
	re: RegExp;
}

/** `import a, b, MOD` / `from MOD import x` at a statement start (line or `;`). */
function pythonImport(module: string): RegExp {
	return new RegExp(`(?:^|[;\\n])[ \\t]*(?:import[ \\t]+[\\w., \\t]*\\b${module}\\b|from[ \\t]+${module}\\b)`);
}

/** `require('MOD')` / `from 'MOD'` / `import('MOD')`, with an optional `node:` prefix. */
function nodeModule(modules: string): RegExp {
	return new RegExp(`(?:require|import)\\s*\\(\\s*['"](?:node:)?(?:${modules})['"]|from\\s+['"](?:node:)?(?:${modules})['"]`);
}

export const INTERPRETER_NETWORK_APIS: Readonly<Record<string, readonly NetworkApi[]>> = {
	python: [
		{ name: "urlopen(", re: /\burlopen\s*\(/ },
		{ name: "urllib.request", re: /\burllib\.request\b|\bfrom\s+urllib\s+import\s+(?:[\w\s,]*,\s*)?request\b/ },
		{ name: "http.client", re: /\bhttp\.client\b|\bfrom\s+http\s+import\s+client\b/ },
		{ name: "requests", re: /\brequests\.(?:get|post|put|patch|delete|head|options|request|Session)\s*\(/ },
		{ name: "import requests", re: pythonImport("requests") },
		{ name: "httpx", re: /\bhttpx\.\w+\s*\(/ },
		{ name: "import httpx", re: pythonImport("httpx") },
		{ name: "aiohttp", re: pythonImport("aiohttp") },
		{ name: "urllib3", re: pythonImport("urllib3") },
		{ name: "socket.create_connection", re: /\bsocket\.create_connection\s*\(/ },
		{ name: "socket .connect((host, port))", re: /\.connect(?:_ex)?\s*\(\s*\(/ },
		{ name: "ftplib/smtplib/telnetlib/paramiko/websockets/pycurl", re: pythonImport("(?:ftplib|smtplib|telnetlib|paramiko|websockets?|pycurl)") },
	],
	node: [
		{ name: "fetch(", re: /\bfetch\s*\(/ },
		{ name: "http.request/get", re: /\bhttps?\.(?:request|get)\s*\(/ },
		{ name: "net/tls connect", re: /\b(?:net|tls)\.(?:connect|createConnection)\s*\(/ },
		{ name: "require network module", re: nodeModule("https?|http2|net|tls|dgram") },
		{ name: "axios", re: /\baxios(?:\.(?:get|post|put|patch|delete|head|request))?\s*\(|['"]axios['"]/ },
		{ name: "undici", re: /\bundici\.\w+\s*\(|['"]undici['"]/ },
		{ name: "WebSocket", re: /\bnew\s+WebSocket\s*\(/ },
	],
	ruby: [
		{ name: "Net::HTTP", re: /\bNet::HTTP\b/ },
		{ name: "open-uri", re: /\bopen-uri\b|\bURI\.open\b/ },
		{ name: "TCPSocket", re: /\bTCPSocket\b/ },
		{ name: "HTTParty/Faraday", re: /\b(?:HTTParty|Faraday)\b/ },
		{
			name: "require network library",
			re: /\brequire\s*\(?\s*['"](?:net\/(?:https?|ftp|smtp|telnet|pop|imap)|open-uri|faraday|httparty|excon|typhoeus|rest-client)['"]/,
		},
	],
	perl: [
		{ name: "LWP", re: /\bLWP::/ },
		{ name: "HTTP::Tiny", re: /\bHTTP::Tiny\b/ },
		{ name: "IO::Socket", re: /\bIO::Socket\b/ },
		{ name: "Net::HTTP", re: /\bNet::HTTP\b/ },
	],
};

/** A process-spawn API plus a string literal that starts with a network verb. */
const SPAWN_RE = /\b(?:subprocess|os\.system|os\.popen|child_process|execSync|execFileSync|spawnSync|Open3|system)\b/;
const VERB_LITERAL_RE = /['"`](?:curl|wget|yt-dlp|nc|ssh|scp)(?=['"`\s])/;
const BACKTICK_VERB_RE = /`(?:curl|wget|yt-dlp)\s/;

const LANGUAGE_OF: ReadonlyArray<[RegExp, string]> = [
	[/^python/, "python"],
	[/^node$/, "node"],
	[/^ruby$/, "ruby"],
	[/^perl$/, "perl"],
];

export interface ProgramNetwork {
	/** The API row that matched. */
	api: string;
	/** Literal hosts named by URL strings in the program. */
	hosts: string[];
	/** No literal host, or a templated one: the peer is not readable. */
	hostsUnknown: boolean;
	/** Every literal host is loopback and none is templated. */
	loopbackOnly: boolean;
}

function matchApi(language: string, body: string): string | null {
	const apis = INTERPRETER_NETWORK_APIS[language] ?? [];
	const hit = apis.find((api) => api.re.test(body));
	if (hit) return hit.name;
	if (VERB_LITERAL_RE.test(body) && SPAWN_RE.test(body)) return "shell-out to a network verb";
	if (BACKTICK_VERB_RE.test(body) && language !== "node" && language !== "python") return "shell-out to a network verb";
	return null;
}

function languageOf(interpreter: string): string | undefined {
	return LANGUAGE_OF.find(([re]) => re.test(interpreter))?.[1];
}

/** The network API an inline program calls, or null when it calls none. */
export function scanProgramForNetwork(interpreter: string, body: string): ProgramNetwork | null {
	const language = languageOf(interpreter);
	if (language === undefined) return null;
	const api = matchApi(language, body);
	if (api === null) return null;
	const { hosts, unknown } = hostsInText(body);
	const loopbackOnly = hosts.length > 0 && !unknown && hosts.every(isLoopbackHost);
	return { api, hosts, hostsUnknown: unknown || hosts.length === 0, loopbackOnly };
}

// ===========================================
// Interpreter command lines — flags before the program (review 3b, 2026-10-05)
// ===========================================
// The program flag can follow value-taking flags (`python3 -W ignore -c …`),
// and module-load flags run code before the program (`perl -MIO::Socket::INET`,
// `ruby -rnet/http`, `node -r undici`). Each language lists its value flags;
// a module flag's value is scanned as a synthetic load statement against the
// API table above.

interface InterpreterFlags {
	/** The flag that introduces an inline program. */
	program: RegExp;
	/** Flags that take a value: attached (`-Wx`, `--x=v`) or the next word. */
	value: readonly string[];
	/** Value flags whose value is a module loaded before the program. */
	module: readonly string[];
	/** The flag whose value is a module run AS the program (`python -m`). */
	run?: string;
	/** A statement that loads `module`, for the API table. */
	load: (module: string) => string;
}

const INTERPRETER_FLAGS: Readonly<Record<string, InterpreterFlags>> = {
	python: { program: /^-[A-Za-z]*c$/, value: ["-W", "-X", "--check-hash-based-pycs"], module: [], run: "-m", load: (m) => `import ${m}` },
	node: {
		program: /^(?:-e|--eval|-p|--print|-pe)$/,
		value: ["--input-type", "-C", "--conditions", "--env-file", "--title", "--inspect-port", "--max-old-space-size"],
		module: ["-r", "--require", "--import", "--loader", "--experimental-loader"],
		load: (m) => `require('${m}')`,
	},
	ruby: { program: /^-[A-Za-z]*e$/, value: ["-I", "-E", "-C"], module: ["-r"], load: (m) => `require '${m}'` },
	perl: { program: /^-[A-Za-z]*[eE]$/, value: ["-I"], module: ["-M", "-m"], load: (m) => `use ${m.replace(/^-/, "").replace(/[=\s].*$/, "")};` },
};

/** What an interpreter's argument list says it will run. */
export interface InterpreterArgs {
	/** The inline program (`-c` / `-e` value), or null. */
	program: string | null;
	/** Modules loaded before the program (`-M`, `-r`, `--import`). */
	modules: string[];
	/** The module run as the program (`python -m`), or null. */
	run: string | null;
	/** The first positional word (a script path, or `-` for stdin), or null. */
	script: string | null;
}

type FlagKind = "program" | "module" | "run" | "value" | "switch";

function flagsOf(interpreter: string): InterpreterFlags | undefined {
	const language = languageOf(interpreter);
	return language === undefined ? undefined : INTERPRETER_FLAGS[language];
}

function takesValue(f: InterpreterFlags, name: string): boolean {
	return f.value.includes(name) || f.module.includes(name) || f.run === name;
}

function kindOf(f: InterpreterFlags, name: string): FlagKind {
	if (f.run === name) return "run";
	if (f.module.includes(name)) return "module";
	if (f.value.includes(name)) return "value";
	return f.program.test(name) ? "program" : "switch";
}

/** `--name=value`, `-Xvalue` or a bare flag: its name and attached value. */
function splitFlag(f: InterpreterFlags, arg: string): { name: string; attached: string | undefined } {
	const eq = arg.indexOf("=");
	if (arg.startsWith("--") && eq > 0) return { name: arg.slice(0, eq), attached: arg.slice(eq + 1) };
	const short = arg.slice(0, 2);
	if (!arg.startsWith("--") && arg.length > 2 && takesValue(f, short)) return { name: short, attached: arg.slice(2) };
	return { name: arg, attached: undefined };
}

interface FlagStep {
	kind: FlagKind;
	value: string | undefined;
	/** Extra argv words the flag consumed. */
	width: number;
}

function readFlag(f: InterpreterFlags, arg: string, next: string | undefined): FlagStep {
	const { name, attached } = splitFlag(f, arg);
	const kind = kindOf(f, name);
	if (kind === "switch" || attached !== undefined) return { kind, value: attached, width: 0 };
	return { kind, value: next, width: 1 };
}

/** Record one flag's effect; true when the program (or module run) is found. */
function applyStep(out: InterpreterArgs, step: FlagStep): boolean {
	const value = step.value ?? null;
	if (step.kind === "module" && value !== null) out.modules.push(value);
	if (step.kind === "program") out.program = value;
	if (step.kind === "run") out.run = value;
	return step.kind === "program" || step.kind === "run";
}

/** True for a word that ends the flags: a script path, `-` (stdin) or `--`. */
function endsFlags(arg: string): boolean {
	return arg === "--" || arg === "-" || !arg.startsWith("-");
}

/** Parse an interpreter's arguments up to its program, module run or script. */
export function parseInterpreterArgs(interpreter: string, args: readonly string[]): InterpreterArgs {
	const out: InterpreterArgs = { program: null, modules: [], run: null, script: null };
	const f = flagsOf(interpreter);
	if (f === undefined) return out;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (endsFlags(arg)) {
			out.script = (arg === "--" ? args[i + 1] : arg) ?? null;
			return out;
		}
		const step = readFlag(f, arg, args[i + 1]);
		i += step.width;
		if (applyStep(out, step)) return out;
	}
	return out;
}

/** The network API that the loaded or run modules bring in, or null. */
export function scanModulesForNetwork(interpreter: string, parsed: InterpreterArgs): ProgramNetwork | null {
	const f = flagsOf(interpreter);
	const modules = parsed.run === null ? parsed.modules : [...parsed.modules, parsed.run];
	if (f === undefined || modules.length === 0) return null;
	return scanProgramForNetwork(interpreter, modules.map(f.load).join("\n"));
}
