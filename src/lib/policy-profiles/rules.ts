import { CHECK_REGISTRY } from "../../harness/check-registry/index.js";
import type { CheckRegistration } from "../../harness/check-registry/types.js";
import { withCheckRoot } from "../../harness/checks/check-root.js";
import { metricPolicyApplies } from "../../harness/metric-policy.js";
import type { InventoryFile, InventoryGap, RepositoryInventory } from "../metrics/measurement-types.js";
import type { ProfileRule } from "./profile.js";

export interface ProfileRuleFinding {
	file: string;
	line: number;
	text: string;
	sourceHash: string;
	evidence: "proven" | "heuristic";
}
export interface ProfileRuleResult {
	id: string;
	check: string;
	mode: ProfileRule["mode"];
	state: "completed" | "partial" | "off" | "not-applicable";
	selectedFiles: number;
	completedFiles: number;
	findings: ProfileRuleFinding[];
	notMeasured: string[];
	warning: boolean;
}
export interface RuleEvaluationContext {
	excluded?: RepositoryInventory["excluded"];
	gaps?: readonly InventoryGap[];
	discoveryIssues?: readonly string[];
}

function runDetectorForFile(root: string, check: CheckRegistration, file: InventoryFile) {
	if (file.language !== "javascript" && file.language !== "typescript") return {
		completed: false, findings: [], notMeasured: [`${file.path}: profile detector adapter supports JavaScript/TypeScript`],
	};
	try {
		const run = withCheckRoot(root, () => check.fn(file.content, file.path));
		const evidence = check.determinism === "fully_deterministic" ? "proven" as const : "heuristic" as const;
		return { completed: true, notMeasured: run.notMeasured.map(notice => `${file.path}: ${notice}`),
			findings: run.result.map(match => ({ file: file.path, line: match.line, text: match.text, sourceHash: file.sha256, evidence })) };
	} catch (error) {
		return { completed: false, findings: [], notMeasured: [`${file.path}: ${error instanceof Error ? error.message : "Detector failed"}`] };
	}
}

/** Explicit registry execution retains detector matches and their own missing-evidence notices. */
export function evaluateProfileRules(root: string, rules: Record<string, ProfileRule>, files: readonly InventoryFile[], context: RuleEvaluationContext = {}): ProfileRuleResult[] {
	return Object.keys(rules).sort().map(id => {
		const rule = rules[id];
		if (!rule) throw new Error(`Missing profile rule ${id}`);
		const check = CHECK_REGISTRY.find(check => check.id === rule.check);
		if (!check) throw new Error(`Unknown profile detector ${rule.check}`);
		const selected = files.filter(file => metricPolicyApplies(rule.scope ?? {}, file.path, file.role));
		const notMeasured = [...context.discoveryIssues ?? [], ...context.gaps?.filter(gap => metricPolicyApplies(rule.scope ?? {}, gap.path, gap.role)).map(gap => `${gap.path}: ${gap.reason}`) ?? []];
		if (rule.scope?.paths !== undefined || rule.scope?.roles !== undefined) {
			notMeasured.push(...context.excluded?.filter(file => metricPolicyApplies(rule.scope ?? {}, file.path, file.role)).map(file => `${file.path}: ${file.reason}`) ?? []);
		}
		const result: ProfileRuleResult = { id, check: check.id, mode: rule.mode, state: "completed", selectedFiles: selected.length,
			completedFiles: 0, findings: [], notMeasured, warning: false };
		if (rule.mode === "off") return { ...result, state: "off" };
		for (const file of selected) {
			const run = runDetectorForFile(root, check, file);
			if (run.completed) result.completedFiles++;
			result.notMeasured.push(...run.notMeasured);
			result.findings.push(...run.findings);
		}
		if (result.notMeasured.length) result.state = "partial";
		else if (!selected.length) result.state = "not-applicable";
		result.warning = rule.mode === "warn" && result.findings.length > 0;
		return result;
	});
}
