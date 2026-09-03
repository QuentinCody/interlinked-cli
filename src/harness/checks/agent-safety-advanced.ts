// Agent-safety checks — "Additional correctness / style" (part 2 of 2).
// Extracted from agent-safety.ts to stay under the 800-line module ceiling.

import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { parseImports, resolveImportPath } from "../project-graph.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// Self-contained correctness/style detectors live in a sibling to keep this
// module under the line cap. Re-exported so the public surface is unchanged.
export {
	checkAccumulatingSpread,
	checkManualFieldCopy,
	checkPromiseRejectNonError,
	checkRequireAwait,
	checkThrowLiteral,
	checkUnvalidatedJsonBoundary,
} from "./agent-safety-advanced-style.js";
// dead_exports moved to its own module (this file is at the line cap) and gained
// an evidence guard after a live FP storm — see dead-exports-inline.ts.
export { checkDeadExports } from "./dead-exports-inline.js";


/**
 * Detect `export default` declarations that are either anonymous or whose
 * symbol name doesn't match the filename. Default exports are grep-hostile —
 * a cold agent searching for `Foo` misses `export default function Foo`
 * because the symbol name often isn't at the export site and rename tools
 * don't update string references to the default.
 *
 * Flags:
 *   - Anonymous default: `export default function () {}`, `export default () => …`,
 *     `export default {`, `export default [`.
 *   - Named default whose name differs from the filename (case-insensitive).
 *
 * Skips:
 *   - Config files: `vite.config.*`, `vitest.config.*`, `biome.config.*`,
 *     `tsup.config.*`, `tailwind.config.*`, `next.config.*`, `rollup.config.*`,
 *     `webpack.config.*`, `playwright.config.*`. Default export is the framework
 *     contract in each case.
 *   - Test files, `.d.ts`, non-JS/TS extensions.
 */
