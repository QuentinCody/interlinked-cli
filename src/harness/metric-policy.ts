import { matchesAnyGlob } from "../lib/path-glob.js";
import { isJsonObject } from "../lib/json-types.js";
import { wireAbsentOptional, wireArray, wireLiteral, wireNumber, wireObject, type WireValidator } from "../lib/value-validation.js";
import type { SourceRole } from "../lib/metrics/measurement-types.js";
import { compareCoverageGlobScope } from "./evaluator/vitest-coverage-glob-scope.js";

/** Disposition of measured findings. Absence preserves the caller's existing behavior. */
export type MetricPolicyMode = "report" | "warn" | "block" | "off";

/** Filters narrow a metric's existing eligible population. */
export interface MetricPolicyScope {
	paths?: string[];
	roles?: SourceRole[];
}

/** A reporting target can tighten a qualified block, while canonical caps remain authoritative. */
export interface MetricPolicyEntry {
	mode?: MetricPolicyMode;
	threshold?: number;
	scope?: MetricPolicyScope;
}

export type MetricPolicies = Record<string, MetricPolicyEntry>;

/** Preserve unrelated entries and independently inherited scope fields. */
export function mergeMetricPolicies(base: MetricPolicies, overrides: MetricPolicies): MetricPolicies {
	const merged = { ...base };
	for (const [id, entry] of Object.entries(overrides)) {
		const previous = base[id];
		merged[id] = { ...previous, ...entry };
		if (previous?.scope || entry.scope) merged[id].scope = { ...previous?.scope, ...entry.scope };
	}
	return merged;
}

const isRole = wireLiteral("product", "test", "configuration", "generated", "fixture", "vendor", "documentation", "asset", "unlinted");
const isScope = wireObject<MetricPolicyScope>({
	paths: wireAbsentOptional(wireArray((value): value is string => typeof value === "string" && value.length > 0)),
	roles: wireAbsentOptional(wireArray(isRole)),
});
const isEntry: WireValidator<MetricPolicyEntry> = wireObject<MetricPolicyEntry>({
	mode: wireAbsentOptional(wireLiteral("report", "warn", "block", "off")),
	threshold: wireAbsentOptional((value): value is number => wireNumber(value) && value >= 0),
	scope: wireAbsentOptional(isScope),
});

function plainRecord(value: unknown): value is Record<string, unknown> {
	if (!isJsonObject(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Preserve valid sibling policies and report malformed entries individually. */
export function parseMetricPolicies(value: unknown): { policies: MetricPolicies; issues: string[] } {
	const policies: MetricPolicies = {}, issues: string[] = [];
	if (value === undefined) return { policies, issues };
	if (!plainRecord(value)) return { policies, issues: ["Metric policies must be a JSON object"] };
	for (const [id, entry] of Object.entries(value)) {
		if (!/^[a-z][a-z0-9._-]{0,127}$/.test(id) || !plainRecord(entry) || !isEntry(entry)) {
			issues.push(`Invalid metric policy ${id}`);
			continue;
		}
		const validated: MetricPolicyEntry = entry;
		const parsed: MetricPolicyEntry = {};
		if (validated.mode !== undefined) parsed.mode = validated.mode;
		if (validated.threshold !== undefined) parsed.threshold = validated.threshold;
		if (validated.scope !== undefined) parsed.scope = validated.scope;
		policies[id] = parsed;
	}
	return { policies, issues };
}

/** Resolve against a qualified caller-supplied threshold and inherited posture. */
export interface MetricPolicyContext {
	inheritedMode: MetricPolicyMode;
	canonicalThreshold: number | null;
	blockingSupported: boolean;
}

export interface ResolvedMetricPolicy {
	configured?: boolean;
	mode: MetricPolicyMode;
	threshold: number | null;
	thresholdKind: "canonical-cap" | "reporting-target";
	inherited: boolean;
	scope: MetricPolicyScope;
	issues: string[];
}

export function resolveMetricPolicy(entry: MetricPolicyEntry | undefined, context: MetricPolicyContext): ResolvedMetricPolicy {
	const issues: string[] = [];
	let mode = entry?.mode ?? context.inheritedMode;
	if (mode === "block" && !context.blockingSupported) {
		issues.push("This metric has no qualified blocking predicate; retaining warning disposition");
		mode = "warn";
	}
	const target = entry?.threshold ?? context.canonicalThreshold;
	const threshold = mode === "block" && target !== null && context.canonicalThreshold !== null
		? Math.min(target, context.canonicalThreshold)
		: target;
	return {
		mode,
		threshold,
		thresholdKind: mode === "block" || entry?.threshold === undefined ? "canonical-cap" : "reporting-target",
		inherited: entry?.mode === undefined,
		scope: entry?.scope ?? {},
		issues,
	};
}

export function metricPolicyApplies(scope: MetricPolicyScope, path: string, role: SourceRole): boolean {
	if (scope.roles && !scope.roles.includes(role)) return false;
	return scope.paths === undefined || matchesAnyGlob(path.replace(/\\/g, "/"), scope.paths);
}

/** Reuse the existing bounded positive-glob proof; unresolved overlap remains explicit. */
function scopeChange(before: MetricPolicyScope, after: MetricPolicyScope): "preserved" | "reduced" | "unproven" {
	if (after.roles && (before.roles === undefined || before.roles.some(role => !after.roles?.includes(role)))) return "reduced";
	if (after.paths === undefined) return "preserved";
	const oldPaths = before.paths ?? ["**"];
	if (oldPaths.every(path => after.paths?.includes(path))) return "preserved";
	const compared = compareCoverageGlobScope({ include: oldPaths, exclude: [] }, { include: after.paths, exclude: [] });
	if (compared.kind === "nondecreasing") return "preserved";
	return compared.kind === "reduced" ? "reduced" : "unproven";
}

/** Compare qualified, effective lower-is-stricter structural policies. */
export function metricPolicyWeakening(before: ResolvedMetricPolicy, after: ResolvedMetricPolicy): string[] {
	if (before.mode !== "block") return [];
	const findings: string[] = [];
	if (after.mode !== "block") findings.push("mode");
	if (before.threshold !== null && (after.threshold === null || after.threshold > before.threshold)) findings.push("threshold");
	const scope = scopeChange(before.scope, after.scope);
	if (scope === "reduced") findings.push("scope");
	if (scope === "unproven") findings.push("scope-unproven");
	return findings;
}
