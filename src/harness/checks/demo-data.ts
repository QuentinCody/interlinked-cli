// Demo-data detection (Batch 8).
//
// Three detectors that catch the most insidious failure mode in
// agent-authored UI/demo code: the agent fails the integration, silently
// substitutes hallucinated data, and ships something that looks plausible
// to humans inspecting the rendered page.
//
//   1. demo_data_unmarked — static smell regex over edited content.
//      Fires on agent-thumbprint fake data (test emails, faker imports,
//      Stripe test cards, lorem ipsum, sentinel UUIDs, mock/fake/dummy/sample
//      identifier prefixes) UNLESS the file declares an `@demo-data:`
//      directive within ~10 lines above the match.
//
//   2. silent_demo_fallback — catches the `try { real API call } catch {
//      return [literal data] }` pattern. The catch-fallback variant is the
//      worst case — it ships to production and degrades silently when the
//      upstream is flaky.
//
//   3. demo_runtime_missing_banner — when any source file imports the
//      vendored `demoData` helper, the project's root layout must mount
//      `<DemoBanner />` so users see the demo banner.
//
//   4. placeholder_data_in_ui — the high-signal slice: placeholder data
//      RENDERED into a user-facing UI file, where a human reads it as
//      production truth. Scoped to .tsx/.jsx/.vue/.svelte/.astro/.html and
//      to rendered positions, so it earns a default gate where the broader
//      demo_data_unmarked stays advisory.
//
// All directives use the `// @demo-data: <reason>` convention; the reason
// is required (empty `@demo-data:` doesn't suppress).

import { nonNull } from "../../lib/non-null.js";
// `lineHasNearbyDemoDirective` and `checkPlaceholderDataInUi` live in the
// decomposed sibling (kept this module under the per-file line cap).
// `checkPlaceholderDataInUi` is re-exported so the public surface is unchanged.
import { lineHasNearbyDemoDirective } from "./demo-data-placeholder-ui.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripComments,
} from "./shared.js";

export { checkPlaceholderDataInUi } from "./demo-data-placeholder-ui.js";

// ==========================================================================
// 1. demo_data_unmarked
// ==========================================================================

interface DemoSmellPattern {
	re: RegExp;
	label: string;
}

// Stripe / payment test PANs — canonical list.
const TEST_CARD_LITERALS: readonly string[] = [
	"4242424242424242",
	"4111111111111111",
	"5555555555554444",
	"378282246310005",
	"4000056655665556",
	"6011111111111117",
];

const SMELL_PATTERNS: readonly DemoSmellPattern[] = [
	{
		re: /[A-Za-z0-9._%+-]+@(?:example\.(?:com|org|net)|test\.(?:com|org|local)|acme\.test|fake\.com)/i,
		label: "test-email literal",
	},
	{
		re: /\b(?:foo|jane|john)\.?(?:doe|smith|test|user)?@/i,
		label: "placeholder-name email",
	},
	{
		re: /\b555[-.\s]?\d{3,4}[-.\s]?\d{0,4}\b/,
		label: "test phone (555 prefix)",
	},
	{
		re: /\b(?:123-45-6789|000-00-0000|999-99-9999)\b/,
		label: "test SSN",
	},
	{
		re: new RegExp(`\\b(?:${TEST_CARD_LITERALS.join("|")})\\b`),
		label: "Stripe / payment test card",
	},
	{
		re: /\b(?:0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12}|a{8}-a{4}-a{4}-a{4}-a{12})\b/i,
		label: "sentinel UUID",
	},
	{
		re: /\b[Ll]orem\s+[Ii]psum\b/,
		label: "lorem ipsum",
	},
	{
		re: /\bfrom\s+["']@?(?:faker-js\/faker|faker|chance|casual|@ngneat\/falso|@anatine\/zod-mock)["']/,
		label: "faker / chance / falso import",
	},
	{
		re: /\b(?:const|let|var)\s+(mock|fake|stub|sample|dummy|demo|placeholder|seed|temp|fixture)[A-Z][\w$]*\s*[=:]/,
		label: "demo/mock identifier prefix",
	},
	{
		re: /\bexport\s+(?:const|function)\s+(get|fetch|load)Mock\w+/,
		label: "exported mock getter",
	},
];