export function checkDefaultExport(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];
	if (filePath.endsWith(".d.ts")) return [];

	const base = basename(filePath).replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/, "");
	if (
		/^(vite|vitest|biome|tsup|tailwind|next|rollup|webpack|playwright|astro|remix|nuxt|svelte|eslint|prettier|cypress|jest)\.config$/i.test(
			base,
		)
	) {
		return [];
	}

	if (isCloudflareWorkerHandler(content)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const ANON_FORMS = [
		/^export\s+default\s+function\s*\(/, // function () {
		/^export\s+default\s+async\s+function\s*\(/, // async function () {
		/^export\s+default\s+class(?:\s+extends\s+\S+)?\s*\{/, // class { or class extends X {
		/^export\s+default\s+\(/, // (args) =>  OR (expr)
		/^export\s+default\s+\{/, // object literal
		/^export\s+default\s+\[/, // array literal
	];
	const NAMED_FORM =
		/^export\s+default\s+(?:async\s+)?(?:function\s*\*?\s+|class\s+)?([A-Za-z_$][\w$]*)\s*[\s({]?/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = nonNull(strippedLines[i]).trim();
		if (!line.startsWith("export default")) continue;

		// Anonymous forms — always flag.
		if (ANON_FORMS.some((re) => re.test(line))) {
			matches.push({
				line: i + 1,
				text: `anonymous default export: ${originalLines[i]?.trim().slice(0, 120) ?? ""}`,
			});
			continue;
		}

		// Named form — flag when the symbol name doesn't match the filename.
		const named = NAMED_FORM.exec(line);
		if (named) {
			const sym = nonNull(named[1]);
			if (sym.toLowerCase() !== base.toLowerCase()) {
				matches.push({
					line: i + 1,
					text: `default export '${sym}' does not match filename '${base}' — grep-hostile for cold readers`,
				});
			}
		}
	}

	return matches;
}

// Cloudflare Workers handler-shape detection. The runtime dispatches into
// these methods on the default export; renaming the symbol or splitting it
// into named exports breaks the contract. We exempt files that look like
// Worker handler modules from `default_export` flagging.
//
// Detection signals (any one is sufficient):
//   1. `satisfies ExportedHandler<...>` or `: ExportedHandler<...>` —
//      explicit type annotation, highest confidence.
//   2. `export default { ... }` (anonymous object literal) where one of the
//      canonical handler method names appears within ~400 chars of the
//      opening brace (covers method shorthand + property assignment).
//   3. `export default <name>;` paired with `const|let|var <name> = { ... }`
//      whose body contains a canonical handler method name.
const WORKER_HANDLER_METHODS = "fetch|email|queue|scheduled|tail|trace";
const WORKER_HANDLER_TYPE_RE = /(?:satisfies|:)\s*ExportedHandler\b/;
const WORKER_HANDLER_ANON_RE = new RegExp(
	`export\\s+default\\s+\\{[\\s\\S]{0,400}?\\b(?:${WORKER_HANDLER_METHODS})\\s*[(:]`,
);
const WORKER_HANDLER_NAMED_DEFAULT_RE = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;/;

function isCloudflareWorkerHandler(content: string): boolean {
	if (WORKER_HANDLER_TYPE_RE.test(content)) return true;
	if (WORKER_HANDLER_ANON_RE.test(content)) return true;
	const namedMatch = WORKER_HANDLER_NAMED_DEFAULT_RE.exec(content);
	if (namedMatch) {
		const name = namedMatch[1];
		const declRe = new RegExp(
			`(?:const|let|var)\\s+${name}\\s*=\\s*\\{[\\s\\S]{0,400}?\\b(?:${WORKER_HANDLER_METHODS})\\s*[(:]`,
		);
		if (declRe.test(content)) return true;
	}
	return false;
}

/**
 * Detect classes that register subscriptions (addEventListener, setInterval,
 * setTimeout) in one method but don't clean them up in a lifecycle method
 * (`dispose` / `destroy` / `close` / `unmount` / `stop`). The cleanup
 * pair-up is the kind of thing a cold agent easily forgets — adding a
 * subscription feels local to `start()` but the cleanup has to live
 * elsewhere.
 *
 * Heuristic (regex + brace-matching, no AST):
 *   1. Find each `class X { ... }` block. Track braces to find the matching
 *      close.
 *   2. Only consider classes that already declare at least one lifecycle
 *      method — that signals the author thinks in dispose semantics. Classes
 *      without a lifecycle method aren't flagged (we can't claim they "should"
 *      have one).
 *   3. For each subscription primitive present in the class body, check the
 *      lifecycle method body for its paired cleanup:
 *        - `setInterval` → `clearInterval`
 *        - `setTimeout`  → `clearTimeout`
 *        - `addEventListener` → `removeEventListener`
 *   4. Flag the subscription-add line if the pair is missing.
 *
 * Skips test files, non-JS/TS files.
 */
// Forward brace-matcher: scanning `text` from `start` (already one char INSIDE
// an opening brace, so depth begins at 1), return the index just past the
// matching close and whether the braces balanced. Shared by the class-body and
// lifecycle-method body scans in checkLifecycleCleanup.
function matchBraceEnd(text: string, start: number): { end: number; balanced: boolean } {
	let depth = 1;
	let pos = start;
	while (pos < text.length && depth > 0) {
		const ch = text[pos];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		pos++;
	}
	return { end: pos, balanced: depth === 0 };
}

// Extract the bodies of any lifecycle methods (dispose/destroy/close/unmount/
// stop) declared in `classBody`. Each returned string is the method body text
// (including its closing brace), used to look for paired cleanup calls.
function collectLifecycleBodies(classBody: string, names: string[]): string[] {
	const bodies: string[] = [];
	for (const name of names) {
		// Method forms: `dispose() {`, `async dispose() {`, `dispose = () => {`.
		const methodRegex = new RegExp(
			`\\b(?:async\\s+|static\\s+|private\\s+|public\\s+|protected\\s+)*${name}\\s*(?:\\([^)]*\\)\\s*(?::[^{]+)?\\s*\\{|=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>\\s*\\{)`,
			"g",
		);
		for (let mm = methodRegex.exec(classBody); mm !== null; mm = methodRegex.exec(classBody)) {
			const start = mm.index + mm[0].length;
			const { end, balanced } = matchBraceEnd(classBody, start);
			if (balanced) bodies.push(classBody.slice(start, end));
		}
	}
	return bodies;
}

const LIFECYCLE_METHOD_NAMES = ["dispose", "destroy", "close", "unmount", "stop"];
const LIFECYCLE_PAIRS: Array<{ add: RegExp; clean: RegExp; label: string }> = [
	{ add: /\bsetInterval\s*\(/, clean: /\bclearInterval\s*\(/, label: "setInterval" },
	{ add: /\bsetTimeout\s*\(/, clean: /\bclearTimeout\s*\(/, label: "setTimeout" },
	{
		add: /\baddEventListener\s*\(/,
		clean: /\bremoveEventListener\s*\(/,
		label: "addEventListener",
	},
];

// Body of the class-block scan in checkLifecycleCleanup: for ONE matched class
// header, append a finding per subscription primitive whose paired cleanup is
// missing from the class's lifecycle methods. Appends into `matches` in place.
function appendClassLifecycleGaps(
	stripped: string,
	originalLines: string[],
	classMatch: RegExpExecArray,
	matches: InlineMatch[],
): void {
	const bodyStart = classMatch.index + classMatch[0].length;
	const { end: bodyEnd, balanced } = matchBraceEnd(stripped, bodyStart);
	if (!balanced) return; // unbalanced

	const classBody = stripped.slice(bodyStart, bodyEnd);

	// Only warn on classes that already have a lifecycle method — we can't
	// claim every class must have one.
	const lifecycleBodies = collectLifecycleBodies(classBody, LIFECYCLE_METHOD_NAMES);
	if (lifecycleBodies.length === 0) return;
	const combinedCleanup = lifecycleBodies.join("\n");

	for (const pair of LIFECYCLE_PAIRS) {
		if (matches.length >= 10) break;
		if (!pair.add.test(classBody)) continue;
		if (pair.clean.test(combinedCleanup)) continue;

		// Find the subscription-add line within the class body for reporting.
		const addSearch = pair.add.exec(classBody);
		if (!addSearch) continue;
		const absOffset = bodyStart + addSearch.index;
		const lineIdx = (stripped.slice(0, absOffset).match(/\n/g) || []).length;
		matches.push({
			line: lineIdx + 1,
			text: `${pair.label}() without matching ${pair.clean.source.replace(/\\b|\\s\*\\\(|\//g, "")} in lifecycle method: ${originalLines[lineIdx]?.trim().slice(0, 120) ?? ""}`,
		});
	}
}

export function checkLifecycleCleanup(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Scan for class blocks. Use the stripped content for matching so we don't
	// trip on keywords inside strings/comments.
	const classRegex = /\bclass\s+[A-Za-z_$][\w$]*(?:\s+extends\s+[^{]+)?\s*\{/g;
	for (
		let classMatch = classRegex.exec(stripped);
		classMatch !== null;
		classMatch = classRegex.exec(stripped)
	) {
		if (matches.length >= 10) break;
		appendClassLifecycleGaps(stripped, originalLines, classMatch, matches);
	}

	return matches;
}

type ParsedImportEdge = ReturnType<typeof parseImports>[number];

// Walk the import graph outward from `absStart` and collect every path that
// returns to it. `content` is the (possibly unsaved) source of the start file;
// every other file is read from disk and cached for the duration of the walk.
function collectImportCycles(content: string, absStart: string): string[][] {
	const MAX_DEPTH = 10;
	const MAX_PATHS = 5;
	const fileCache = new Map<string, string | null>();
	const readCached = (p: string): string | null => {
		const hit = fileCache.get(p);
		if (hit !== undefined) return hit;
		try {
			const raw = readFileSync(p, "utf-8");
			fileCache.set(p, raw);
			return raw;
		} catch {
			fileCache.set(p, null);
			return null;
		}
	};

	const cycles: string[][] = [];
	const onPath = new Set<string>();

	// One import edge of `current`: record a cycle back to the start file, or
	// descend into the imported file. Mutually recursive with `dfs`.
	const walkEdge = (current: string, trail: string[], edge: ParsedImportEdge): void => {
		if (edge.isTypeOnly) return;
		const resolved = resolveImportPath(current, edge.specifier);
		if (!resolved) return;

		if (resolved === absStart && trail.length > 0) {
			cycles.push([...trail, current, absStart]);
			return;
		}
		if (onPath.has(resolved)) return; // Avoid infinite recursion on other cycles.

		onPath.add(resolved);
		dfs(resolved, [...trail, current]);
		onPath.delete(resolved);
	};

	const dfs = (current: string, trail: string[]): void => {
		if (cycles.length >= MAX_PATHS) return;
		if (trail.length > MAX_DEPTH) return;

		const src = current === absStart && trail.length === 0 ? content : readCached(current);
		if (!src) return;

		const imports = parseImports(src, current);
		for (const edge of imports) {
			if (cycles.length >= MAX_PATHS) return;
			walkEdge(current, trail, edge);
		}
	};

	onPath.add(absStart);
	dfs(absStart, []);
	onPath.delete(absStart);

	return cycles;
}

/**
 * Detect import cycles involving the edited file. A cycle (A → B → C → A)
 * usually signals unclear module boundaries and can cause runtime
 * undefined-at-import-time bugs that are hard to debug because the symptom
 * (a property access on `undefined`) is far from the cause.
 *
 * Self-contained DFS walk:
 *   - Start from the edited file and follow its non-type-only imports.
 *   - For each file, read content on demand (cached per call), parse imports,
 *     resolve specifiers to absolute paths.
 *   - Flag any path that returns to the starting file.
 *   - Cap depth at `MAX_DEPTH` and output at `MAX_PATHS` to stay fast.
 *
 * Type-only imports are skipped — they're erased at compile time and don't
 * create runtime cycles.
 *
 * Skips test files, `.d.ts` files, non-JS/TS extensions, and files outside
 * the project root.
 */
export function checkCircularImports(
	content: string,
	filePath: string,
	cwd: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (filePath.endsWith(".d.ts")) return [];

	const absStart = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	if (relative(cwd, absStart).startsWith("..")) return [];

	const cycles = collectImportCycles(content, absStart);

	const matches: InlineMatch[] = [];
	const seen = new Set<string>();
	for (const cycle of cycles) {
		if (matches.length >= 10) break;
		const readable = cycle.map((p) => relative(cwd, p)).join(" → ");
		if (seen.has(readable)) continue;
		seen.add(readable);
		matches.push({ line: 1, text: `import cycle: ${readable}` });
	}
	return matches;
}

/**
 * Detect exports that no other file in the project imports. Cold-reader
 * clarity signal: `export { foo, bar, baz }` promises a public surface —
 * when half of it is actually dead, a cold agent wastes time trying to
 * understand what `bar` is for when it's never used.
 *
 * Strategy (project-wide, reuses getGitSourceFiles + parseExports):
 *   1. Parse the edited file's exports. Filter out re-exports (covered by
 *      checkExportRipple) and type-only exports (often legitimate public API
 *      even when unused internally).
 *   2. For each other source file that references the edited file's basename
 *      in a string literal (cheap prefilter), parse its imports.
 *   3. Aggregate every imported symbol targeted at the edited file.
 *   4. Flag exports whose names don't appear in that aggregate.
 *
 * Early-exits and skips:
 *   - Skip default exports (conservative: default-export hygiene handled by a
 *     separate check).
 *   - Skip barrel files (`index.ts` / `index.tsx`): those are deliberately
 *     wide re-export surfaces; every name is intentionally a public handle.
 *   - Skip test files. Skip `.d.ts` files.
 *   - If any importer uses a namespace import (`import * as X from ...`),
 *     treat ALL exports as used — the namespace reference could be indexing
 *     into any of them at runtime and we can't tell statically.
 */

