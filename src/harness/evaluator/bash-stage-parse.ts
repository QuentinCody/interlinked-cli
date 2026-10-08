// ===========================================
// Bash stage parsing for the taint origin classifier
// ===========================================
// The secret-output origin classifier (secret-output-origin.ts) and the
// external-origin file registry (external-origin-files.ts) need two things
// the blessed `splitSegments` contract does not keep: WHICH separator joined
// two segments (a pipe carries data, `;` / `&&` do not) and the redirect
// operators of each segment. This module adds only that layer. Argument
// tokens still come from the blessed `shellSplit` / `stripLeadingPrefix`.
//
// Everything here is fail-safe for the taint gate: a shape it does not model
// is reported as `dynamic` (or yields null), and the callers then keep the
// old behavior (ratchet to Confidential, record nothing).

import { nonNull } from "../../lib/non-null.js";
import { shellSplit, stripLeadingPrefix } from "../shell-structure.js";

export interface Stage {
	/** Raw stage text, redirects included. */
	text: string;
	/** Offset in the full command just past this stage (for cd-hop resolution). */
	end: number;
	/** argv with redirects removed, env/sudo prefixes and loop keywords stripped. */
	argv: string[];
	/** `>` / `>>` / `&>` targets (stdout or stderr) of this stage. */
	outputs: string[];
	/** `<` input files of this stage. */
	inputs: string[];
	/** Command/process substitution, grouping, braces, a heredoc, or an
	 *  unreadable redirect target: the stage is not modeled. */
	dynamic: boolean;
}

export interface Pipeline {
	stages: Stage[];
}

/** Keywords that precede the real command in a compound statement. */
const LEADING_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!"]);

/** Replace quoted content (and escaped characters) with `_` so separators
 *  and redirect operators can be found by position. Same length as input. */
export function maskQuoted(s: string): string {
	let out = "";
	let quote: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = nonNull(s[i]);
		if (c === "\\" && i + 1 < s.length && quote !== "'") {
			out += "__";
			i++;
			continue;
		}
		if (quote === null) {
			if (c === "'" || c === '"') quote = c;
			out += c;
			continue;
		}
		if (c === quote) quote = null;
		out += quote === null ? c : "_";
	}
	return out;
}

type Separator = { kind: "pipe" | "statement"; len: number };

function pipeSeparator(next: string | undefined, prev: string | undefined): Separator | null {
	if (next === "|") return { kind: "statement", len: 2 };
	if (prev === ">") return null; // `>|` clobber redirect
	return { kind: "pipe", len: next === "&" ? 2 : 1 };
}

function ampSeparator(next: string | undefined, prev: string | undefined): Separator | null {
	if (next === "&") return { kind: "statement", len: 2 };
	if (next === ">" || prev === ">" || prev === "<") return null; // `&>`, `2>&1`
	return { kind: "statement", len: 1 };
}

function separatorAt(m: string, i: number): Separator | null {
	const c = m[i];
	if (c === "\n") return { kind: "statement", len: 1 };
	if (c === ";") return { kind: "statement", len: m[i + 1] === ";" ? 2 : 1 };
	if (c === "|") return pipeSeparator(m[i + 1], m[i - 1]);
	if (c === "&") return ampSeparator(m[i + 1], m[i - 1]);
	return null;
}

/** Split a command into statements (`;`, `&&`, `||`, `&`, newline), each a
 *  pipeline of stages joined by `|`. Quote-aware. */
export function splitPipelines(command: string): Pipeline[] {
	const masked = maskQuoted(command);
	const pipelines: Pipeline[] = [];
	let stages: Stage[] = [];
	let start = 0;
	const flushStage = (end: number) => {
		const text = command.slice(start, end);
		if (text.trim() !== "") stages.push(parseStage(text, end));
	};
	for (let i = 0; i < masked.length; i++) {
		const sep = separatorAt(masked, i);
		if (!sep) continue;
		flushStage(i);
		if (sep.kind === "statement" && stages.length > 0) {
			pipelines.push({ stages });
			stages = [];
		}
		i += sep.len - 1;
		start = i + 1;
	}
	flushStage(masked.length);
	if (stages.length > 0) pipelines.push({ stages });
	return pipelines;
}

/** Read one shell word starting at `from` (after blanks). */
function readWord(text: string, from: number): { word: string; end: number } | null {
	let i = from;
	while (i < text.length && /[ \t]/.test(nonNull(text[i]))) i++;
	const q = text[i];
	if (q === "'" || q === '"') {
		const close = text.indexOf(q, i + 1);
		return close < 0 ? null : { word: text.slice(i + 1, close), end: close + 1 };
	}
	const m = /^[^\s;&|<>()]+/.exec(text.slice(i));
	return m ? { word: m[0], end: i + m[0].length } : null;
}

