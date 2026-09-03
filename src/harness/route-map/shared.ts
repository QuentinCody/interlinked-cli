// ===========================================
// Route-map shared helpers
// ===========================================
// Pure-function utilities reused by every per-framework adapter under
// `src/harness/route-map/`. No I/O, no framework-specific assumptions
// beyond what's documented per export. Keeping this module small and
// dependency-free lets adapters import only what they need without
// dragging the dispatcher into the import graph.

import type { Endpoint, EndpointFramework, ParamSpec } from "../types/session.js";

/**
 * Convert a directory-segments path (e.g. `users/[id]/posts`) into a URL
 * path (`/users/:id/posts`). Handles file-convention frameworks
 * (Next.js / SvelteKit / Nuxt):
 *   - `[id]`         → `:id`
 *   - `[...slug]`    → `*slug`
 *   - `(group)`      → dropped (Next.js route groups)
 *
 * Pure function. The same logic was inlined in the V0 route-map.ts;
 * promoting it lets each convention adapter share one implementation.
 */
export function conventionPath(rawSegments: string): string {
	const parts = rawSegments.split(/[/\\]/);
	const urlParts = parts.map((part) => {
		if (/^\[\.\.\.(\w+)\]$/.test(part)) {
			return `*${part.slice(4, -1)}`;
		}
		if (/^\[(\w+)\]$/.test(part)) {
			return `:${part.slice(1, -1)}`;
		}
		if (/^\(.+\)$/.test(part)) {
			return null;
		}
		return part;
	});
	return `/${urlParts.filter(Boolean).join("/")}`;
}

/**
 * Extract the named parameters declared in a URL path. Recognizes the
 * four canonical syntaxes — `[id]`, `:id`, `{id}`, `<id>` — so the same
 * helper works for Next.js / Express / Hono / FastAPI conventions.
 *
 * Returns one `ParamSpec` per distinct param, in declaration order, all
 * with `source: "path"`. Caller is responsible for layering query / body
 * / header params on top of these path params.
 */
export function extractPathParams(path: string): ParamSpec[] {
	const params: ParamSpec[] = [];
	const seen = new Set<string>();
	// One regex covering all four conventions; the alternation order is
	// load-bearing — `[...slug]` and `[id]` must precede `:id` matches.
	const re = /\[\.\.\.(\w+)\]|\[(\w+)\]|:(\w+)|\{(\w+)\}|<(\w+)>/g;
	for (let m = re.exec(path); m !== null; m = re.exec(path)) {
		const name = m[1] || m[2] || m[3] || m[4] || m[5];
		if (!name || seen.has(name)) continue;
		seen.add(name);
		params.push({ name, source: "path" });
	}
	return params;
}

/**
 * Returns the 1-indexed line number for a 0-indexed string offset. Mirrors
 * the V0 `before.split("\n").length` computation but avoids the off-by-one
 * subtlety by counting newlines explicitly.
 */
export function lineNumberAt(content: string, offset: number): number {
	if (offset <= 0) return 1;
	let line = 1;
	for (let i = 0; i < offset && i < content.length; i++) {
		if (content[i] === "\n") line += 1;
	}
	return line;
}

/**
 * Find the nearest preceding handler symbol above a route-registration
 * line. Heuristic — no AST. Recognizes:
 *   - `function NAME` / `async function NAME`
 *   - `const NAME =` / `let NAME =` / `var NAME =`
 *   - `export function NAME` / `export const NAME` / `export default function NAME`
 *   - `async def NAME(` (Python — FastAPI)
 *
 * Scans up to `lookbackLines` lines upward; returns `undefined` when no
 * symbol is found in range. The 50-line cap matches the Phase A3 spec.
 *
 * For Python (`opts.language === "python"`) the scan is bidirectional —
 * FastAPI's `@app.get("/x")\n` decorator IS the route line, with the
 * handler following on the next non-blank line.
 */
const LANG_TS = "ts" as const;
const LANG_PYTHON = "python" as const;
type HandlerLanguage = typeof LANG_TS | typeof LANG_PYTHON;

/**
 * Scan backward from `idx` (inclusive) up to `lookback` lines, looking for
 * a `function NAME` / `const|let|var NAME =` declaration (with or without
 * `export`/`export default`/`async`). Returns the first symbol found, or
 * `undefined` when the scan exhausts its range without a match.
 */
function scanBackwardForHandlerSymbol(lines: string[], idx: number, lookback: number): string | undefined {
	for (let i = idx; i >= Math.max(0, idx - lookback); i--) {
		const line = lines[i];
		if (line === undefined) continue;
		let m = /^\s*export\s+default\s+(?:async\s+)?function\s+(\w+)/.exec(line);
		if (m) return m[1];
		m = /^\s*export\s+(?:async\s+)?function\s+(\w+)/.exec(line);
		if (m) return m[1];
		m = /^\s*export\s+(?:const|let|var)\s+(\w+)\s*=/.exec(line);
		if (m) return m[1];
		m = /^\s*(?:async\s+)?function\s+(\w+)/.exec(line);
		if (m) return m[1];
		m = /^\s*(?:const|let|var)\s+(\w+)\s*=/.exec(line);
		if (m) return m[1];
	}
	return undefined;
}

