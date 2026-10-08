// ===========================================
// Inline interpreter programs and heredoc bodies — shared, pure leaf
// ===========================================
// Two PreToolUse classifiers read the PROGRAM a Bash command feeds to an
// interpreter instead of the command line around it:
//   - the inline-interpreter write guard (evaluator/interpreter-write-guard.ts)
//     looks for a write call into repo source;
//   - the network-intent predicate (network-intent.ts) looks for a network API.
// Both need the same answers — which word names an interpreter, where a heredoc
// body starts and ends — so the primitives live here, once. No fs, no env, no
// module-scope mutable state; nothing here imports another harness module.

import { nonNull } from "../lib/non-null.js";

/** An inline program plus how it reached the interpreter. */
export interface InlineProgram {
	interpreter: string;
	form: string;
	body: string;
}

/** Interpreters whose inline programs the classifiers read. `sh`/`bash` are
 *  absent on purpose: a shell program is more shell, which the callers parse as
 *  commands, not as a program in another language. */
const INTERPRETER_WORD_RE = /^(?:[\w.\-/]*\/)?(python3(?:\.\d+)?|python|node|perl|ruby)$/;

/** The interpreter a command word names (`/usr/bin/python3` → `python3`), or null. */
export function interpreterName(word: string): string | null {
	const m = INTERPRETER_WORD_RE.exec(word);
	return m ? nonNull(m[1]) : null;
}

/** Words that precede the real verb without replacing it: wrappers and the
 *  shell's compound keywords (`for …; do python3 -c …; done`, `if …; then …`).
 *  The keywords were added 2026-10-05 with the network-intent predicate: a
 *  segment that starts with `do` or `then` still runs the word after it. */
const TRANSPARENT_PREFIXES = new Set([
	"env", "command", "exec", "nohup", "time", "sudo", "builtin",
	"do", "then", "else", "elif", "if", "while", "until", "!", "{",
]);

/** `VAR=value` prefix assignment (bash evaluates these before the verb). */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Characters that end one command segment and start the next. */
const SEGMENT_BREAKS = ["\n", ";", "&", "|", "("] as const;

/** How far past a segment start we need to look to find its command word. */
const COMMAND_WORD_LOOKAHEAD = 80;

/**
 * The interpreter a command SEGMENT invokes, or null for every other verb.
 * Only the segment's own command word counts — skipping `VAR=` assignments and
 * transparent prefixes — so `cat <<EOF` is not a program and neither is a
 * `python3 -c …` line quoted inside an `echo` argument.
 */
export function interpreterOf(segment: string): string | null {
	for (const word of segment.trim().split(/\s+/)) {
		if (word === "") continue;
		if (ASSIGNMENT_RE.test(word)) continue;
		if (TRANSPARENT_PREFIXES.has(word)) continue;
		return interpreterName(word); // the first real word decides, either way
	}
	return null;
}

/** The interpreter of the segment containing `atIdx`, or null. `atIdx` points at
 *  the heredoc operator (whose segment head precedes it) or at the interpreter
 *  word itself; a bounded look-ahead covers both without scanning a whole body. */
function segmentInterpreter(cmd: string, atIdx: number): string | null {
	const head = cmd.slice(0, atIdx);
	let segStart = -1;
	for (const ch of SEGMENT_BREAKS) segStart = Math.max(segStart, head.lastIndexOf(ch));
	return interpreterOf(cmd.slice(segStart + 1, atIdx + COMMAND_WORD_LOOKAHEAD));
}

/** Heredoc operator + delimiter: `<<EOF`, `<<-EOF`, `<<'PY'`, `<< "SH"`. A
 *  here-STRING (`<<< word`) is not a heredoc: the lookarounds keep its `<<` from
 *  reading the word as a delimiter and swallowing the rest of the command. */