const REDIRECT_RE = /(\d*|&)(>>|>\||>|<<<|<<|<)(&\d*-?)?/g;

function hasUnmodeledSyntax(text: string, masked: string): boolean {
	if (/\$\(|`|<\(|>\(/.test(text)) return true;
	return /[(){}]/.test(masked.replace(/\$\{[A-Za-z_]\w*\}/g, ""));
}

/** Strip env/sudo prefixes and leading loop / conditional keywords. */
export function stripStageKeywords(tokens: string[]): string[] {
	let out = stripLeadingPrefix(tokens);
	while (out.length > 0 && LEADING_KEYWORDS.has(nonNull(out[0]))) {
		out = stripLeadingPrefix(out.slice(1));
	}
	return out;
}

/** Record one redirect operator match on `stage` and blank it out of `chars`. */
function applyRedirect(stage: Stage, chars: string[], m: RegExpMatchArray & { index: number }): void {
	const op = nonNull(m[2]);
	const opEnd = m.index + m[0].length;
	if (op === "<<" || op === "<<<") stage.dynamic = true;
	const isDup = m[3] !== undefined;
	const target = isDup ? null : readWord(stage.text, opEnd);
	if (!isDup && target === null) stage.dynamic = true;
	chars.fill(" ", m.index, target ? target.end : opEnd);
	if (target) (op === "<" ? stage.inputs : stage.outputs).push(target.word);
}

function parseStage(text: string, end: number): Stage {
	const masked = maskQuoted(text);
	const chars = text.split("");
	const stage: Stage = { text, end, argv: [], outputs: [], inputs: [], dynamic: hasUnmodeledSyntax(text, masked) };
	for (const m of masked.matchAll(REDIRECT_RE)) applyRedirect(stage, chars, m);
	stage.argv = stripStageKeywords(shellSplit(chars.join("")));
	return stage;
}

/** Last path segment of a command token, lower-cased (`/usr/bin/curl` → `curl`). */
export function commandHead(token: string | undefined): string {
	if (token === undefined) return "";
	return (token.split("/").pop() ?? token).toLowerCase();
}

/** True when a token still carries a shell expansion this module did not resolve. */
export function hasUnresolvedVar(token: string): boolean {
	return /\$[A-Za-z_{(0-9@*#?!$-]/.test(token);
}

/** Bind `NAME=value` tokens at the start of `raw` (literal values only). */
function bindAssignments(raw: readonly string[], vars: Map<string, string[]>): void {
	for (const tok of raw) {
		const m = /^([A-Za-z_]\w*)=(.*)$/.exec(tok);
		if (!m) return;
		if (!hasUnresolvedVar(nonNull(m[2]))) vars.set(nonNull(m[1]), [nonNull(m[2])]);
	}
}

/** Variables bound to literal values in the same command: `for NAME in a b c`
 *  lists and `NAME=value` statements. A value that itself expands is not bound. */
export function boundVariables(pipelines: readonly Pipeline[]): Map<string, string[]> {
	const vars = new Map<string, string[]>();
	for (const p of pipelines) {
		const raw = shellSplit(nonNull(p.stages[0]).text);
		const values = raw.slice(3);
		if (raw[0] === "for" && raw[2] === "in" && raw[1] !== undefined) {
			if (values.every((v) => !hasUnresolvedVar(v))) vars.set(raw[1], values);
			continue;
		}
		bindAssignments(raw, vars);
	}
	return vars;
}

const MAX_EXPANSIONS = 64;
const VAR_REF = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g;

function boundNamesIn(argv: readonly string[], vars: ReadonlyMap<string, string[]>): Set<string> {
	const names = new Set<string>();
	for (const tok of argv) {
		for (const m of tok.matchAll(VAR_REF)) {
			const name = nonNull(m[1] ?? m[2]);
			if (vars.has(name)) names.add(name);
		}
	}
	return names;
}

/** Every argv the stage can run as, substituting bound variables jointly.
 *  Unbound variables are left in place (callers test `hasUnresolvedVar`).
 *  Null when the expansion count exceeds the bound. */
export function expandArgv(argv: readonly string[], vars: ReadonlyMap<string, string[]>): string[][] | null {
	let combos: Array<Map<string, string>> = [new Map()];
	for (const name of boundNamesIn(argv, vars)) {
		const values = nonNull(vars.get(name));
		combos = combos.flatMap((combo) => values.map((value) => new Map(combo).set(name, value)));
		if (combos.length > MAX_EXPANSIONS) return null;
	}
	const substitute = (tok: string, combo: Map<string, string>) =>
		tok.replace(VAR_REF, (whole: string, a?: string, b?: string) => combo.get(nonNull(a ?? b)) ?? whole);
	return combos.map((combo) => argv.map((tok) => substitute(tok, combo)));
}
