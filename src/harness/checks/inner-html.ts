// innerHTML / dangerouslySetInnerHTML sink check (pre_block `inner_html`).
// Extracted from agent-safety-js-correctness.ts to stay under the per-file
// line ceiling when the 2026-10-21 adversarial pass added the benign-use
// classification below.

import { nonNull } from "../../lib/non-null.js";
import { stripAllLiterals } from "../strip-helpers.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

/**
 * A value that starts with a recognized sanitizer / escaper call. This is the
 * detector's own `fix_instruction` ("use a sanitization library"), so a line
 * that follows it must not be blocked. The receiver is any member path
 * (`DOMPurify.sanitize`, Angular's `this.sanitizer.sanitize`); a Trusted
 * Types `policy.createHTML(` counts only WITH a receiver, since a bare
 * `createHTML(` is just as likely a markup builder.
 */
const SANITIZER_CALL_RE =
	/^(?:await\s+)?(?:(?:[\w$]+\??\.)+(?:sanitize(?:Html|HTML)?|escape(?:Html|HTML)|createHTML|filterXSS)|sanitize(?:Html|HTML)?|escape(?:Html|HTML)|filterXSS|(?:_|lodash)\.escape|he\.(?:encode|escape))\s*\(/;

/**
 * What may follow the sanitizer call's closing paren: a TypeScript non-null
 * `!` or `as` casts (`as unknown as string` — the TS DOM lib types
 * `innerHTML` as `string`, so a Trusted Types value needs one), an
 * EMPTY-literal fallback (`?? ""` — Angular's `sanitize` returns null), and
 * closers: `;`, `)`, `}}`, a JSX `/>`.
 */
const SANITIZED_TAIL_RE =
	/^(?:\s*!)?(?:\s+as\s+[\w$.]+(?:<[^<>]*>)?(?:\[\])?)*(?:\s*\?\?\s*(?:""|''))?[\s;,)}]*(?:\/>)?[\s;,)}]*$/;

/** How many following lines a wrapped value may continue over (prettier output). */
const MAX_VALUE_CONTINUATION = 8;

function bracketBalance(text: string): number {
	let depth = 0;
	for (const ch of text) {
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth--;
	}
	return depth;
}

/**
 * The value that starts with `head` on STRIPPED line `i`, extended over the
 * following lines while it is still empty (`el.innerHTML =` with the value
 * wrapped to the next line) or its brackets are still open (a sanitizer call
 * whose options object spans lines; a JSX `{{` prop). Bounded so a runaway
 * bracket never joins the whole file.
 */
function valueSpanningLines(strippedLines: string[], i: number, head: string): string {
	let value = head.trim();
	let depth = bracketBalance(value);
	for (let j = i + 1; (value === "" || depth > 0) && j < strippedLines.length && j - i <= MAX_VALUE_CONTINUATION; j++) {
		const next = nonNull(strippedLines[j]).trim();
		value = value === "" ? next : `${value} ${next}`;
		depth += bracketBalance(next);
	}
	return value;
}

/**
 * True when `value` (the text after `=` or `__html:`) is one sanitizer call
 * and nothing else — `sanitize(a) + raw` still carries `raw` into the sink.
 */
function isSanitizedValue(value: string): boolean {
	const m = SANITIZER_CALL_RE.exec(value);
	if (!m) return false;
	let depth = 0;
	for (let i = m[0].length - 1; i < value.length; i++) {
		const ch = value[i];
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return SANITIZED_TAIL_RE.test(value.slice(i + 1));
	}
	return false;
}

/**
 * `el.innerHTML = ""` (the clear-children idiom): an EMPTY literal value. A
 * non-empty literal (`"<b>hi</b>"`) stays a finding — the verify and
 * recurrence suites pin it as a positive. Judged on the literal-SHAPE view
 * (`stripAllLiterals`: comments blanked, string interiors blanked to spaces,
 * quotes kept, length preserved), where `""` and `"x"` (→ `" "`) still
 * differ; the detector's main stripper blanks every string to `""`.
 */
