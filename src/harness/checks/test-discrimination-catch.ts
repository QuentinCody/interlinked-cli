// CLASS: assertions only reached through catch can pass when nothing throws.
// FIRES WHEN: an active test's assertions occur only in catch, the try has no
// assertion/failure sentinel, and no recognized assertion-count/throw guard exists.
// DOES NOT FIRE: expect.assertions/hasAssertions, a fail/throw sentinel in try,
// a recognized toThrow assertion, skipped tests, or unavailable optional TypeScript.
// CALIBRATION (2026-09-06/07, tracked tests in this tree; historical snapshots):
// | pass | hits/files | inspected precision | correction |
// | AST implementation | 0/0 | unmeasured (no hits) | 16 companion cases on build |
// KNOWN GAPS: guards are lexical, not a proof of reachability or positive count;
// nested helper execution and aliased assertion libraries are not fully modeled.
// HOW TO EXTEND: change AST guard classification with P/N counterexamples;
// retain skipped-test handling. Census: scripts/scan-test-discrimination.ts.

import { testCallInfo } from "./test-structure.js";
import type * as TS from "typescript";
import { parseTsSource } from "./cyclomatic-ast.js";
import { getExtension, type InlineMatch, isTestFile, JS_TS_EXTS } from "./shared.js";
import { checkMatchLimit } from "./check-scan-policy.js";

type TsModule = typeof TS;


const MAX_MATCHES = 10;

interface TestBlock {
	body: TS.Node;
}

