// Region exemptions for `ubs_hardcoded_localhost` — lines that sit inside a
// language region where a loopback literal is test data, documentation, or a
// build-time dev branch rather than a shipped endpoint:
//
//   - Rust: the item carrying a `#[cfg(test)]` attribute; production items
//     after that item's closing brace remain in scope.
//   - Python: a triple-quoted string in STATEMENT position (a docstring, with
//     its doctest examples). A triple-quoted string assigned to a name or passed
//     as an argument is data and stays in scope.
//   - C / C++ / Swift: the dev branch of a `#if DEBUG` / `#ifdef DEBUG` /
//     `#ifndef NDEBUG` region, or the `#else` branch of a release-only region.
//     Directive lines themselves are never exempt; nested unrelated `#if`s
//     inherit the enclosing dev region.
//
// Every rule reads the file's own text; none reads the directory. Input is the
// ORIGINAL lines (not comment-stripped), because the Python rule needs to see
// the docstring delimiters that the string-preserving stripper leaves intact
// and the directives are line-anchored either way.

import { nonNull } from "../../../lib/non-null.js";
import { getExtension } from "../shared.js";

// --- Rust ------------------------------------------------------------------
const RUST_CFG_TEST_RE = /^\s*#\[cfg\((?:test\b|any\([^)]*\btest\b)/;

/** Last line of the attributed item, including external `mod tests;` items. */
function rustTestItemEnd(lines: string[], start: number): number | null {
	let depth = 0;
	for (let i = start; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const code = line.trimStart().startsWith("#[") ? line.slice(line.indexOf("]") + 1) : line;
		for (const ch of code) {
			if (ch === ";" && depth === 0) return i;
			if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) return i;
		}
	}
	return null;
}

function rustTestItems(lines: string[], out: Set<number>): void {
	const stripped = lines.join("\n").replace(
		/\/\*[\s\S]*?\*\/|\/\/[^\n]*|\bb?r(#*)"[\s\S]*?"\1|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\\n]|\\.)'/g,
		(text) => text.replace(/[^\n]/g, " "),
	).split("\n");
	for (let start = 0; start < lines.length; start++) {
		if (!RUST_CFG_TEST_RE.test(stripped[start] ?? "")) continue;
		const end = rustTestItemEnd(stripped, start);
		if (end === null) continue;
		for (let i = start; i <= end; i++) out.add(i);
		start = end;
	}
}

// --- Python ----------------------------------------------------------------
const PY_DOCSTRING_OPEN_RE = /^\s*[rRuUbBfF]{0,2}("""|''')/;

/** Position of the first triple-quote token on the line, or null. */
function tripleQuoteAt(line: string): { token: string; index: number } | null {
	const dq = line.indexOf('"""');
	const sq = line.indexOf("'''");
	if (dq < 0 && sq < 0) return null;
	if (sq < 0 || (dq >= 0 && dq < sq)) return { token: '"""', index: dq };
	return { token: "'''", index: sq };
}

function pythonDocstrings(lines: string[], out: Set<number>): void {
	let open: string | null = null;
	let exempt = false;
	for (let i = 0; i < lines.length; i++) {
		const line = nonNull(lines[i]);
		if (open !== null) {
			if (exempt) out.add(i);
			if (line.includes(open)) open = null;
			continue;
		}
		const hit = tripleQuoteAt(line);
		if (hit === null) continue;
		exempt = PY_DOCSTRING_OPEN_RE.test(line);
		if (exempt) out.add(i);
		// One-line form: the closer follows the opener on the same line.
		if (!line.slice(hit.index + 3).includes(hit.token)) open = hit.token;
	}
}

// --- C preprocessor (C / C++ / Swift) -----------------------------------------
const DIRECTIVE_RE = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b\s*(.*)$/;
const DEV_MACRO_RE = /\b(?:_?DEBUG|DEV|DEVELOPMENT)\b/;
const RELEASE_MACRO_RE = /\b(?:NDEBUG|RELEASE)\b/;

interface Frame {
	thenDev: boolean;
	elseDev: boolean;
	inElse: boolean;
}

/** Classify a `#if`-family condition: which branch (if any) is the dev branch. */
function classifyCondition(keyword: string, cond: string): Frame {
	const negated = keyword === "ifndef" || /^\s*!/.test(cond);
	const dev = DEV_MACRO_RE.test(cond);
	const release = RELEASE_MACRO_RE.test(cond);
	return {
		thenDev: (dev && !negated) || (release && negated),
		elseDev: (release && !negated) || (dev && negated),
		inElse: false,
	};
}

function frameIsDev(frame: Frame): boolean {
	return frame.inElse ? frame.elseDev : frame.thenDev;
}

function applyDirective(stack: Frame[], keyword: string, cond: string): void {
	if (keyword === "endif") {
		stack.pop();
		return;
	}
	if (keyword === "else" || keyword === "elif") {
		const top = stack[stack.length - 1];
		if (top === undefined) return;
		if (keyword === "elif") stack[stack.length - 1] = classifyCondition("if", cond);
		else top.inElse = true;
		return;
	}
	stack.push(classifyCondition(keyword, cond));
}

function preprocessorDevRegions(lines: string[], out: Set<number>): void {
	const stack: Frame[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = DIRECTIVE_RE.exec(nonNull(lines[i]));
		if (m !== null) {
			applyDirective(stack, nonNull(m[1]), m[2] ?? "");
			continue;
		}
		if (stack.some(frameIsDev)) out.add(i);
	}
}

// --- Entry -------------------------------------------------------------------
const RUST_EXTS = new Set([".rs"]);
const PY_EXTS = new Set([".py", ".pyi"]);
const CPP_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx", ".swift"]);

/**
 * 0-based indices of the lines a language region exempts from the localhost
 * scan, in ascending order. Languages without a region rule yield nothing.
 */
export function localhostRegionExemptLines(lines: string[], filePath: string): Set<number> {
	const out = new Set<number>();
	const ext = getExtension(filePath);
	if (RUST_EXTS.has(ext)) rustTestItems(lines, out);
	else if (PY_EXTS.has(ext)) pythonDocstrings(lines, out);
	else if (CPP_EXTS.has(ext)) preprocessorDevRegions(lines, out);
	return out;
}
