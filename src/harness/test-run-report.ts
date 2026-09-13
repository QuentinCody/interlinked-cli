import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import type { TestPlan } from "./test-plan.js";

/** A zero exit code alone cannot certify that the selected tests actually ran. */
export function testReportIssue(root: string, report: string, plan: TestPlan): string | null {
    try {
        const value: unknown = JSON.parse(readFileSync(report, "utf8"));
        if (!isJsonObject(value) || value.success !== true || typeof value.numPassedTests !== "number" || value.numPassedTests < 1 || !Array.isArray(value.testResults)) return "Missing completed nonempty Vitest report";
        const actual = new Set<string>();
        for (const file of value.testResults) {
            if (!isJsonObject(file) || typeof file.name !== "string") return "Malformed Vitest file result";
            actual.add(relative(root, file.name).replaceAll("\\", "/"));
        }
        if (plan.mode === "selected" && JSON.stringify([...actual].sort()) !== JSON.stringify(plan.tests.map(test => test.path).sort())) return "Executed test files differ from the plan";
        return null;
    } catch { return "Vitest report unavailable"; }
}