export function findHandlerSymbol(
	content: string,
	routeLine: number,
	opts?: { language?: HandlerLanguage; lookbackLines?: number },
): string | undefined {
	const language: HandlerLanguage = opts?.language ?? LANG_TS;
	const lookback = opts?.lookbackLines ?? 50;
	const lines = content.split("\n");
	const idx = Math.max(0, Math.min(lines.length - 1, routeLine - 1));

	if (language === LANG_PYTHON) {
		for (let i = idx; i < Math.min(lines.length, idx + 10); i++) {
			const lineText = lines[i];
			if (lineText === undefined) continue;
			const m = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/.exec(lineText);
			if (m?.[1] !== undefined) return m[1];
		}
		// Fall through if forward scan found nothing.
	}

	return scanBackwardForHandlerSymbol(lines, idx, lookback);
}

/**
 * Build a fresh, fully-populated `Endpoint` record. Convenience wrapper
 * so adapters don't repeat the `auth_chain: [], declared_params: []`
 * boilerplate. Path params are derived from `path` by default; pass
 * `declared_params` to override or to add query/body/header params.
 */
export function makeEndpoint(opts: {
	framework: EndpointFramework;
	method: string;
	path: string;
	file: string;
	line?: number | undefined;
	handler_symbol?: string | undefined;
	declared_params?: ParamSpec[] | undefined;
}): Endpoint {
	return {
		framework: opts.framework,
		method: opts.method,
		path: opts.path,
		file: opts.file,
		line: opts.line,
		handler_symbol: opts.handler_symbol,
		auth_chain: [],
		declared_params: opts.declared_params ?? extractPathParams(opts.path),
	};
}

/**
 * The eight HTTP method names exported by the file-convention frameworks
 * (Next.js / SvelteKit). Includes `ALL` as the catch-all method when a
 * convention file has no `export GET/POST/...` and falls back to "any
 * method". The Express/Hono adapter recognizes the lowercase forms via
 * its call-site regex; this list is convention-side only.
 */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/**
 * Best-effort handler-symbol extraction for a single route-registration
 * line. Tries the cheap inline pattern (`.get("/x", handlerIdent)`)
 * first; falls back to {@link findHandlerSymbol} when the second
 * argument is an inline arrow/function expression. Used by Express and
 * Hono adapters; the two were identical before this consolidation.
 */
export function sniffInlineHandlerSymbol(
	line: string,
	content: string,
	lineNumber: number,
): string | undefined {
	const inline = /["'`][^"'`]+["'`]\s*,\s*([A-Za-z_$][\w$]*)\s*(?:[),]|$)/.exec(line);
	if (inline) return inline[1];
	return findHandlerSymbol(content, lineNumber - 1);
}

/**
 * True if `globalOffset` (a position inside `content`) sits inside a
 * single-line string literal. Counts unescaped `"` and `'` quotes
 * between the start of the matched line and the offset. Used by
 * adapters to filter out matches like
 *   `const docs = "use app.get('/x', h) like this";`
 * where the route-shaped substring is incidental. Line-local; precision
 * good enough for V1.
 */
export function isInsideStringLiteral(globalOffset: number, content: string): boolean {
	const lineStart = content.lastIndexOf("\n", globalOffset - 1) + 1;
	const col = globalOffset - lineStart;
	const lineEnd = content.indexOf("\n", lineStart);
	const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
	const prefix = line.slice(0, col);
	let doubleQ = 0;
	let singleQ = 0;
	for (let i = 0; i < prefix.length; i++) {
		const ch = prefix[i];
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === '"') doubleQ += 1;
		else if (ch === "'") singleQ += 1;
	}
	return doubleQ % 2 === 1 || singleQ % 2 === 1;
}

/** Detect which HTTP-method names a convention route file exports. */
export function detectExportedMethods(content: string): string[] {
	const methods: string[] = [];
	for (const method of HTTP_METHODS) {
		const pattern = new RegExp(
			`^\\s*export\\s+(?:async\\s+)?(?:function|const|let)\\s+${method}\\b`,
			"m",
		);
		if (pattern.test(content)) methods.push(method);
	}
	return methods.length > 0 ? methods : ["ALL"];
}

/**
 * Locate the 1-indexed line of `export ... METHOD` in `content`. Used
 * by file-convention adapters (Next.js / SvelteKit) to anchor each
 * Endpoint at the line where its method handler is declared.
 */
export function findMethodExportLine(content: string, method: string): number | undefined {
	const re = new RegExp(
		`^\\s*export\\s+(?:async\\s+)?(?:function|const|let)\\s+${method}\\b`,
		"m",
	);
	const m = re.exec(content);
	if (!m) return undefined;
	return lineNumberAt(content, m.index);
}

/**
 * True if `content` declares ANY of the HTTP method handlers. Used by
 * file-convention adapters to distinguish "no method exports → not an
 * endpoint" from "no method exports → treat as ALL (catch-all)".
 */
export function hasExportedMethod(content: string): boolean {
	return /\bexport\s+(?:async\s+)?(?:function|const|let)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(
		content,
	);
}
