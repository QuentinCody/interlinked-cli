import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectStandardsReport } from "./census.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "standards-census-"))); roots.push(root);
	writeFileSync(join(root, "source.ts"), "export const value = JSON.parse(input) as { value: any }; fetch(url);");
	writeFileSync(join(root, "source.test.ts"), "export const testValue = 1 as any;");
	writeFileSync(join(root, "other.py"), "value = 1");
	writeFileSync(join(root, "package.json"), '{ "scripts": { "test": "touch EXECUTED" } }');
	return root;
}

it("retains all standards, exact syntax and source-bound candidates without a compliance score", () => {
	const root = fixture(), report = collectStandardsReport(root);
	expect(report.standards).toHaveLength(35);
	expect(report.standards.every(row => row.compliance === null)).toBe(true);
	expect(report.standards.find(row => row.id === "s27")?.counts.astOccurrences).toBe(4);
	expect(report.standards.find(row => row.id === "s35")).toMatchObject({ state: "not_measured", occurrenceIds: [], caseIds: [] });
	expect(report.occurrences.every(row => /^[a-f0-9]{64}$/.test(row.sourceHash))).toBe(true);
	expect(report.inventory.entries.find(row => row.path === "other.py")).toMatchObject({ supported: false });
	expect(report.modelCalls).toBe(0);
	expect(report.provenance.sourceConsistency.state).toBe("stable_selected_snapshot");
	expect(report.actions.actions.every(row => row.inferenceCostUsd === 0 && row.enforcement === "report")).toBe(true);
	expect(existsSync(join(root, "EXECUTED"))).toBe(false);
});

it("preserves all-role denominators when selecting product-only measurements", () => {
	const root = fixture(), all = collectStandardsReport(root), product = collectStandardsReport(root, { scope: "product" });
	expect(product.inventory.byRole).toEqual(all.inventory.byRole);
	expect(product.inventory.selectedFiles).toBe(1);
	expect(product.occurrences.every(row => row.role === "product")).toBe(true);
	expect(product.standards.find(row => row.id === "s27")?.counts.astOccurrences).toBe(2);
});

it("rejects unknown profiles and scopes before scanning", () => {
	expect(() => collectStandardsReport("/absent", { profile: "unknown" })).toThrow("Unknown standards profile");
	expect(() => collectStandardsReport("/absent", { scope: "unknown" })).toThrow("Standards scope must be all or product");
});

it("keeps an empty source population and missing compiler settings unmeasured", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "standards-empty-"))); roots.push(root);
	const report = collectStandardsReport(root);
	expect(report.standards.every(row => row.state === "not_measured")).toBe(true);
	expect(report.standards.find(row => row.id === "s25")?.coverage.compilerState).toBe("missing");
});