const HEREDOC_RE = /(?<!<)<<(?!<)-?\s*(?:"([A-Za-z_][\w.-]*)"|'([A-Za-z_][\w.-]*)'|([A-Za-z_][\w.-]*))/g;

/** One heredoc: the operator text, its delimiter, its body, and the span of
 *  the command that the body and its terminator line occupy. */
export interface Heredoc {
	/** Index of the `<<` operator in the command. */
	opIndex: number;
	/** The operator as written (`<<'EOF'`). */
	operator: string;
	delimiter: string;
	body: string;
	/** Start of the body (the character after the operator line's newline). */
	bodyStart: number;
	/** End of the terminator line, or the command's end when it is missing. */
	bodyEnd: number;
}

type HeredocSpan = Pick<Heredoc, "body" | "bodyStart" | "bodyEnd">;

/** Body span of a heredoc: the lines after the operator up to the line whose
 *  trimmed text is the delimiter. A missing terminator yields the rest of the
 *  command — a truncated payload still carries its program. */
function heredocSpan(cmd: string, afterOp: number, delimiter: string): HeredocSpan | null {
	const nl = cmd.indexOf("\n", afterOp);
	if (nl === -1) return null;
	const lines = cmd.slice(nl + 1).split("\n");
	const end = lines.findIndex((line) => line.trim() === delimiter);
	const bodyLines = end === -1 ? lines : lines.slice(0, end);
	const spanned = end === -1 ? lines : lines.slice(0, end + 1);
	return { body: bodyLines.join("\n"), bodyStart: nl + 1, bodyEnd: nl + 1 + spanned.join("\n").length };
}

/** Every heredoc in `cmd`, in source order. An operator that sits inside an
 *  earlier heredoc's body (`x << n` in a python program) is program text, not
 *  shell, and is skipped. */
export function findHeredocs(cmd: string): Heredoc[] {
	const out: Heredoc[] = [];
	let consumedTo = -1;
	for (const m of cmd.matchAll(HEREDOC_RE)) {
		const delimiter = m[1] ?? m[2] ?? m[3];
		if (delimiter === undefined || m.index < consumedTo) continue;
		const span = heredocSpan(cmd, m.index + m[0].length, delimiter);
		if (span === null) continue;
		out.push({ opIndex: m.index, operator: m[0], delimiter, ...span });
		consumedTo = span.bodyEnd;
	}
	return out;
}

/** Programs fed to an interpreter on stdin via a heredoc. */
export function collectHeredocPrograms(cmd: string): InlineProgram[] {
	const programs: InlineProgram[] = [];
	for (const doc of findHeredocs(cmd)) {
		const interpreter = segmentInterpreter(cmd, doc.opIndex);
		if (!interpreter) continue;
		programs.push({ interpreter, form: `heredoc (<<${doc.delimiter})`, body: doc.body });
	}
	return programs;
}

/** `python3 -c "…"` / `node -e '…'`, with optional flags before the script. */
const INLINE_FLAG_RE =
	/(?:[\w.\-/]*\/)?(python3(?:\.\d+)?|python|node|perl|ruby)\s+(?:-[A-Za-z-]\S*\s+){0,6}?-([ce])\s+("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')/g;

/** Programs passed inline with `-c` / `-e`. */
export function collectFlagPrograms(cmd: string): InlineProgram[] {
	const programs: InlineProgram[] = [];
	for (const m of cmd.matchAll(INLINE_FLAG_RE)) {
		const quoted = m[3];
		if (quoted === undefined) continue;
		// The interpreter must be the segment's command word, not a word inside
		// another command's quoted argument (`echo "python3 -c …"` is data).
		const interpreterIdx = m.index + m[0].indexOf(nonNull(m[1]));
		if (!segmentInterpreter(cmd, interpreterIdx)) continue;
		programs.push({
			interpreter: nonNull(m[1]),
			form: `-${nonNull(m[2])}`,
			body: quoted.slice(1, -1),
		});
	}
	return programs;
}