// RFC 2606 / RFC 6761 test domains — separate list because they're often
// embedded in URL strings rather than emails.
const RFC_TEST_DOMAIN_RE =
	/\bhttps?:\/\/[^/\s"'`]*\.(?:example\.(?:com|org|net)|test|invalid|localhost|example)\b/i;

const SKIPPED_PATH_RE =
	/(?:^|\/)(?:__fixtures__|__mocks__|fixtures|mocks|test-data|seed-data|seeds)(?:\/|$)/;
// Pattern bank 1: SMELL_PATTERNS. Count all hits per line, not just the
// first — multi-declaration lines are common in seed/demo data. `budget`
// caps how many matches this call may return (the caller's remaining
// MAX_MATCHES headroom).
function smellPatternMatchesForLine(lines: string[], i: number, budget: number): InlineMatch[] {
	const line = nonNull(lines[i]);
	const found: InlineMatch[] = [];

	for (const pat of SMELL_PATTERNS) {
		if (found.length >= budget) break;
		const globalRe = new RegExp(pat.re.source, pat.re.flags.includes("g") ? pat.re.flags : pat.re.flags + "g");
		const hits = line.match(globalRe);
		if (!hits || hits.length === 0) continue;
		if (lineHasNearbyDemoDirective(lines, i)) continue;
		for (let h = 0; h < hits.length && found.length < budget; h++) {
			found.push({
				line: i + 1,
				text: `unmarked demo data (${pat.label}): ${nonNull(hits[h]).slice(0, 80)}. Mark with \`// @demo-data: <reason>\` directly above, or wrap with demoData() from the vendored runtime.`,
			});
		}
	}

	return found;
}

// Pattern bank 2: RFC test-domain URLs (separate so the message is specific).
function rfcTestDomainMatchForLine(lines: string[], i: number): InlineMatch | null {
	const line = nonNull(lines[i]);
	if (!RFC_TEST_DOMAIN_RE.test(line)) return null;
	if (lineHasNearbyDemoDirective(lines, i)) return null;
	return {
		line: i + 1,
		text: `unmarked demo data (RFC test domain): ${line.trim().slice(0, 110)}. Mark with \`// @demo-data: <reason>\` or move to a config file.`,
	};
}

/** Public API — flags fake-data smell patterns without `@demo-data:` directive. */
export function checkDemoDataUnmarked(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (SKIPPED_PATH_RE.test(filePath.replace(/\\/g, "/"))) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 8;

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;

		matches.push(...smellPatternMatchesForLine(lines, i, MAX_MATCHES - matches.length));

		if (matches.length >= MAX_MATCHES) continue;
		const rfcMatch = rfcTestDomainMatchForLine(lines, i);
		if (rfcMatch) matches.push(rfcMatch);
	}

	return matches;
}

// ==========================================================================
// 2. silent_demo_fallback
// ==========================================================================

