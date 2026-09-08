import { wireAbsentOptional, wireArray, wireBoolean, wireLiteral, wireNumber, wireObject, wireRecord, wireString } from "../lib/value-validation.js";
import type { CheckCondition, CheckPolicyDefaults, CheckPolicyEntry, CheckPolicyFile, CoverageRatchetConfig, MutationGateConfig } from "./check-policy.js";

const isAction = wireLiteral("silent", "info", "warn_after", "warn_before", "ratchet", "ask", "block_preview", "auto_fix");
const isScope = wireLiteral("diff", "touched_file", "project");
const isCondition = wireObject<CheckCondition>({
	paths: wireAbsentOptional(wireArray(wireString)),
	branch: wireAbsentOptional(wireString),
	after_warnings_gte: wireAbsentOptional(wireNumber),
});
const isEscalation = wireObject<NonNullable<CheckPolicyEntry["escalate"]>>({
	after_warnings_gte: wireNumber,
	then: isAction,
});
const isEntry = wireObject<CheckPolicyEntry>({
	action: wireAbsentOptional(isAction),
	scope: wireAbsentOptional(isScope),
	when: wireAbsentOptional(isCondition),
	escalate: wireAbsentOptional(isEscalation),
});
const isDefaults = wireObject<Partial<CheckPolicyDefaults>>({
	action: wireAbsentOptional(isAction),
	scope: wireAbsentOptional(isScope),
});
const isCoverage = wireObject<Partial<CoverageRatchetConfig>>({
	enabled: wireAbsentOptional(wireBoolean),
	per_file: wireAbsentOptional(wireBoolean),
	allow_decrease_pct: wireAbsentOptional(wireNumber),
});
const isMutation = wireObject<Partial<MutationGateConfig>>({
	enabled: wireAbsentOptional(wireBoolean),
	min_score: wireAbsentOptional(wireNumber),
	schedule: wireAbsentOptional(wireLiteral("pre_commit", "pre_push", "weekly", "manual")),
});

export const isCheckPolicyFile = wireObject<CheckPolicyFile>({
	version: wireAbsentOptional(wireNumber),
	mode: wireAbsentOptional(wireString),
	defaults: wireAbsentOptional(isDefaults),
	checks: wireAbsentOptional(wireRecord(isEntry)),
	overrides: wireAbsentOptional(wireRecord(isEntry)),
	coverage_ratchet: wireAbsentOptional(isCoverage),
	mutation_gate: wireAbsentOptional(isMutation),
});
