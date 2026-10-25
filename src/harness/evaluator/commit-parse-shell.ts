// ===========================================
// git-command detection — shell-semantic command units
// ===========================================
// The commit-time gates must see EVERY command a Bash string runs. The old
// blessed splitter split on `;` `&&` `||` `|` `&` only, so a newline was not a
// separator and a leading `# note` line read as a comment to the end of the
// WHOLE command: `# note\ngit commit -m x` hid the commit from every commit gate
// (red-team 2026-10-21, "plumbing-verb commit", rounds 2 and 3). This module is
// now THE segmenter: {@link shellUnits} for the git parsers, and the blessed
// {@link splitSegments} (re-exported by shell-structure.ts) for every other
// command classifier. It segments by shell semantics:
//
//   - newline, `;`, `&&`, `||`, `|`, `|&`, `&` separate commands outside quotes;
//   - `#` starts a comment only at the start of a word, and ends at the newline;
//   - backslash-newline joins two lines;
//   - heredoc bodies (`<<EOF`, `<<-EOF`, quoted delimiters) are DATA, except a
//     body fed to a shell reading stdin (`bash <<EOF`), which is a program, and
//     the `$(…)` / backtick substitutions of an UNQUOTED body, which run;
//   - `$(…)`, backticks, `(…)` subshells and `<(…)` process substitutions are
//     recursed into as child SCOPES (a `cd` inside one does not leak out);
//   - redirections (`> f`, `2>&1`, `<<< w`) are removed from argv, so a target
//     is never read as a pathspec;
//   - wrappers are unwrapped by commit-parse-unwrap.ts (`env`, `sudo`, `command`, `exec`, `nohup`, `time`,
//     `nice`, `timeout`, `xargs`, `stdbuf`, `doas`, `ionice`, `VAR=` prefixes,
//     control keywords, case arms), and inline programs expanded (`bash -c '…'`,
//     `eval …`, `env -S '…'`).
//
// Pure: no fs, no env, no module-scope mutable state. Linear per nesting level;
// nesting is bounded by MAX_DEPTH (deeper content is not seen). Deliberately NOT
// covered (documented residuals): git aliases from config, scripts that run git
// internally (`bash x.sh`, `python -c …`, a Makefile), text piped into a shell
// (`echo … | sh`), `eval` of a runtime value, and `)` inside a `case` arm or a
// comment within `$(…)`.
import { nonNull } from "../../lib/non-null.js";
import { combineCwd, literalDir, shellSplit } from "./commit-parse-tokens.js";
import { isShellName, unwrapCommand } from "./commit-parse-unwrap.js";

/** One simple command the string runs, after wrapper stripping. */
export interface ShellUnit {
	/** argv with quotes removed, redirections dropped, wrappers stripped. */
	argv: string[];
	/** "" for top level; `.n` suffixes for each nested substitution / subshell / program. */
	scope: string;
	/** Directory a wrapper sets (`env -C dir`), or null. */
	wrapperCwd: string | null;
}

/** Recursion bound across substitutions, subshells and `sh -c` programs. */
const MAX_DEPTH = 8;
/** Marks a redirection target in segment text; such tokens are dropped from argv. */
const REDIRECT_MARK = "\u0000";
/** Stands in for a substitution's output in the parent's argv (non-literal on purpose). */
const SUBSTITUTION_PLACEHOLDER = "$__SUBSTITUTION__";

/** One raw command of one scope, in execution order. */
interface RawSegment {
	text: string;
	/** The command's SOURCE slice: comments cut, heredoc bodies not included. */
	source: string;
	scope: string;
	heredocs: string[];
}

interface PendingHeredoc {
	delimiter: string;
	stripTabs: boolean;
	quoted: boolean;
	owner: string[];
}

interface Scan {
	src: string;
	i: number;
	cur: string;
	heredocs: string[];
	pending: PendingHeredoc[];
	nested: RawSegment[];
	out: RawSegment[];
	scope: string;
	depth: number;
	children: { n: number };
	/** Source index where the current command starts. */
	start: number;
	/** Source index of the current command's `#` comment, or -1. */
	commentAt: number;
}

