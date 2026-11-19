import { statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { inventoryPaths, type InventoryPaths } from "../../lib/metrics/inventory-paths.js";
import { hasErrorCode } from "./tool-errors.js";
import type { CheckOptions, CheckScope, SkipEntry, ToolAvailability, ToolId } from "./types.js";
import { rustfmtProjectScope } from "./tool-runners/rustfmt-project.js";

const LANGUAGE_EXTENSIONS = {
	rustfmt: new Set([".rs"]),
	"c-compile": new Set([".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".m", ".mm"]),
};
const LOCAL_INPUTS = { "docs-check": "scripts/check-docs.mjs" };
const DEPENDENCY_INPUTS = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "requirements.txt", "pyproject.toml", "poetry.lock", "Pipfile.lock", "uv.lock", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "pom.xml", "build.gradle", "build.gradle.kts", "gradle.lockfile", "packages.lock.json", "composer.lock", "Gemfile.lock"]);

function missingLocalInput(id: "docs-check", root: string): string | null {
	const path = LOCAL_INPUTS[id];
	try {
		return statSync(join(root, path)).isFile() ? null : `No project-local ${path}`;
	} catch (error) {
		// An unreadable input is unknown. Preserve the capability/error path.
		return hasErrorCode(error, "ENOENT") ? `No project-local ${path}` : null;
	}
}

/** Only a complete selected inventory can prove a language is inapplicable.
 * Root-local scripts/manifests never inherit applicability from another project. */
export function selectApplicableTools(tools: readonly ToolAvailability[], scope: CheckScope, options: Pick<CheckOptions, "resourcePolicy"> = {}): { applicable: ToolAvailability[]; skipped: SkipEntry[] } {
	const applicable: ToolAvailability[] = [];
	const skipped: SkipEntry[] = [];
	const inventory = tools.some(tool => tool.id === "dep-audit" || (scope.mode === "project" && tool.id in LANGUAGE_EXTENSIONS
		&& (tool.id !== "rustfmt" || options.resourcePolicy !== "foreground-verify"))) ? inventoryPaths(scope.projectRoot) : undefined;
	for (const tool of tools) {
		if (tool.id === "rustfmt" && scope.mode === "project") {
			const selected = rustfmtProjectScope(scope.projectRoot, options.resourcePolicy === "foreground-verify" ? undefined : inventory);
			if (selected.mode === "excluded") skipped.push({ check: tool.id, category: selected.category, reason: selected.reason });
			else if (selected.mode === "unavailable") skipped.push({ check: tool.id, category: "error", reason: selected.reason });
			else applicable.push(tool);
			continue;
		}
		const reason = inapplicabilityReason(tool.id, scope, inventory);
		if (reason) skipped.push({ check: tool.id, category: "file_type_mismatch", reason });
		else applicable.push(tool);
	}
	return { applicable, skipped };
}

function inapplicabilityReason(id: ToolId, scope: CheckScope, inventory: InventoryPaths | undefined): string | null {
	if (id === "docs-check") return missingLocalInput(id, scope.projectRoot);
	if (id === "dep-audit") {
		if (!inventory || inventory.issues.length > 0 || inventory.paths.some(path => DEPENDENCY_INPUTS.has(basename(path)))) return null;
		return "No selected supported dependency manifests or lockfiles";
	}
	if (id !== "rustfmt" && id !== "c-compile") return null;
	const extensions = LANGUAGE_EXTENSIONS[id];
	if (scope.mode === "file") return scope.targetFile && !extensions.has(extname(scope.targetFile).toLowerCase()) ? "Selected file has no matching language extension" : null;
	if (!inventory || inventory.issues.length > 0 || inventory.paths.some(path => extensions.has(extname(path).toLowerCase()))) return null;
	return `No selected ${id === "rustfmt" ? "Rust" : "C/C++"} source files`;
}

/** Explicit exclusions precede applicability. Unavailable installation semantics remain intact. */
export function selectToolsForRun(available: readonly ToolAvailability[], scope: CheckScope, options?: CheckOptions) {
	const selected = available.filter(tool => !options?.skipTools?.includes(tool.id));
	const selection = selectApplicableTools(selected, scope, options);
	const toolsToRun = selection.applicable.filter(tool => tool.available);
	const toolsSkipped = available.filter(tool => !toolsToRun.includes(tool));
	const skipped: SkipEntry[] = toolsSkipped.map(tool => {
		if (options?.skipTools?.includes(tool.id)) return { check: tool.id, category: "config_disabled", reason: "skipped by options" };
		return selection.skipped.find(row => row.check === tool.id) ?? {
			check: tool.id,
			reason: tool.probeError || tool.reason || (tool.available ? "skipped by options" : "not installed"),
			category: tool.probeError ? "error" : tool.available ? "config_disabled" : "tool_missing",
		};
	});
	return { toolsToRun, toolsSkipped, skipped };
}

export function projectToolInputMissing(id: ToolId, projectRoot: string): boolean {
	return selectApplicableTools([{ id, available: true }], { projectRoot, mode: "project" }).skipped.length > 0;
}
