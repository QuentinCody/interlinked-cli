// Same-file trust resolution for the pre_block JS security detectors
// (`child_process_exec_user_input`, `cookie_missing_security_flags`).
//
// A pre_block check blocks the edit, so an expression the detector cannot
// classify must be treated as UNDECIDABLE (allow), never as hostile. These
// helpers answer two questions from the file alone, with no cross-file
// resolution: "is this program expression one the process controls?" and
// "what does this options / header expression resolve to?". Resolution
// follows `const` bindings only (a `let` may be reassigned) and is bounded
// in depth. Added by the 2026-10-21 adversarial review.

import { blankStringLiteralsPreserveLength } from "../error-handling-lossy-rethrow.js";
import { hasParseErrors, parseTsSource } from "../cyclomatic-ast.js";
import type { TsModule } from "../cyclomatic-ast.js";
import type * as TS from "typescript";

export { blankStringLiteralsPreserveLength };

const MAX_RESOLVE_DEPTH = 3;

/** `{ code, blanked }`: comment-stripped source and its length-preserving string-blanked twin. */
export interface SourceView {
	code: string;
	blanked: string;
}

export function sourceView(commentStripped: string): SourceView {
	return { code: commentStripped, blanked: blankStringLiteralsPreserveLength(commentStripped) };
}

/**
 * Initializer text of an unambiguous same-file const. Without a call-site
 * position, duplicate names and shadowing parameters cannot be resolved;
 * keep those unknown instead of borrowing a declaration from another scope.
 */
export function sameFileConstInit(view: SourceView, name: string): string | null {
	let parsed = parseTsSource(view.code, "bindings.ts");
	if (parsed && hasParseErrors(parsed.sf)) parsed = parseTsSource(view.code, "bindings.tsx");
	if (!parsed || hasParseErrors(parsed.sf)) return null;
	const { ts, sf } = parsed;
	let declarations = 0;
	let initializer: string | null = null;
	const record = (binding: TS.BindingName, value: TS.Expression | undefined): void => {
		if (!ts.isIdentifier(binding)) {
			for (const element of binding.elements) if (ts.isBindingElement(element)) record(element.name, undefined);
			return;
		}
		if (binding.text !== name) return;
		declarations++;
		initializer = value?.getText(sf) ?? null;
	};
	const visit = (node: TS.Node): void => {
		if (ts.isVariableDeclaration(node)) {
			const constant = ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
			record(node.name, constant ? node.initializer : undefined);
		} else if (ts.isParameter(node)) record(node.name, undefined);
		else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) record(node.name, undefined);
		else if (ts.isImportClause(node) && node.name) record(node.name, undefined);
		else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) record(node.name, undefined);
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return declarations === 1 ? initializer : null;
}

/** Split an argument list on depth-0 commas. `blankedArgs` must align with `args`. */
export function splitTopLevelArgs(args: string, blankedArgs: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < blankedArgs.length; i++) {
		const c = blankedArgs[i];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			out.push(args.slice(start, i));
			start = i + 1;
		}
	}
	out.push(args.slice(start));
	return out.map((a) => a.trim()).filter((a) => a !== "");
}

/** The expression text starting at `from` up to the next depth-0 `,` or `)`. */
export function expressionAt(view: SourceView, from: number): string {
	let depth = 0;
	let j = from;
	for (; j < view.blanked.length; j++) {
		const c = view.blanked[j];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) break;
			depth--;
		} else if (depth === 0 && (c === "," || c === "\n")) break;
	}
	return view.code.slice(from, j).trim();
}

// ===========================================
// child_process: trusted program expressions
// ===========================================

// Values the running process (not a request) controls: its own binary, its
// module location, and operator environment. `process.argv[n]` is deliberately
// absent — a CLI argument can be forwarded from anywhere.
const TRUSTED_PROGRAM_VALUE = /^(?:process\.(?:execPath|argv0|env\.[\w$]+)|__dirname|__filename|import\.meta\.(?:dirname|filename|url))$/;
const TRUSTED_LOCATION_CALL = /^(?:require\.resolve|fileURLToPath|(?:path\.)?(?:join|resolve))$/;

