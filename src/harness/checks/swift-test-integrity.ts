// interlinked-tdd: exempt
// Agent-specific failure-mode helpers extracted from swift.ts.
// Test-regression signals, env-reference extraction, and mock/stub drift detection.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// -------------------------------------------
// P0 Checks: Agent-Specific Failure Modes
// -------------------------------------------

/**
 * Check 1: Test Regression Signals
 * Detect .skip/.todo on test blocks, and count assertions for delta tracking.
 */
export function checkTestRegressions(
	content: string,
	filePath: string,
): { skipped: InlineMatch[]; assertionCount: number } {
	if (!isTestFile(filePath)) return { skipped: [], assertionCount: 0 };

	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext))
		return { skipped: [], assertionCount: 0 };

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Detect .skip and .todo
	const skipped = scanLinesStripped(
		originalLines,
		strippedLines,
		/\b(describe|it|test)\.skip\s*\(|\b(describe|it|test)\.todo\s*\(|\b(xit|xtest|xdescribe)\s*\(/,
		15,
	);

	// Count assertions
	let assertionCount = 0;
	for (const line of strippedLines) {
		const matches = line.match(/\bexpect\s*\(|\bassert\s*[.(]|\.should\./g);
		if (matches) assertionCount += matches.length;
	}

	return { skipped, assertionCount };
}

/**
 * Check 2: Env/Config Reference Integrity
 * Extract environment variable references from code.
 */
interface EnvReference {
	name: string;
	line: number;
	source: string;
}

const SYSTEM_ENV_VARS = new Set([
	"NODE_ENV",
	"HOME",
	"USER",
	"USERNAME",
	"USERPROFILE",
	"PATH",
	"CI",
	"TERM",
	"SHELL",
	"LANG",
	"HOSTNAME",
	"PWD",
	"EDITOR",
	"TMPDIR",
	"TZ",
	"PORT",
	"NO_COLOR",
]);

export function extractEnvReferences(content: string, filePath: string): EnvReference[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"].includes(ext)) return [];
	if (isTestFile(filePath) || filePath.endsWith(".d.ts")) return [];

	// Dot-access reads (`process.env.X`, `env.X`, …) scan content with BOTH comments
	// and string/template literals blanked — so an `env.KV` inside a detector's
	// message string or a doc example isn't counted as a real reference (the
	// `env.X` member form is especially prone to this in worker-binding prose).
	// Bracket-access reads (`process.env["X"]`) need the quoted key intact, so they
	// scan the comments-only-stripped content. Both transforms preserve line count.
	const dotLines = stripCommentsAndStrings(content).split("\n");
	const bracketLines = stripComments(content).split("\n");
	const refs: EnvReference[] = [];

	const dotPatterns: Array<{ re: RegExp; source: string }> = [
		{ re: /\bprocess\.env\.([A-Z][A-Z0-9_]+)\b/g, source: "process.env" },
		{ re: /\bimport\.meta\.env\.([A-Z][A-Z0-9_]+)\b/g, source: "import.meta.env" },
		{ re: /\bc\.env\.([A-Z][A-Z0-9_]+)\b/g, source: "c.env" },
		{ re: /(?<![\w.])env\.([A-Z][A-Z0-9_]+)\b/g, source: "env.X" },
	];
	const bracketPatterns: Array<{ re: RegExp; source: string }> = [
		{ re: /\bprocess\.env\["([A-Z][A-Z0-9_]+)"\]/g, source: "process.env" },
		{ re: /\bprocess\.env\['([A-Z][A-Z0-9_]+)'\]/g, source: "process.env" },
		{ re: /\bEnv\["([A-Z][A-Z0-9_]+)"\]/g, source: "Env[X]" },
		{ re: /\bEnv\['([A-Z][A-Z0-9_]+)'\]/g, source: "Env[X]" },
	];

	const scan = (linesArr: string[], pats: Array<{ re: RegExp; source: string }>): void => {
		for (const [i, lineText] of linesArr.entries()) {
			for (const { re, source } of pats) {
				re.lastIndex = 0;
				for (const m of lineText.matchAll(re)) {
					const name = nonNull(m[1]);
					if (!SYSTEM_ENV_VARS.has(name)) {
						refs.push({ name, line: i + 1, source });
					}
				}
			}
		}
	};
	scan(dotLines, dotPatterns);
	scan(bracketLines, bracketPatterns);

	return refs;
}

/**
 * Check 3: Mock/Stub Drift
 * In test files, extract vi.mock/jest.mock factories and check mocked names
 * against actual module exports.
 */
interface MockDefinition {
	line: number;
	modulePath: string;
	mockedNames: string[];
	text: string;
}

/**
 * Advance from a `{` just past a `vi.mock`/`jest.mock` factory's opening
 * brace to the index just past its matching closing brace, honoring nested
 * `{`/`}` pairs inside the factory body.
 */
function findMockFactoryBodyEnd(fullText: string, bodyStart: number): number {
	let depth = 1;
	let i = bodyStart;
	while (i < fullText.length && depth > 0) {
		if (fullText[i] === "{") depth++;
		else if (fullText[i] === "}") depth--;
		i++;
	}
	return i;
}

/**
 * Build the `MockDefinition` for one `vi.mock`/`jest.mock(...)` match, or
 * `null` when it doesn't qualify (non-relative module path, or no
 * `name: vi.fn()`/`name: jest.fn()` properties in the factory body).
 */
function extractOneMockDefinition(
	fullText: string,
	lines: string[],
	match: RegExpMatchArray,
): MockDefinition | null {
	const startIdx = nonNull(match.index);
	const modulePath = nonNull(match[1]);
	if (!modulePath.startsWith(".") && !modulePath.startsWith("@/")) return null;

	// Find the matching closing })
	const bodyStart = startIdx + match[0].length;
	const bodyEnd = findMockFactoryBodyEnd(fullText, bodyStart);
	const body = fullText.slice(bodyStart, bodyEnd - 1);

	// Extract property names: `name: vi.fn()` or `name: jest.fn()`
	const mockedNames: string[] = [];
	for (const pm of body.matchAll(/(\w+)\s*:\s*(?:vi|jest)\.fn\(/g)) {
		mockedNames.push(nonNull(pm[1]));
	}

	if (mockedNames.length === 0) return null;

	const line = fullText.slice(0, startIdx).split("\n").length;
	return {
		line,
		modulePath,
		mockedNames,
		text: lines[line - 1]?.trim().slice(0, 150) || "",
	};
}

export function extractMockDefinitions(content: string, filePath: string): MockDefinition[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) return [];

	const lines = content.split("\n");
	const mocks: MockDefinition[] = [];

	// Match vi.mock("path", () => ({ ... })) or jest.mock("path", () => ({ ... }))
	// We need to find the factory body and extract property names
	const fullText = content;
	const mockPattern = /\b(?:vi|jest)\.mock\(\s*["']([^"']+)["']\s*,\s*\(\)\s*=>\s*\(\{/g;

	for (const match of fullText.matchAll(mockPattern)) {
		const mock = extractOneMockDefinition(fullText, lines, match);
		if (mock) mocks.push(mock);
	}

	return mocks;
}

/**
 * Parse one already-trimmed `export`-prefixed source line and return the
 * symbol name(s) it declares. Mirrors the per-line branches previously
 * inlined in `extractModuleExportNames`'s loop body, unchanged.
 */
function namesFromExportLine(trimmed: string): string[] {
	// export function name / export async function name
	const fn = trimmed.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
	if (fn) return [nonNull(fn[1])];

	// export const/let/var name
	const v = trimmed.match(/^export\s+(?:const|let|var)\s+(\w+)/);
	if (v) return [nonNull(v[1])];

	// export class name
	const cls = trimmed.match(/^export\s+(?:abstract\s+)?class\s+(\w+)/);
	if (cls) return [nonNull(cls[1])];

	// export interface/type name
	const iface = trimmed.match(/^export\s+(?:interface|type)\s+(\w+)/);
	if (iface) return [nonNull(iface[1])];

	// export enum name
	const enm = trimmed.match(/^export\s+enum\s+(\w+)/);
	if (enm) return [nonNull(enm[1])];

	// export default
	if (/^export\s+default\b/.test(trimmed)) return ["default"];

	// export { a, b, c } or export type { a, b, c } (single-line)
	const named = trimmed.match(/^export\s+(?:type\s+)?\{([^}]+)\}/);
	if (!named) return [];
	const names: string[] = [];
	for (const n of nonNull(named[1]).split(",")) {
		const name = n
			.trim()
			.replace(/^type\s+/, "")
			.split(/\s+as\s+/)
			.pop()
			?.trim();
		if (name) names.push(name);
	}
	return names;
}

/**
 * Extract exported symbol names from a module (for mock drift comparison).
 */
export function extractModuleExportNames(content: string): string[] {
	const names: string[] = [];
	// Normalize multi-line export/import blocks to single lines for easier parsing
	const normalized = content.replace(/export\s+(?:type\s+)?\{[^}]*\}/gs, (m) =>
		m.replace(/\n/g, " "),
	);
	const lines = normalized.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("export")) continue;
		names.push(...namesFromExportLine(trimmed));
	}

	return names;
}
