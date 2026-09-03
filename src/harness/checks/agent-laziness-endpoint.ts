// interlinked-tdd: exempt
// Agent-laziness checks (Batch 1) — detectors 6–11.
//
// Split out of agent-laziness.ts to keep each module under the line cap.
// These six inline regex detectors (double-cast, union-widening, NODE_ENV
// branch, fetch-without-timeout, unbounded Promise.all, sync I/O on hot
// paths) are self-contained: each owns its constants + helpers and depends
// only on shared.js. Moved verbatim; behavior is identical.
//
// The main file re-exports these so existing importers keep working.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isCliFile,
	isTestFile,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// ==========================================================================
// 6. `as unknown as X` double cast
// ==========================================================================
// Agents reach for this when a single `as` won't satisfy TypeScript. Lying
// to the type system through a wider escape hatch. Distinct from `as any`.

const DOUBLE_CAST_RE = /\bas\s+unknown\s+as\s+([A-Z][\w$<>[\],\s]*)/;

/** Public API — flags `x as unknown as Foo` double-cast escape hatch. */
export function checkDoubleCastUnknown(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const m = DOUBLE_CAST_RE.exec(nonNull(strippedLines[i]));
		if (!m) continue;
		const target = nonNull(m[1]).trim().slice(0, 30);
		matches.push({
			line: i + 1,
			text: `\`as unknown as ${target}\` — double-cast bypasses the type system. Validate at the boundary instead. ${nonNull(originalLines[i]).trim().slice(0, 80)}`,
		});
	}
	return matches;
}

// ==========================================================================
// 7. Union widened with `string`
// ==========================================================================
// `type X = "a" | "b" | string` defeats the union — TS narrows it back to
// `string`. Agent-specific anti-pattern: writing the literal alternatives
// AND the wide type "to be safe."

const TYPE_ALIAS_ANCHOR_RE = /^\s*(?:export\s+)?type\s+\w+/;
// Match `"a" | "b" | string` where `string` is bare (not followed by `&`).
// Negative lookahead `(?!\s*&)` excludes the branded-string pattern
// `string & {}`, which is the recommended fix and must not be flagged.
const UNION_LITERAL_THEN_BARE_STRING_RE =
	/(?:["'][^"']*["']\s*\|\s*)+\s*(?:\(\s*)?string\b(?!\s*&)/;
const UNION_BARE_STRING_THEN_LITERAL_RE =
	/(?<!&\s*)\bstring\b(?!\s*&)\s*\|\s*(?:["'][^"']*["']\s*(?:\|\s*["'][^"']*["']\s*)*)/;

const TYPE_ALIAS_WINDOW_LINES = 6;

/** Public API — flags string-literal unions widened by a bare `string`. */
export function checkUnionWidenedWithString(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");

	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		if (!TYPE_ALIAS_ANCHOR_RE.test(nonNull(strippedLines[i]))) continue;
		const window = originalLines
			.slice(i, Math.min(originalLines.length, i + TYPE_ALIAS_WINDOW_LINES))
			.join(" ");
		const widensWithString =
			UNION_LITERAL_THEN_BARE_STRING_RE.test(window) ||
			UNION_BARE_STRING_THEN_LITERAL_RE.test(window);
		if (!widensWithString) continue;
		matches.push({
			line: i + 1,
			text: `union widened with bare \`string\`: ${nonNull(originalLines[i]).trim().slice(0, 130)} — the literal alternatives are erased.`,
		});
	}
	return matches;
}

// ==========================================================================
// 8. NODE_ENV branch in production
// ==========================================================================
// `process.env.NODE_ENV === "test"` (or "development") inside non-test
// source — branches production behavior on the test mode. Different harm
// class than env-as-config.

