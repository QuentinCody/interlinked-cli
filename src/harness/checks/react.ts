// React / frontend checks.
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import { DSIH_USAGE_RE, DSIH_WINDOW_LINES, isStaticDsihValue } from "./react-dsih-value.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";
import { buildLineStarts } from "./shared-text-utils.js";

// ===========================================
// React/Frontend Checks
// ===========================================

/** Detect excessive useState hooks (8+) — consider useReducer or splitting. */
export function checkExcessiveUseState(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	let count = 0;
	const WARNING_THRESHOLD = 8;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = nonNull(lines[i]).trim();
		if (/\buseState\s*[<(]/.test(trimmed)) {
			count++;
		}
	}

	if (count >= WARNING_THRESHOLD) {
		for (let i = 0; i < lines.length; i++) {
			if (/\buseState\s*[<(]/.test(nonNull(lines[i]).trim())) {
				matches.push({
					line: i + 1,
					text: `[${count} useState hooks — consider useReducer or splitting component] ${nonNull(lines[i]).trim().slice(0, 100)}`,
				});
				break;
			}
		}
	}

	return matches;
}

/** Detect dangerouslySetInnerHTML usage — XSS risk.
 *
 * 139-repo audit (2026-05): Flexpa's `flexpa-link-react-native-example/
 * app/+html.tsx:30` was the canonical FP — `<style dangerouslySetInner
 * HTML={{ __html: responsiveBackground }} />` where `responsiveBackground`
 * is a same-file `const responsiveBackground = `body { ... }`;` literal
 * (Expo Router boilerplate). Static-CSS pattern with zero user input.
 *
 * Refinement: when the JSX expression value is a bare identifier (not a
 * member access, function call, or interpolation), check the same file
 * for a `const <id> = "..."` / `const <id> = `...`` declaration. If the
 * literal is template/string with no `${var}` interpolation, treat as
 * static — don't fire.
 *
 * 2026-10-21 adversarial review: the token is a USAGE only as a JSX
 * attribute or a props-object member (`DSIH_USAGE_RE`) — an interface
 * member, a destructuring alias and JSX text never fire — and the value
 * may sit on the lines below the attribute (prettier wrapping). A direct
 * literal, a same-file static `const` (type annotation allowed) and a
 * recognized sanitizer call (`DOMPurify.sanitize`, `sanitizeHtml`, …) are
 * static; the classifier lives in `react-dsih-value.ts`.
 */
export function checkDangerouslySetInnerHTML(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const lineStarts = buildLineStarts(content);

	const matches: InlineMatch[] = [];
	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		if (!nonNull(strippedLines[i]).includes("dangerouslySetInnerHTML")) continue;
		// Usage is decided on the stripped text; the object form may wrap
		// its `__html` onto the lines below, so test the window, anchored
		// to this line.
		if (!DSIH_USAGE_RE.test(strippedLines.slice(i, i + DSIH_WINDOW_LINES).join("\n"))) continue;

		// Classify the `__html` value on the ORIGINAL text (the identifier
		// or literal must be visible), over the same window.
		const windowStart = nonNull(lineStarts[i]);
		const windowEnd = lineStarts[i + DSIH_WINDOW_LINES] ?? content.length;
		if (isStaticDsihValue(content, windowStart, windowEnd)) continue;

		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}
	return matches;
}

const DOM_ACCESS_RE =
	/\bdocument\.(getElementById|querySelector|querySelectorAll|getElementsBy)\s*\(/;
// An effect hook whose callback opens a `{` block on the same line. We only
// start tracking when a brace actually opens — `useEffect(fn, [])` (named
// callback, no inline block) carries no body to exempt.
const EFFECT_OPENER_RE = /\b(?:useEffect|useLayoutEffect)\s*\(/;
// createPortal's second argument is legitimately a DOM node (the portal target).
const CREATE_PORTAL_RE = /\bcreatePortal\s*\(/;

/** Net `{` minus `}` on a single stripped line (strings/comments already blanked). */
function netBraceDelta(line: string): number {
	let delta = 0;
	for (const ch of line) {
		if (ch === "{") delta++;
		else if (ch === "}") delta--;
	}
	return delta;
}

/**
 * Carry the effect-callback brace depth across one stripped line. A line inside
 * an open effect callback adjusts the running depth (floored at 0); otherwise an
 * effect opener whose own line nets a positive delta seeds the depth.
 */
function nextEffectDepth(strippedLine: string, effectDepth: number): number {
	if (effectDepth > 0) {
		const carried = effectDepth + netBraceDelta(strippedLine);
		return carried < 0 ? 0 : carried;
	}
	if (EFFECT_OPENER_RE.test(strippedLine)) {
		const delta = netBraceDelta(strippedLine);
		if (delta > 0) return delta;
	}
	return effectDepth;
}

/**
 * Decide whether one stripped line is reportable direct DOM access. Exemptions:
 * createPortal target node, or anywhere inside an effect callback (the opener
 * line itself counts — `inEffect` is its pre-update state, so also check the
 * same-line effect opener).
 */
function isReportableDomAccess(strippedLine: string, inEffect: boolean): boolean {
	if (!DOM_ACCESS_RE.test(strippedLine)) return false;
	if (CREATE_PORTAL_RE.test(strippedLine)) return false;
	if (inEffect || EFFECT_OPENER_RE.test(strippedLine)) return false;
	return true;
}

/**
 * Detect direct DOM access in React components — use useRef instead.
 *
 * Refined (2026-06) to drop two legitimate React escape hatches that the
 * blanket regex FP'd on: the `createPortal(...)` target-node argument, and DOM
 * access inside a `useEffect` / `useLayoutEffect` callback (the sanctioned place
 * to touch the DOM after render). Render-body and event-handler DOM access —
 * the real "should be a ref" bug — still fires.
 */
export function checkDirectDomAccess(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Brace depth of the innermost open effect-hook callback, or 0 when not
	// inside one. Seeded when an effect opener line nets a positive brace delta.
	let effectDepth = 0;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const strippedLine = nonNull(strippedLines[i]);
		const originalLine = nonNull(originalLines[i]);

		const inEffect = effectDepth > 0;
		// Update depth for THIS line before deciding the next iteration's state.
		effectDepth = nextEffectDepth(strippedLine, effectDepth);

		if (!isReportableDomAccess(strippedLine, inEffect)) continue;

		matches.push({ line: i + 1, text: originalLine.trim().slice(0, 150) });
	}
	return matches;
}

/** Detect excessive inline object props causing unnecessary re-renders (3+). */
export function checkInlineObjectProps(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const allMatches: InlineMatch[] = [];

	const inlineObjPattern = /\w+=\{\{/;
	let count = 0;

	for (let i = 0; i < strippedLines.length; i++) {
		if (inlineObjPattern.test(nonNull(strippedLines[i]))) {
			count++;
			if (allMatches.length < 10) {
				allMatches.push({
					line: i + 1,
					text: nonNull(lines[i]).trim().slice(0, 150),
				});
			}
		}
	}

	if (count < 3) return [];

	return [
		{
			line: nonNull(allMatches[0]).line,
			text: `[${count} inline object props — creates new references every render, causing unnecessary re-renders. Extract to constants or useMemo] ${nonNull(allMatches[0]).text}`,
		},
	];
}

/** Detect async event handlers — errors silently swallowed without try/catch. */
export function checkAsyncEventHandler(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /on[A-Z]\w+=\{async\s/, 10);
}
