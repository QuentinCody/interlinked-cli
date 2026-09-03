// React index-as-key detection.
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile } from "./shared.js";

// ===========================================
// Index as Key Detection (React)
// ===========================================

// Direct variable: key={i}, key={index}, key={idx}, key={k}
const DIRECT_INDEX_KEY = /key=\{(i|idx|index|k)\}\s*/;
// Template literal: key={`..${i}..`}, key={`..${index}..`}, etc.
const TEMPLATE_INDEX_KEY = /key=\{`[^`]*\$\{(i|idx|index|k)\}[^`]*`\}/;

/** True when the line passes an index variable to a React `key` prop. */
function usesIndexAsKey(trimmed: string): boolean {
	return DIRECT_INDEX_KEY.test(trimmed) || TEMPLATE_INDEX_KEY.test(trimmed);
}

/**
 * Look backwards for the .map() call to check if it's a static array.
 * Patterns like [0,1,2].map, Array(n).fill().map, or "skeleton" in
 * the template key are static lists that never reorder — index is fine.
 */
function isStaticList(lines: string[], lineIndex: number, trimmed: string): boolean {
	let contextWindow = "";
	for (let j = Math.max(0, lineIndex - 3); j <= lineIndex; j++) {
		contextWindow += lines[j];
	}
	if (/\[\s*[\d,\s]+\]\s*\.map\b/.test(contextWindow)) return true; // literal array
	if (/Array\s*\(\s*\d+\s*\)/.test(contextWindow)) return true; // Array(n).fill().map
	return /skeleton|placeholder|loading|spacer/i.test(trimmed); // UI placeholders
}

/**
 * Detect array index used as React key prop — breaks reconciliation on reorder.
 * Catches `key={i}`, `key={index}`, `key={idx}`, `key={k}` and template
 * literal variants like `key={\`item-${i}\`}`.
 *
 * Only fires on .tsx/.jsx files. Skips test files.
 */
export function checkIndexAsKey(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < lines.length; i++) {
		const trimmed = nonNull(lines[i]).trim();
		if (!usesIndexAsKey(trimmed)) continue;
		if (isStaticList(lines, i, trimmed)) continue;

		matches.push({
			line: i + 1,
			text: `[index used as key — breaks reconciliation on reorder. Use a stable identifier] ${trimmed.slice(0, 100)}`,
		});
	}

	return matches;
}
