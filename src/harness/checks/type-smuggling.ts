// Type-smuggling detection — flag TypeScript `as T` casts where the source
// expression's static type has no structural overlap with `T`.
//
// The Rust-`unsafe`-shaped escape hatch in TypeScript: a cast that lies, vs.
// a cast that narrows. We trust `as unknown`/`as any` casts (broad widening
// escape hatches), `as const` (literal-narrowing), and any cast where source
// and target overlap structurally in either direction. We flag the rest.
//
// Runtime TypeScript loading (Path C — createRequire + optional load):
//   - This check needs the TypeScript compiler API at runtime. Bundling TS
//     into dist/ trips esbuild's CJS-require helper inside TS's internals,
//     crashing every CLI entry that transitively loads the check registry
//     (`interlinked install-hooks`, etc.).
//   - We use a type-only import for compile-time signatures and
//     `node:module`'s `createRequire` to load TS at runtime from the user's
//     project `node_modules`. esbuild leaves both alone.
//   - When TS isn't installed in the project (rare for a TS-shaped repo,
//     but possible for a JS-only repo where this check wouldn't fire
//     anyway), `loadTs()` returns null and `checkTypeSmuggling` no-ops.
//
// Phase: post / Severity: warning / Gate: advisory (shipped advisory first
// per CLAUDE.md; structural-overlap detection in TS's type system is
// inherently heuristic on union/intersection/generic boundaries).

import { createRequire } from "node:module";
import type * as TS from "typescript";
import { getExtension, type InlineMatch, isTestFile } from "./shared.js";

// Only .ts/.tsx/.mts/.cts are typechecked — plain .js/.jsx have no `as`
// expressions to analyze (cast-shaped JSDoc casts aren't in the AST as
// AsExpression nodes).
const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** Truncate the matching line in the report so the agent's context isn't
 * blown by a single long line. */
const REPORT_LINE_TRUNC = 150;

/** Soft cap on findings per file — keeps the report focused. */
const MAX_MATCHES_PER_FILE = 10;

/** Files larger than this are skipped — type-checking large files is
 * expensive and the detector is advisory, not a gate. */
const MAX_LINES_PER_FILE = 1000;

// ─────────────────────────────────────────────────────────────────────────
// Runtime TypeScript loading
// ─────────────────────────────────────────────────────────────────────────

type TsModule = typeof TS;

// Cache states:
//   undefined  — not yet attempted to resolve
//   null       — attempted, not available in this environment
//   TsModule   — loaded successfully (subsequent calls return cached value)
let _ts: TsModule | null | undefined;

/**
 * Resolve the TypeScript compiler API at runtime from the user's project
 * `node_modules`. Returns null when TS is not installed (this check then
 * silently no-ops).
 *
 * Why this dance: `import ts from "typescript"` causes esbuild to bundle
 * the entire ~10MB TS module into our dist/. The bundled output trips on
 * TS's internal `require("fs")` calls (CJS dynamic require inside an
 * ESM-emitted chunk → "Dynamic require of 'fs' is not supported"). Every
 * CLI entry that transitively loads this check (`install-hooks`,
 * `verify`, etc.) crashes at module init.
 *
 * `createRequire` is a Node-native escape hatch: esbuild leaves it alone,
 * and Node's CJS resolver loads `typescript` from the user's
 * `node_modules` where its internal `require("fs")` works as TS expects.
 * Side benefit: the check uses the user's actual TS version, so its
 * verdict matches what their own tsc would say.
 */
function loadTs(): TsModule | null {
	if (_ts !== undefined) return _ts;
	try {
		// The `/_` suffix is a non-existent sentinel path so createRequire
		// uses CWD as the resolution base. Node only needs a parent path;
		// the file doesn't have to exist.
		const req = createRequire(`${process.cwd()}/_`);
		_ts = req("typescript") as TsModule;
	} catch {
		_ts = null;
	}
	return _ts;
}

/**
 * Test-only reset for the TS module cache. Tests that exercise
 * graceful-degrade paths use this to force a re-resolve under different
 * conditions. Not part of the public check API.
 */
export function __resetTsCacheForTests(): void {
	_ts = undefined;
}

/**
 * Quick AST-text pre-scan: bail out early when the file has no `as T`
 * shape at all. `as` is a keyword in TypeScript but also a common
 * identifier in plain JS — the regex anchors to whitespace + `as` +
 * whitespace and any non-`;` character (covers identifiers, type
 * literals `{`, parens `(`, arrays `[`, and `const`).
 *
 * False positives on the pre-scan are harmless (we'd just continue into
 * the AST walk and find nothing). False negatives (missed AsExpressions)
 * would skip the check; the regex deliberately over-matches.
 */
