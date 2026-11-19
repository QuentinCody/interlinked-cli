import { describe, expect, it } from "vitest";
import { metricPolicyApplies, parseMetricPolicies, resolveMetricPolicy, metricPolicyWeakening } from "./metric-policy.js";

const context = { inheritedMode: "warn" as const, canonicalThreshold: 25, blockingSupported: true };

describe("metric policy parsing", () => {
	it("retains each supported mode and an explicit zero reporting target", () => {
		for (const mode of ["report", "warn", "block", "off"]) {
			const parsed = parseMetricPolicies({ cyclomatic: { mode, threshold: 0 } });
			expect(parsed.issues).toEqual([]);
			expect(parsed.policies.cyclomatic).toEqual({ mode, threshold: 0 });
		}
	});
	it("retains valid siblings beside malformed entries", () => {
		const parsed = parseMetricPolicies({ cyclomatic: { mode: "off" }, cognitive: { mode: "enforced" } });
		expect(parsed.policies).toEqual({ cyclomatic: { mode: "off" } });
		expect(parsed.issues).toHaveLength(1);
	});
	it.each([null, [], 1, "block"])("reports an invalid policy map %s", value => {
		expect(parseMetricPolicies(value).policies).toEqual({});
		expect(parseMetricPolicies(value).issues).toHaveLength(1);
	});
	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "20"])("rejects an invalid threshold %s", threshold => {
		expect(parseMetricPolicies({ cyclomatic: { mode: "block", threshold } }).issues).toHaveLength(1);
	});
	it("rejects invalid scope roles without losing valid unrelated policy", () => {
		const parsed = parseMetricPolicies({ cyclomatic: { scope: { roles: ["production"] } }, cognitive: { scope: { paths: ["src/**"], roles: ["product"] } } });
		expect(parsed.policies.cyclomatic).toBeUndefined();
		expect(parsed.policies.cognitive?.scope?.roles).toEqual(["product"]);
	});
});

describe("metric policy resolution", () => {
	it("inherits existing behavior and the canonical cap when absent", () => {
		expect(resolveMetricPolicy(undefined, context)).toEqual({ mode: "warn", threshold: 25, thresholdKind: "canonical-cap", inherited: true, scope: {}, issues: [] });
	});
	it("keeps reporting targets distinct from an enforcement cap", () => {
		const resolved = resolveMetricPolicy({ mode: "warn", threshold: 80 }, context);
		expect(resolved.mode).toBe("warn");
		expect(resolved.threshold).toBe(80);
		expect(resolved.thresholdKind).toBe("reporting-target");
	});
	it("uses the tighter cap for explicit blocking", () => {
		expect(resolveMetricPolicy({ mode: "block", threshold: 50 }, context).threshold).toBe(25);
		expect(resolveMetricPolicy({ mode: "block", threshold: 12 }, context).threshold).toBe(12);
	});
	it("keeps unsupported blocking visible and nonblocking", () => {
		const resolved = resolveMetricPolicy({ mode: "block", threshold: 10 }, { ...context, blockingSupported: false });
		expect(resolved.mode).toBe("warn");
		expect(resolved.issues.join(" ")).toContain("blocking");
	});
	it("does not turn an unavailable numeric measurement into a finding", () => {
		const resolved = resolveMetricPolicy({ mode: "warn" }, { ...context, canonicalThreshold: null });
		expect(resolved.threshold).toBeNull();
	});
});

describe("metric policy scope", () => {
	it("matches relative paths and source roles together", () => {
		const scope = { paths: ["src/**"], roles: ["product" as const] };
		expect(metricPolicyApplies(scope, "src/a.ts", "product")).toBe(true);
		expect(metricPolicyApplies(scope, "scripts/a.ts", "product")).toBe(false);
		expect(metricPolicyApplies(scope, "src/a.test.ts", "test")).toBe(false);
	});
	it("represents an explicit empty scope without widening it", () => {
		expect(metricPolicyApplies({ paths: [] }, "src/a.ts", "product")).toBe(false);
		expect(metricPolicyApplies({}, "src/a.ts", "product")).toBe(true);
	});
});

describe("adopted metric-policy integrity", () => {
	const adopted = resolveMetricPolicy({ mode: "block", threshold: 10 }, context);
	it.each(["off", "report", "warn"] as const)("detects a blocking mode weakened to %s", mode => {
		expect(metricPolicyWeakening(adopted, resolveMetricPolicy({ mode }, context))).toContain("mode");
	});
	it("detects a higher effective threshold and cap fallback", () => {
		expect(metricPolicyWeakening(adopted, resolveMetricPolicy({ mode: "block", threshold: 20 }, context))).toContain("threshold");
		expect(metricPolicyWeakening(adopted, resolveMetricPolicy(undefined, { ...context, inheritedMode: "block" }))).toContain("threshold");
	});
	it("protects inherited blocking when a new policy disables it", () => {
		const inherited = resolveMetricPolicy(undefined, { ...context, inheritedMode: "block" });
		expect(metricPolicyWeakening(inherited, resolveMetricPolicy({ mode: "off" }, context))).toContain("mode");
	});
	it("detects lost paths and roles while allowing a scope union", () => {
		const before = resolveMetricPolicy({ mode: "block", scope: { paths: ["src/**"], roles: ["product"] } }, context);
		const narrow = resolveMetricPolicy({ mode: "block", scope: { paths: ["src/a.ts"], roles: ["product"] } }, context);
		const broad = resolveMetricPolicy({ mode: "block", scope: { paths: ["src/**", "scripts/**"], roles: ["product", "test"] } }, context);
		expect(metricPolicyWeakening(before, narrow)).toContain("scope");
		expect(metricPolicyWeakening(before, broad)).toEqual([]);
	});
	it("does not treat report-only customization as an adopted block", () => {
		expect(metricPolicyWeakening(resolveMetricPolicy(undefined, context), resolveMetricPolicy({ mode: "off" }, context))).toEqual([]);
	});
	it("accepts a proved broader glob and preserves uncertainty for unsupported patterns", () => {
		const before = resolveMetricPolicy({ mode: "block", scope: { paths: ["src/*.ts"] } }, context);
		const broad = resolveMetricPolicy({ mode: "block", scope: { paths: ["src/**"] } }, context);
		expect(metricPolicyWeakening(before, broad)).toEqual([]);
		const unresolved = resolveMetricPolicy({ mode: "block", scope: { paths: ["src/!(test).ts"] } }, context);
		expect(metricPolicyWeakening(before, unresolved)).toContain("scope-unproven");
	});
});
