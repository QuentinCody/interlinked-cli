// `ubs_subprocess_shell_true` (Python) — split out of python-checks.ts so the
// detector's precision work does not push that module over the line cap.
//
// The 2026-10-21 adversarial review found legitimate code the original
// `subprocess\.X\([\s\S]{0,500}?shell=True` window blocked:
//   - a multi-line docstring that merely mentions `subprocess.run(cmd, shell=True)`
//   - a safe list-arg call followed, within 500 chars, by an UNRELATED call or
//     `def` carrying `shell=True` (the window crossed the closing paren)
//   - `shell=True` passed to a nested call inside the arguments
//   - a fixed string-literal command (`subprocess.run("make html | tail", shell=True)`):
//     no part of the command can originate from input, which is the injection
//     surface the check names
//   - Bandit's own `# nosec B602` / bare `# nosec` acknowledgment

import { nonNull } from "../../../lib/non-null.js";
import { getExtension, type InlineMatch, isVendoredOrFixturePath, stripCommentsAndStrings } from "../shared.js";
import { blankPythonTripleQuotedStrings, isNoqaSuppressedInRange, MATCH_LIMIT } from "./_shared.js";
import { callBodyAt } from "./python-yaml-load.js";

interface CallArg {
	/** Offset of the argument's first character in the call body. */
	start: number;
	text: string;
}

/** Split a call body at depth-0 commas, keeping each argument's body offset. */
function topLevelArgs(body: string): CallArg[] {
	const args: CallArg[] = [];
	let depth = 0;
	let start = 0;
	for (let k = 0; k < body.length; k++) {
		const ch = body.charAt(k);
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) {
			args.push({ start, text: body.slice(start, k) });
			start = k + 1;
		}
	}
	args.push({ start, text: body.slice(start) });
	return args;
}

const SHELL_TRUE_ARG_RE = /^\s*shell\s*=\s*True\s*$/;
const KWARG_RE = /^\s*[A-Za-z_]\w*\s*=(?!=)/;
const ARGS_KWARG_RE = /^\s*args\s*=(?!=)/;

// After stripping, a plain (non-f) string literal is its prefix plus empty
// quotes; a triple-quoted literal is blanked to whitespace entirely.
const LITERAL = `(?:[rRuUbB]|[rR][bB]|[bB][rR])?(?:""|'')`;
const LITERAL_SEQUENCE_RE = new RegExp(`^(?:${LITERAL}\\s*)*$`);
const LITERAL_LIST_RE = new RegExp(`^[[(](?:${LITERAL}|[\\s,])*[\\])]$`);

/** The command argument: the first positional argument, else an `args=` kwarg. */
function commandArg(args: CallArg[]): string | null {
	const first = args[0];
	if (first && !KWARG_RE.test(first.text)) return first.text;
	const named = args.find((arg) => ARGS_KWARG_RE.test(arg.text));
	return named ? named.text.replace(ARGS_KWARG_RE, "") : null;
}

/** Is the command a fixed literal (string, implicit concatenation, or a list/tuple of literals)? */
function isStaticLiteralCommand(command: string | null): boolean {
	if (command === null) return false;
	const trimmed = command.trim();
	return LITERAL_SEQUENCE_RE.test(trimmed) || LITERAL_LIST_RE.test(trimmed);
}

/** Offset (in `stripped`) of the call's own top-level `shell=True` kwarg, or -1. */
function shellTrueOffset(stripped: string, open: number): number {
	const body = callBodyAt(stripped, open);
	const args = topLevelArgs(body);
	const shellArg = args.find((arg) => SHELL_TRUE_ARG_RE.test(arg.text));
	if (!shellArg || isStaticLiteralCommand(commandArg(args))) return -1;
	return open + 1 + shellArg.start + shellArg.text.indexOf("shell");
}

/**
 * Detect `subprocess.<fn>(... shell=True ...)` — command-injection vector.
 *
 * `shell=True` must be a top-level keyword argument of the subprocess call
 * itself (balanced call body), and the command must not be a fixed literal.
 * `[A-Za-z_]+` admits `subprocess.Popen(...)`. A Bandit `# noqa: S602/S603`
 * or `# nosec B602/B603` on any line from the call start to `shell` suppresses.
 */
export function checkSubprocessShellTrue(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".py" && ext !== ".pyi") return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(blankPythonTripleQuotedStrings(content));
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (const m of stripped.matchAll(/\bsubprocess\.[A-Za-z_]+\s*\(/g)) {
		if (matches.length >= MATCH_LIMIT) break;
		// Anchor at `shell` so the warning points at the dangerous keyword.
		const shellIdx = shellTrueOffset(stripped, m.index + m[0].length - 1);
		if (shellIdx === -1) continue;
		const lineNum = stripped.slice(0, shellIdx).split("\n").length;
		// The suppression typically sits on the opening line of a multi-line call.
		const callStartLine = stripped.slice(0, m.index).split("\n").length;
		if (isNoqaSuppressedInRange(originalLines, callStartLine, lineNum, "ubs_subprocess_shell_true")) continue;
		matches.push({ line: lineNum, text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150) });
	}
	return matches;
}
