// interlinked-tdd: exempt
// Loop-body performance anti-pattern checks (await/query/sort/json/regex/clone/
// malloc/sprintf/string-concat in loops). Split out of performance.ts to keep
// that module under the per-file line cap. The shared loop-body extractors
// (`extractBraceLoopBodies`, `getLoopBodies`) stay in performance.ts —
// `extractBraceLoopBodies` exceeds the cyclomatic cap and anchors there — and
// are imported back here. Each detector's `loop` binding is inferred from those
// extractors' return type, so `LoopBody` itself need not be imported by name.

import { nonNull } from "../../lib/non-null.js";
import { extractBraceLoopBodies, getLoopBodies } from "./performance.js";
import { getExtension, type InlineMatch } from "./shared.js";

/**
 * Detect await inside for/while loops (not for-await-of).
 * Serializes inherently parallel work — use Promise.all() instead.
 */
/**
 * Check if an await at line `awaitIdx` within a loop body is inside a nested
 * async function/arrow. If so, the await is in a different execution scope
 * (e.g., promises.push(async () => { await ... })) and is NOT sequential.
 */
function isAwaitInNestedAsync(bodyLines: string[], awaitIdx: number): boolean {
	// Scan backward from the await line looking for async declarations.
	// Track brace depth relative to each async declaration.
	let depth = 0;
	for (let k = awaitIdx; k >= 0; k--) {
		const line = nonNull(bodyLines[k]);
		// Count braces in reverse — closing braces increase depth, opening decrease
		for (let c = line.length - 1; c >= 0; c--) {
			if (line[c] === "}") depth++;
			if (line[c] === "{") depth--;
		}
		// If we find an async declaration and we're inside its braces (depth < 0),
		// the await is inside a nested async function
		if (
			k < awaitIdx &&
			depth < 0 &&
			/\basync\s+(function\b|\(|[a-zA-Z_$]\w*\s*=>)/.test(line)
		) {
			return true;
		}
	}
	return false;
}

export function checkAwaitInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const bodies = extractBraceLoopBodies(content);
	const matches: InlineMatch[] = [];

	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (!/\bawait\b/.test(nonNull(loop.bodyLines[i]))) continue;

			// Skip if the await is inside a nested async function/arrow
			if (isAwaitInNestedAsync(loop.bodyLines, i)) continue;

			matches.push({
				line: loop.startLine + i,
				text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
			});
			break; // One per loop is enough
		}
	}

	return matches;
}

/**
 * Per-language regex extracting the iterated identifier from a loop head line
 * (`for (const row of rows)` → `rows`). Null when the language has no
 * head-iterable form we trace (C-style index loops carry no iterable name).
 */
