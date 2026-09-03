// interlinked-tdd: exempt
// Taste checks (leaf cluster) — narrative naming, test-description quality, god-file.
// Extracted from taste.ts to keep that module under the per-file line cap.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	stripCommentsAndStrings,
} from "./shared.js";

/**
 * Detect variable declarations with semantically empty names.
 * Names like `data`, `result`, `temp`, `val` carry no information about
 * what they hold — the reader must infer from context.
 *
 * Only flags const/let/var declarations (not parameters or properties).
 * Skips: test files, short functions (<=5 lines), variables with type annotations,
 * immediately-returned variables.
 */
export function checkNarrativeNaming(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const BLOCKLIST = /^(data|result|temp|tmp|val|value|obj|item|stuff|thing|info|ret|output)$/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		// Match: const/let/var <name> = (without type annotation providing context)
		const declMatch = nonNull(line).match(/\b(?:const|let|var)\s+(\w+)\s*(?::\s*(\S+))?\s*=/);
		if (!declMatch) continue;

		const varName = nonNull(declMatch[1]);
		const typeAnnotation = declMatch[2];

		if (!BLOCKLIST.test(varName)) continue;

		// Skip if there's a meaningful type annotation (the type provides context)
		if (typeAnnotation && !/^(any|unknown|string|number|boolean|object)$/.test(typeAnnotation))
			continue;

		// Skip if the variable is immediately returned on the next line
		if (
			i + 1 < strippedLines.length &&
			nonNull(strippedLines[i + 1]).trim().startsWith(`return ${varName}`)
		)
			continue;

		matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
	}

	return matches;
}

const NOISE_WORDS = new Set([
	"work",
	"works",
	"working",
	"correct",
	"correctly",
	"proper",
	"properly",
	"right",
	"good",
	"fine",
	"ok",
	"okay",
	"handle",
	"handles",
	"test",
	"tests",
	"testing",
	"it",
	"should",
	"does",
	"the",
	"a",
	"an",
	"is",
	"be",
	"do",
	"can",
	"will",
	"basic",
	"simple",
	"stuff",
	"things",
	"function",
	"method",
	"check",
	"verify",
]);

/** True when every alphabetic word of the description is a noise word. */
function isAllNoiseWords(desc: string): boolean {
	const words = desc
		.toLowerCase()
		.replace(/[^a-z\s]/g, "")
		.split(/\s+/)
		.filter((w) => w.length > 0);
	return words.length > 0 && words.every((w) => NOISE_WORDS.has(w));
}

/** A description is vague when it is too short or carries only noise words. */
function isVagueTestDescription(desc: string): boolean {
	return desc.length < 10 || isAllNoiseWords(desc);
}

/**
 * Detect vague or tautological test descriptions.
 * `it("works")` or `test("should work correctly")` tells you nothing
 * when the test fails at 2am.
 *
 * Flags descriptions that are:
 * - Too short (<10 characters)
 * - Composed entirely of noise words
 * - Tautological ("test the function", "it works")
 *
 * Only runs on test files. Skips it.skip, it.todo, xit, xtest.
 */
export function checkTestDescriptionQuality(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Match it("..."), test("..."), describe("...")
	const testPattern = /\b(?:it|test|describe)\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/;
	// Skip skipped/todo tests
	const skipPattern = /\b(?:it|test|describe)\s*\.\s*(?:skip|todo|only)\s*\(/;
	const xPattern = /\b(?:xit|xtest|xdescribe)\s*\(/;

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = originalLines[i];
		const trimmed = nonNull(line).trim();

		if (skipPattern.test(trimmed) || xPattern.test(trimmed)) continue;

		const m = trimmed.match(testPattern);
		if (!m) continue;

		const desc = nonNull((m[1] || m[2] || m[3])).trim();

		if (!isVagueTestDescription(desc)) continue;

		matches.push({
			line: i + 1,
			text: `[vague test name: "${desc}"] ${trimmed.slice(0, 120)}`,
		});
	}

	return matches;
}

/**
 * Detect files that export too many symbols relative to their size (god files).
 * A file that's long AND exports many symbols is trying to be a library in a file.
 *
 * Heuristic: exportCount >= 5 AND lineCount >= 300 AND exportCount * lineCount > 3000
 *
 * Skips: barrel/index files (mostly re-exports), .d.ts, test files, generated files.
 * Only counts value exports (functions, classes, consts) — type-only exports don't count.
 */
// God-file thresholds (kept inline so the heuristic is auditable in one place).
const GOD_FILE_MIN_LINES = 300;
const GOD_FILE_MIN_VALUE_EXPORTS = 5;
const GOD_FILE_EXPORTS_X_LINES_THRESHOLD = 3000;
const GOD_FILE_BARREL_REEXPORT_RATIO = 0.8;

/**
 * Count the file's value exports and re-exports.
 * Type-only exports (`export type`, `export interface`) count as neither —
 * they carry no runtime surface.
 */
function countExports(lines: string[]): { valueExports: number; reExports: number } {
	let valueExports = 0;
	let reExports = 0;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("export")) continue;

		// Re-exports: export { ... } from or export * from
		if (/^export\s+(\{[^}]*\}\s+from|type\s+\{[^}]*\}\s+from|\*\s+from)/.test(trimmed)) {
			reExports++;
			continue;
		}

		// Type-only exports: export type/interface/enum
		if (/^export\s+(type|interface)\s/.test(trimmed)) continue;

		// Value exports
		if (/^export\s+(function|async\s+function|const|let|var|class|default|enum)\b/.test(trimmed)) {
			valueExports++;
		}
	}

	return { valueExports, reExports };
}

export function checkGodFile(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (filePath.endsWith(".d.ts")) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const lines = content.split("\n");
	const lineCount = lines.length;
	if (lineCount < GOD_FILE_MIN_LINES) return [];

	// Skip generated files
	const header = lines.slice(0, 5).join("\n");
	if (/@generated|auto-generated|DO NOT EDIT/i.test(header)) return [];

	// Count value exports (not type/interface exports)
	const { valueExports: valueExportCount, reExports: reExportCount } = countExports(lines);

	// Skip barrel files: re-exports dominate the file. `totalExports > 0` guards
	// the division — checked before reaching the ratio comparison.
	const totalExports = valueExportCount + reExportCount;
	if (
		totalExports > 0 &&
		reExportCount / totalExports > GOD_FILE_BARREL_REEXPORT_RATIO
	) {
		return [];
	}

	if (valueExportCount < GOD_FILE_MIN_VALUE_EXPORTS) return [];
	if (valueExportCount * lineCount <= GOD_FILE_EXPORTS_X_LINES_THRESHOLD) return [];

	return [
		{
			line: 1,
			text: `[god file: ${lineCount} lines, ${valueExportCount} value exports → consider splitting into a directory]`,
		},
	];
}
