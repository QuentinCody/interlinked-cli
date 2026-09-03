// Default-branch exhaustiveness-assertion detection for the exhaustiveness
// check: does a switch's `default:` clause assert the discriminant is
// exhausted (never-typed assignment, assertNever/exhaustiveCheck call, or an
// Unreachable/Exhaustive/Impossible/Assertion error throw)?

type TsModule = typeof import("typescript");

const ASSERT_NEVER_RE = /\b(?:assertNever|exhaustiveCheck|absurd|unreachable)\b/;
const UNREACHABLE_THROW_RE = /\bthrow\s+new\s+\w*(?:Unreachable|Exhaustive|Impossible|Assertion)\w*/i;

/**
 * Recognized shapes:
 *   - `const _: never = <expr>;`
 *   - `assertNever(<expr>)` (or aliases above)
 *   - `throw new UnreachableError(...)` / `Exhaustive…Error` / etc.
 *   - any `return assertNever(...)` / `throw assertNever(...)` variant
 *   - any of the above inside a braced clause body (`default: { … }`)
 */
export function defaultBranchAssertsNever(
	ts: TsModule,
	clause: import("typescript").DefaultClause,
	sourceFile: import("typescript").SourceFile,
): boolean {
	return statementsAssertNever(ts, clause.statements, sourceFile);
}

/**
 * Scan a statement list for one of the recognized idioms, descending into a
 * bare `{ … }` block. `default: { const _x: never = c; throw … }` is the FIRST
 * idiom this check's own `fix_instruction` recommends, and the clause then
 * holds a single Block — scanning only the top level reported the recommended
 * fix as a finding. Descent is limited to plain blocks: an assertion buried in
 * an `if`/`try` body is conditional, so it still does not count. Per-statement
 * idiom matching (everything except block descent) lives in
 * `matchesAssertNeverIdiom` — a `Block` statement can never itself satisfy any
 * of those idioms (mutually exclusive `SyntaxKind`s), so recursing and moving
 * on via `continue` is equivalent to falling through the old combined checks.
 */
function statementsAssertNever(
	ts: TsModule,
	statements: readonly import("typescript").Statement[],
	sourceFile: import("typescript").SourceFile,
): boolean {
	for (const stmt of statements) {
		if (ts.isBlock(stmt)) {
			if (statementsAssertNever(ts, stmt.statements, sourceFile)) return true;
			continue;
		}
		if (matchesAssertNeverIdiom(ts, stmt, sourceFile)) return true;
	}
	return false;
}

/**
 * `const _: never = <expr>;` — the never-typed-declaration idiom.
 */
function isNeverTypedDeclaration(ts: TsModule, stmt: import("typescript").Statement): boolean {
	if (!ts.isVariableStatement(stmt)) return false;
	for (const decl of stmt.declarationList.declarations) {
		if (decl.type && decl.type.kind === ts.SyntaxKind.NeverKeyword) return true;
	}
	return false;
}

/**
 * `throw new UnreachableError(...)` / `Exhaustive…Error` / etc., or
 * `throw assertNever(...)` / `throw exhaustiveCheck(...)` variants.
 */
function matchesThrowIdiom(
	ts: TsModule,
	stmt: import("typescript").Statement,
	sourceFile: import("typescript").SourceFile,
): boolean {
	if (!ts.isThrowStatement(stmt)) return false;
	if (ts.isNewExpression(stmt.expression)) {
		const exprText = stmt.expression.expression.getText(sourceFile);
		if (UNREACHABLE_THROW_RE.test(`throw new ${exprText}`)) return true;
	}
	if (ts.isCallExpression(stmt.expression)) {
		if (ASSERT_NEVER_RE.test(stmt.expression.expression.getText(sourceFile))) return true;
	}
	return false;
}

/**
 * `assertNever(<expr>)` (or aliases above), as an expression statement or as
 * `return assertNever(<expr>)`.
 */
function matchesCallExpressionIdiom(
	ts: TsModule,
	stmt: import("typescript").Statement,
	sourceFile: import("typescript").SourceFile,
): boolean {
	if (!(ts.isExpressionStatement(stmt) || ts.isReturnStatement(stmt))) return false;
	if (!stmt.expression || !ts.isCallExpression(stmt.expression)) return false;
	return ASSERT_NEVER_RE.test(stmt.expression.expression.getText(sourceFile));
}

/**
 * Does a single (non-block) statement match one of the recognized
 * exhaustiveness-assertion idioms on its own?
 *   - `const _: never = <expr>;`
 *   - `assertNever(<expr>)` (or aliases above), as an expression statement or
 *     as `return assertNever(<expr>)`
 *   - `throw new UnreachableError(...)` / `Exhaustive…Error` / etc.
 *   - `throw assertNever(...)` / `throw exhaustiveCheck(...)` variants
 */
function matchesAssertNeverIdiom(
	ts: TsModule,
	stmt: import("typescript").Statement,
	sourceFile: import("typescript").SourceFile,
): boolean {
	if (isNeverTypedDeclaration(ts, stmt)) return true;
	if (matchesThrowIdiom(ts, stmt, sourceFile)) return true;
	return matchesCallExpressionIdiom(ts, stmt, sourceFile);
}