function loopIterableRegexFor(ext: string): RegExp | null {
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		return /\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)\s+[^)]*?\s+(?:of|in)\s+(?:await\s+)?([A-Za-z_$][\w$]*)/;
	}
	if (ext === ".py") return /\bfor\s+[\w,\s()]+?\s+in\s+([A-Za-z_]\w*)\s*[:.[]/;
	if (ext === ".go") return /\bfor\s+[^:={]*:=\s*range\s+([A-Za-z_]\w*)/;
	if (ext === ".rs") return /\bfor\s+[\w\s,()]+?\s+in\s+&?(?:mut\s+)?([A-Za-z_]\w*)/;
	if (ext === ".java") return /\bfor\s*\(\s*[\w<>[\],\s]+?\s+\w+\s*:\s*([A-Za-z_]\w*)\s*\)/;
	if (ext === ".swift") return /\bfor\s+\w+\s+in\s+([A-Za-z_]\w*)\b/;
	return null;
}

/** Shared per-file state for the query-in-loop scan, built once per call. */
interface QueryScanCtx {
	/** The language's query-call pattern. */
	pattern: RegExp;
	/** Original file lines (for head/assignment tracing). */
	contentLines: string[];
	/** Loop-head iterable extractor, null when the language has none. */
	iterRe: RegExp | null;
}

/**
 * Trace the loop's iterable back to a prior query-result assignment — the
 * defining N+1 shape (`rows = query(); for row of rows: query(row.x)`).
 * Scans up to 8 lines above the body for the loop head, then up to 40 lines
 * above the head for an assignment whose LHS binds the iterable and whose
 * RHS matches the same query pattern. Returns null when no tie is found;
 * the caller still reports the plain query-in-loop finding.
 */
function findQueryFedIterable(
	ctx: QueryScanCtx,
	bodyStartLine: number,
): { sourceLine: number; iterable: string } | null {
	if (!ctx.iterRe) return null;
	const lines = ctx.contentLines;
	for (let k = bodyStartLine - 2; k >= Math.max(0, bodyStartLine - 8); k--) {
		const m = ctx.iterRe.exec(nonNull(lines[k]));
		if (!m) continue;
		const iterable = nonNull(m[1]);
		// LHS-binding test: iterable appears before the first `=` (covers
		// const/let/var, tuple destructuring, and Go's `rows, err :=`).
		const lhsRe = new RegExp(`^[^=]*\\b${iterable.replace(/\$/g, "\\$")}\\b[^=]*=(?!=)`);
		for (let j = k - 1; j >= Math.max(0, k - 40); j--) {
			const line = nonNull(lines[j]);
			if (lhsRe.test(line) && ctx.pattern.test(line)) {
				return { sourceLine: j + 1, iterable };
			}
		}
		return null; // head found, no query-fed source — don't keep scanning up
	}
	return null;
}

/**
 * Detect database queries inside loops — the N+1 query anti-pattern.
 * Each iteration is a round-trip to the database.
 *
 * When the loop's iterable traces to a prior query result, the finding text
 * carries an `[n+1: ...]` tag naming the source line and the batched fix —
 * the confirmed N+1 shape, vs the weaker "some query in some loop".
 */
function queryCallPatternFor(ext: string): RegExp | null {
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		return /\b(db|prisma|knex|sequelize|pool|client|connection|sql|supabase)\s*\.\s*(query|execute|exec|find|findOne|findMany|findUnique|findFirst|select|insert|update|delete|raw|prepare|get|all|run)\s*\(/;
	}
	if (ext === ".py") {
		return /\b(cursor|session|db|conn|connection)\s*\.\s*(execute|executemany|query|filter|all|get|fetch|fetchone|fetchall)\s*\(/;
	}
	if (ext === ".go") {
		return /\b(db|tx|conn|pool)\s*\.\s*(Query|QueryRow|Exec|Get|Select|NamedExec)\s*\(/;
	}
	if (ext === ".rs") {
		return /\b(sqlx::query|diesel::|\.execute|\.fetch_one|\.fetch_all|\.fetch_optional)\s*\(/;
	}
	if (ext === ".java") {
		return /\b(statement|preparedStatement|session|entityManager|jdbcTemplate)\s*\.\s*(execute|executeQuery|executeUpdate|find|persist|merge|createQuery)\s*\(/i;
	}
	if (ext === ".swift") {
		return /\b(context|viewContext|managedObjectContext)\s*\.\s*(fetch|execute|save|count)\s*\(|\b(db|dbQueue|dbPool)\s*\.\s*(read|write|execute)\s*\(/;
	}
	return null;
}

type QueryLoopBody = ReturnType<typeof getLoopBodies>[number];

/** First query hit inside one loop body, tagged `[n+1: ...]` when the loop's iterable traces to a prior query result. */
function queryLoopMatch(loop: QueryLoopBody, ctx: QueryScanCtx): InlineMatch | null {
	for (let i = 0; i < loop.bodyLines.length; i++) {
		if (!ctx.pattern.test(nonNull(loop.bodyLines[i]))) continue;
		const fed = findQueryFedIterable(ctx, loop.startLine);
		const tag = fed
			? ` [n+1: \`${fed.iterable}\` is loaded by the query at line ${fed.sourceLine} — batch into one query (WHERE ... IN (...), a JOIN, or the ORM's include/prefetch)]`
			: "";
		return {
			line: loop.startLine + i,
			text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150) + tag,
		};
	}
	return null;
}

export function checkQueryInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const bodies = getLoopBodies(content, filePath);
	if (bodies.length === 0) return [];

	const pattern = queryCallPatternFor(ext);
	if (!pattern) return [];

	const ctx: QueryScanCtx = {
		pattern,
		contentLines: content.split("\n"),
		iterRe: loopIterableRegexFor(ext),
	};

	const matches: InlineMatch[] = [];
	for (const loop of bodies) {
		if (matches.length >= 10) break;
		const match = queryLoopMatch(loop, ctx);
		if (match) matches.push(match);
	}

	return matches;
}

/**
 * Detect string concatenation with += in loops — O(n²) in Python and Go.
 * Python strings are immutable; Go strings require reallocation.
 */
export function checkStringConcatInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".py" && ext !== ".go") return [];

	const bodies = getLoopBodies(content, filePath);
	const matches: InlineMatch[] = [];
	const pattern = ext === ".py" ? /\w+\s*\+=\s*["'f]/ : /\w+\s*\+=\s*["'`]|fmt\.Sprintf/;

	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (pattern.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

/**
 * Detect new RegExp() or re.compile() inside loop bodies.
 * Regex compilation is expensive — hoist above the loop.
 */
export function checkRegexInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const bodies = getLoopBodies(content, filePath);
	if (bodies.length === 0) return [];

	let pattern: RegExp;
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		pattern = /\bnew\s+RegExp\s*\(/;
	} else if (ext === ".py") {
		pattern = /\bre\.compile\s*\(/;
	} else if (ext === ".swift") {
		pattern = /\bNSRegularExpression\s*\(pattern:|try\s+Regex\s*\(/;
	} else {
		return [];
	}

	const matches: InlineMatch[] = [];
	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (pattern.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

/**
 * Detect .clone() inside loop bodies in Rust — unnecessary heap allocation.
 * Borrow instead, or use Rc/Arc for shared ownership.
 */
export function checkCloneInLoop(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".rs") return [];

	const bodies = extractBraceLoopBodies(content);
	const matches: InlineMatch[] = [];

	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (/\.clone\s*\(\s*\)/.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

/**
 * Scan one loop body for the first line matching `pattern`, returning it as
 * an InlineMatch (or null if the loop body has no match).
 */
function findFirstSortMatch(
	loop: ReturnType<typeof getLoopBodies>[number],
	pattern: RegExp,
): InlineMatch | null {
	for (let i = 0; i < loop.bodyLines.length; i++) {
		if (pattern.test(nonNull(loop.bodyLines[i]))) {
			return {
				line: loop.startLine + i,
				text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
			};
		}
	}
	return null;
}

/**
 * Detect .sort() / sorted() inside loop bodies — O(n² log n) total.
 * Sort once before the loop, or use a heap/priority queue.
 */
export function checkSortInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const bodies = getLoopBodies(content, filePath);
	if (bodies.length === 0) return [];

	let pattern: RegExp;
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		pattern = /\.sort\s*\(/;
	} else if (ext === ".py") {
		pattern = /\bsorted\s*\(|\.sort\s*\(/;
	} else if (ext === ".rs") {
		pattern = /\.sort\s*\(|\.sort_by\s*\(|\.sort_unstable/;
	} else if (ext === ".go") {
		pattern = /\bsort\.(Slice|Sort|Strings|Ints|Float64s)\s*\(/;
	} else if ([".c", ".cpp", ".cc", ".cxx"].includes(ext)) {
		pattern = /\b(qsort|std::sort)\s*\(/;
	} else if (ext === ".swift") {
		pattern = /\.sorted\s*\(|\.sort\s*\(/;
	} else {
		return [];
	}

	const matches: InlineMatch[] = [];
	for (const loop of bodies) {
		if (matches.length >= 10) break;
		const match = findFirstSortMatch(loop, pattern);
		if (match) matches.push(match);
	}

	return matches;
}

/**
 * Detect JSON.parse/stringify or json.loads/dumps inside loop bodies.
 * Serialization churn in hot paths — restructure to serialize outside the loop.
 */
export function checkJsonInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const bodies = getLoopBodies(content, filePath);
	if (bodies.length === 0) return [];

	let pattern: RegExp;
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		pattern = /\bJSON\.(parse|stringify)\s*\(/;
	} else if (ext === ".py") {
		pattern = /\bjson\.(loads|dumps|load|dump)\s*\(/;
	} else if (ext === ".swift") {
		pattern =
			/\bJSONDecoder\s*\(\s*\)\s*\.decode\b|\bJSONEncoder\s*\(\s*\)\s*\.encode\b|\bJSONSerialization\s*\.\s*(?:jsonObject|data)\s*\(/;
	} else {
		return [];
	}

	const matches: InlineMatch[] = [];
	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (pattern.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}

/**
 * Detect malloc/calloc/realloc inside loop without free in same body.
 * Memory leak in hot path.
 */
export function checkMallocInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"].includes(ext)) return [];

	const bodies = extractBraceLoopBodies(content);
	const matches: InlineMatch[] = [];

	for (const loop of bodies) {
		// Check if body has malloc but no free
		const hasFree = /\bfree\s*\(/.test(loop.body);
		if (hasFree) continue;

		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (/\b(malloc|calloc|realloc)\s*\(/.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
				});
				break; // One per loop
			}
		}
	}

	return matches;
}

/**
 * Detect fmt.Sprintf inside loop in Go — allocates formatted string per iteration.
 * Use strings.Builder with WriteString/Fprintf instead.
 */
export function checkSprintfInLoop(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".go") return [];

	const bodies = extractBraceLoopBodies(content);
	const matches: InlineMatch[] = [];

	for (const loop of bodies) {
		for (let i = 0; i < loop.bodyLines.length; i++) {
			if (matches.length >= 10) break;
			if (/\bfmt\.Sprintf\s*\(/.test(nonNull(loop.bodyLines[i]))) {
				matches.push({
					line: loop.startLine + i,
					text: nonNull(loop.originalBodyLines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	return matches;
}