function newScan(src: string, scope: string, depth: number, children: { n: number }): Scan {
	return { src, i: 0, cur: "", heredocs: [], pending: [], nested: [], out: [], scope, depth, children, start: 0, commentAt: -1 };
}

/** A fresh child scope id under `scope`. */
function childScope(scope: string, children: { n: number }): string {
	children.n += 1;
	return `${scope}.${children.n}`;
}

/** Segments of a child scope (a substitution body or subshell), or [] past the bound. */
function childSegments(s: Scan, body: string): RawSegment[] {
	if (s.depth >= MAX_DEPTH) return [];
	return scanSegments(body, childScope(s.scope, s.children), s.depth + 1, s.children);
}

function atWordStart(s: Scan): boolean {
	return s.cur.length === 0 || /\s$/.test(s.cur);
}

/**
 * End the current command: its substitutions ran first, then the command itself.
 * A command whose argv text is empty but whose source is not (a bare `( … )`
 * subshell) is still kept, so {@link splitSegments} reports it.
 */
function finishSegment(s: Scan): void {
	s.out.push(...s.nested);
	const source = s.src.slice(s.start, s.commentAt >= 0 ? s.commentAt : s.i);
	if (s.cur.trim().length > 0 || source.trim().length > 0) {
		s.out.push({ text: s.cur, source, scope: s.scope, heredocs: s.heredocs });
	}
	s.nested = [];
	s.cur = "";
	s.heredocs = [];
}

/** Start the next command at the current scan position. */
function beginSegment(s: Scan): void {
	s.start = s.i;
	s.commentAt = -1;
}

/** Index of the `'` closing the single quote at `at`, or the last index. */
function endOfSingle(src: string, at: number): number {
	const close = src.indexOf("'", at + 1);
	return close < 0 ? src.length - 1 : close;
}

/** Index of the `close` char ending the quote / backtick at `at` (escapes honored), or the last index. */
function endOfEscaped(src: string, at: number, close: string): number {
	for (let i = at + 1; i < src.length; i++) {
		if (src[i] === "\\") i++;
		else if (src[i] === close) return i;
	}
	return src.length - 1;
}