/** Find every (non-skipped) it()/test()/specify() block with a function body. */
function findTestBlocks(ts: TsModule, sf: TS.SourceFile): TestBlock[] {
	const blocks: TestBlock[] = [];
	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node)) {
			const info = testCallInfo(ts, node);
			if (info && !info.skipped) {
				const fnArg = node.arguments.find(
					(a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
				);
				if (fnArg?.body) blocks.push({ body: fnArg.body });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return blocks;
}

/** Collect every `TryStatement` anywhere inside `node` (any nesting depth). */
function collectTryStatements(ts: TsModule, node: TS.Node): TS.TryStatement[] {
	const found: TS.TryStatement[] = [];
	const visit = (n: TS.Node): void => {
		if (ts.isTryStatement(n)) found.push(n);
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

/** Walk down through chained property accesses / calls to the root identifier
 *  name (`expect(x).not.toBe(y)` → "expect"; `assert.strictEqual(a, b)` →
 *  "assert"; `fail(...)` → "fail"). Returns null when the chain does not
 *  bottom out at a bare identifier (e.g. `obj[key](...)`). */
function calleeRootIdentifier(ts: TsModule, expr: TS.Expression): string | null {
	let cur: TS.Expression = expr;
	for (;;) {
		if (ts.isPropertyAccessExpression(cur)) {
			cur = cur.expression;
			continue;
		}
		if (ts.isCallExpression(cur)) {
			cur = cur.expression;
			continue;
		}
		if (ts.isIdentifier(cur)) return cur.text;
		return null;
	}
}

/** True when some property-access name along the chain equals `name`
 *  (e.g. `chainHasMemberName(expect(x).rejects.toThrow(), "toThrow")`). */
function chainHasMemberName(ts: TsModule, expr: TS.Expression, name: string): boolean {
	let cur: TS.Expression = expr;
	for (;;) {
		if (ts.isPropertyAccessExpression(cur)) {
			if (cur.name.text === name) return true;
			cur = cur.expression;
			continue;
		}
		if (ts.isCallExpression(cur)) {
			cur = cur.expression;
			continue;
		}
		return false;
	}
}

/** True when `node` (or any descendant) contains a call rooted at `expect`
 *  or `assert` — the broad "this block has an assertion" signal. */
function hasAssertionCall(ts: TsModule, node: TS.Node): boolean {
	let found = false;
	const visit = (n: TS.Node): void => {
		if (found) return;
		if (ts.isCallExpression(n)) {
			const root = calleeRootIdentifier(ts, n.expression);
			if (root === "expect" || root === "assert") {
				found = true;
				return;
			}
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

/** True when `node` contains `expect.assertions(n)` or `expect.hasAssertions()`
 *  anywhere — the standard vitest/jest "N assertions must run" guard. */
function hasAssertionsCountGuard(ts: TsModule, node: TS.Node): boolean {
	let found = false;
	const visit = (n: TS.Node): void => {
		if (found) return;
		if (
			ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			ts.isIdentifier(n.expression.expression) &&
			n.expression.expression.text === "expect" &&
			(n.expression.name.text === "assertions" || n.expression.name.text === "hasAssertions")
		) {
			found = true;
			return;
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

/** True when `node` contains `expect(...).toThrow(...)` (or `.rejects.toThrow`)
 *  anywhere — an explicit "this call must throw" assertion elsewhere in the
 *  block makes an unguarded try/catch a non-issue. */
function hasToThrowGuard(ts: TsModule, node: TS.Node): boolean {
	let found = false;
	const visit = (n: TS.Node): void => {
		if (found) return;
		if (ts.isCallExpression(n)) {
			const root = calleeRootIdentifier(ts, n.expression);
			if (root === "expect" && chainHasMemberName(ts, n.expression, "toThrow")) {
				found = true;
				return;
			}
		}
		ts.forEachChild(n, visit);
	};
	visit(node);
	return found;
}

/** True when `call` is a "this must not be reached" sentinel: bare `fail(...)`,
 *  `assert.fail(...)`, or `expect.unreachable(...)`. */
function isFailSentinelCall(ts: TsModule, call: TS.CallExpression): boolean {
	const root = calleeRootIdentifier(ts, call.expression);
	if (root === "fail") return true;
	if (root === "assert" && chainHasMemberName(ts, call.expression, "fail")) return true;
	if (root === "expect" && chainHasMemberName(ts, call.expression, "unreachable")) return true;
	return false;
}

/** True when the LAST statement of a try body is a `throw`, or a fail-sentinel
 *  call — the "must not fall through silently" guard. */
function tryEndsWithFailGuard(ts: TsModule, tryBlock: TS.Block): boolean {
	const stmts = tryBlock.statements;
	const last = stmts[stmts.length - 1];
	if (!last) return false;
	if (ts.isThrowStatement(last)) return true;
	if (ts.isExpressionStatement(last) && ts.isCallExpression(last.expression)) {
		return isFailSentinelCall(ts, last.expression);
	}
	return false;
}

function buildMatch(sf: TS.SourceFile, tryStmt: TS.TryStatement, content: string): InlineMatch {
	const line = sf.getLineAndCharacterOfPosition(tryStmt.getStart(sf)).line + 1;
	const raw = (content.split("\n")[line - 1] ?? "").trim();
	const text =
		`catch_without_assertion_guard: try body asserts nothing and has no fail-guard, but the ` +
		`catch block asserts — this test passes vacuously if the SUT never throws (${raw})`;
	return { line, text: text.slice(0, 150) };
}

/**
 * Flag `try { … } catch (e) { … expect(…) … }` blocks inside a test where the
 * catch is the sole source of assertions and nothing guards against the SUT
 * silently not throwing. Returns [] when the file is not a test file or the
 * optional `typescript` dep is absent.
 */
function unguardedCatch(ts: TsModule, tryStmt: TS.TryStatement): boolean {
	if (!tryStmt.catchClause || !hasAssertionCall(ts, tryStmt.catchClause.block)) return false;
	if (hasAssertionCall(ts, tryStmt.tryBlock)) return false;
	return !tryEndsWithFailGuard(ts, tryStmt.tryBlock);
}

/** Find unguarded catch assertions in supported tests; optional-parser absence has no findings. */
export function checkCatchWithoutAssertionGuard(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const parsed = parseTsSource(content, filePath);
	if (!parsed) return [];
	const { ts, sf } = parsed;
	const matches: InlineMatch[] = [];
	const maxMatches = checkMatchLimit(MAX_MATCHES);

	for (const block of findTestBlocks(ts, sf)) {
		if (matches.length >= maxMatches) break;
		if (hasAssertionsCountGuard(ts, block.body) || hasToThrowGuard(ts, block.body)) continue;
		for (const tryStmt of collectTryStatements(ts, block.body).filter((statement) => unguardedCatch(ts, statement))) {
			if (matches.length >= maxMatches) break;
			matches.push(buildMatch(sf, tryStmt, content));
		}
	}

	return matches;
}
