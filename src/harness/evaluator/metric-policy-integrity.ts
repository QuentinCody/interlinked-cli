import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
import { checkPolicyFromDocuments } from "../check-policy.js";
import { DEFAULT_MAX_COGNITIVE_CAP, DEFAULT_MAX_CYCLOMATIC, DEFAULT_MAX_FUNCTION_TOKENS, normalizeOverrides } from "../metric-caps.js";
import { inheritedStructuralMetricPolicy, resolveStructuralMetricPolicy, STRUCTURAL_METRIC_KEYS, type StructuralMetricThresholds } from "../metric-policy-config.js";
import { metricPolicyWeakening } from "../metric-policy.js";
import type { BaselineGamingFinding } from "./baseline-integrity-gate.js";
import { waterLineRoot } from "./effective-caps.js";
import type { HarnessEvent } from "../types.js";
import { toolWriteTargets } from "./write-targets.js";

/** Conditional controls use the existing intent/effect/commit comparison machinery. */
export const METRIC_POLICY_FILES = [".interlinked/check-policy.json", ".interlinked/check-policy.local.json"] as const;
export const METRIC_POLICY_CONTROL_FILES = [...METRIC_POLICY_FILES, ".interlinked/config.json"] as const;

/** Context snapshots supplement the baseline set without changing its public inventory. */
export function captureMetricPolicySources(root: string, readSource: (path: string) => string | null): Record<string, string | null> {
	return Object.fromEntries(METRIC_POLICY_CONTROL_FILES.map(path => [path, readSource(resolve(root, path))]));
}

export function isMetricPolicyPath(path: string): boolean {
	return /(?:^|\/)\.interlinked\/(?:check-policy(?:\.local)?|config)\.json$/i.test(path.replace(/\\/g, "/"));
}

export interface MetricPolicyIntegrityContext {
	root: string;
	readBefore?: (path: string) => string | null;
	readAfter?: (path: string) => string | null;
}

function parseDocument(text: string | null): unknown {
	if (text === null) return null;
	try { const value: unknown = JSON.parse(text); return value; }
	catch { return null; }
}

function diskSource(root: string, path: string): string | null {
	try { return readFileSync(resolve(root, path), "utf8"); }
	catch { return null; }
}

function legacyPolicy(config: unknown): unknown {
	if (!isJsonObject(config) || !isJsonObject(config.harness)) return undefined;
	return config.harness.edit_metrics;
}

function thresholds(value: unknown): StructuralMetricThresholds {
	const parsed = normalizeOverrides(value);
	return {
		cyclomatic: parsed.max_cyclomatic ?? DEFAULT_MAX_CYCLOMATIC,
		cognitive: parsed.max_cognitive ?? DEFAULT_MAX_COGNITIVE_CAP,
		"function-tokens": parsed.max_function_tokens ?? DEFAULT_MAX_FUNCTION_TOKENS,
	};
}

function policyState(readSource: (path: string) => string | null) {
	const policy = checkPolicyFromDocuments(parseDocument(readSource(METRIC_POLICY_FILES[0])), parseDocument(readSource(METRIC_POLICY_FILES[1])));
	const inherited = inheritedStructuralMetricPolicy(legacyPolicy(parseDocument(readSource(".interlinked/config.json"))));
	const caps = thresholds(parseDocument(readSource(".interlinked/metric-caps.json")));
	return Object.fromEntries(STRUCTURAL_METRIC_KEYS.map(metric => [metric, resolveStructuralMetricPolicy(policy, metric, inherited.mode, caps[metric])]));
}

function controlPath(filePath: string): (typeof METRIC_POLICY_CONTROL_FILES)[number] {
	if (/(?:^|\/)config\.json$/i.test(filePath)) return ".interlinked/config.json";
	return /check-policy\.local\.json$/i.test(filePath) ? METRIC_POLICY_FILES[1] : METRIC_POLICY_FILES[0];
}

function configuredMetrics(readSource: (path: string) => string | null) {
	return checkPolicyFromDocuments(parseDocument(readSource(METRIC_POLICY_FILES[0])), parseDocument(readSource(METRIC_POLICY_FILES[1]))).metrics;
}

/** Whether an unprojectable control edit can affect an already adopted block. */
export function hasMetricPolicyEnforcement(filePath: string, text: string | null, context: MetricPolicyIntegrityContext): boolean {
	const target = controlPath(filePath);
	const readSource = context.readBefore ?? ((path: string) => diskSource(context.root, path));
	const state = policyState(path => path === target ? text : readSource(path));
	const configured = configuredMetrics(readSource);
	return STRUCTURAL_METRIC_KEYS.some(metric => state[metric]?.mode === "block" && (target !== ".interlinked/config.json" || configured?.[metric] !== undefined));
}