const EMPTY_LITERAL_VALUE_RE = /^(["'`])\1\s*(?:[;,)}]|$)/;

/** One assignment's value: up to the first `;` outside brackets, else the rest of the line. */
function statementValue(text: string): string {
	let depth = 0;
	for (let k = 0; k < text.length; k++) {
		const ch = text[k];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === ";" && depth <= 0) return text.slice(0, k + 1);
	}
	return text;
}

/**
 * Every `.innerHTML =` WRITE on line `i` is benign: an empty string literal,
 * or a value that is one sanitizer call (on this line or wrapped onto the
 * following ones). A line with only comparisons (`innerHTML ==`) is benign.
 * Each write is judged on its own (2026-10-21 round-3 verification:
 * `a.innerHTML = ""; b.innerHTML = userInput;` was exempted whole because
 * one empty clear appeared on the line). The sanitizer tail keeps its old
 * reading of string literals as empty (`?? "x"` read as `?? ""`).
 */
function isBenignInnerHtmlAssignment(shapeLines: string[], i: number): boolean {
	const line = nonNull(shapeLines[i]);
	const writes = [...line.matchAll(/\.innerHTML\s*=(?!=)\s*/g)];
	return writes.every((w, k) => {
		const rest = line.slice((w.index ?? 0) + w[0].length);
		const value = statementValue(rest);
		if (EMPTY_LITERAL_VALUE_RE.test(value.trim())) return true;
		const spans = k === writes.length - 1 && value === rest;
		const judged = spans ? valueSpanningLines(shapeLines, i, rest) : value;
		return isSanitizedValue(judged.replace(/(["'`]) *\1/g, "$1$1"));
	});
}

/**
 * A `dangerouslySetInnerHTML` mention that is not a sink write: a TYPE
 * declaration (`dangerouslySetInnerHTML?:` / `__html: string`), a
 * destructuring pattern (`const { dangerouslySetInnerHTML: _x, ...rest } =`),
 * or a `__html:` value that is one sanitizer call — on this line or, after
 * prettier wraps the prop (`dangerouslySetInnerHTML={{` / `__html: …` /
 * `}}`), on the following ones.
 */
function isBenignDangerouslySet(strippedLines: string[], i: number, trimmed: string): boolean {
	if (/dangerouslySetInnerHTML\?:|__html\??:\s*(?:string|TrustedHTML|unknown|any|never)\b/.test(trimmed)) {
		return true;
	}
	// A member annotated with a NAMED type (`dangerouslySetInnerHTML: RawHtml;`,
	// `React.DOMAttributes<T>[""];`): PascalCase head, terminated by `;` or the
	// line end. An object-literal VALUE is camelCase and ends in `,` or `}`.
	if (/dangerouslySetInnerHTML:\s*[A-Z][\w$.]*(?:<[^;{}]*>)?(?:\[[^;{}]*\])*\s*(?:;|$)/.test(trimmed)) return true;
	if (/\{[^{}]*\bdangerouslySetInnerHTML\b[^{}]*\}\s*=[^=]/.test(trimmed)) return true;
	const start = /dangerouslySetInnerHTML\s*[=:]\s*/.exec(trimmed);
	if (!start) return false;
	const value = valueSpanningLines(strippedLines, i, trimmed.slice(start.index + start[0].length));
	const key = /__html\s*:\s*/.exec(value);
	return key !== null && isSanitizedValue(value.slice(key.index + key[0].length));
}

/**
 * JSX TEXT that quotes the idiom (`<p>Never write el.innerHTML = x</p>`): the
 * stripper leaves JSX text as written. Only a line that carries a tag counts,
 * and the text between the closing `>` and the sink must be prose — no
 * brackets, parens, braces, or statement separators.
 */
function isJsxProse(trimmed: string): boolean {
	if (!/<\/|\/>|<[a-zA-Z]/.test(trimmed)) return false;
	return /(?<![=\-])>[^<>{}();`]*(?:\.innerHTML\s*=|dangerouslySetInnerHTML)/.test(trimmed);
}

/** `const <name> = <…>.createElement("template")`, judged on the ORIGINAL text (the stripper blanks the tag). */
const TEMPLATE_DECL_RE = /\bconst\s+([\w$]+)\s*=\s*(?:[\w$]+\.)*createElement\(\s*(["'`])template\2\s*\)/g;

/**
 * Members that READ data off a parsed node. None of them returns a node, so
 * none can carry the node out of the inert template into a document.
 */
const INERT_READ_MEMBERS = new Set([
	"attributes",
	"getAttribute",
	"getAttributeNames",
	"hasAttribute",
	"textContent",
	"tagName",
	"nodeName",
	"localName",
	"id",
	"className",
	"dataset",
	"src",
	"href",
	"type",
]);

/** An identifier (`[\w$]+`) as a regex source: only `$` needs escaping. */
function identifierSource(name: string): string {
	return name.replace(/\$/g, "\\$");
}

/** Each use of identifier `name` in `stripped`: the text before it and the text after it. */
function usesOf(stripped: string, name: string): { before: string; after: string }[] {
	const re = new RegExp(`(?<![\\w$.])${identifierSource(name)}(?![\\w$])`, "g");
	return [...stripped.matchAll(re)].map((m) => ({
		before: stripped.slice(Math.max(0, m.index - 40), m.index),
		after: stripped.slice(m.index + name.length),
	}));
}

/** Every use of `node` is its one binding from `template.content.querySelector(` or a data read. */
function isInertNode(stripped: string, node: string, template: string): boolean {
	const binding = new RegExp(`^\\s*=\\s*${identifierSource(template)}\\.content\\.querySelector\\(`);
	let bindings = 0;
	for (const { before, after } of usesOf(stripped, node)) {
		const member = /^\??\.([\w$]+)/.exec(after);
		if (member && INERT_READ_MEMBERS.has(nonNull(member[1]))) continue;
		if (!/\bconst\s+$/.test(before) || !binding.test(after)) return false;
		bindings++;
	}
	return bindings === 1;
}

/**
 * True when the `<template>` bound to `name` stays inert: one `const`
 * declaration, and every other use is an `innerHTML` write or a
 * `const node = name.content.querySelector(…)` binding whose node is inert.
 * Appending the content, cloning it, returning it, or attaching the template
 * itself all fail this, because the parsed nodes then reach a document.
 */
function isInertTemplate(stripped: string, name: string): boolean {
	let declarations = 0;
	for (const { before, after } of usesOf(stripped, name)) {
		if (/^\.innerHTML\s*=(?!=)/.test(after)) continue;
		if (/\bconst\s+$/.test(before) && /^\s*=\s*(?:[\w$]+\.)*createElement\(/.test(after)) {
			declarations++;
			continue;
		}
		const node = /\bconst\s+([\w$]+)\s*=\s*$/.exec(before);
		if (!node || !/^\.content\.querySelector\(/.test(after)) return false;
		if (!isInertNode(stripped, nonNull(node[1]), name)) return false;
	}
	return declarations === 1;
}

/** Names of the detached `<template>` elements in the file that never leave the inert parse. */
function inertTemplateNames(content: string, stripped: string): Set<string> {
	const names = new Set<string>();
	for (const m of content.matchAll(TEMPLATE_DECL_RE)) {
		const name = nonNull(m[1]);
		if (isInertTemplate(stripped, name)) names.add(name);
	}
	return names;
}

/** Every `.innerHTML =` write on the stripped line goes to an inert template. */
function writesOnlyInertTemplates(trimmed: string, inert: Set<string>): boolean {
	if (inert.size === 0) return false;
	const writes = trimmed.match(/\.innerHTML\s*=(?!=)/g)?.length ?? 0;
	const receivers = [...trimmed.matchAll(/(?<![\w$.])([\w$]+)\.innerHTML\s*=(?!=)/g)];
	return writes > 0 && receivers.length === writes && receivers.every((r) => inert.has(nonNull(r[1])));
}

/**
 * Detect dangerouslySetInnerHTML (React) and direct innerHTML assignment.
 * Skips matches inside regex literals and test patterns (e.g., lint check
 * implementations), and writes to a detached `<template>` used only as an
 * HTML parser (2026-10-21 cross-repo falsification, date-fns cdnPolyfill.js).
 */
export function checkInnerHtmlUsage(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const shapeLines = stripAllLiterals(content).split("\n");
	const inert = inertTemplateNames(content, stripped);
	const matches: InlineMatch[] = [];
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 10) break;
		const trimmed = line.trim();
		// Skip lines that are regex patterns (detecting innerHTML vs using it)
		if (/\/.*innerHTML.*\//.test(trimmed) || /\/.*dangerouslySet.*\//.test(trimmed)) continue;
		// Skip lines that are .test() or .match() calls on the pattern
		if (/\.test\(/.test(trimmed) || /\.match\(/.test(trimmed)) continue;
		if (isJsxProse(trimmed)) continue;
		const dangerous =
			/dangerouslySetInnerHTML/.test(trimmed) && !isBenignDangerouslySet(strippedLines, i, trimmed);
		const assigned =
			/\.innerHTML\s*=/.test(trimmed) &&
			!isBenignInnerHtmlAssignment(shapeLines, i) &&
			!writesOnlyInertTemplates(trimmed, inert);
		if (dangerous || assigned) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}