const ASYNC_REAL_CALL_RE =
	/\b(?:await\s+)?(?:fetch|axios\s*\.\s*\w+|client\.\w+|api\.\w+|http\s*\.\s*\w+)\s*\(/;
const LITERAL_FALLBACK_RE = /^\s*return\s+[[{]/;

// Signals that a catch block SURFACES the failure rather than hiding it.
// `return { ok: false, error: err.message }` is error handling, not a
// silent demo fallback — the check only targets catches where the caller
// cannot tell the upstream failed.
const CATCH_LOG_RE = /\b(?:console\s*\.\s*\w+|logger\s*\.\s*\w+|(?:this|ctx)\s*\.\s*log)\s*\(/;
const CATCH_ERROR_FIELD_RE =
	/\b(?:ok\s*:\s*false|success\s*:\s*false|(?:error|err|errors)\s*:|status\s*:\s*["'`](?:fail|failed|error))/;

/** True when the catch body hides the failure entirely: no rethrow, no
 *  logging, no reference to the caught error binding, and no error/fail
 *  field in whatever it returns. Only then is a literal fallback "silent". */
function catchHidesFailure(catchBody: string, errBinding: string | undefined): boolean {
	if (/\bthrow\b/.test(catchBody)) return false;
	if (CATCH_LOG_RE.test(catchBody)) return false;
	if (CATCH_ERROR_FIELD_RE.test(catchBody)) return false;
	// Any use of the caught error binding (err.message, String(e), passing
	// it to a reporter) counts as surfacing it.
	if (errBinding && new RegExp(`\\b${errBinding}\\b`).test(catchBody)) return false;
	return true;
}

/** Public API — flags `try { real call } catch { return literal }` patterns. */
export function checkSilentDemoFallback(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripComments(content);
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	const tryRe = /\btry\s*\{/g;
	tryRe.lastIndex = 0;
	let m: RegExpExecArray | null = tryRe.exec(stripped);
	while (m !== null && matches.length < MAX_MATCHES) {
		const tryStart = m.index;
		const tryBlock = extractBlockAfter(stripped, tryStart + m[0].length - 1);
		if (!tryBlock) {
			m = tryRe.exec(stripped);
			continue;
		}
		// The `catch` clause should immediately follow the try block.
		const afterTry = tryBlock.endOffset;
		const catchMatch = /^\s*catch(?:\s*\(\s*([\w$]+)[^)]*\))?\s*\{/.exec(stripped.slice(afterTry));
		if (!catchMatch) {
			m = tryRe.exec(stripped);
			continue;
		}
		const catchStart = afterTry + catchMatch.index + catchMatch[0].length - 1;
		const catchBlock = extractBlockAfter(stripped, catchStart);
		if (!catchBlock) {
			m = tryRe.exec(stripped);
			continue;
		}

		const tryHasRealCall = ASYNC_REAL_CALL_RE.test(tryBlock.body);
		const catchReturnsLiteral = catchBlock.body
			.split("\n")
			.some((line) => LITERAL_FALLBACK_RE.test(line));
		// Only "silent" when the catch neither rethrows, logs, references the
		// error binding, nor embeds an error/fail field in the returned value.
		const errBinding = catchMatch[1];

		if (tryHasRealCall && catchReturnsLiteral && catchHidesFailure(catchBlock.body, errBinding)) {
			const lineIdx = (stripped.slice(0, tryStart).match(/\n/g) || []).length;
			matches.push({
				line: lineIdx + 1,
				text: `silent demo fallback: real API call in \`try\`, literal data returned from \`catch\`. The catch silently substitutes fake data when the upstream fails — production users see invented results. Re-throw, return a typed error, or mark the fallback with demoData() so the UI shows a banner.`,
			});
		}

		m = tryRe.exec(stripped);
	}

	return matches;
}

interface BlockExtraction {
	body: string;
	endOffset: number;
}

function extractBlockAfter(text: string, openIdx: number): BlockExtraction | null {
	if (text[openIdx] !== "{") return null;
	let depth = 1;
	for (let i = openIdx + 1; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return { body: text.slice(openIdx + 1, i), endOffset: i + 1 };
		}
	}
	return null;
}

// ==========================================================================
// 3. demo_runtime_missing_banner
// ==========================================================================

const ROOT_LAYOUT_PATHS = [
	"app/layout.tsx",
	"app/layout.jsx",
	"src/app/layout.tsx",
	"src/app/layout.jsx",
	"pages/_app.tsx",
	"pages/_app.jsx",
	"src/pages/_app.tsx",
	"src/main.tsx",
	"src/main.jsx",
	"src/index.tsx",
	"src/index.jsx",
	"App.tsx",
	"src/App.tsx",
];

function isRootLayoutFile(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	for (const root of ROOT_LAYOUT_PATHS) {
		if (norm.endsWith(`/${root}`) || norm === root) return true;
	}
	return false;
}

// Match imports from the package's own subpath, the legacy `@interlinked/`
// scope (kept for transition), and any relative `*/demo-runtime` path so
// users who vendor a copy still trigger the banner check.
const DEMO_RUNTIME_IMPORT_RE =
	/\bfrom\s+["'](?:interlinked-cli\/demo-runtime|@interlinked\/demo-runtime|\.{1,2}\/[^"']*demo-runtime)["']/;
const DEMO_BANNER_USAGE_RE = /<\s*DemoBanner\s*\/?>/;

/** Public API — flags root-layout files that import demoData but don't render DemoBanner. */
export function checkDemoRuntimeMissingBanner(content: string, filePath: string): InlineMatch[] {
	if (!isRootLayoutFile(filePath)) return [];
	if (!DEMO_RUNTIME_IMPORT_RE.test(content)) return [];
	if (DEMO_BANNER_USAGE_RE.test(content)) return [];
	return [
		{
			line: 1,
			text: `root layout imports demo-runtime helpers but does not render <DemoBanner />. Without the banner, users have no signal that the page contains demo data. Add \`import { DemoBanner } from "interlinked-cli/demo-runtime";\` and render <DemoBanner /> inside the body of this layout.`,
		},
	];
}