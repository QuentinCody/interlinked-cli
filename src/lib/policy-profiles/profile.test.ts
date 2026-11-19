import { describe, expect, it } from "vitest";
import { parsePolicyProfile, policyProfileHash } from "./profile.js";

describe("data-only policy profile", () => {
	it("preserves known metric targets and named detector selections", () => {
		const profile = parsePolicyProfile({ schemaVersion: 1, id: "team.typescript", metrics: { difficulty: { mode: "warn", threshold: 0 }, "function-tokens": { mode: "block", threshold: 400 } }, rules: { "no-nan": { check: "nan_comparison", mode: "report", scope: { paths: ["src/**"], roles: ["product"] } } } });
		expect(profile.metrics["function-tokens"]).toEqual({ mode: "block", threshold: 400 });
		expect(profile.metrics.tokens).toBeUndefined();
		expect(profile.metrics.difficulty?.threshold).toBe(0);
		expect(profile.rules["no-nan"]?.check).toBe("nan_comparison");
	});
	it("keeps an unsupported requested metric block visible for assessment", () => {
		expect(parsePolicyProfile({ schemaVersion: 1, id: "team", metrics: { "file.lines": { mode: "block", threshold: 10 } } }).metrics["file.lines"]?.mode).toBe("block");
	});
	it("keeps AST and canonical token definitions independently addressable", () => {
		const profile = parsePolicyProfile({ schemaVersion: 1, id: "team", metrics: { tokens: { threshold: 100 }, "function-tokens": { threshold: 400 } } });
		expect(profile.metrics.tokens?.threshold).toBe(100);
		expect(profile.metrics["function-tokens"]?.threshold).toBe(400);
	});
	it("defaults rule disposition to report when optional fields are absent", () => {
		expect(parsePolicyProfile({ schemaVersion: 1, id: "team", rules: { numeric: { check: "nan_comparison" } } }).rules.numeric?.mode).toBe("report");
	});
	it.each([
		{ schemaVersion: 2, id: "team" },
		{ schemaVersion: 1, id: "team", metrics: { arbitrary: { threshold: 5 } } },
		{ schemaVersion: 1, id: "team", metrics: { cognitive: { command: "node custom.js" } } },
		{ schemaVersion: 1, id: "team", rules: { custom: { check: "unknown_detector" } } },
		{ schemaVersion: 1, id: "team", rules: { custom: { check: "nan_comparison", mode: "block" } } },
		{ schemaVersion: 1, id: "team", imports: ["./plugin.js"] },
	])( "rejects unsupported or ambiguous profile data %#", input => {
		expect(() => parsePolicyProfile(input)).toThrow();
	});
	it("hashes canonical data independently of declaration order", () => {
		const left = parsePolicyProfile({ schemaVersion: 1, id: "team", metrics: { cognitive: { threshold: 10, mode: "warn" }, cyclomatic: {} } });
		const right = parsePolicyProfile({ id: "team", schemaVersion: 1, metrics: { cyclomatic: {}, cognitive: { mode: "warn", threshold: 10 } } });
		expect(policyProfileHash(left)).toBe(policyProfileHash(right));
	});
});
