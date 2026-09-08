// unknown_type_alias — ported from dmmulroy/anti-slop (MIT license,
// https://github.com/dmmulroy/anti-slop), detection ALGORITHM only. No
// Oxlint dependency, no new package — see docs/external-pulse/anti-slop.md
// for the full intake (§7 "smallest spike", §9 artifact). The
// `conditional_empty_object_spread` sibling check from the same intake
// lives in type-discipline.ts (split at the per-file line cap; see
// CLAUDE.md "Per-file line cap").
//
// `type Foo = unknown;`, including through a chain of same-file, non-
// generic aliases (`type Foo = unknown; type Bar = Foo;` flags both).
// Invisible to the existing type-density ratchet: `UNKNOWN_ANNOTATION_PATTERN`
// (quality-checks/ratchet-metrics.ts) requires a literal `:` immediately
// before `unknown`, and a bare alias declaration has no such colon. TS-only
// (type aliases don't exist in plain JS). Ported from
// no-unknown-type-aliases.ts.
//
// Parse-only AST walk — no ts.Program, no ts.TypeChecker; same shape as the
// upstream Oxlint rule (walks its own ESTree + scope manager, never
// `ts.TypeChecker`). Runtime TypeScript loading follows the same
// createRequire dance as type-smuggling.ts / type-discipline.ts (see either
// file's header for the full esbuild-bundling rationale). Returns []
// silently when TypeScript isn't installed — same AST-availability degrade
// contract every parse-based check in this tree follows.
//
// Phase: post / Severity: warning / Gate: advisory — a new detector with no
// dogfood FP history yet; corpus scan (scratch/type-discipline-corpus-scan.mts)
// found 0 fires in this repo's own tree (no `type X = unknown;` anywhere),
// so there was nothing to tighten. See DEFAULT_ADVISORY_SKIPS for rationale.

import { createRequire } from "node:module";
import type * as TS from "typescript";
import { parseTsSourceWith } from "./cyclomatic-ast.js";
import { getExtension, type InlineMatch, isTestFile } from "./shared.js";

type TsModule = typeof TS;

/** TS-only extensions — `type X = …` syntax does not exist in plain JS. */
const TS_ONLY_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);

const MAX_MATCHES_PER_FILE = 10;
const MAX_LINES_PER_FILE = 1500;
const REPORT_LINE_TRUNC = 150;

/** Cheap pre-filter — a real `type X = …` declaration always has whitespace
 *  (space/tab/newline) between the keyword and the name. */
const TYPE_KEYWORD_RE = /\btype\s/;

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

function unwrapParenType(ts: TsModule, type: TS.TypeNode): TS.TypeNode {
	let current = type;
	while (ts.isParenthesizedTypeNode(current)) current = current.type;
	return current;
}

/**
 * Name of a same-file, zero-type-argument alias reference — null for
 * anything else (primitive keywords, generic instantiations, qualified
 * names). Mirrors the upstream `referencedAliasName`.
 */
function referencedAliasName(ts: TsModule, type: TS.TypeNode): string | null {
	const unwrapped = unwrapParenType(ts, type);
	if (!ts.isTypeReferenceNode(unwrapped) || !ts.isIdentifier(unwrapped.typeName)) return null;
	if (unwrapped.typeArguments && unwrapped.typeArguments.length > 0) return null;
	return unwrapped.typeName.text;
}

/**
 * True when `type` resolves to exactly `unknown` — either directly, or by
 * chasing same-file, non-generic alias references. `visited` blocks a
 * circular chain from recursing forever. Mirrors the upstream
 * `resolvesToUnknown`.
 */
function resolvesToUnknown(
	ts: TsModule,
	aliases: ReadonlyMap<string, TS.TypeAliasDeclaration>,
	type: TS.TypeNode,
	visited: ReadonlySet<string>,
): boolean {
	const unwrapped = unwrapParenType(ts, type);
	if (unwrapped.kind === ts.SyntaxKind.UnknownKeyword) return true;

	const name = referencedAliasName(ts, unwrapped);
	if (name === null || visited.has(name)) return false;

	const alias = aliases.get(name);
	if (!alias || (alias.typeParameters && alias.typeParameters.length > 0)) return false;

	return resolvesToUnknown(ts, aliases, alias.type, new Set([...visited, name]));
}

function collectUnknownTypeAliases(ts: TsModule, sourceFile: TS.SourceFile): InlineMatch[] {
	const aliases = new Map<string, TS.TypeAliasDeclaration>();
	for (const stmt of sourceFile.statements) {
		if (ts.isTypeAliasDeclaration(stmt)) aliases.set(stmt.name.text, stmt);
	}
	if (aliases.size === 0) return [];

	const matches: InlineMatch[] = [];
	const lines = sourceFile.text.split("\n");
	for (const alias of aliases.values()) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		if (!resolvesToUnknown(ts, aliases, alias.type, new Set([alias.name.text]))) continue;
		const line = lineOf(ts, sourceFile, alias.name.getStart(sourceFile));
		matches.push({
			line,
			text: `type alias '${alias.name.text}' only renames 'unknown' — keep unknown explicit at the boundary or replace with the parsed type: ${excerptAt(lines, line)}`.slice(
				0,
				REPORT_LINE_TRUNC,
			),
		});
	}
	return matches;
}

/**
 * Detect `type Foo = unknown;` — a named alias whose resolved type (chased
 * through same-file, non-generic alias references) is exactly `unknown`.
 * `Record<string, unknown>` and similar generic instantiations are NOT
 * alias declarations and never match — deliberately consistent with
 * checkBroadObjectTypes's 2026-06 FP fix exempting `Record<string,
 * unknown>` (agent-safety-js-correctness.ts).
 *
 * Returns `[]` when the file is a test/data file, not a TS file, too
 * large, has no `unknown`/`type` tokens at all, or the optional
 * `typescript` dep is unavailable.
 */
export function detectUnknownTypeAlias(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!TS_ONLY_EXTS.has(getExtension(filePath))) return [];
	if (content.length === 0) return [];
	if (content.split("\n").length > MAX_LINES_PER_FILE) return [];
	if (!content.includes("unknown") || !TYPE_KEYWORD_RE.test(content)) return [];

	const ts = loadTs();
	if (!ts) return [];

	const sourceFile = parseSourceFile(ts, content, filePath);
	if (!sourceFile) return [];

	try {
		return collectUnknownTypeAliases(ts, sourceFile);
	} catch {
		return [];
	}
}
