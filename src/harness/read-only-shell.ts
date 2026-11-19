// ===========================================
// Provably read-only shell commands
// ===========================================
// A shell command's effects are known only after it ran, so a workspace change
// seen during a Bash call is attributed to that call by default. Several agents
// work in one checkout: without this test, `rg foo src` is recorded as the
// writer of every file a concurrent actor changed while it ran.
//
// This classifier answers "can this command line write a file?" from the text
// alone. It FAILS CLOSED: only a small allowlist of commands, with their
// write-capable options excluded, is read-only. Every other construct
// (redirect to a file, substitution, unknown command) answers false, which keeps
// today's attribution. A wrong "true" would hide a real write; a wrong "false"
// only keeps an existing false attribution.

/** Commands that cannot write a file with any argument this module admits. */
const READ_COMMANDS: ReadonlySet<string> = new Set([
	"rg", "grep", "egrep", "fgrep", "cat", "head", "tail", "wc", "ls", "stat", "file", "pwd", "which",
	"date", "echo", "printf", "true", "false", "test", "[", "cut", "tr", "nl", "basename", "dirname",
	"realpath", "diff", "cmp", "du", "df", "jq", "column", "cd",
]);

/** `git` subcommands that only read the repository. */
const READ_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "cat-file", "grep", "describe",
]);

const FIND_WRITE_ACTIONS = /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;
const SED_PRINT_SCRIPT = /^\d+(?:,\d+)?p$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\s]*$/;

/** Quoted text cannot hold a separator or a redirect, but a double-quoted span
 *  can run a substitution. Returns null when the quoting cannot be read. */
function maskQuotes(command: string): string | null {
	let out = "";
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i] as string;
		if (quote === null) {
			if (ch === "\\") return null; // an escape outside quotes: not analyzed
			if (ch === '"' || ch === "'") quote = ch;
			out += ch === '"' || ch === "'" ? "Q" : ch;
		} else if (ch === quote) {
			quote = null;
			out += "Q";
		} else {
			if (quote === '"' && (ch === "`" || ch === "$" || ch === "\\")) return null;
			out += "q";
		}
	}
	return quote === null ? out : null;
}

/** Remove the redirects that write no file: `2>&1`, `>/dev/null`, `2>/dev/null`. */
function stripInertRedirects(masked: string): string {
	return masked.replace(/\d?>&\d/g, " ").replace(/(?:\d|&)?>\s*\/dev\/null/g, " ");
}

function sedIsPrintOnly(args: readonly string[]): boolean {
	if (!args.includes("-n")) return false;
	const rest = args.filter((arg) => arg !== "-n");
	// One print script (quoted scripts are masked to Q…Q), then file names.
	const script = rest[0];
	if (script === undefined || script.startsWith("-")) return false;
	return /^Qq+Q$/.test(script) || SED_PRINT_SCRIPT.test(script);
}

function gitIsReadOnly(args: readonly string[]): boolean {
	const words = args.filter((arg) => arg !== "--no-optional-locks" && arg !== "--no-pager");
	const subcommand = words[0];
	if (subcommand === undefined || !READ_GIT_SUBCOMMANDS.has(subcommand)) return false;
	return !words.some((arg) => arg === "-o" || arg.startsWith("--output"));
}

function segmentIsReadOnly(segment: string, original: string): boolean {
	const words = segment.trim().split(/\s+/).filter(Boolean);
	while (words.length > 0 && ENV_ASSIGNMENT.test(words[0] as string)) words.shift();
	const [command, ...args] = words;
	if (command === undefined) return false;
	if (command === "sed") return sedIsPrintOnly(args) && sedScriptsArePrintOnly(original);
	if (command === "git") return gitIsReadOnly(args);
	if (command === "find") return !args.some((arg) => FIND_WRITE_ACTIONS.test(arg));
	if (command === "sort") return !args.some((arg) => arg === "-o" || arg.startsWith("--output"));
	if (command === "uniq") return args.every((arg) => arg.startsWith("-"));
	return READ_COMMANDS.has(command);
}

/** Every quoted `sed` script in the command line must be a plain line-range print. */
function sedScriptsArePrintOnly(original: string): boolean {
	const quoted = [...original.matchAll(/sed\s+(?:-n\s+)?(?:(['"])([^'"]*)\1)/g)].map((m) => m[2] ?? "");
	return quoted.every((script) => SED_PRINT_SCRIPT.test(script));
}

/** True only when each part of the command line is a known read command with no
 *  write-capable option, and no file redirect or substitution is present. */
export function isProvablyReadOnlyShellCommand(command: string): boolean {
	if (command.trim() === "" || command.includes("<<")) return false;
	const masked = maskQuotes(command);
	if (masked === null) return false;
	const plain = stripInertRedirects(masked);
	if (/[<>`$()]/.test(plain)) return false;
	const segments = plain.split(/\|\||&&|[|;\n]/);
	if (segments.some((segment) => segment.includes("&"))) return false; // background job
	return segments.every((segment) => segment.trim() === "" ? false : segmentIsReadOnly(segment, command));
}