function trustedAtom(ts: TsModule, node: TS.Expression): boolean {
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
	if (TRUSTED_PROGRAM_VALUE.test(node.getText().replace(/\s/g, ""))) return true;
	return ts.isElementAccessExpression(node) && node.expression.getText() === "process.env" && ts.isStringLiteral(node.argumentExpression);
}

/** Classify compound expressions by every value they can contribute. */
function trustedComposite(ts: TsModule, node: TS.Expression, trusted: (node: TS.Expression) => boolean): boolean | undefined {
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return trusted(node.expression);
	if (ts.isConditionalExpression(node)) return trusted(node.whenTrue) && trusted(node.whenFalse);
	if (!ts.isBinaryExpression(node)) return undefined;
	const op = node.operatorToken.kind;
	return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(op) && trusted(node.left) && trusted(node.right);
}

/** Location helpers are trusted only when all their arguments are trusted. */
function trustedLocationCall(ts: TsModule, node: TS.Expression, trusted: (node: TS.Expression) => boolean): boolean | undefined {
	if (ts.isCallExpression(node)) return TRUSTED_LOCATION_CALL.test(node.expression.getText()) && node.arguments.length > 0 && node.arguments.every(trusted);
	if (!ts.isNewExpression(node)) return undefined;
	return node.expression.getText() === "URL" && node.arguments?.length === 2 && node.arguments[1]?.getText() === "import.meta.url" && node.arguments.every(trusted);
}

/**
 * True when `expr` (a program / command expression) is one the process
 * controls: a trusted head, a string literal (or ternary of literals), a
 * self-locating initializer, or a same-file `const` that resolves to one.
 */
