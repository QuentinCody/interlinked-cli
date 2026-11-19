import { describe, expect, it } from "vitest";
import { CHECK_REGISTRY } from "../check-registry/index.js";
import { withForegroundCheckScan } from "./check-scan-policy.js";
import { hashBytes } from "../../lib/metrics/inventory.js";
import { scanStandardsEvidence } from "../../lib/standards/evidence.js";

const cases = [
	{ id: "promise_reject_non_error", cap: 10, source: (i: number) => `Promise.reject("failure${i}");`, safe: 'Promise.reject(new Error("failure"));' },
	{ id: "non_null_assertion", cap: 10, source: (i: number) => `const value${i} = record!.name;`, safe: "const value = record?.name;" },
	{ id: "floating_promises", cap: 10, source: (i: number) => `fetch(url${i});`, safe: "fetch(url).catch(handle);" },
	{ id: "double_cast_unknown", cap: 5, source: (i: number) => `const value${i} = input as unknown as Model;`, safe: "const value = input as Model;" },
	{ id: "boolean_trap", cap: 10, source: (i: number) => `configure${i}(true, false);`, safe: "configure({ enabled: true, visible: false });" },
	{ id: "positional_optional_boolean", cap: 10, source: (i: number) => `export function configure${i}(enabled?: boolean) {}`, safe: "export function configure(enabled: boolean) {}" },
	{ id: "many_optional_params", cap: 10, source: (i: number) => `export function configure${i}(first?: string, second?: number, third?: boolean) {}`, safe: "export function configure(first?: string, second?: number) {}" },
	{ id: "same_typed_primitive_params", cap: 10, source: (i: number) => `export function configure${i}(tenant: string, recipient: string) { return tenant + recipient; }`, safe: "export function configure(x: number, y: number) { return x + y; }" },
];

describe.each(cases)("foreground result collection for $id", ({ id, cap, source, safe }) => {
	const check = CHECK_REGISTRY.find(entry => entry.id === id)!;
	const content = Array.from({ length: 20 }, (_, i) => source(i)).join("\n");

	it("P1: retains all twenty recognized sites and the final source location", () => {
		expect(check.fn(content, "/project/src/app.ts")).toHaveLength(cap);
		const matches = withForegroundCheckScan(() => check.fn(content, "/project/src/app.ts"));
		expect(matches).toHaveLength(20);
		expect(matches.map(match => match.line)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		expect(matches.at(-1)).toMatchObject({ line: 20 });
		expect(check.fn(content, "/project/src/app.ts")).toHaveLength(cap);
	});

	it("N1: preserves legitimate exceptions and test-source applicability", () => {
		expect(withForegroundCheckScan(() => check.fn(safe, "/project/src/app.ts"))).toEqual([]);
		expect(withForegroundCheckScan(() => check.fn(content, "/project/src/app.test.ts"))).toEqual([]);
	});

	it("P2: retains the same twenty matches through the standards evidence entry point", () => {
		const file = { path: "src/app.ts", content, role: "product" as const, language: "typescript", sha256: hashBytes(content) };
		const report = scanStandardsEvidence("/project", [file], [id]);
		expect(report.occurrences.filter(row => row.rule === id)).toHaveLength(20);
		expect(report.checks[0]).toMatchObject({ measuredFiles: 1, unknownFiles: 0 });
		expect(report.notMeasured).toEqual([]);
	});
});