const NODEENV_BRANCH_RE =
	/\bprocess\s*\.\s*env\s*\.\s*NODE_ENV\s*[!=]==?\s*['"](test|development|dev|staging|local)['"]/;

const CONFIG_FILE_BASES = new Set([
	"vite",
	"vitest",
	"tsup",
	"biome",
	"next",
	"remix",
	"nuxt",
	"astro",
	"webpack",
	"rollup",
	"tailwind",
	"playwright",
	"jest",
	"babel",
	"postcss",
	"svelte",
	"eslint",
	"prettier",
]);
const CONFIG_FILE_TAIL_RE = /\.config\.[mc]?[jt]sx?$/;

function isProjectConfigFile(filePath: string): boolean {
	const last = filePath.replace(/\\/g, "/").split("/").pop() || "";
	if (!CONFIG_FILE_TAIL_RE.test(last)) return false;
	const base = nonNull(last.split(".")[0]);
	return CONFIG_FILE_BASES.has(base);
}

/** Public API — flags `process.env.NODE_ENV` comparisons in production source. */
export function checkNodeEnvBranchInProd(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (isProjectConfigFile(filePath)) return [];
	if (filePath.includes("/setup") || filePath.includes("/bootstrap")) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	// Strip comments only — string literals are essential to this check
	// because the literal compared value (`"test"` / `"development"`) is
	// exactly what the regex inspects.
	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const m = NODEENV_BRANCH_RE.exec(nonNull(strippedLines[i]));
		if (!m) continue;
		const matchedEnv = m[1];
		matches.push({
			line: i + 1,
			text: `production code branches on NODE_ENV (matched value: ${matchedEnv}): ${nonNull(originalLines[i]).trim().slice(0, 110)}`,
		});
	}
	return matches;
}

// ==========================================================================
// 9. Fetch without timeout / abort
// ==========================================================================
// `fetch(url)` and `axios.{get,post,...}(url)` calls without `signal:` /
// `timeout:` in their options. Window scan over up to 10 forward lines
// to allow for multi-line options objects.

