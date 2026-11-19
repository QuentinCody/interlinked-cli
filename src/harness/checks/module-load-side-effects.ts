// Top-level (import-time) side-effect detector.
//
// The TS coding standard says modules should not perform I/O, open
// connections, start servers, or read env at import time — module load should
// be free of side effects so the module is testable and import order can't
// cause ordering bugs. This flags a side-effecting call that executes at the
// module level, including immediate invocations and static class initialization.
//
// Heuristic (direct effect names; no transitive call graph or reachability proof) →
// findings tagged `[heuristic]`. Ships advisory. Entrypoint modules
// (index/server/cli/hook-entry/bootstrap/setup) are exempt — bootstrapping is
// exactly where import-time setup belongs.

import { basenameNoExt } from "./shared-path-heuristics.js";
import type { InlineMatch } from "./shared.js";
import type * as TS from "typescript";
import { parseTsSource, hasParseErrors, type ParsedTsSource } from "./cyclomatic-ast.js";
import { reportNotMeasured } from "./check-root.js";

/** Side-effecting calls: fs writes/reads, process spawns, servers, network. */
const SIDE_EFFECT_RE = /^(?:(?:fs|fsp|fsPromises|http|https|net|childProcess)\.)?(?:readFileSync|writeFileSync|appendFileSync|existsSync|mkdirSync|rmSync|readdirSync|execSync|spawnSync|createServer|fetch)$|\.listen$/;
const JS_TS_RE = /\.[mc]?[jt]sx?$/;
const TEST_RE = /\.(?:test|spec)\.[mc]?[jt]sx?$|\/__tests__\//;
const ENTRYPOINT_NAMES: ReadonlySet<string> = new Set([
	"index",
	"main",
	"server",
	"cli",
	"hook-entry",
	"bootstrap",
	"setup",
]);

/**
 * Find side-effecting calls executed at module load (top level).
 *
 * @param content - The source text to scan.
 * @param filePath - The file's path (entrypoints are exempt).
 * @returns One match per top-level side-effecting line.
 */
export function findTopLevelSideEffects(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_RE.test(filePath)) return [];
	if (TEST_RE.test(filePath)) return [];
	if (ENTRYPOINT_NAMES.has(basenameNoExt(filePath))) return [];
	const parsed = parseTsSource(content, filePath);
	if (!parsed || hasParseErrors(parsed.sf)) {
		reportNotMeasured("top_level_side_effect", "complete TypeScript syntax unavailable");
		return [];
	}
	const { ts, sf } = parsed;
	const lines = new Set<number>();
	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node) && SIDE_EFFECT_RE.test(node.expression.getText(sf)) && executesAtModuleLoad(node, parsed)) {
			lines.add(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	const rawLines = content.split("\n");
	return [...lines].map(line => ({ line: line + 1, text: (rawLines[line] ?? "").trim().slice(0, 150) }));
}

/** Recognize eager execution ancestry, optionally relative to an explicitly entered callback. */
export function executesAtModuleLoad(node: TS.Node, { ts }: ParsedTsSource, stop?: TS.Node): boolean {
	for (let parent = node.parent; parent && parent !== stop; parent = parent.parent) {
		if (ts.isFunctionLike(parent)) {
			let callee: TS.Node = parent;
			while (callee.parent && (ts.isParenthesizedExpression(callee.parent) || ts.isAsExpression(callee.parent))) callee = callee.parent;
			if (!callee.parent || !ts.isCallExpression(callee.parent) || callee.parent.expression !== callee) return false;
		}
		if (ts.isPropertyDeclaration(parent) && !parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) return false;
	}
	return true;
}