export function isTrustedProgramExpr(expr: string, view: SourceView, depth = 0): boolean {
	const e = expr.trim();
	if (e === "") return false;
	const parsed = parseTsSource(`const program = ${e};`, "program.ts");
	if (!parsed || hasParseErrors(parsed.sf) || parsed.sf.statements.length !== 1) return false;
	const { ts, sf } = parsed;
	const statement = sf.statements[0];
	if (!statement || !ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return false;
	const expression = statement.declarationList.declarations[0]?.initializer;
	if (!expression) return false;
	const trusted = (node: typeof expression): boolean => {
		if (trustedAtom(ts, node)) return true;
		const composite = trustedComposite(ts, node, trusted) ?? trustedLocationCall(ts, node, trusted);
		if (composite !== undefined) return composite;
		if (!ts.isIdentifier(node) || depth >= MAX_RESOLVE_DEPTH) return false;
		const init = sameFileConstInit(view, node.text);
		return init !== null && isTrustedProgramExpr(init, view, depth + 1);
	};
	return trusted(expression);
}

/**
 * The `cp` / `childProcess` names this file binds to a RegExp (`const cp =
 * /…/` or `new RegExp(…)`): a compiled pattern's `.exec(line)` is not a
 * shell-out. Only a provably-not-child_process binding exempts the alias —
 * an alias with no import at all is still judged (the positive cases pin it).
 */
export function aliasesBoundToRegExp(view: SourceView): Set<string> {
	const names = new Set<string>();
	const re = /\b(?:const|let|var)\s+(cp|childProcess)\s*(?::[^=;\n]*)?=\s*(?:\/|new\s+RegExp\b)/g;
	for (const m of view.blanked.matchAll(re)) names.add(m[1] ?? "");
	return names;
}

/**
 * True when every `${...}` interpolation of a template literal is a trusted
 * program expression. A nested-brace interpolation is not classified (false).
 */
export function templateInterpolationsTrusted(template: string, view: SourceView): boolean {
	const parts = [...template.matchAll(/\$\{([^{}]*)\}/g)];
	if (parts.length === 0) return false;
	if (/\$\{[^}]*\{/.test(template)) return false;
	return parts.every((p) => isTrustedProgramExpr(p[1] ?? "", view));
}

// ===========================================
// cookies: options / header resolution
// ===========================================

export type FlagVerdict = "ok" | "missing" | "undecidable";

function flagDeclared(text: string, name: string): boolean {
	const declared = new RegExp(`\\b${name}\\s*:`, "i").test(text);
	const disabled = new RegExp(`\\b${name}\\s*:\\s*false\\b`, "i").test(text);
	return declared && !disabled;
}

/** Both `httpOnly` and `secure` declared with a non-`false` value. */
export function optionsTextSatisfied(text: string): boolean {
	return flagDeclared(text, "httpOnly") && flagDeclared(text, "secure");
}

/**
 * Resolve a cookie options argument to the text of every property it
 * carries: an object literal's own body plus each `...spread` it names,
 * or a same-file `const` identifier's resolved body. Null = undecidable
 * (a parameter, a call, a member access, or a binding this file lacks).
 */
export function resolveOptionsText(expr: string, view: SourceView, depth = 0): string | null {
	if (depth >= MAX_RESOLVE_DEPTH) return null;
	const e = expr.trim();
	if (e.startsWith("{")) {
		const body = objectBody(e);
		let text = body;
		for (const spread of body.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
			const resolved = resolveIdentifier(spread[1] ?? "", view, depth + 1);
			if (resolved === null) return null;
			text += `\n${resolved}`;
		}
		return text;
	}
	if (/^[A-Za-z_$][\w$]*$/.test(e)) return resolveIdentifier(e, view, depth + 1);
	return null;
}

function resolveIdentifier(name: string, view: SourceView, depth: number): string | null {
	const init = sameFileConstInit(view, name);
	if (init === null) return null;
	return resolveOptionsText(init, view, depth);
}

/** Interior of the first `{...}` in `e` (brace-balanced; to EOF when unbalanced). */
function objectBody(e: string): string {
	const open = e.indexOf("{");
	let depth = 1;
	let j = open + 1;
	while (j < e.length && depth > 0) {
		const c = e[j];
		if (c === "{") depth++;
		else if (c === "}") depth--;
		j++;
	}
	return depth === 0 ? e.slice(open + 1, j - 1) : e.slice(open + 1);
}

/**
 * Verdict for a `res.cookie` / `cookies.set` argument list. The options are
 * the first top-level object-literal argument (Koa's `cookies.set({ name,
 * value, … })` puts it first), else the third argument (an identifier to
 * resolve); no options at all is `missing`.
 */
export function cookieOptionsVerdict(args: string, blankedArgs: string, view: SourceView): FlagVerdict {
	const parts = splitTopLevelArgs(args, blankedArgs);
	const options = parts.find((p) => p.startsWith("{")) ?? parts[2];
	if (options === undefined) return "missing";
	const text = resolveOptionsText(options, view);
	if (text === null) return "undecidable";
	return optionsTextSatisfied(text) ? "ok" : "missing";
}

/** True when `cookies` is bound in this file to a Map / Set (a parsed jar, not a response). */
export function cookiesBoundToCollection(view: SourceView): boolean {
	return /\bcookies\s*(?::[^=;\n]*)?=\s*new\s+(?:Map|Set)\b/.test(view.blanked);
}

function headerTextSatisfied(text: string): boolean {
	const httpOnly = /\bhttponly\b/i.test(text);
	const secure = /\bsecure\b/i.test(text) && !/\bsecure\s*:\s*false\b/i.test(text);
	return httpOnly && secure;
}

/**
 * Verdict for a `setHeader('Set-Cookie', <value>)` value. A bare identifier
 * or an array of identifiers is resolved through same-file `const` bindings
 * (unbound ⇒ undecidable); a quote-free call expression (`build(token)`) is
 * undecidable; any other text — literal, template, or odd — is judged as
 * written.
 */
export function setHeaderValueVerdict(value: string, view: SourceView): FlagVerdict {
	const v = value.trim();
	if (v === "") return "undecidable";
	const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
	const names = inner
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	const identifierList = names.length > 0 && names.every((n) => /^[A-Za-z_$][\w$]*$/.test(n));
	if (!identifierList) {
		if (!/["'`]/.test(v) && /^[A-Za-z_$][\w$.]*\s*\(/.test(v)) return "undecidable";
		return headerTextSatisfied(v) ? "ok" : "missing";
	}
	for (const name of names) {
		const init = sameFileConstInit(view, name);
		if (init === null) return "undecidable";
		if (!headerTextSatisfied(init)) return "missing";
	}
	return "ok";
}