const FETCH_CALL_RE = /\bfetch\s*\(/;
const AXIOS_CALL_RE = /\baxios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(/;
const TIMEOUT_OR_SIGNAL_RE = /\b(?:signal|timeout|AbortSignal|AbortController)\b/;
// Cloudflare Worker entry handler — `async fetch(request: Request, env: Env, ctx: ExecutionContext)`
// or `fetch(req: Request, ...)` as a method on the default ExportedHandler. NOT a
// `fetch()` call; the runtime invokes it on incoming requests. Detect by the
// `: Request` typed parameter — that string essentially never appears inside a
// fetch() function call.
const FETCH_HANDLER_DECL_RE = /(?:^|\s|,)\(?\s*(?:async\s+)?fetch\s*\(\s*\w+\s*:\s*Request\b/;
// Member-access `<receiver>.fetch(` where the receiver is NOT a global-namespace
// alias. The global `fetch` is invoked bare; member calls like
// `env.ASSETS.fetch(request)` (Cloudflare service / static-asset / Durable-Object
// bindings) and `stub.fetch(req)` dispatch through the runtime's binding plumbing,
// which doesn't accept a per-call `AbortSignal`/timeout the way `globalThis.fetch`
// does. We still flag the namespaced globals (`globalThis`/`self`/`window`/`global`).
const FETCH_GLOBAL_NS = /\b(?:globalThis|self|window|global)$/;
const FETCH_MEMBER_RECEIVER_RE = /([\w$.]+)\.fetch\s*\(/;

const FETCH_CONTEXT_LINES = 10;

function fetchHasTimeoutInWindow(strippedLines: string[], startIdx: number): boolean {
	const end = Math.min(strippedLines.length, startIdx + FETCH_CONTEXT_LINES + 1);
	const window = strippedLines.slice(startIdx, end).join("\n");
	return TIMEOUT_OR_SIGNAL_RE.test(window);
}

/**
 * True when the `fetch(` on this line is a member call on a runtime binding
 * (`env.ASSETS.fetch(...)`, a service-binding stub, a Durable-Object stub) rather
 * than the global `fetch`. Those dispatch through Workers binding plumbing and
 * don't take a per-call `AbortSignal`/timeout, so flagging them is a false
 * positive. Namespaced globals (`globalThis.fetch` etc.) are NOT treated as
 * bindings — they still need a timeout.
 */
function isBindingFetchCall(line: string): boolean {
	const m = FETCH_MEMBER_RECEIVER_RE.exec(line);
	if (!m) return false;
	const receiver = nonNull(m[1]);
	return !FETCH_GLOBAL_NS.test(receiver);
}

/**
 * Evaluates one stripped source line for a missing-timeout fetch/axios call.
 * Returns the finding for that line, or `null` when the line doesn't apply
 * (not a fetch/axios call, a Worker handler declaration, a binding member
 * call, or a call that already has a timeout/signal in its context window).
 */
function evaluateFetchTimeoutLine(strippedLines: string[], i: number): InlineMatch | null {
	const line = nonNull(strippedLines[i]);
	const isFetch = FETCH_CALL_RE.test(line);
	const isAxios = AXIOS_CALL_RE.test(line);
	if (!isFetch && !isAxios) return null;
	// Skip Cloudflare Worker entry handler — the `fetch(req: Request, ...)`
	// method declaration on the default ExportedHandler is invoked by the
	// runtime, not a `fetch()` call we'd want to add a timeout to.
	if (isFetch && FETCH_HANDLER_DECL_RE.test(line)) return null;
	// Skip runtime binding member calls (`env.ASSETS.fetch(request)`, service /
	// DO stubs) — they don't accept a per-call AbortSignal/timeout.
	if (isFetch && isBindingFetchCall(line)) return null;
	if (fetchHasTimeoutInWindow(strippedLines, i)) return null;
	const label = isFetch ? "fetch()" : "axios call";
	return {
		line: i + 1,
		text: `${label} without signal: / timeout: option — slow upstreams will leak request handles. Pass an AbortController.signal or per-call timeout.`,
	};
}

/** Public API — flags fetch / axios calls without an abort signal or timeout. */
export function checkFetchWithoutTimeout(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const match = evaluateFetchTimeoutLine(strippedLines, i);
		if (match) matches.push(match);
	}
	return matches;
}

// ==========================================================================
// 10. Promise.all on unbounded array
// ==========================================================================
// `Promise.all(arr.map(asyncFn))` where `arr` traces back to a function
// parameter, fetched value, or unbounded source. Fans out N requests; with
// 10K rows you get 10K parallel sockets.

const PROMISE_ALL_MAP_RE = /\bPromise\s*\.\s*all\s*\(\s*([\w$]+)\s*\.\s*map\s*\(/;
const PROMISE_ALL_INLINE_RE = /\bPromise\s*\.\s*all\s*\(\s*\[/;
const ARRAY_FROM_FINITE_RE = /\bArray\s*\.\s*from\s*\(\s*\{\s*length\s*:\s*\d+/;

function isLocallyBoundedArray(line: string, ident: string): boolean {
	const literalAssign = new RegExp(`\\b${ident}\\s*=\\s*\\[`);
	return literalAssign.test(line) || ARRAY_FROM_FINITE_RE.test(line);
}

/** Public API — flags `Promise.all(<ident>.map(...))` patterns. */
export function checkUnboundedPromiseAll(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const line = nonNull(strippedLines[i]);
		if (PROMISE_ALL_INLINE_RE.test(line)) continue;
		const m = PROMISE_ALL_MAP_RE.exec(line);
		if (!m) continue;
		const ident = nonNull(m[1]);
		if (isLocallyBoundedArray(line, ident)) continue;
		matches.push({
			line: i + 1,
			text: `Promise.all(${ident}.map(...)) fans out unboundedly. Use p-limit / pMap({concurrency}) to cap parallelism: ${nonNull(originalLines[i]).trim().slice(0, 100)}`,
		});
	}
	return matches;
}

// ==========================================================================
// 11. Synchronous I/O on hot paths
// ==========================================================================
// `*Sync(...)` calls inside HTTP handler / route / middleware files or in
// functions whose names imply request handling. Narrow scope keeps FPs out
// of CLIs and one-shot scripts.

const HOT_PATH_DIR_RE = /(?:^|\/)(?:handlers|routes|api|middleware|controllers)(?:\/|$)/;
// Handler-shaped function names. Two families:
//   1. `handle` / `route` / `onRequest` / `on<Capital>` — prefix match is
//      safe: these strings essentially never begin a non-handler identifier.
//   2. Bare HTTP verbs (`get` / `post` / `put` / `patch` / `delete` /
//      `fetch` / `serve`) — these MUST be the WHOLE identifier. A `\w*`
//      suffix here is the FP source: `getActivityPath`, `getSessionsDir`,
//      `getUnsyncedEvents`, `deleteRecord`, `fetchPage`, … are plain
//      getters/helpers in ordinary library code, not route handlers. A
//      router method is registered as exactly `get(` / `post(` etc., so
//      anchoring the verb to a full identifier keeps the true positives
//      (`function get(req) {…}`, `router.get(...)`) while dropping the
//      camelCase-helper false positives.
const HOT_PATH_PREFIX_NAMES = "handle|route|onRequest|on[A-Z]\\w*";
const HOT_PATH_VERB_NAMES = "get|post|put|patch|delete|fetch|serve";
const HOT_PATH_FN_NAME_RE = new RegExp(
	`\\b(?:async\\s+)?function\\s+(?:(?:${HOT_PATH_PREFIX_NAMES})\\w*|(?:${HOT_PATH_VERB_NAMES}))\\s*\\(`,
);
const HOT_PATH_ARROW_RE = new RegExp(
	`\\b(?:const|let|var)\\s+(?:(?:${HOT_PATH_PREFIX_NAMES})\\w*|(?:${HOT_PATH_VERB_NAMES}))\\s*[:=]\\s*(?:async\\s*)?\\(`,
);
const SYNC_IO_RE =
	/\b(?:readFileSync|writeFileSync|appendFileSync|execSync|spawnSync|statSync|lstatSync|mkdirSync|readdirSync|unlinkSync|rmSync|copyFileSync|renameSync|chmodSync|openSync|closeSync|realpathSync)\s*\(/;

// Refinement (2026-07): filename / function-shape heuristics alone
// misclassified non-HTTP files as hot paths (daemon loops, gate evaluators,
// runner wrappers whose comments merely mention "route"). A file is only an
// HTTP hot path when it shows CONCRETE server evidence: an HTTP-framework
// import (express / fastify / koa / hono / restify / polka), or a node:http(s)
// import paired with an actual `createServer(` call — importing node:http for
// a CLIENT (`http.request`) is not serving traffic.
const HTTP_FRAMEWORK_IMPORT_RE =
	/(?:from\s*|require\s*\(\s*)["'](?:express|fastify|koa|@koa\/[^"']+|hono(?:\/[^"']+)?|@hono\/[^"']+|restify|polka)["']/;
const NODE_HTTP_IMPORT_RE = /(?:from\s*|require\s*\(\s*)["'](?:node:)?https?["']/;
const CREATE_SERVER_CALL_RE = /\bcreateServer\s*\(/;

/** True when the file demonstrably runs an HTTP server — the precondition for
 *  any hot-path classification. Import specifiers are string literals, so this
 *  reads the ORIGINAL content. */
function fileHasHttpServerEvidence(content: string): boolean {
	if (HTTP_FRAMEWORK_IMPORT_RE.test(content)) return true;
	return NODE_HTTP_IMPORT_RE.test(content) && CREATE_SERVER_CALL_RE.test(content);
}

function fileLooksLikeHotPath(content: string, filePath: string): boolean {
	// No HTTP server in the file → nothing here is a request hot path,
	// regardless of what the directory or function names look like.
	if (!fileHasHttpServerEvidence(content)) return false;
	const norm = filePath.replace(/\\/g, "/");
	if (HOT_PATH_DIR_RE.test(norm)) return true;
	return HOT_PATH_FN_NAME_RE.test(content) || HOT_PATH_ARROW_RE.test(content);
}

/** Public API — flags sync I/O calls inside HTTP-handler-shaped files. */
export function checkSyncIoOnHotPath(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (isCliFile(filePath)) return [];
	if (filePath.includes("/scripts/") || filePath.includes("/bench/")) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (!fileLooksLikeHotPath(content, filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const m = SYNC_IO_RE.exec(nonNull(strippedLines[i]));
		if (!m) continue;
		const callName = m[0].replace(/\s+/g, "").replace(/\($/, "");
		matches.push({
			line: i + 1,
			text: `sync I/O on hot path (${callName}): ${nonNull(originalLines[i]).trim().slice(0, 100)} — blocks the event loop under load.`,
		});
	}
	return matches;
}
