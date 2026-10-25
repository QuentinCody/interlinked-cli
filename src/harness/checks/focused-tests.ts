// Focused tests check (committed .only / fdescribe / fit).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";
import { offsetToLine } from "./shared-text-utils.js";

// ===========================================
// Focused Tests — committed .only / fdescribe / fit that skip all other tests
// ===========================================

/** Jasmine/Jest focus globals. These are never member calls and never SUT imports. */
const FOCUS_GLOBALS = ["fit", "fdescribe", "fcontext", "ftest"] as const;

/**
 * Module specifiers that provide the focus globals. A name imported or
 * required from one of these is STILL a focus marker; from anywhere else
 * (`../curve-fit.js`, `./f-test.js`) it is the system under test.
 */
const RUNNER_MODULE_RE =
	/^(?:vitest|jest|@jest\/globals|jasmine|jasmine-core|mocha|bun:test|node:test|@playwright\/test|ava|uvu|tap|qunit|cypress)(?:\/|$)/;

/** A line that mentions a runner global object (guards the destructured-parameter arm). */
const RUNNER_RHS_RE = /\b(?:globalThis|global|window|self|jasmine|jest)\b/;

/**
 * An initializer that RE-EXPOSES a runner global — `= globalThis.fit;`,
 * `= (globalThis as any).fit`, `= jasmine;` — a plain read with no call in
 * it. `= jest.fn()` / `= jasmine.createSpy("fit")` CALL the runner to make a
 * new value (a mock), and `= (w) => Math.min(w, window.innerWidth)` only
 * mentions `window`; both are local bindings.
 */
