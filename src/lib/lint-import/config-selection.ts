import { statSync } from "node:fs";
import { LINT_ADAPTERS } from "./adapters.js";
import { lintPath, normalizedLintPath } from "./policy.js";
import type { LintImportEntry } from "./types.js";

export interface ConfigSelection { config?: string[]; scope?: string; cadence?: string }

export function explicitLintConfigs(root: string, options: ConfigSelection): LintImportEntry[] {
    const configs = options.config ?? [];
    if (options.scope !== undefined && configs.length === 0) throw new Error("--scope requires --config");
    const scope = normalizedLintPath(root, options.scope ?? ".");
    if (!statSync(lintPath(root, scope)).isDirectory()) throw new Error("Lint scope must be a directory");
    const cadence = options.cadence;
    if (cadence !== undefined && cadence !== "hook" && cadence !== "audit") throw new Error("--cadence must be hook or audit");
    return configs.map((selection) => {
        const separator = selection.indexOf("=");
        const tool = selection.slice(0, separator);
        if (separator < 1 || !LINT_ADAPTERS[tool]?.configFlag) throw new Error("--config requires tool=file for an adapter with explicit config support");
        const config = normalizedLintPath(root, selection.slice(separator + 1));
        return { tool, scope, config, sources: [config], cadence: cadence ?? LINT_ADAPTERS[tool]?.cadence ?? "hook" };
    });
}
