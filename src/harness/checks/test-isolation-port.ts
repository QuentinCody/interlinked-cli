// CLASS: fixed network ports make tests depend on other local processes.
// FIRES WHEN: JS/TS test code binds/dials a literal port >=1024 via listen,
// recognized port-option calls, process.env.PORT, or a loopback URL context.
// DOES NOT FIRE: port 0, ports below 1024, unrecognized contexts, or code-as-string
// fixtures whose call anchor disappears from the structural view.
// CALIBRATION (2026-09-06/07, tracked tests in this tree; historical snapshots):
// | pass | hits/files | inspected precision | correction |
// | calibrated | 0/0 | unmeasured (no hits) | string-fixture anchors removed |
// KNOWN GAPS: bounded four-line windows and skipped-call detection are heuristic;
// lower ports can still collide. A parsed port is not proof that a socket opens.
// HOW TO EXTEND: add a bind/dial context with P/N fixtures and keep the real-code
// anchor check. Census: scripts/scan-test-discrimination.ts.

import { getExtension, type InlineMatch, JS_TS_EXTS, stripComments, stripCommentsAndStrings } from "./shared.js";
import { isTestFile } from "./shared-test-classification.js";

/** Ports below this are treated as deliberate "nothing is listening here"
 *  fixtures (an unreachable-upstream test double), never a real bind target. */
const MIN_FIXED_PORT = 1024;

/** How many lines forward of a candidate line we join into one scan window —
 *  covers the common multi-line `.listen({\n  port: N,\n})` shape without a
 *  full brace-aware parse. */
const WINDOW_SIZE = 4;

const SKIP_CALL_RE = /\b(?:describe|it|test|suite)\.(?:skip|todo)\s*\(/;

/** True only when the call-name anchor for one of the four detection patterns
 *  is REAL CODE on this line — not text quoted inside an outer string literal.
 *  Guards against a fixture string like `'await fetch("http://x:3000")'` (a
 *  code sample handed to another check's test) reading as a live binding: the
 *  structural (string-and-comment-stripped) view blanks the whole quoted
 *  fixture, including this anchor, so the keyword vanishes from it. */
const REAL_CODE_ANCHOR_RE =
	/\b(?:listen|createServer|connect|fetch|WebSocket|new\s+URL|process\s*\.\s*env\s*\.\s*PORT)\b/;

/** `.listen(8787)` / `.listen(8787, "127.0.0.1")` / `listen(8787, ...)`. */
const LISTEN_DIRECT_RE = /\blisten\s*\(\s*(\d+)\b/;

/** A `port:` key inside a call to one of the usual bind/dial contexts —
 *  `createServer(...).listen({ port: N })`, `net.connect({ port: N })`, etc. */
const CONTEXT_PORT_RE =
	/\b(?:createServer|listen|connect|fetch|WebSocket)\s*\([^)]{0,160}?\bport\s*:\s*(\d+)/;

/** `process.env.PORT = "8787"` (or unquoted). */
const ENV_PORT_RE = /\bprocess\.env\.PORT\s*=\s*["']?(\d+)["']?/;

/** A `fetch(...)` / `connect(...)` / `new URL(...)` / `new WebSocket(...)` call
 *  whose first argument is a literal loopback URL carrying an explicit port. */
const URL_CONTEXT_RE =
	/\b(?:fetch|connect|new\s+URL|new\s+WebSocket)\s*\(\s*[`'"](?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost):(\d+)/;

/** True once a candidate port is a real fixed-bind target, not `0` (OS-assigned)
 *  or a sub-1024 "nothing answers here" fixture. */
function isFixedPort(rawPort: string | undefined): boolean {
	if (rawPort === undefined) return false;
	const port = Number(rawPort);
	return Number.isFinite(port) && port >= MIN_FIXED_PORT;
}

/** First fixed-port hit in `window` across every pattern, or null. */
function detectFixedPort(window: string): boolean {
	const direct = LISTEN_DIRECT_RE.exec(window);
	if (direct && isFixedPort(direct[1])) return true;
	const ctx = CONTEXT_PORT_RE.exec(window);
	if (ctx && isFixedPort(ctx[1])) return true;
	const env = ENV_PORT_RE.exec(window);
	if (env && isFixedPort(env[1])) return true;
	const url = URL_CONTEXT_RE.exec(window);
	return url !== null && isFixedPort(url[1]);
}

/** 1-based line numbers that fall inside a `describe/it/test/suite.skip|.todo`
 *  block, via brace-depth tracking over the string-and-comment-stripped text
 *  (so braces inside string/template content never perturb the count). */
function computeSkipLines(structuralLines: readonly string[]): Set<number> {
	const skipped = new Set<number>();
	let depth = 0;
	let skipActive = false;
	let skipDepth = 0;
	for (let i = 0; i < structuralLines.length; i++) {
		const line = structuralLines[i] ?? "";
		if (!skipActive && SKIP_CALL_RE.test(line)) {
			skipActive = true;
			skipDepth = depth;
		}
		if (skipActive) skipped.add(i + 1);
		const opens = (line.match(/\{/g) ?? []).length;
		const closes = (line.match(/\}/g) ?? []).length;
		depth += opens - closes;
		if (skipActive && depth <= skipDepth) skipActive = false;
	}
	return skipped;
}

function buildMatch(line: number, originalLine: string): InlineMatch {
	const trimmed = originalLine.trim().slice(0, 150);
	return { line, text: `fixed_port_in_test: ${trimmed}` };
}

/** Public API — flags a hardcoded TCP port (≥1024) bound or dialed in a test
 *  file: `.listen(N)`, a `port: N` option, a `PORT` env assignment, or a
 *  fixed-port loopback URL literal passed to fetch/connect/WebSocket/URL. */
export function checkFixedPortInTest(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const original = content.split("\n");
	const commentStripped = stripComments(content).split("\n");
	const structural = stripCommentsAndStrings(content).split("\n");
	const skipLines = computeSkipLines(structural);

	const matches: InlineMatch[] = [];
	for (let i = 0; i < commentStripped.length; i++) {
		const lineNo = i + 1;
		if (skipLines.has(lineNo)) continue;
		if (!REAL_CODE_ANCHOR_RE.test(structural[i] ?? "")) continue;
		const window = commentStripped.slice(i, i + WINDOW_SIZE).join(" ");
		if (!detectFixedPort(window)) continue;
		matches.push(buildMatch(lineNo, original[i] ?? ""));
	}
	return matches;
}