/** Reconstruct companion policy/cap/config images with the same tool projector as baseline intent. */
export function metricPolicySourcesForEvent(
	event: HarnessEvent,
	root: string,
	readDisk: (path: string) => string | null,
): MetricPolicyIntegrityContext {
	const contextPaths = [...METRIC_POLICY_FILES, ".interlinked/metric-caps.json", ".interlinked/config.json"];
	const targets = toolWriteTargets(event.tool_name ?? "", event.tool_input ?? {}, event.cwd, readDisk,
		path => contextPaths.some(relative => resolve(root, relative) === resolve(path)));
	const before = new Map<string, string | null>();
	const readBefore = (path: string): string | null => {
		if (!before.has(path)) before.set(path, readDisk(resolve(root, path)));
		return before.get(path) ?? null;
	};
	const readAfter = (path: string): string | null => {
		const target = targets.find(target => resolve(target.filePath) === resolve(root, path));
		if (target?.proposed.kind === "decided" && target.proposed.contents.length === 1) return target.proposed.contents[0] ?? null;
		return readBefore(path);
	};
	return { root, readBefore, readAfter };
}

export interface MetricPolicyLoosening {
	file: string;
	beforeText: string;
	afterText: string | null;
	absentBefore?: boolean;
	details: string[];
}

/** Control-file comparisons are conditional, so historical check settings remain ordinary config. */
export function metricPolicySnapshotLoosenings(
	before: Readonly<Record<string, string | null>>,
	after: Readonly<Record<string, string | null>>,
	root: string | undefined,
): MetricPolicyLoosening[] {
	if (!root) return [];
	const source = (snapshot: Readonly<Record<string, string | null>>, path: string): string | null =>
		Object.hasOwn(snapshot, path) ? snapshot[path] ?? null : diskSource(root, path);
	return METRIC_POLICY_CONTROL_FILES.flatMap(file => {
		const beforeText = before[file] ?? null, afterText = after[file] ?? null;
		if (beforeText === afterText) return [];
		const findings = detectMetricPolicyLoosening(file, beforeText, afterText, {
			root, readBefore: path => source(before, path), readAfter: path => source(after, path),
		});
		return findings.length === 0 ? [] : [{ file, beforeText: beforeText ?? "", afterText,
			...(beforeText === null ? { absentBefore: true } : {}), details: findings.map(finding => finding.message) }];
	});
}

/** Compare effective adopted predicates, including inherited enforcement and personal overrides.
 * Unrelated check customizations hold no new water-line. Source readers can supply a complete
 * proposed/snapshotted companion image for multi-file edits and staged commits. */
export function detectMetricPolicyLoosening(
	filePath: string,
	beforeText: string | null,
	afterText: string | null,
	context?: MetricPolicyIntegrityContext,
): BaselineGamingFinding[] {
	if (!isMetricPolicyPath(filePath)) return [];
	const root = context?.root ?? waterLineRoot(filePath);
	if (!root) return [];
	const target = controlPath(filePath);
	const beforeSource = context?.readBefore ?? ((path: string) => diskSource(root, path));
	const afterSource = context?.readAfter ?? ((path: string) => diskSource(root, path));
	const before = policyState(path => path === target ? beforeText : beforeSource(path));
	const after = policyState(path => path === target ? afterText : afterSource(path));
	const configured = configuredMetrics(beforeSource);
	const findings: BaselineGamingFinding[] = [];
	for (const metric of STRUCTURAL_METRIC_KEYS) {
		if (target === ".interlinked/config.json" && configured?.[metric] === undefined) continue;
		const oldPolicy = before[metric], newPolicy = after[metric];
		if (!oldPolicy || !newPolicy) continue;
		for (const reason of metricPolicyWeakening(oldPolicy, newPolicy)) findings.push({
			file: filePath,
			rule: `metric-policy:${metric}:${reason}`,
			before: oldPolicy,
			after: newPolicy,
			message: reason === "scope-unproven"
				? `${metric} adopted enforcement scope preservation could not be proved. Retain the established selectors or use the operator's intentional-reset workflow.`
				: `${metric} adopted enforcement ${reason} would weaken. Preserve the established mode, effective cap and scope; intentional changes use the existing operator workflow.`,
		});
	}
	return findings;
}
