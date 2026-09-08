// conditional_empty_object_spread — ported from dmmulroy/anti-slop (MIT
// license, https://github.com/dmmulroy/anti-slop), detection ALGORITHM
// only. No Oxlint dependency, no new package — see
// docs/external-pulse/anti-slop.md for the full intake (§7 "smallest
// spike", §9 artifact). The `unknown_type_alias` sibling check from the
// same intake lives in type-discipline-unknown-alias.ts (split at the
// per-file line cap; see CLAUDE.md "Per-file line cap").
//
// `{ ...(cond ? {} : { field: v }) }` (or the mirror-image `cond ? { field:
// v } : {}`): a ternary spread used to conditionally OMIT a field from an
// object literal, instead of a direct conditional property or two separate
// statements. Runs on every JS/TS extension — the pattern is plain-JS-
// shaped, not a type issue. Ported from no-conditional-empty-object-
// spread.ts (report-only for v0; the upstream autofix is not ported,
// matching the intake's smallest-spike scope).
//
// TIGHTENED past the upstream shape: the idiomatic conditional-key-
// omission pattern (`<guard> ? { key: expr } : {}`, where the property's
// value is textually the guarded expression) is exempt — see
// `isGuardedKeyOmission`'s docstring. This repo's own corpus scan
// (scratch/type-discipline-corpus-scan.mts) fired 241 times before any
// exemption; 106 after the strict-`!== undefined` subset alone; 32 after
// widening to the other guard shapes this repo's own code actually uses
// (bare truthy checks, `typeof`, `.length`/`.size`, optional chaining).
// The remaining 32 are genuinely NOT pure passthroughs (transformed
// values, multi-property branches, compound `&&`/string-literal guards) —
// re-run the scan after any further change to this detector.
//
// AST-walk only — parse-only, no ts.Program, no ts.TypeChecker. The
// upstream Oxlint rule is itself parse-only (walks Oxlint's ESTree + scope
// manager, never `ts.TypeChecker`); this port keeps that shape, using the
// runtime-loaded `typescript` compiler API's own AST instead. Runtime
// loading follows the same createRequire dance as type-smuggling.ts and
// correctness-misc.ts (see either file's header for the full esbuild-
// bundling rationale) — a type-only import for compile-time signatures,
// `node:module`'s `createRequire` to load the real `typescript` from the
// user's project `node_modules` at runtime. Returns [] silently when
// TypeScript isn't installed — same AST-availability degrade contract
// every parse-based check in this tree follows.
//
// Phase: post / Severity: warning / Gate: advisory — a new detector with
// no dogfood FP history yet beyond this file's own corpus scan; see
// DEFAULT_ADVISORY_SKIPS for rationale.

import { createRequire } from "node:module";
import type * as TS from "typescript";
import { parseTsSourceWith } from "./cyclomatic-ast.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_ALL_EXTS } from "./shared.js";

type TsModule = typeof TS;

const MAX_MATCHES_PER_FILE = 10;
const MAX_LINES_PER_FILE = 1500;
const REPORT_LINE_TRUNC = 150;

// ─────────────────────────────────────────────────────────────────────────
// Runtime TypeScript loading (see file header for the esbuild rationale)
// ─────────────────────────────────────────────────────────────────────────

let _ts: TsModule | null | undefined;

function loadTs(): TsModule | null {
	if (_ts !== undefined) return _ts;
	try {
		// The `/_` suffix is a non-existent sentinel path so createRequire uses
		// CWD as the resolution base — same trick as type-smuggling.ts.
		const req = createRequire(`${process.cwd()}/_`);
		// SAFETY: createRequire loads the installed TypeScript package selected by Node resolution; its exported compiler API matches the imported declarations.
		_ts = req("typescript") as TsModule;
	} catch {
		_ts = null;
	}
	return _ts;
}

function parseSourceFile(ts: TsModule, content: string, filePath: string): TS.SourceFile | null {
	try {
		return parseTsSourceWith(ts, content, filePath);
	} catch {
		return null;
	}
}

function lineOf(ts: TsModule, sourceFile: TS.SourceFile, pos: number): number {
	return ts.getLineAndCharacterOfPosition(sourceFile, pos).line + 1;
}

function excerptAt(lines: string[], line: number): string {
	return (lines[line - 1] ?? "").trim().slice(0, 100);
}

// ─────────────────────────────────────────────────────────────────────────
// Ternary + empty-object-branch matching
// ─────────────────────────────────────────────────────────────────────────

