import { describe, expect, it } from "vitest";
import { evaluateProfileRules } from "./rules.js";
import type { InventoryFile } from "../metrics/measurement-types.js";

const file: InventoryFile = { path: "src/a.ts", role: "product", language: "typescript", sha256: "source", content: "export function invalid(x: number) { return x === NaN; }" };
describe("explicit profile detector selection", () => {
	it("P1 retains a selected known detector match as a candidate", () => {
		const [result] = evaluateProfileRules("/repo", { numeric: { check: "nan_comparison", mode: "warn" } }, [file]);
		expect(result?.findings).toHaveLength(1);
		expect(result?.findings[0]?.file).toBe("src/a.ts");
		expect(result?.state).toBe("completed");
		expect(result?.warning).toBe(true);
	});
	it("N1 retains scope exclusion and off disposition explicitly", () => {
		const results = evaluateProfileRules("/repo", { excluded: { check: "nan_comparison", mode: "warn", scope: { paths: ["other/**"] } }, disabled: { check: "nan_comparison", mode: "off" } }, [file]);
		expect(results.map(row => row.state)).toEqual(["off", "not-applicable"]);
		expect(results.every(row => row.findings.length === 0)).toBe(true);
	});
	it("N2 skips unsupported source languages with explicit coverage", () => {
		const [result] = evaluateProfileRules("/repo", { numeric: { check: "nan_comparison", mode: "report" } }, [{ ...file, language: "python", path: "a.py" }]);
		expect(result?.state).toBe("partial");
		expect(result?.notMeasured.join(" ")).toContain("profile detector adapter supports JavaScript/TypeScript");
	});
	it("retains explicitly selected excluded and unreadable source as unmeasured", () => {
		const [result] = evaluateProfileRules("/repo", { fixture: { check: "nan_comparison", mode: "report", scope: { roles: ["fixture"] } } }, [], {
			excluded: [{ path: "fixtures/a.ts", role: "fixture", reason: "Excluded by source-role policy" }],
			gaps: [{ path: "fixtures/b.ts", role: "fixture", reason: "Unreadable source" }],
		});
		expect(result?.state).toBe("partial");
		expect(result?.notMeasured).toHaveLength(2);
	});
});
