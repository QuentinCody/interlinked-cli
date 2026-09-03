// Discriminated-union exhaustiveness check.
//
// Flags TS `switch` statements on a literal-union or discriminated-union typed
// value when exhaustiveness is NOT asserted in the default branch. Strategy:
//   1. Cheap text gate (no `switch (` token → bail).
//   2. Parse via `ts.createSourceFile` (cheap, no Program build).
//   3. Walk SwitchStatement nodes; resolve discriminant type via AST-only
//      heuristics (inline annotations, parameter/variable type, type-alias
//      lookup in the same file). When the type can't be resolved syntactically
//      we skip — heuristic, false-negative-friendly.
//   4. For unions of ≥2 literal members, check case coverage + default-branch
//      assertion (never-typed assignment, assertNever, UnreachableError throw).
//
// Bias: aim for the "added a union member, forgot a case, no assertNever
// default" bug shape without firing on boolean switches, typeof narrowing,
// runtime parsing of unknown input, or numeric-discriminated fully-covered
// switches.

import { createRequire } from "node:module";
import { parseTsSourceWith } from "./cyclomatic-ast.js";
import { defaultBranchAssertsNever } from "./exhaustiveness-assert-never.js";
import {
	indexTypeAliases,
	resolveExpressionType,
	type ResolutionContext,
	typeNodeToDiscriminatedUnion,
	typeNodeToLiteralUnion,
} from "./exhaustiveness-type-resolution.js";
import { getExtension, type InlineMatch, isTestFile } from "./shared.js";

// `typescript` is a devDep; load lazily so the check is a no-op in
// environments where the package is missing.
type TsModule = typeof import("typescript");
const nodeRequire = createRequire(import.meta.url);
let _tsCache: TsModule | null | undefined;

function loadTs(): TsModule | null {
	if (_tsCache !== undefined) return _tsCache;
	try {
		_tsCache = nodeRequire("typescript") as TsModule;
	} catch {
		_tsCache = null;
	}
	return _tsCache;
}

/** Test-only hook so unit tests can simulate `typescript` being unavailable. */
export function __resetTsCacheForTesting(): void {
	_tsCache = undefined;
}

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;

/**
 * Detect TS switch statements on discriminated unions that lack an
 * exhaustiveness assertion in the default branch. No-op outside .ts/.tsx/.mts/
 * .cts, in test files, and when the `typescript` package is unavailable.
 */
export function checkDiscriminatedUnionExhaustiveness(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!SUPPORTED_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	if (!/\bswitch\s*\(/.test(content)) return [];

	const maybeTs = loadTs();
	if (!maybeTs) return [];
	const ts: TsModule = maybeTs;

	const sourceFile = parseTsSourceWith(ts, content, filePath);

	const lines = sourceLineTexts(sourceFile, content);
	const matches: InlineMatch[] = [];
	const ctx: ResolutionContext = {
		localUnions: indexTypeAliases(ts, sourceFile, typeNodeToLiteralUnion),
		localDiscriminated: indexTypeAliases(ts, sourceFile, typeNodeToDiscriminatedUnion),
	};

	const visit = (node: import("typescript").Node): void => {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		if (ts.isSwitchStatement(node)) {
			const finding = analyzeSwitch(ts, node, sourceFile, lines, ctx);
			if (finding) matches.push(finding);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	return matches;
}

/**
 * Split `content` on TypeScript's OWN line terminators, not `split("\n")`.
 *
 * The reported line index comes from `getLineAndCharacterOfPosition`, and TS's
 * scanner breaks lines on a lone CR and on U+2028 / U+2029 as well as LF. An
 * LF-only split therefore desynchronizes from that index on such files: the
 * index runs past the end of the split view, so the source snippet silently
 * degrades to the empty string. Deriving both from the same line table keeps
 * `lines[line]` in range for every position the parser can hand back.
 */
function sourceLineTexts(
	sourceFile: import("typescript").SourceFile,
	content: string,
): string[] {
	const starts = sourceFile.getLineStarts();
	return starts.map((start, i) => content.slice(start, starts[i + 1] ?? content.length));
}

// ---------------------------------------------------------------------------
// Switch analysis
// ---------------------------------------------------------------------------

function analyzeSwitch(
	ts: TsModule,
	node: import("typescript").SwitchStatement,
	sourceFile: import("typescript").SourceFile,
	lines: string[],
	ctx: ResolutionContext,
): InlineMatch | null {
	const expr = node.expression;
	// `switch (typeof x)` — type-narrow style; not the bug shape we target.
	if (ts.isTypeOfExpression(expr)) return null;

	const resolved = resolveExpressionType(ts, expr, ctx);
	if (!resolved || resolved.tags.length < 2) return null;

	const caseTags = new Set<string>();
	let defaultClause: import("typescript").DefaultClause | null = null;
	for (const clause of node.caseBlock.clauses) {
		if (ts.isDefaultClause(clause)) {
			defaultClause = clause;
			continue;
		}
		const tag = caseExpressionToLiteralTag(ts, clause.expression);
		if (tag !== null) caseTags.add(tag);
	}

	const missing = resolved.tags.filter((t) => !caseTags.has(t));
	if (missing.length === 0) return null; // Fully covered by cases.
	if (defaultClause && defaultBranchAssertsNever(ts, defaultClause, sourceFile)) {
		return null;
	}

	const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	const lineNo = line + 1;
	const raw = (lines[line] ?? "").trim();
	const missingDisplay = missing.slice(0, 3).join(", ") + (missing.length > 3 ? ", …" : "");
	const detail = resolved.discriminant
		? `discriminated union on \`${resolved.discriminant}\` missing case(s): ${missingDisplay}`
		: `union missing case(s): ${missingDisplay}`;
	return {
		line: lineNo,
		text: `${raw.slice(0, REPORT_LINE_TRUNC)} — ${detail}`.slice(0, 200),
	};
}

/** Convert a `case <expr>:` expression to its tag form, or null. */
function caseExpressionToLiteralTag(
	ts: TsModule,
	expr: import("typescript").Expression,
): string | null {
	if (ts.isStringLiteralLike(expr)) return JSON.stringify(expr.text);
	if (ts.isNumericLiteral(expr)) return expr.text;
	if (ts.isNoSubstitutionTemplateLiteral(expr)) return JSON.stringify(expr.text);
	// `case -1:` / `case +2:`. Both are PrefixUnaryExpressions, never numeric
	// literals — treating only the minus form as a tag made `case +2:` invisible
	// and reported an exhaustive switch as missing that member.
	if (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) {
		if (expr.operator === ts.SyntaxKind.MinusToken) return `-${expr.operand.text}`;
		if (expr.operator === ts.SyntaxKind.PlusToken) return expr.operand.text;
	}
	return null;
}