function unwrapParenExpr(ts: TsModule, node: TS.Expression): TS.Expression {
	let current = node;
	while (ts.isParenthesizedExpression(current)) current = current.expression;
	return current;
}

function isEmptyObjectLiteral(ts: TsModule, node: TS.Expression): boolean {
	return ts.isObjectLiteralExpression(node) && node.properties.length === 0;
}

/** The single `key: value` (or shorthand `key`) property of an object
 *  literal with exactly one member — null for anything else (empty, spread,
 *  method, computed, or multi-property). */
function singleAssignableProperty(
	ts: TsModule,
	node: TS.Expression,
): TS.PropertyAssignment | TS.ShorthandPropertyAssignment | null {
	if (!ts.isObjectLiteralExpression(node) || node.properties.length !== 1) return null;
	const [prop] = node.properties;
	if (!prop) return null;
	if (ts.isPropertyAssignment(prop)) return prop;
	if (ts.isShorthandPropertyAssignment(prop)) return prop;
	return null;
}

/** Source text of a single-property assignment's VALUE — the initializer
 *  for `{ key: expr }`, the name itself for shorthand `{ key }`. */
function propertyValueText(
	ts: TsModule,
	sourceFile: TS.SourceFile,
	prop: TS.PropertyAssignment | TS.ShorthandPropertyAssignment,
): string {
	if (ts.isPropertyAssignment(prop)) return prop.initializer.getText(sourceFile).trim();
	return prop.name.getText(sourceFile).trim();
}

// ─────────────────────────────────────────────────────────────────────────
// Guard-shape recognition — what is the ternary's condition actually
// checking, and on which branch is the checked expression "present"?
// ─────────────────────────────────────────────────────────────────────────

interface GuardedCheck {
	/** Source text of the guarded expression. */
	expressionText: string;
	/** True when the guarded expression is truthy/defined on the ternary's
	 *  TRUE branch (so the POPULATED object branch is the consequent). */
	isDefinedWhenTrue: boolean;
}

/** Recognizes `expr !== undefined` / `undefined !== expr` (and the `===`
 *  mirror) — a strict-equality undefined guard against ONE named
 *  expression. Anything else (loose `!=`, both/neither side `undefined`,
 *  a non-comparison test) returns null. Mirrors the upstream rule's own
 *  `undefinedCheckedExpression`. */
function undefinedCheckedExpression(
	ts: TsModule,
	sourceFile: TS.SourceFile,
	test: TS.Expression,
): GuardedCheck | null {
	const binary = unwrapParenExpr(ts, test);
	if (!ts.isBinaryExpression(binary)) return null;
	const isStrictNe = binary.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
	const isStrictEq = binary.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken;
	if (!isStrictNe && !isStrictEq) return null;

	const left = unwrapParenExpr(ts, binary.left);
	const right = unwrapParenExpr(ts, binary.right);
	const leftIsUndefined = ts.isIdentifier(left) && left.text === "undefined";
	const rightIsUndefined = ts.isIdentifier(right) && right.text === "undefined";
	if (leftIsUndefined === rightIsUndefined) return null; // both or neither — reject

	const other = leftIsUndefined ? right : left;
	return { expressionText: other.getText(sourceFile).trim(), isDefinedWhenTrue: isStrictNe };
}

/** Recognizes `typeof expr === "..."` / `typeof expr !== "..."` (either
 *  equality strictness — loose vs. strict makes no practical difference
 *  against a `typeof` result, which is always a string primitive). */
function typeofCheckedExpression(
	ts: TsModule,
	sourceFile: TS.SourceFile,
	test: TS.Expression,
): GuardedCheck | null {
	const binary = unwrapParenExpr(ts, test);
	if (!ts.isBinaryExpression(binary)) return null;
	const op = binary.operatorToken.kind;
	const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
	const isNe =
		op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
	if (!isEq && !isNe) return null;

	const left = unwrapParenExpr(ts, binary.left);
	if (!ts.isTypeOfExpression(left)) return null;
	return { expressionText: left.expression.getText(sourceFile).trim(), isDefinedWhenTrue: isEq };
}

/**
 * Recognizes `expr.length <op> ...` / `expr.size <op> ...` — a non-empty
 * guard on a collection, REGARDLESS of the comparison operator or right-
 * hand side (`> 0`, `!== 0`, `>= 1`, …): this only decides WHAT expression
 * is being tested, not whether the ternary is exempt — the caller still
 * requires the populated branch's single property VALUE to textually equal
 * this expression, so an unrelated comparison (`arr.length > 100 ? {
 * hugeFlag: true } : {}`) stays flagged regardless of matching this shape.
 *
 * Known conservative gap: always reports `isDefinedWhenTrue: true` (a
 * NON-empty reading), so an EMPTY-check spelled with `.length` (`x.length
 * === 0 ? {} : { x }`) is not recognized as this shape and stays flagged
 * rather than exempted — under-exemption, never a wrong exemption, so the
 * failure mode is "one more advisory finding," not a suppressed real one.
 */