function hasAsExpressionLikely(content: string): boolean {
	// Match `<expr> as <something>` where the target token starts with an
	// identifier, type-literal brace `{`, paren `(`, bracket `[`, or
	// `const`. Excludes statement-terminating `;` / line end as the start
	// of the target token.
	return /\bas\s+(?:const|[A-Za-z_$({[])/.test(content);
}

/**
 * Conservative type-overlap test using the type-checker's assignability
 * in BOTH directions, plus a handful of escape-hatch carve-outs.
 *
 * Returns true when the cast looks like *smuggling* (no structural
 * relationship between source and target), false otherwise.
 *
 * Conservative because TS's type system has corners — generic constraints,
 * conditional types, mapped types — where the checker's verdict can swing
 * on context. When both `isTypeAssignableTo` directions fail we have high
 * confidence; that's the gate.
 */
/**
 * `TS.TypeChecker.getTypeAtLocation` / `getTypeFromTypeNode` are declared to
 * always return `TS.Type` — but `ts` here is loaded dynamically
 * (`req("typescript")`, see `TsModule`), and the checker instance a caller
 * hands in can be a wrapper/mock around the real one (exercised by the
 * "keeps an earlier match when a LATER cast's source type resolves to
 * undefined" test, which mocks `getTypeAtLocation` to return `undefined` for
 * one node). Route both reads through a call whose return type honestly
 * includes `undefined` so the downstream guard stays necessary — a direct
 * `let sourceType: TS.Type | undefined; sourceType = checker.getTypeAtLocation(...)`
 * would get narrowed back to `TS.Type` by control-flow analysis at the
 * assignment, defeating the point.
 */
function typeAtLocationOf(checker: TS.TypeChecker, node: TS.Node): TS.Type | undefined {
	return checker.getTypeAtLocation(node);
}
function typeFromTypeNodeOf(checker: TS.TypeChecker, node: TS.TypeNode): TS.Type | undefined {
	return checker.getTypeFromTypeNode(node);
}

/**
 * Detect the classic `as unknown as T` double-cast escape: the CHILD of an
 * outer AsExpression is itself an AsExpression whose target is `unknown`.
 * Returns the outer target's source text, or `null` when `node` isn't a
 * double-cast.
 */
function detectDoubleCastTarget(
	ts: TsModule,
	node: TS.AsExpression | TS.TypeAssertion,
	typeNode: TS.TypeNode,
	sourceFile: TS.SourceFile,
): string | null {
	if (
		ts.isAsExpression(node) &&
		ts.isAsExpression(node.expression) &&
		node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
	) {
		return typeNode.getText(sourceFile);
	}
	return null;
}

function isSmugglingCast(
	ts: TsModule,
	checker: TS.TypeChecker,
	sourceType: TS.Type,
	targetType: TS.Type,
): boolean {
	// Escape hatch 1: source is `unknown` or `any` — wide types are explicit
	// widening escape hatches and the agent has signalled intent by the
	// time it's casting from `unknown`. (`unknown as T` is the recommended
	// pattern after JSON.parse / boundary parse.)
	if (sourceType.flags & ts.TypeFlags.Unknown) return false;
	if (sourceType.flags & ts.TypeFlags.Any) return false;

	// Escape hatch 2: target is `unknown` or `any` — widening to escape;
	// almost always immediately re-narrowed. Don't flag.
	if (targetType.flags & ts.TypeFlags.Unknown) return false;
	if (targetType.flags & ts.TypeFlags.Any) return false;

	// Escape hatch 3: source is `never` (TS infers never on a few edge
	// cases — empty arrays, exhaustive switch fallthroughs). Casting from
	// never is mostly a typing artifact, not smuggling.
	if (sourceType.flags & ts.TypeFlags.Never) return false;

	// Either direction assignable = legitimate use of `as`:
	//   - source ⊂ target: widening (e.g. `dogInstance as Animal`)
	//   - target ⊂ source: narrowing (e.g. `animal as Dog`)
	if (checker.isTypeAssignableTo(sourceType, targetType)) return false;
	if (checker.isTypeAssignableTo(targetType, sourceType)) return false;

	// Otherwise: source and target are structurally unrelated.
	return true;
}

/**
 * Detect whether the cast target is itself `any` or `unknown` via syntax,
 * before we even ask the checker. Cheap fast path; also catches the cases
 * where the checker reports the target as `any` because resolution failed.
 */
function targetIsAnyOrUnknownSyntax(ts: TsModule, typeNode: TS.TypeNode): boolean {
	if (typeNode.kind === ts.SyntaxKind.AnyKeyword) return true;
	if (typeNode.kind === ts.SyntaxKind.UnknownKeyword) return true;
	// `as any[]`, `as Record<string, any>` etc still get caught by the
	// type-checker — the syntactic test is just a fast first filter.
	return false;
}

/**
 * Walk all AsExpression and TypeAssertionExpression nodes in the source
 * file and decide per-node whether it's smuggling.
 *
 * Returns `null` when the file should be skipped silently (parse errors,
 * checker unavailable, too-large file).
 */
function collectSmugglingCasts(
	ts: TsModule,
	program: TS.Program,
	sourceFile: TS.SourceFile,
): InlineMatch[] | null {
	const checker = program.getTypeChecker();

	const matches: InlineMatch[] = [];
	const lines = sourceFile.text.split("\n");

	const visit = (node: TS.Node): void => {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;

		// `foo as Bar` — AsExpression
		// `<Bar>foo`  — TypeAssertionExpression (legacy syntax; rare in .tsx
		//                because of JSX collision, but legal in .ts/.mts/.cts)
		// Guard clause (not a de-nested extraction): everything below only
		// applies to As/TypeAssertion nodes, so bail early and recurse for
		// every other node shape. Same branches, same order, same
		// forEachChild-always-runs-once invariant as before, just de-indented
		// by one nesting level (32 -> lower cognitive score; see
		// scratch/type-smuggling-cognitive-probe-2026-08-01.mts).
		if (!(ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))) {
			ts.forEachChild(node, visit);
			return;
		}

		const match = evaluateAsNode(ts, checker, sourceFile, lines, node, node.type);
		if (match) matches.push(match);

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return matches;
}

/**
 * Decide the verdict for a single AsExpression/TypeAssertion node and build
 * its `InlineMatch` when it should be reported. Returns `null` for every
 * "skip silently" path (as-const, any/unknown target, checker-threw,
 * unresolved types, no structural mismatch) — extracted from `visit` so the
 * walker stays a pure recursion, same order/branches as before.
 */
function evaluateAsNode(
	ts: TsModule,
	checker: TS.TypeChecker,
	sourceFile: TS.SourceFile,
	lines: string[],
	node: TS.AsExpression | TS.TypeAssertion,
	typeNode: TS.TypeNode,
): InlineMatch | null {
	// Skip `as const` — literal-narrowing, not smuggling.
	if (
		ts.isAsExpression(node) &&
		ts.isTypeReferenceNode(typeNode) &&
		ts.isIdentifier(typeNode.typeName) &&
		typeNode.typeName.text === "const"
	) {
		return null;
	}

	// Skip casts whose target is `any` / `unknown` — those are legitimate
	// widening escape hatches re-narrowed later.
	if (targetIsAnyOrUnknownSyntax(ts, typeNode)) return null;

	// Detect the classic `as unknown as T` double-cast escape: the CHILD of
	// an outer AsExpression is itself an AsExpression whose target is
	// `unknown`. We flag it with a specific message, since the double-cast
	// is even more diagnostic than a single shape-mismatch cast. We always
	// flag regardless of overlap result, because the inner `as unknown` is
	// itself the lie — the source type at the outer `as T` level is already
	// `unknown` (which would normally be exempt), so the structural-overlap
	// test would say "fine" when the user is actually doing the most
	// suspicious thing. Override that.
	const doubleCastTargetText = detectDoubleCastTarget(ts, node, typeNode, sourceFile);
	if (doubleCastTargetText !== null) {
		const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
		return {
			line: line + 1,
			text: buildDoubleCastReportText(lines[line] || "", doubleCastTargetText),
		};
	}

	let sourceType: TS.Type | undefined;
	let targetType: TS.Type | undefined;
	try {
		sourceType = typeAtLocationOf(checker, node.expression);
		targetType = typeFromTypeNodeOf(checker, typeNode);
	} catch {
		// Checker threw — skip silently rather than false-fire.
		return null;
	}

	if (!sourceType || !targetType) return null;

	if (!isSmugglingCast(ts, checker, sourceType, targetType)) return null;

	const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
	const sourceTypeText = safeTypeToString(checker, sourceType);
	const targetTypeText = typeNode.getText(sourceFile);
	return {
		line: line + 1,
		text: buildSmugglingReportText(lines[line] || "", sourceTypeText, targetTypeText),
	};
}

function safeTypeToString(checker: TS.TypeChecker, t: TS.Type): string {
	try {
		const s = checker.typeToString(t);
		return s.length > 40 ? `${s.slice(0, 37)}...` : s;
	} catch {
		return "<unresolved>";
	}
}

function buildSmugglingReportText(
	lineText: string,
	source: string,
	target: string,
): string {
	const trimmed = lineText.trim().slice(0, 90);
	return `type-smuggling cast: source \`${source}\` has no structural overlap with target \`${target.slice(
		0,
		40,
	)}\` — ${trimmed}`.slice(0, REPORT_LINE_TRUNC);
}

function buildDoubleCastReportText(lineText: string, target: string): string {
	const trimmed = lineText.trim().slice(0, 100);
	return `double-cast detected: \`as unknown as ${target.slice(
		0,
		40,
	)}\` bypasses the type system — ${trimmed}`.slice(0, REPORT_LINE_TRUNC);
}

/**
 * Build a single-file ts.Program for the given content + path.
 *
 * Uses an in-memory CompilerHost so we don't touch the disk for the file
 * under test. Library files (lib.d.ts etc.) come from the real default
 * compiler host — we want assignability checks against real lib types.
 */
function createSingleFileProgram(
	ts: TsModule,
	content: string,
	filePath: string,
): { program: TS.Program; sourceFile: TS.SourceFile } | null {
	const compilerOptions: TS.CompilerOptions = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: false, // we just want type resolution; strict adds nothing here
		skipLibCheck: true,
		skipDefaultLibCheck: true,
		noResolve: true, // suppress module resolution — we only have the one file
		allowJs: false,
		isolatedModules: false,
	};

	const sourceFile = ts.createSourceFile(
		filePath,
		content,
		ts.ScriptTarget.ES2022,
		/* setParentNodes */ true,
		filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);

	const realHost = ts.createCompilerHost(compilerOptions, /* setParentNodes */ true);

	const host: TS.CompilerHost = {
		...realHost,
		getSourceFile: (
			name: string,
			languageVersion: TS.ScriptTarget,
			onError?: (m: string) => void,
			shouldCreate?: boolean,
		) => {
			if (name === filePath) return sourceFile;
			return realHost.getSourceFile(name, languageVersion, onError, shouldCreate);
		},
		writeFile: () => {
			/* no-op — we never emit */
		},
		fileExists: (name: string) => {
			if (name === filePath) return true;
			return realHost.fileExists(name);
		},
		readFile: (name: string) => {
			if (name === filePath) return content;
			return realHost.readFile(name);
		},
		getCanonicalFileName: (name: string) => name,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => "\n",
		getDefaultLibFileName: realHost.getDefaultLibFileName.bind(realHost),
	};

	let program: TS.Program;
	try {
		program = ts.createProgram([filePath], compilerOptions, host);
	} catch {
		return null;
	}

	const resolved = program.getSourceFile(filePath);
	if (!resolved) return null;
	return { program, sourceFile: resolved };
}

/**
 * Public API — flags TypeScript `as T` casts where the source expression's
 * static type does not structurally overlap with `T`.
 *
 * Returns `InlineMatch[]` like every other check. Returns `[]` when the
 * file is non-TS, too large, has no `as` expressions, is a test file, or
 * the type-checker can't be built — all "skip silently" paths are merged
 * into the empty-result return.
 *
 * Also returns `[]` when the TypeScript compiler API is not available in
 * the user's project node_modules (no-op for non-TS projects, where the
 * check wouldn't fire anyway).
 */
export function checkTypeSmuggling(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!TS_EXTS.has(getExtension(filePath))) return [];

	// Bail on huge files — type-checking is expensive and this is advisory.
	// `split("\n")` already counts; cheap relative to the AST walk that
	// follows.
	const lineCount = content.length === 0 ? 0 : content.split("\n").length;
	if (lineCount > MAX_LINES_PER_FILE) return [];

	if (!hasAsExpressionLikely(content)) return [];

	const ts = loadTs();
	// Graceful no-op when TypeScript isn't available in the user's project.
	// For TS projects this branch is never taken; for JS-only projects the
	// check wouldn't fire anyway (no .ts files to scan).
	if (!ts) return [];

	let result: InlineMatch[] | null = null;
	try {
		const built = createSingleFileProgram(ts, content, filePath);
		if (!built) return [];
		result = collectSmugglingCasts(ts, built.program, built.sourceFile);
	} catch {
		// Anything thrown by the compiler — bail silently. The detector is
		// advisory; we'd rather miss a case than false-fire on broken type
		// info. Anchored to the user's CLAUDE.md instruction: "If the
		// type-checker can't resolve a type (errors, dependencies missing),
		// skip silently — don't false-fire on broken type info."
		return [];
	}

	return result ?? [];
}
