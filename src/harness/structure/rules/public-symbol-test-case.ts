// ===========================================
// Rule: Public Symbol Test-Case Requirement
// ===========================================
// Complements `public_symbol_companions` (which checks companion files were
// TOUCHED when the source changed). This rule checks that a companion test
// file actually references the symbol by name — catching the case where the
// test file exists but contains no test case for the symbol.
//
// Fires when:
//   - A public symbol's source file is in changedFiles
//   - The symbol has at least one declared/inferred companion test file
//   - None of those test files contain a `\b<symbolLabel>\b` reference
//
// Why this matters: "test file exists" is not the same as "test case exists".
// An agent can land a new export whose test file was created months ago for
// a different symbol; static file presence misses the gap. Requiring the
// symbol NAME to appear in the test file surfaces the gap cheaply.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ArtifactGraph } from "../artifact-graph.js";
import type { ArtifactNode, Determinism, StructureFinding } from "../types.js";

export function checkPublicSymbolTestCase(
	graph: ArtifactGraph,
	changedFiles: string[],
	repoRoot?: string,
): StructureFinding[] {
	const findings: StructureFinding[] = [];
	const changedSet = new Set(changedFiles);
	const symbolNodes = graph.getNodesByKind("public_symbol");
	const root = repoRoot ?? process.cwd();

	for (const symbol of symbolNodes) {
		if (!changedSet.has(symbol.file)) continue;
		const finding = evaluateSymbolTestCase(graph, symbol, root);
		if (finding) findings.push(finding);
	}

	return findings;
}

/**
 * Evaluate a single public symbol against its companion test files, returning
 * a `public_symbol_test_case_missing` finding when none of them reference the
 * symbol by name — or `null` when the symbol has no companion tests, or at
 * least one companion test already references it.
 */
function evaluateSymbolTestCase(
	graph: ArtifactGraph,
	symbol: ArtifactNode,
	root: string,
): StructureFinding | null {
	const { tests } = graph.getCompanions(symbol.id);
	if (tests.length === 0) return null;

	const pattern = symbolReferenceRegex(symbol.label);
	const { referencingFiles, nonReferencingFiles } = classifyCompanionTests(tests, root, pattern);

	// If at least one companion test file references the symbol, we're good.
	if (referencingFiles.length > 0) return null;

	const allDeclared =
		symbol.provenance === "declared" && tests.every((t) => t.provenance === "declared");
	const determinism: Determinism = allDeclared ? "fully_deterministic" : "partially_deterministic";

	return {
		name: "public_symbol_test_case_missing",
		severity: "warning",
		message: `Public symbol "${symbol.label}" has ${tests.length} companion test file(s) but none contain a reference to it. Add a test case that imports/invokes "${symbol.label}".`,
		file: symbol.file,
		affected_files: nonReferencingFiles,
		determinism,
		provenance: symbol.provenance,
		artifact_kind: "public_symbol",
		artifact_id: symbol.id,
		required_updates: nonReferencingFiles.map((f) => ({
			file: f,
			kind: "test",
			reason: `Add a test case referencing "${symbol.label}"`,
		})),
		confidence: allDeclared ? 1.0 : 0.75,
	};
}

/**
 * Split a symbol's companion test files into those whose on-disk content
 * references the symbol (by `pattern`) and those that don't — including
 * missing/unreadable files, which are treated as non-referencing.
 */
function classifyCompanionTests(
	tests: Array<{ file: string; provenance: string }>,
	root: string,
	pattern: RegExp,
): { referencingFiles: string[]; nonReferencingFiles: string[] } {
	const referencingFiles: string[] = [];
	const nonReferencingFiles: string[] = [];

	for (const test of tests) {
		const content = readCompanionTestContent(root, test.file);
		if (content !== null && pattern.test(content)) {
			referencingFiles.push(test.file);
		} else {
			nonReferencingFiles.push(test.file);
		}
	}

	return { referencingFiles, nonReferencingFiles };
}

/**
 * Read a companion test file's content, returning `null` when it doesn't
 * exist or can't be read (both treated as "no reference" by the caller —
 * the signal remains actionable even if the root cause is IO).
 */
function readCompanionTestContent(root: string, testFile: string): string | null {
	const absPath = resolve(root, testFile);
	if (!existsSync(absPath)) return null;
	try {
		return readFileSync(absPath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Build a case-sensitive identifier-boundary regex matching the symbol label.
 * JS identifiers may legally contain `$` and `_` in addition to `[A-Za-z0-9]`,
 * so a plain `\b` won't anchor correctly around labels like `$foo`. Instead
 * we explicitly require the preceding and following characters to not be
 * identifier-constituent characters.
 */
function symbolReferenceRegex(label: string): RegExp {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Reason: `label` comes from the artifact graph, not user input. The regex
	// metacharacters above are escaped, and the pattern structure (fixed
	// lookbehind / lookahead) is static.
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
}
