import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as parser from "../../harness/checks/cyclomatic-ast.js";
import { measureTypeSoundness } from "./adapter-types.js";
import { collectRepositoryInventory } from "./inventory.js";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function inventory(files: Record<string, string>) {
	const root = mkdtempSync(join(process.cwd(), "scratch", "typed-recovery-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return collectRepositoryInventory(root, { resourcePolicy: "foreground-survey" });
}

describe("typed score parser coverage", () => {
	// test-contract: public-api — a recovered parser tree supplies no certified operation population.
	it("reports malformed-only source as inconclusive with a named syntax gap", () => {
		const report = measureTypeSoundness(inventory({ "broken.ts": "export function broken(value: any) { value.trim();" }));
		expect(report.metrics[0]?.state).toBe("inconclusive");
		expect(report.metrics[0]?.limitations.some(reason => reason.includes("broken.ts") && reason.includes("syntactic"))).toBe(true);
		expect(report.metrics[0]?.measuredEntities).toBe(0);
		expect(report.findings).toEqual([]);
	});

	it("retains valid-file unsafe observations alongside a separate syntax gap", () => {
		const report = measureTypeSoundness(inventory({
			"valid.ts": "export function valid(value: any) { return value.trim(); }",
			"broken.ts": "export function broken(value: any) { value.trim();",
		}));
		expect(report.metrics[0]?.state).toBe("inconclusive");
		expect(report.metrics[0]?.limitations.some(reason => reason.includes("broken.ts"))).toBe(true);
		expect(report.findings.length).toBeGreaterThan(0);
		expect(report.findings.every(finding => finding.file === "valid.ts")).toBe(true);
	});

	it("preserves exact valid source, including narrowed unknown and type-only declarations", () => {
		const report = measureTypeSoundness(inventory({ "valid.ts": "export type Item = { name: string };\nexport function valid(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }" }));
		expect(report.metrics[0]?.state).toBe("measured");
		expect(report.findings).toEqual([]);
	});

	it("keeps an absent optional compiler explicitly unsupported", () => {
		const input = inventory({ "valid.ts": "export const value = 1;" });
		vi.spyOn(parser, "parseTsSource").mockReturnValue(null);
		const report = measureTypeSoundness(input);
		expect(report.metrics[0]).toMatchObject({ state: "unsupported", value: null, measuredEntities: 0, eligibleEntities: 1 });
		expect(report.metrics[0]?.limitations).toContain("TypeScript compiler unavailable");
	});
});
