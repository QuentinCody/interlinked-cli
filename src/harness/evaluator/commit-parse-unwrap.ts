// ===========================================
// git-command detection — wrapper stripping
// ===========================================
// Strip the words in front of a real command so the commit gates see git
// however it is launched: `env [-i] [-C dir] [VAR=…]`, `sudo`, `doas`,
// `command`, `exec`, `nohup`, `time`, `nice`, `ionice`, `timeout`, `xargs`,
// `stdbuf`, `VAR=` prefixes, control keywords, function headers and case
// arms. Inline programs (`bash -c '…'`, `sh -lc "…"`, `eval …`, `env -S '…'`)
// are returned as `program` so the caller (commit-parse-shell.ts) segments
// them as a child scope. Pure; no fs, no env, no module-scope mutable state.
import { nonNull } from "../../lib/non-null.js";
import { combineCwd, literalDir } from "./commit-parse-tokens.js";

/** Interpreters whose `-c` operand, or heredoc on stdin, is a shell program. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);

/** True when `token` names a shell interpreter (`bash`, `/bin/sh`, …). */
export function isShellName(token: string): boolean {
	return SHELLS.has(token.slice(token.lastIndexOf("/") + 1));
}

interface WrapperSpec {
	/** Flags that consume the next token (or an attached / `=` value). */
	value: ReadonlySet<string>;
	/** Flags that change the directory the command runs in. */
	cwd?: ReadonlySet<string>;
	/** Flags whose value is a shell program (`env -S`). */
	program?: ReadonlySet<string>;
	/** Flags that make the wrapper run nothing (`command -v`). */
	stop?: ReadonlySet<string>;
	/** Positional operands before the command (`timeout DURATION cmd`). */
	positional?: number;
}

const set = (...xs: string[]): ReadonlySet<string> => new Set(xs);

const WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
	env: {
		value: set("-u", "--unset", "-C", "--chdir", "-S", "--split-string"),
		cwd: set("-C", "--chdir"),
		program: set("-S", "--split-string"),
	},
	sudo: { value: set("-u", "-g", "-C", "-D", "-U", "-h", "-p", "-r", "-t", "--user", "--group"), cwd: set("-D") },
	doas: { value: set("-u", "-C") },
	command: { value: set(), stop: set("-v", "-V") },
	exec: { value: set("-a") },
	nohup: { value: set() },
	time: { value: set("-f", "-o", "--format", "--output") },
	nice: { value: set("-n", "--adjustment") },
	ionice: { value: set("-c", "-n", "-p", "--class", "--classdata") },
	timeout: { value: set("-s", "-k", "--signal", "--kill-after"), positional: 1 },
	xargs: { value: set("-I", "-i", "-n", "-P", "-L", "-l", "-d", "-E", "-e", "-s", "-a", "--arg-file", "--delimiter") },
	stdbuf: { value: set("-i", "-o", "-e", "--input", "--output", "--error") },
};

/** Words that precede the real command of a compound statement, or close one. */
const KEYWORDS = set("if", "then", "elif", "else", "do", "while", "until", "!", "{", "}", "fi", "done", "esac");

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

interface Flag {
	flag: string;
	value: string | null;
	next: number;
}

/** The flag at `argv[i]` (separate, attached or `--x=v` value), or null at the first operand. */
function readFlag(argv: string[], i: number, value: ReadonlySet<string>): Flag | null {
	const t = argv[i];
	if (t === undefined || !t.startsWith("-") || t === "-") return null;
	const eq = t.indexOf("=");
	if (t.startsWith("--") && eq > 0) return { flag: t.slice(0, eq), value: t.slice(eq + 1), next: i + 1 };
	if (value.has(t)) return { flag: t, value: argv[i + 1] ?? null, next: i + 2 };
	const short = t.slice(0, 2);
	if (!t.startsWith("--") && t.length > 2 && value.has(short)) return { flag: short, value: t.slice(2), next: i + 1 };
	return { flag: t, value: null, next: i + 1 };
}

/** The command behind the wrappers; `program` is set for an inline shell program. */
export interface Unwrapped {
	argv: string[];
	cwd: string | null;
	program: string | null;
}

/** Strip one wrapper per its spec; "stop" when it runs nothing. */
function unwrapWith(argv: string[], spec: WrapperSpec): Unwrapped | "stop" {
	let i = 1;
	let cwd: string | null = null;
	for (let f = readFlag(argv, i, spec.value); f !== null; f = readFlag(argv, i, spec.value)) {
		i = f.next;
		if (f.flag === "--") break;
		if (spec.stop?.has(f.flag)) return "stop";
		if (spec.program?.has(f.flag)) return { argv: [], cwd, program: f.value ?? "" };
		if (spec.cwd?.has(f.flag) && f.value !== null) cwd = literalDir(f.value);
	}
	return { argv: argv.slice(i + (spec.positional ?? 0)), cwd, program: null };
}

/** `bash -c '…'` / `sh -lc "…"`: the program operand, or null for a script / stdin shell. */
function shellProgram(argv: string[]): string | null {
	for (let i = 1; i < argv.length; i++) {
		const t = nonNull(argv[i]);
		if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) return argv[i + 1] ?? "";
		if (/^[-+][oO]$/.test(t)) i++;
		else if (!/^[-+]/.test(t)) return null;
	}
	return null;
}

/** The argv after a leading keyword, assignment, function header or case arm; null when none. */
function stripSyntax(argv: string[]): string[] | null {
	const head = nonNull(argv[0]);
	if (KEYWORDS.has(head) || ASSIGNMENT_RE.test(head) || /^[\w.:-]+\(\)$/.test(head)) return argv.slice(1);
	if (head === "function") return argv.slice(2);
	if (head === "case") {
		const rest = argv.slice(argv.indexOf("in") + 1);
		return argv.includes("in") && rest[0]?.endsWith(")") ? rest.slice(1) : [];
	}
	return head.endsWith(")") ? argv.slice(1) : null; // a later case arm: `b) cmd`
}

/** One unwrapping step: the inner command, "stop", or null when `argv` is the command itself. */
function unwrapStep(argv: string[]): Unwrapped | "stop" | null {
	const syntax = stripSyntax(argv);
	if (syntax !== null) return { argv: syntax, cwd: null, program: null };
	const head = nonNull(argv[0]);
	const name = head.slice(head.lastIndexOf("/") + 1);
	if (name === "eval") return { argv: [], cwd: null, program: argv.slice(1).join(" ") };
	if (SHELLS.has(name)) {
		const program = shellProgram(argv);
		return program === null ? null : { argv: [], cwd: null, program };
	}
	const spec = WRAPPERS[name];
	return spec ? unwrapWith(argv, spec) : null;
}

/**
 * Strip wrappers, keywords and assignments from `argv` until the real command
 * is at the head. Returns null when nothing runs; `program` is set when the
 * command is an inline shell program to recurse into.
 */
export function unwrapCommand(argv: string[]): Unwrapped | null {
	let rest = argv;
	let cwd: string | null = null;
	for (let guard = 0; guard < 64 && rest.length > 0; guard++) {
		const next = unwrapStep(rest);
		if (next === "stop") return null;
		if (next === null) return { argv: rest, cwd, program: null };
		cwd = combineCwd(cwd, next.cwd);
		if (next.program !== null) return { argv: [], cwd, program: next.program };
		rest = next.argv;
	}
	return null;
}
