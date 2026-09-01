// interlinked-tdd: exempt
// UBS language-specific detectors — JS/TS DOM/XSS & crypto security checks.
// Leaf cluster extracted from js-security-checks.ts during the 500-line
// decomposition. Each function returns InlineMatch[]. Ext-gated to JS/TS
// (and HTML/JSX for SRI). No dependency on the namespaced-call helpers in
// the parent module — this is a self-contained leaf.

import { nonNull } from "../../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	isVendoredOrFixturePath,
	stripCommentsAndStrings,
} from "../shared.js";
import { isJsTsFile } from "./_shared.js";

/**
 * `ubs_unchecked_redirect` — JS/TS `redirect(url)` / `location.href = url` /
 * `res.redirect(url)` with a non-literal URL is an open-redirect vector when
 * `url` originates from a request param. pre_warn / error.
 */
export function checkUncheckedRedirect(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// `redirect(x)` / `<obj>.redirect(x)` / `location.href = x` / `window.location = x`.
	// Anchored on identifier (not `""` literal — strings were stripped).
	const callRe = /\b(?:redirect|location\.href|window\.location)\s*[=(]\s*([A-Za-z_$]\w*)/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const stripLine = nonNull(strippedLines[i]);
		if (!callRe.test(stripLine)) continue;
		// Skip lines that look like a relative-path string assignment intent —
		// those were stripped to `""`, so an empty arg slot won't match here.
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

// Local JS/TS extension predicate for checkUncheckedRedirect — kept inline so
// the broader `isJsTsFile` extension list (which includes `.mts`/`.cts`) is
// not coupled into this module's gate; the original used `isJsTsFile`.
function isJsTsExt(ext: string): boolean {
	return (
		ext === ".ts" ||
		ext === ".tsx" ||
		ext === ".js" ||
		ext === ".jsx" ||
		ext === ".mjs" ||
		ext === ".cjs" ||
		ext === ".mts" ||
		ext === ".cts"
	);
}

/**
 * `ubs_document_write` — `document.write(...)` / `document.writeln(...)` is an
 * XSS sink and a render-blocking anti-pattern. No legitimate use in modern
 * code; the safe alternatives are `textContent` or DOM construction with
 * `createElement` / `appendChild`. pre_warn / warning.
 */
export function checkDocumentWrite(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsExt(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\bdocument\s*\.\s*write(?:ln)?\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_outer_html_assignment` — `<expr>.outerHTML = <value>`. Equivalent XSS
 * sink to `.innerHTML =` (which `checkInnerHtmlUsage` already covers); kept
 * separate because the safe-alternative guidance differs (`outerHTML` replaces
 * the element itself, so `replaceWith(textNode)` is the textContent analog).
 * pre_warn / warning.
 */
export function checkOuterHtmlAssignment(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsExt(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\.outerHTML\s*=/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_insert_adjacent_html` — `.insertAdjacentHTML(position, htmlString)`
 * parses the second arg as HTML and is an XSS sink whenever any part of the
 * string is attacker-controlled. Safe alternative is `insertAdjacentText`
 * for text, or `insertAdjacentElement` with a DOM-constructed node.
 * pre_warn / warning.
 */
export function checkInsertAdjacentHtml(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsExt(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const re = /\.insertAdjacentHTML\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_node_create_cipher` — Node `crypto.createCipher(...)` /
 * `createDecipher(...)` derive the key via an MD5-based KDF with no IV. The
 * function was removed entirely in Node 22; pre-22 code using it has a
 * predictable key schedule. `createCipheriv` / `createDecipheriv` with a
 * random IV is the safe replacement. pre_warn / error.
 *
 * Negative lookahead excludes the `iv`-suffixed safe forms. Matches both the
 * `crypto.createCipher(...)` and bare-destructured `createCipher(...)` shapes.
 */
export function checkNodeCreateCipher(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsExt(ext)) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	// Node API casing is inconsistent: `createCipher` (capital C) but
	// `createDecipher` (capital D, lowercase c). Spell both branches out so
	// the regex catches all four legacy variants while the `(?!iv)` negative
	// lookahead excludes the safe `createCipheriv` / `createDecipheriv`
	// forms. Matches both `crypto.create*(...)` and bare-destructured
	// `create*(...)` shapes.
	const re = /\bcreate(?:Cipher|Decipher)(?!iv)\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!re.test(nonNull(strippedLines[i]))) continue;
		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_script_without_sri` — `<script src="https://..."></script>` with an
 * external URL but no `integrity="sha..."` attribute. If the CDN is
 * compromised or substituted, the loaded code executes with full page
 * privileges. SRI ties the script content to a known hash so a swapped file
 * fails to load instead of silently executing.
 *
 * Scans HTML and JSX/TSX/Vue/Svelte sources. Markdown is intentionally
 * skipped — documentation routinely shows unsafe examples for illustration.
 * pre_warn / warning.
 */
export function checkScriptWithoutSri(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const isHtml = ext === ".html" || ext === ".htm";
	const isJsxLike =
		ext === ".jsx" || ext === ".tsx" || ext === ".vue" || ext === ".svelte" || ext === ".astro";
	if (!isHtml && !isJsxLike) return [];
	if (isTestFile(filePath)) return [];
	if (isVendoredOrFixturePath(filePath)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Match an entire `<script ...>` opening tag. The negative-lookahead window
	// requires that NO `integrity=` attribute appears before the closing `>`.
	// `src=` must reference an absolute external URL (`//` or `http(s)?://`).
	// Bounded character runs (400 / 300 chars) keep the regex linear-time.
	const re =
		/<script\s+(?![^>]{0,400}\bintegrity\s*=)[^>]{0,200}\bsrc\s*=\s*["'](?:https?:)?\/\/[^"']{1,300}["'][^>]{0,100}>/gi;

	for (const m of content.matchAll(re)) {
		if (matches.length >= 10) break;
		const idx = m.index;
		const lineNum = content.slice(0, idx).split("\n").length;
		matches.push({ line: lineNum, text: nonNull(originalLines[lineNum - 1]).trim().slice(0, 150) });
	}
	return matches;
}