function lengthCheckedExpression(
	ts: TsModule,
	sourceFile: TS.SourceFile,
	test: TS.Expression,
): string | null {
	const binary = unwrapParenExpr(ts, test);
	if (!ts.isBinaryExpression(binary)) return null;
	const left = unwrapParenExpr(ts, binary.left);
	if (!ts.isPropertyAccessExpression(left)) return null;
	if (left.name.text !== "length" && left.name.text !== "size") return null;
	return left.expression.getText(sourceFile).trim();
}

/**
 * The expression a ternary's condition is guarding, and whether it is
 * truthy/present on the TRUE branch — covering every shape observed in
 * this repo's own options-building code (corpus scan,
 * scratch/type-discipline-corpus-scan.mts): a bare identifier/property
 * check (`cond ? … : {}`), its negation (`!cond ? {} : …`), a strict
 * undefined guard, a `typeof` narrowing guard, and a `.length`/`.size`
 * non-empty guard. Returns null for anything else (a boolean expression,
 * `&&`/`||`, an arbitrary function call, …) — those stay conservative (not
 * recognized as a guard at all, so the caller never exempts them).
 */
function guardedExpression(
	ts: TsModule,
	sourceFile: TS.SourceFile,
	test: TS.Expression,
): GuardedCheck | null {
	const expr = unwrapParenExpr(ts, test);

	if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
		return { expressionText: expr.operand.getText(sourceFile).trim(), isDefinedWhenTrue: false };
	}

	const undef = undefinedCheckedExpression(ts, sourceFile, expr);
	if (undef) return undef;

	const typeofCheck = typeofCheckedExpression(ts, sourceFile, expr);
	if (typeofCheck) return typeofCheck;

	const lengthExpr = lengthCheckedExpression(ts, sourceFile, expr);
	if (lengthExpr !== null) return { expressionText: lengthExpr, isDefinedWhenTrue: true };

	if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
		return { expressionText: expr.getText(sourceFile).trim(), isDefinedWhenTrue: true };
	}

	return null;
}

/**
 * Strips optional-chaining `?.` down to plain `.`. Used only to COMPARE the
 * guard expression against the populated branch's property value: inside
 * that branch the guard has already proven the chain non-nullish, so
 * `existingShared?.mode ? { mode: existingShared.mode } : {}` — guard with
 * `?.`, value with plain `.`, same underlying path — is the same idiom as
 * an exact match, just spelled defensively at the check and confidently
 * inside the branch it guards. Never used for anything but this
 * side-by-side text comparison.
 */
function stripOptionalChaining(text: string): string {
	return text.replace(/\?\./g, ".");
}

/**
 * True for the idiomatic conditional-key-omission pattern — `<guard> ?
 * { key: expr } : {}` (or the branch-swapped mirror, including shorthand
 * `{ key }`) — where the ternary's guarded expression (see
 * `guardedExpression`) and the populated branch's single property VALUE
 * are textually identical (up to `?.`/`.` — see `stripOptionalChaining`).
 * This is NOT a smell: spreading `{}` is the (sometimes only) way to OMIT a
 * key entirely rather than set it explicitly — under
 * `exactOptionalPropertyTypes`, setting a key to `undefined` is itself a
 * type error, and either way it is a different runtime shape (`"key" in
 * obj` flips).
 *
 * Mirrors the upstream rule's own `canAutofixConditionalEmptyObjectSpread`
 * shape (the strict-undefined-guard subset) — upstream treats that subset
 * as AUTOFIXABLE (replaces the whole spread with the bare property), which
 * is wrong under `exactOptionalPropertyTypes`: that substitution sets the
 * key explicitly instead of omitting it, a behavior change. We treat the
 * same shape as exempt instead, and widen it past upstream's strict-
 * undefined-only recognition to the other guard shapes this repo's own
 * code actually uses (bare truthy checks, `typeof`, `.length`/`.size`,
 * optional chaining).
 *
 * Measured need: see file header — 241 corpus fires before any exemption,
 * down to 32 after this exemption (7 of the drop from `?.`-vs-`.` alone,
 * in `lib/config.ts`).
 */
