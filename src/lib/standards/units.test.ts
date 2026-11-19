import { expect, it } from "vitest";
import { hashBytes } from "../metrics/inventory.js";
import { attachStandardsUnitIds, collectStandardsUnits } from "./units.js";
import { scanStandardsEvidence } from "./evidence.js";

it("retains existing source-driven function identities and adjacent comments with caller gaps", () => {
	const content = "/** Retry boundary. */\nexport function outer() { return () => 1; }";
	const file = { path: "source.ts", role: "product" as const, language: "typescript", content, sha256: hashBytes(content) };
	const result = collectStandardsUnits("/repo", [file]);
	expect(result.units).toHaveLength(2);
	const outer = result.units.find(row => row.name === "outer");
	expect(outer).toMatchObject({ evidenceUnitId: "source.ts::outer:function", sourceHash: file.sha256, extractor: "semantic-evidence-v4", comment: "/** Retry boundary. */" });
});

it("keeps function-purpose and caller evidence explicitly uncollected", () => {
	const content = "function parse() { return 1; }";
	const result = collectStandardsUnits("/repo", [{ path: "source.ts", role: "product", language: "typescript", content, sha256: hashBytes(content) }]);
	expect(result.units[0]?.context).toEqual({ callers: "not_collected", filePurpose: "not_established" });
	expect(result.units[0]?.comment).toBeNull();
	expect(result.units[0]?.id).toMatch(/^[a-f0-9]{64}$/);
	expect(result.notMeasured).toEqual([]);
});

it("links nested source occurrences to enclosing units while leaving module syntax outside functions", () => {
	const content = "function outer() { function inner() { return 1 as any; } return inner(); } throw 'module';";
	const file = { path: "source.ts", role: "product" as const, language: "typescript", content, sha256: hashBytes(content) };
	const units = collectStandardsUnits("/repo", [file]), evidence = scanStandardsEvidence("/repo", [file], [], []);
	attachStandardsUnitIds(evidence.occurrences, units.units);
	expect(evidence.occurrences.find(row => row.rule === "explicit_any")?.unitIds).toHaveLength(2);
	expect(evidence.occurrences.find(row => row.rule === "throw_statement")?.unitIds).toEqual([]);
});

it("binds comment-only edits to a new source snapshot while preserving stable evidence-unit identity", () => {
	const before = "/** First explanation. */\nfunction task() { return 1; }", after = before.replace("First", "Later");
	const units = [before, after].map(content => collectStandardsUnits("/repo", [{ path: "source.ts", role: "product", language: "typescript", content, sha256: hashBytes(content) }]).units[0]);
	expect(units[0]?.evidenceUnitId).toBe(units[1]?.evidenceUnitId);
	expect(units[0]?.id).not.toBe(units[1]?.id);
	expect(units[0]?.sourceHash).not.toBe(units[1]?.sourceHash);
});
