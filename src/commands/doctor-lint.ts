import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkLintSources, LINT_POLICY_PATH, loadLintPolicy } from "../lib/lint-import/policy.js";
import { prepareLintImport } from "../lib/lint-import/selection.js";
import type { CheckResult } from "./doctor-check-types.js";

export function lintAdoptionChecks(cwd: string): CheckResult[] {
    try {
        if (existsSync(join(cwd, LINT_POLICY_PATH))) {
            const policy = loadLintPolicy(cwd);
            if (!policy) return [];
            checkLintSources(cwd, policy);
            return [{ name: "Lint adoption", status: "pass", message: `${policy.entries.length} imported lint scopes; use interlinked lint check to measure current findings` }];
        }
        const { inventory, policy } = prepareLintImport(cwd, {});
        if (inventory.sources.length === 0 && inventory.complete) return [];
        const count = policy.entries.length;
        return [{ name: "Lint adoption", status: "warn", message: `${inventory.sources.length} lint sources detected (${count} importable scopes). Preview: interlinked lint import; apply: interlinked lint import --write --baseline${inventory.complete ? "" : "; discovery incomplete — inspect lint scan --json"}` }];
    } catch (error) {
        return [{ name: "Lint adoption", status: "warn", message: error instanceof Error ? error.message : String(error) }];
    }
}