function isGuardedKeyOmission(
	ts: TsModule,
	sourceFile: TS.SourceFile,
	conditional: TS.ConditionalExpression,
): boolean {
	const checked = guardedExpression(ts, sourceFile, conditional.condition);
	if (!checked) return false;

	const whenTrue = unwrapParenExpr(ts, conditional.whenTrue);
	const whenFalse = unwrapParenExpr(ts, conditional.whenFalse);
	const consequentIsEmpty = isEmptyObjectLiteral(ts, whenTrue);
	const alternateIsEmpty = isEmptyObjectLiteral(ts, whenFalse);
	if (consequentIsEmpty === alternateIsEmpty) return false; // not a single-empty-branch ternary

	const populatedBranch = consequentIsEmpty ? whenFalse : whenTrue;
	const populatedIsConsequent = !consequentIsEmpty;
	if (populatedIsConsequent !== checked.isDefinedWhenTrue) return false;

	const property = singleAssignableProperty(ts, populatedBranch);
	if (!property) return false;

	const valueText = stripOptionalChaining(propertyValueText(ts, sourceFile, property));
	return valueText === stripOptionalChaining(checked.expressionText);
}

/**
 * True when `argument` (the operand of an object-literal spread) is a
 * ternary with `{}` on exactly one branch — the other branch can be
 * anything (a multi-field object, a variable, a call) — EXCLUDING the
 * idiomatic guarded key-omission shape (see `isGuardedKeyOmission`).
 * Mirrors the upstream `conditionalEmptyObjectSpread` matcher; the
 * autofix-eligibility half is repurposed as an exemption rather than
 * ported as a fix — see that function's docstring.
 */
function isFlaggableConditionalEmptySpread(
	ts: TsModule,
	sourceFile: TS.SourceFile,
	argument: TS.Expression,
): boolean {
	const conditional = unwrapParenExpr(ts, argument);
	if (!ts.isConditionalExpression(conditional)) return false;
	const whenTrue = unwrapParenExpr(ts, conditional.whenTrue);
	const whenFalse = unwrapParenExpr(ts, conditional.whenFalse);
	if (!isEmptyObjectLiteral(ts, whenTrue) && !isEmptyObjectLiteral(ts, whenFalse)) return false;
	return !isGuardedKeyOmission(ts, sourceFile, conditional);
}

function collectConditionalEmptySpreads(ts: TsModule, sourceFile: TS.SourceFile): InlineMatch[] {
	const matches: InlineMatch[] = [];
	const lines = sourceFile.text.split("\n");

	const visit = (node: TS.Node): void => {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;

		// `SpreadAssignment` is TS's node for `{ ...expr }` — object-literal
		// spread only (array/call spreads are the separate `SpreadElement`
		// kind), so no extra "is this inside an ObjectLiteralExpression" check
		// is needed the way the upstream ESTree walker needs one.
		if (
			!ts.isSpreadAssignment(node) ||
			!isFlaggableConditionalEmptySpread(ts, sourceFile, node.expression)
		) {
			ts.forEachChild(node, visit);
			return;
		}

		const line = lineOf(ts, sourceFile, node.getStart(sourceFile));
		matches.push({
			line,
			text: `conditional empty-object spread omits a field via ternary — prefer a direct property or two statements: ${excerptAt(lines, line)}`.slice(
				0,
				REPORT_LINE_TRUNC,
			),
		});

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return matches;
}

/**
 * Detect `{ ...(cond ? {} : { field: v }) }` — a ternary spread that
 * conditionally omits a field from an object literal, instead of a direct
 * conditional property or two statements. (`{ ...(cond && { field: v }) }`
 * reads the same but is exempt: `&&` is not a ConditionalExpression.) The
 * idiomatic guarded key-omission shape — `<guard> ? { key: expr } : {}`,
 * where the property's value is textually the guarded expression — is
 * exempt too; see `isGuardedKeyOmission`.
 *
 * Runs on every JS/TS extension — plain-JS-shaped pattern, not a type
 * issue. Returns `[]` when the file is a test/data file, too large, has no
 * spread syntax at all, or the optional `typescript` dep is unavailable.
 */
export function detectConditionalEmptyObjectSpread(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_ALL_EXTS.includes(getExtension(filePath))) return [];
	if (content.length === 0) return [];
	if (content.split("\n").length > MAX_LINES_PER_FILE) return [];
	if (!content.includes("...")) return [];

	const ts = loadTs();
	if (!ts) return [];

	const sourceFile = parseSourceFile(ts, content, filePath);
	if (!sourceFile) return [];

	try {
		return collectConditionalEmptySpreads(ts, sourceFile);
	} catch {
		return [];
	}
}