/** Index of the `)` closing a group opened just before `from` (quote- and nesting-aware), or the end. */
function findClose(src: string, from: number): number {
	let depth = 1;
	for (let i = from; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") i++;
		else if (c === "'") i = endOfSingle(src, i);
		else if (c === '"') i = endOfEscaped(src, i, '"');
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return src.length;
}

/** Recurse into `body` as a child scope and leave a placeholder for its output. */
function enterSubstitution(s: Scan, body: string, end: number, recurse: boolean): void {
	if (recurse) s.nested.push(...childSegments(s, body));
	s.cur += SUBSTITUTION_PLACEHOLDER;
	s.i = end + 1;
}

/**
 * At `$(`, `$((` or a backtick: recurse into the body (an arithmetic `$((…))`
 * holds no commands). Returns true when it consumed a substitution.
 */
function consumeSubstitution(s: Scan): boolean {
	const { src, i } = s;
	if (src[i] === "`") {
		const end = endOfEscaped(src, i, "`");
		enterSubstitution(s, src.slice(i + 1, end).replace(/\\`/g, "`"), end, true);
		return true;
	}
	if (src[i] !== "$" || src[i + 1] !== "(") return false;
	const end = findClose(src, i + 2);
	enterSubstitution(s, src.slice(i + 2, end), end, src[i + 2] !== "(");
	return true;
}

/** Inside double quotes: escapes, substitutions, and the closing quote. */
function consumeDouble(s: Scan): void {
	s.cur += '"';
	s.i++;
	while (s.i < s.src.length) {
		const c = nonNull(s.src[s.i]);
		if (c === "\\") {
			const next = s.src[s.i + 1] ?? "";
			if (next !== "\n") s.cur += c + next;
			s.i += 2;
		} else if (!consumeSubstitution(s)) {
			s.cur += c;
			s.i++;
			if (c === '"') return;
		}
	}
}

function consumeSingle(s: Scan): void {
	const end = endOfSingle(s.src, s.i);
	s.cur += s.src.slice(s.i, end + 1);
	s.i = end + 1;
}

function skipBlanks(s: Scan): void {
	while (s.src[s.i] === " " || s.src[s.i] === "\t") s.i++;
}

/** One part of a heredoc delimiter word at `s.i`: its text, and whether it was quoted. */
function delimiterPart(s: Scan): { text: string; quoted: boolean } {
	const c = nonNull(s.src[s.i]);
	if (c === "'" || c === '"') {
		const end = c === "'" ? endOfSingle(s.src, s.i) : endOfEscaped(s.src, s.i, '"');
		const text = s.src.slice(s.i + 1, end);
		s.i = end + 1;
		return { text, quoted: true };
	}
	if (c === "\\") {
		s.i += 2;
		return { text: s.src[s.i - 1] ?? "", quoted: true };
	}
	s.i++;
	return { text: c, quoted: false };
}

/** Read the heredoc delimiter word at `s.i` (quotes removed), noting whether any part was quoted. */
function readDelimiter(s: Scan): { word: string; quoted: boolean } {
	skipBlanks(s);
	let word = "";
	let quoted = false;
	while (s.i < s.src.length && !/[\s;&|<>()]/.test(nonNull(s.src[s.i]))) {
		const part = delimiterPart(s);
		word += part.text;
		quoted ||= part.quoted;
	}
	return { word, quoted };
}

/** Redirection operator length at `i` (`>`, `>>`, `>|`, `>&`, `<`, `<>`, `<&`, `<<<`, `&>`, `&>>`). */
function redirectLength(src: string, i: number): number {
	if (src.startsWith("<<<", i) || src.startsWith("&>>", i)) return 3;
	return [">>", ">|", ">&", "<>", "<&", "&>"].includes(src.slice(i, i + 2)) ? 2 : 1;
}

/** At an unquoted `<` / `>` / `&>`: a process substitution, a heredoc, or a redirection. */
function consumeRedirect(s: Scan): void {
	const { src, i } = s;
	if (src[i + 1] === "(" && src[i] !== "&") {
		const end = findClose(src, i + 2);
		enterSubstitution(s, src.slice(i + 2, end), end, true);
		return;
	}
	if (src.startsWith("<<", i) && !src.startsWith("<<<", i)) {
		const stripTabs = src[i + 2] === "-";
		s.i += stripTabs ? 3 : 2;
		const { word, quoted } = readDelimiter(s);
		s.pending.push({ delimiter: word, stripTabs, quoted, owner: s.heredocs });
		s.cur += " "; // the operator and its delimiter never reach argv
		return;
	}
	s.cur = s.cur.replace(/(^|\s)\d+$/, "$1"); // an fd prefix (`2>`) belongs to the operator
	s.i += redirectLength(src, i);
	skipBlanks(s);
	s.cur += ` ${REDIRECT_MARK}`; // the target word that follows is not an argument
}

/** Read the heredoc body that starts at `s.i`, through its delimiter line (or the end). */
function readHeredocBody(s: Scan, p: PendingHeredoc): string {
	const lines: string[] = [];
	while (s.i < s.src.length) {
		const nl = s.src.indexOf("\n", s.i);
		const end = nl < 0 ? s.src.length : nl;
		const line = s.src.slice(s.i, end);
		s.i = end + 1;
		if ((p.stripTabs ? line.replace(/^\t+/, "") : line) === p.delimiter) break;
		lines.push(line);
	}
	return lines.join("\n");
}

/** The `$(…)` / backtick commands an UNQUOTED heredoc body expands (they run). */
function bodySubstitutions(s: Scan, body: string): RawSegment[] {
	const inner = newScan(body, s.scope, s.depth, s.children);
	while (inner.i < body.length) {
		if (body[inner.i] === "\\") inner.i += 2;
		else if (!consumeSubstitution(inner)) inner.i++;
	}
	return inner.nested;
}

/** Consume the bodies of the heredocs registered on the line that just ended. */
function consumeHeredocBodies(s: Scan): void {
	for (const p of s.pending.splice(0)) {
		const body = readHeredocBody(s, p);
		p.owner.push(body);
		if (!p.quoted) s.out.push(...bodySubstitutions(s, body));
	}
}

/** A `;` `&` `|` separator at `s.i` (an `&>` was already taken as a redirect): its length, or 0. */
function separatorLength(s: Scan): number {
	const c = s.src[s.i];
	const next = s.src[s.i + 1];
	if (c === ";") return next === ";" ? 2 : 1;
	if (c === "|") return next === "|" || next === "&" ? 2 : 1;
	if (c === "&") return next === "&" ? 2 : 1;
	return 0;
}

/** One unquoted character that is not a separator, redirect, quote or substitution. */
function consumePlain(s: Scan): void {
	const c = nonNull(s.src[s.i]);
	const next = s.src[s.i + 1];
	if (c === "\\") {
		if (next !== "\n" && next !== undefined) s.cur += c + next; // backslash-newline joins
		s.i += 2;
	} else if (c === "#" && atWordStart(s)) {
		if (s.commentAt < 0) s.commentAt = s.i;
		const nl = s.src.indexOf("\n", s.i);
		s.i = nl < 0 ? s.src.length : nl; // the comment ends at its newline
	} else if (c === "(" && atWordStart(s)) {
		const end = findClose(s.src, s.i + 1);
		s.nested.push(...childSegments(s, s.src.slice(s.i + 1, end)));
		s.i = end + 1;
	} else {
		s.cur += c;
		s.i++;
	}
}

/** Process one unquoted position of the scan. */
function step(s: Scan): void {
	const c = s.src[s.i];
	if (c === "\n") {
		finishSegment(s);
		s.i++;
		consumeHeredocBodies(s);
		beginSegment(s);
		return;
	}
	if (c === "'") return consumeSingle(s);
	if (c === '"') return consumeDouble(s);
	if (consumeSubstitution(s)) return;
	if (c === "<" || c === ">" || (c === "&" && s.src[s.i + 1] === ">")) return consumeRedirect(s);
	const sep = separatorLength(s);
	if (sep === 0) return consumePlain(s);
	finishSegment(s);
	s.i += sep;
	beginSegment(s);
}

function scanSegments(src: string, scope: string, depth: number, children: { n: number }): RawSegment[] {
	const s = newScan(src, scope, depth, children);
	while (s.i < src.length) step(s);
	finishSegment(s);
	return s.out;
}

// ---- units -----------------------------------------------------------------

/** True when argv is a shell reading its program from stdin (`bash`, `sh -s`, `bash -e`). */
function shellReadsStdin(argv: string[]): boolean {
	return isShellName(nonNull(argv[0])) && argv.slice(1).every((t) => /^[-+]/.test(t));
}

/** Units of one raw segment, recursing into an inline program (`bash -c`, `eval`, `bash <<EOF`). */
function segmentUnits(seg: RawSegment, depth: number, children: { n: number }): ShellUnit[] {
	const argv = shellSplit(seg.text).filter((t) => !t.startsWith(REDIRECT_MARK));
	const u = unwrapCommand(argv);
	if (u === null) return [];
	const programs = u.program !== null ? [u.program] : shellReadsStdin(u.argv) ? seg.heredocs : [];
	if (programs.length === 0) return [{ argv: u.argv, scope: seg.scope, wrapperCwd: u.cwd }];
	if (depth >= MAX_DEPTH) return [];
	return programs.flatMap((program) => {
		const scope = childScope(seg.scope, children);
		// A wrapper's chdir is local to the program it launches. Seed that
		// child scope before its commands so inner cd hops inherit the wrapper
		// directory and later parent commands keep their original directory.
		const setup: ShellUnit[] = u.cwd === null ? [] : [{ argv: ["cd", u.cwd], scope, wrapperCwd: null }];
		return [...setup, ...unitsOf(program, scope, depth + 1, children)];
	});
}

function unitsOf(command: string, scope: string, depth: number, children: { n: number }): ShellUnit[] {
	return scanSegments(command, scope, depth, children).flatMap((seg) => segmentUnits(seg, depth, children));
}

/**
 * Every simple command `command` runs, in execution order, with wrappers
 * stripped and nested programs expanded. THE segmentation the commit parser
 * uses — see the module header for the shell rules it models.
 */
export function shellUnits(command: string): ShellUnit[] {
	return unitsOf(command, "", 0, { n: 0 });
}

/**
 * THE blessed segmenter (shell-structure.ts contract): the top-level commands of
 * `command`, each as its SOURCE slice, in order. Same shell rules as
 * {@link shellUnits} because it is the same scan: newline, `;`, `&&`, `||`, `|`,
 * `|&` and `&` separate commands outside quotes; a `#` comment is cut at a word
 * start and ends at its newline; heredoc bodies are data and never a segment; a
 * backslash-newline stays inside its command ({@link shellSplit} joins it).
 * Substitutions and subshells stay inside their parent's slice — a classifier
 * that must see their commands uses {@link shellUnits}. A slice is a substring of
 * `command`, so a caller may locate it with `indexOf`.
 */
export function splitSegments(command: string): string[] {
	return scanSegments(command, "", 0, { n: 0 })
		.filter((seg) => seg.scope === "")
		.map((seg) => seg.source);
}

/** True when the scan stands on a `;` / `&` / `|` separator before any text of
 *  the current command: an empty command, which the shell refuses. */
function atEmptyCommandSeparator(s: Scan): boolean {
	if (s.src[s.i] === "&" && s.src[s.i + 1] === ">") return false; // `&>` is a redirect
	if (separatorLength(s) === 0 || s.nested.length > 0) return false;
	return s.cur.trim() === "" && s.src.slice(s.start, s.i).trim() === "";
}

/**
 * The FIRST top-level command of `command` as its source slice — the same
 * segmentation as `splitSegments(command)[0]` — except that a command opening
 * with a separator (`&& git add x`, `; python3`) yields "": the shell rejects
 * an empty command as a syntax error, so nothing runs. Leading blank lines and
 * comment lines are skipped, as the shell skips them. For the classifiers that
 * look only at the head command of a line.
 */
export function leadingCommand(command: string): string {
	const s = newScan(command, "", 0, { n: 0 });
	const first = (): RawSegment | undefined => s.out.find((seg) => seg.scope === "");
	while (s.i < command.length && first() === undefined) {
		if (atEmptyCommandSeparator(s)) return "";
		step(s);
	}
	if (first() === undefined) finishSegment(s);
	return first()?.source ?? "";
}

/** True when `token` is the git binary (`git`, `/usr/bin/git`, `git.exe`). */
export function isGitBinary(token: string | undefined): boolean {
	return token !== undefined && /(?:^|[/\\])git(?:\.exe)?$/.test(token);
}

/** The literal target of a `cd` / `pushd` unit, or null (not a cd, or not static). */
export function cdTargetOf(argv: string[]): string | null {
	if (argv.length < 2 || (argv[0] !== "cd" && argv[0] !== "pushd")) return null;
	const dir = argv.slice(1).find((t) => !t.startsWith("-"));
	if (dir === undefined || dir === "-" || dir.startsWith("~")) return null;
	return literalDir(dir);
}

/**
 * `cd` state per scope: a child scope (substitution, subshell, `sh -c`)
 * starts from its parent's directory when first seen, and its own `cd` never
 * changes the parent's.
 */
export class ScopedCwd {
	private readonly dirs = new Map<string, string | null>();

	get(scope: string): string | null {
		const known = this.dirs.get(scope);
		if (known !== undefined) return known;
		const dir = scope === "" ? null : this.get(scope.slice(0, scope.lastIndexOf(".")));
		this.dirs.set(scope, dir);
		return dir;
	}

	cd(scope: string, dir: string): void {
		this.dirs.set(scope, combineCwd(this.get(scope), dir));
	}

	/** The effective directory of a unit: its scope's cwd, then the wrapper's `-C`. */
	of(unit: ShellUnit): string | null {
		return combineCwd(this.get(unit.scope), unit.wrapperCwd);
	}
}
