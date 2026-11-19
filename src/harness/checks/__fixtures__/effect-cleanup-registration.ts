import { describe, it, type TestContext } from "vitest";
import type { checkMissingEffectCleanup } from "../missing-effect-cleanup.js";

export type EffectCleanupCheck = typeof checkMissingEffectCleanup;
export type EffectCleanupCases = Record<string, (check: EffectCleanupCheck) => void>;
type ScenarioGroups = Record<string, Record<string, () => void>>;

export function bindEffectCleanupCases(cases: EffectCleanupCases, check: EffectCleanupCheck): Record<string, () => void> {
	const bound: Record<string, () => void> = {};
	for (const [name, run] of Object.entries(cases)) bound[name] = run.bind(undefined, check);
	return bound;
}

/** The discoverable files retain literal test names for the check-evidence and mutation tools. */
export function namedEffectCleanupCase(groups: ScenarioGroups): (context: TestContext) => void {
	return ({ task }) => {
		const run = groups[task.suite?.name ?? ""]?.[task.name];
		if (!run) throw new Error(`Effect cleanup scenario missing for ${task.name}`);
		run();
	};
}

/** Run the same assertions with the fallback backend selected by the caller. */
export function registerEffectCleanupScenarios(groups: ScenarioGroups): void {
	for (const [suite, cases] of Object.entries(groups)) {
		describe(suite, () => {
			for (const [title, run] of Object.entries(cases)) it(title, run);
		});
	}
}