const RUNNER_REEXPORT_RE = /(?<![=!<>])=(?![=>])\s*\(?\s*(?:globalThis|global|window|self|jasmine|jest)\b[^(;]*(?:;|$)/;

/** `from "<spec>"` / `require("<spec>")` on an ORIGINAL line (strings are blanked in the stripped copy). */
function moduleSpecifierOf(originalLine: string): string | null {
	const m = /(?:\bfrom\s*|\brequire\s*\(\s*)(["'])([^"']+)\1/.exec(originalLine);
	return m ? nonNull(m[2]) : null;
}

/**
 * Names among {@link FOCUS_GLOBALS} that this file binds itself — a
 * `function fit(` declaration, a `const { fit } = …` / `const fit = …` /
 * `let fit: Fitter;` / `for (const fit of …)` binding, a parameter
 * (`(fit) =>`, `(fit: Fn, xs)`, `({ fit }: Deps)`), or an `import { fit }`
 * from a non-runner module. A bound name is the file's own helper (curve
 * `fit`, statistical `ftest`), not Jasmine's global, so a bare call to it is
 * not a focus marker.
 */
function locallyBoundFocusNames(originalLines: string[], strippedLines: string[]): Set<string> {
	const bound = new Set<string>();
	const names = FOCUS_GLOBALS.join("|");
	const declRe = new RegExp(`\\bfunction\\s*\\*?\\s*(${names})\\s*\\(`);
	// The keyword alone binds the name: a type annotation (`const fit: Fitter =`),
	// a bare `let fit;`, or a `for (const fit of …)` head carries no `=` after it.
	const bindRe = new RegExp(
		`\\b(?:const|let|var)\\s+(?:(${names})\\b|\\{[^}]*\\b(?:\\w+\\s*:\\s*)?(${names})\\b[^}]*\\})`,
	);
	// A parameter: the name directly after `(` or `,`, followed by `,` `:` `)`
	// or a default `=`; or inside a destructured parameter `({ fit }: Deps)`.
	// A focus global is only ever CALLED, never passed or destructured.
	const paramRe = new RegExp(`[(,]\\s*(?:(${names})\\b\\s*[,:)=]|\\{[^{}]*\\b(${names})\\b[^{}]*\\})`);
	for (const [i, stripped] of strippedLines.entries()) {
		const decl = declRe.exec(stripped);
		if (decl) bound.add(nonNull(decl[1]));
		const spec = moduleSpecifierOf(nonNull(originalLines[i]));
		const bind = bindRe.exec(stripped);
		if (bind && isLocalBinding(stripped.slice(bind.index), spec)) {
			bound.add(nonNull(bind[1] ?? bind[2]));
		}
		const param = paramRe.exec(stripped);
		// A runner object on the line matters only to the DESTRUCTURED arm
		// (`Object.assign(globalThis, { fit })` re-exposes it); a plain
		// `(fit) => fit(window.innerWidth)` parameter is still a binding.
		if (param && spec === null && (param[1] !== undefined || !RUNNER_RHS_RE.test(stripped))) {
			bound.add(nonNull(param[1] ?? param[2]));
		}
	}
	for (const name of importedFocusNames(originalLines, strippedLines)) bound.add(name);
	for (const name of destructuredFocusNames(originalLines, strippedLines)) bound.add(name);
	return bound;
}

/** A `const`/`let`/`var` binding shadows the global unless its RHS re-exposes a runner. */
function isLocalBinding(statement: string, spec: string | null): boolean {
	if (RUNNER_REEXPORT_RE.test(statement)) return false;
	return spec === null || !RUNNER_MODULE_RE.test(spec);
}

/**
 * Focus names bound by a destructuring pattern that may span lines
 * (`const {\n  fit,\n} = await import("../curve-fit.js")`) or is an ARRAY
 * pattern (`const [fit, refit] = makeFitters()`). Judged on the statement
 * from the pattern's closing bracket to the end of that line, so the runner
 * re-export and module-specifier rules match the single-line binding's.
 */
function destructuredFocusNames(originalLines: string[], strippedLines: string[]): string[] {
	const names = FOCUS_GLOBALS.join("|");
	const patternRe = /\b(?:const|let|var)\s*(?:\{([^{}]*)\}|\[([^[\]]*)\])\s*=(?![=>])/g;
	const nameRe = new RegExp(`(?:^|[,{\\[\\s])(?:\\w+\\s*:\\s*)?(${names})\\b(?!\\s*:)`, "g");
	const stripped = strippedLines.join("\n");
	const out: string[] = [];
	for (const m of stripped.matchAll(patternRe)) {
		const eqOffset = m.index + m[0].length - 1;
		const lineNo = offsetToLine(stripped, eqOffset);
		const lineStart = stripped.lastIndexOf("\n", eqOffset) + 1;
		const lineEnd = stripped.indexOf("\n", eqOffset);
		const statement = stripped.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
		if (!isLocalBinding(statement, moduleSpecifierOf(nonNull(originalLines[lineNo - 1])))) continue;
		for (const n of nonNull(m[1] ?? m[2]).matchAll(nameRe)) out.push(nonNull(n[1]));
	}
	return out;
}

/**
 * Focus names bound by an `import` from a non-runner module. Scanned over the
 * whole stripped content because a multi-line import carries its `from` on a
 * later line than the name; the specifier text is read from the ORIGINAL line
 * that holds the `from` (strings are blanked in the stripped copy).
 */
function importedFocusNames(originalLines: string[], strippedLines: string[]): string[] {
	const names = FOCUS_GLOBALS.join("|");
	// A default import may be followed by named or namespace bindings
	// (`import fit, { residuals } from`), and a named one may follow a default
	// (`import curve, { fit } from`).
	const importRe = new RegExp(
		`\\bimport\\s+(?:(${names})\\b(?:\\s*,\\s*(?:\\{[^}]*\\}|\\*\\s*as\\s+[\\w$]+))?|(?:[\\w$]+\\s*,\\s*)?\\{[^}]*\\b(?:\\w+\\s+as\\s+)?(${names})\\b[^}]*\\})\\s*from\\s*["']`,
		"g",
	);
	const stripped = strippedLines.join("\n");
	const out: string[] = [];
	for (const m of stripped.matchAll(importRe)) {
		const fromLine = offsetToLine(stripped, m.index + m[0].length - 1);
		const spec = moduleSpecifierOf(nonNull(originalLines[fromLine - 1]));
		if (spec !== null && !RUNNER_MODULE_RE.test(spec)) out.push(nonNull(m[1] ?? m[2]));
	}
	return out;
}

/**
 * Detect committed `.only` / focused-test markers that cause CI to run a
 * subset of the suite and silently skip the rest. These must never land on
 * main — they're the single worst gaming vector for test coverage.
 *
 * Patterns:
 *   it.only(, test.only(, describe.only(, context.only(
 *   fit(, fdescribe(, fcontext(, ftest(
 *
 * The bare forms are Jasmine/Jest GLOBALS, so a member call (`fitAddon.fit()`,
 * `this.fit(`) and a name the file binds itself (`import { fit } from
 * "../curve-fit.js"`, `function ftest(`) are not focus markers.
 */
export function checkFocusedTests(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const bound = locallyBoundFocusNames(originalLines, strippedLines);
	const globals = FOCUS_GLOBALS.filter((n) => !bound.has(n));
	// The negative lookaheads reject a DEFINITION — `fit(w: number): Box {` /
	// `fit(a, b) {` (a class method or shorthand) — whose parameter list is
	// followed by a body, and a SIGNATURE — `fit(xs: Point[]): Line;` in an
	// interface or an `abstract` member — whose parameter list is followed by
	// a return type that runs to the end of the line. A focus call's argument
	// list is never followed by `{`, and never by `: Type` at end of line.
	const bareRe =
		globals.length > 0
			? new RegExp(
					`(?<![.\\w$])(?:${globals.join("|")})\\s*\\((?![^()]*\\)\\s*(?::[^{=;]+)?\\{)(?![^()]*\\)\\s*:\\s*[^{=;?]*;?\\s*\\}*\\s*$)`,
				)
			: null;
	const matches: InlineMatch[] = [];
	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 15) break;
		const only = ONLY_CALL_RE.exec(line);
		const bare = bareRe?.exec(line);
		const focusedOnly = only !== null && !isForwardingDefinition(line.slice(0, only.index));
		const focusedBare = bare != null && !isWrappedDefinition(strippedLines, i, bare.index + bare[0].length - 1);
		if (focusedOnly || focusedBare) matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

const ONLY_CALL_RE = /\b(?:it|test|describe|context)\.only\s*\(/;

/**
 * The text before a `.only(` call DEFINES a forwarding wrapper on the same
 * line — `describeWithDb.only = (name, fn) => describe.only(…)` or an
 * object member `only: (name, fn) => it.only(…)`. The call runs only when
 * a test opts into the wrapper's own `.only`; the definition focuses nothing.
 */
function isForwardingDefinition(before: string): boolean {
	return /(?:\.only\s*=(?![=>])|\bonly\s*:)\s*(?:async\s*)?(?:function\b[^(]*\([^)]*\)|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/.test(
		before,
	);
}

/** How many following lines a wrapped parameter list may span (prettier output). */
const MAX_WRAPPED_PARAM_LINES = 20;

/**
 * A focus-named `fit(` whose parameter list does NOT close on its own line
 * (prettier wrapped it) is a DEFINITION or SIGNATURE when the matching `)`
 * is followed by a body `{` / `: Type {` or by a `: Type;` return type on
 * that line. A wrapped focus CALL closes with `)` / `);` / `,` instead.
 * `openIdx` is the index of the `(` on stripped line `i`.
 */
function isWrappedDefinition(strippedLines: string[], i: number, openIdx: number): boolean {
	let depth = 0;
	for (let j = i; j < strippedLines.length && j - i <= MAX_WRAPPED_PARAM_LINES; j++) {
		const line = nonNull(strippedLines[j]);
		for (let k = j === i ? openIdx : 0; k < line.length; k++) {
			const ch = line[k];
			if (ch === "(") depth++;
			else if (ch === ")" && --depth === 0) {
				if (j === i) return false; // single-line form: the regex lookaheads already decided
				const rest = line.slice(k + 1);
				return /^\s*(?::[^{=;]+)?\{/.test(rest) || /^\s*:\s*[^{=;?]*;?\s*\}*\s*$/.test(rest);
			}
		}
	}
	return false;
}
