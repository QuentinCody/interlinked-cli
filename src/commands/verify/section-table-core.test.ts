// ===========================================
// section-table-core fragment tests
// ===========================================

import { describe, expect, it } from "vitest";
import { coreSections } from "./section-table-core.js";

describe("coreSections", () => {
	it("is non-empty", () => {
		expect(coreSections.length).toBeGreaterThan(0);
	});

	it("each entry has well-formed fields", () => {
		for (const spec of coreSections) {
			expect(typeof spec.label).toBe("string");
			expect(typeof spec.key).toBe("string");
			expect(typeof spec.noun).toBe("string");
			expect(typeof spec.passLabel).toBe("string");
			expect(["31", "33"].includes(spec.color)).toBe(true);
		}
	});

	it("opens with the error-severity red sections", () => {
		expect(coreSections[0]?.key).toBe("jsonValidity");
		expect(coreSections[0]?.color).toBe("31");
		expect(coreSections.map((s) => s.key)).toContain("phantomImports");
		expect(coreSections.map((s) => s.key)).toContain("exportRipple");
	});

	it("ends with the warning-severity inline sections", () => {
		const keys = coreSections.map((s) => s.key);
		expect(keys).toContain("largeFiles");
		expect(keys).toContain("strongTyping");
		expect(coreSections.at(-1)?.key).toBe("crap");
	});

	// Full-array exact-value assertion: every label/noun/passLabel/color literal
	// hand-transcribed from the source, independent of the source's own values.
	// This is the only technique that kills StringLiteral->"" mutations, since
	// toContain/typeof checks above are indifferent to the actual string content.
	it("matches the exact hand-transcribed field values for every entry", () => {
		expect(coreSections).toEqual([
			{
				label: "json validity",
				key: "jsonValidity",
				noun: "invalid JSON files",
				passLabel: "all JSON files valid",
				color: "31",
			},
			{
				label: "phantom imports",
				key: "phantomImports",
				noun: "unresolved imports",
				passLabel: "all imports resolve",
				color: "31",
			},
			{
				label: "export ripple",
				key: "exportRipple",
				noun: "broken import references",
				passLabel: "all import references valid",
				color: "31",
			},
			{
				label: "dead exports",
				key: "deadExports",
				noun: "named exports no other file imports",
				passLabel: "no dead exports",
				color: "33",
			},
			{
				label: "dead type exports",
				key: "deadTypeExports",
				noun: "exported types no other file imports",
				passLabel: "no dead type exports",
				color: "33",
			},
			{
				label: "duplicate type declarations",
				key: "duplicateTypeDeclaration",
				noun: "type names also declared in another module",
				passLabel: "every type name maps to one declaration",
				color: "33",
			},
			{
				label: "circular imports",
				key: "circularImports",
				noun: "import cycles involving this file",
				passLabel: "no import cycles",
				color: "33",
			},
			{
				label: "untested inverse pairs",
				key: "untestedInversePair",
				noun: "inverse pairs with no round-trip test",
				passLabel: "all inverse pairs round-trip-tested",
				color: "33",
			},
			{
				label: "untested idempotent fns",
				key: "untestedIdempotent",
				noun: "idempotent-shaped functions with no property test",
				passLabel: "all idempotent-shaped functions tested",
				color: "33",
			},
			{
				label: "lifecycle cleanup",
				key: "lifecycleCleanup",
				noun: "subscription without paired cleanup in dispose/destroy",
				passLabel: "all subscriptions paired with cleanup",
				color: "33",
			},
			{
				label: "default export hygiene",
				key: "defaultExport",
				noun: "anonymous default export or symbol name not matching filename",
				passLabel: "no grep-hostile default exports",
				color: "33",
			},
			{
				label: "code clones (DRY)",
				key: "codeClones",
				noun: "functions near-duplicating another function",
				passLabel: "no near-duplicate functions",
				color: "33",
			},
			{
				label: "large files",
				key: "largeFiles",
				noun: "files over threshold lines",
				passLabel: "all files under threshold lines",
				color: "33",
			},
			{
				label: "untested files",
				key: "untestedFiles",
				skipId: "untested_files",
				noun: "source files with no companion test and coverage below threshold",
				passLabel: "all source files tested (companion or coverage)",
				color: "33",
			},
			{
				label: "strong typing",
				key: "strongTyping",
				noun: "any/unknown-type usages",
				passLabel: "no any/unknown-types",
				color: "33",
			},
			{
				label: "suppressions",
				key: "suppressions",
				noun: "suppression comments",
				passLabel: "no suppression comments",
				color: "33",
			},
			{
				label: "console statements",
				key: "consoleStatements",
				noun: "console.log/debug/info",
				passLabel: "no debug logging",
				color: "33",
			},
			{
				label: "silent catches",
				key: "silentCatches",
				noun: "empty catch blocks",
				passLabel: "no empty catch blocks",
				color: "33",
			},
			{
				label: "test regressions",
				key: "testRegressions",
				noun: "skipped/todo tests",
				passLabel: "no skipped or weakened tests",
				color: "33",
			},
			{
				label: "missing return types",
				key: "missingReturnTypes",
				noun: "exported functions without return types",
				passLabel: "all exported functions have return types",
				color: "33",
			},
			{
				label: "mock drift",
				key: "mockDrift",
				noun: "stale mock references",
				passLabel: "all mocks match module exports",
				color: "33",
			},
			{
				label: "incomplete renames",
				key: "incompleteRenames",
				noun: "orphaned string refs",
				passLabel: "no orphaned string references",
				color: "33",
			},
			{
				label: "test coverage gaps",
				key: "noTestFile",
				noun: "source files without tests",
				passLabel: "all source files have tests",
				color: "33",
			},
			{
				label: "function complexity",
				key: "complexity",
				noun: "complex functions",
				passLabel: "no overly complex functions",
				color: "33",
			},
			{
				label: "CRAP risk",
				key: "crap",
				noun: "high-CRAP functions (complexity × coverage)",
				passLabel: "no CRAP hotspots",
				color: "31",
			},
		]);
	});
});
