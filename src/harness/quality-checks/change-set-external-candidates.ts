import { isAbsolute, relative, resolve } from "node:path";
import { configNameToToolId } from "../check-engine/index.js";
import type { ToolId } from "../check-engine/types.js";
import type { QualityCheckConfig } from "../types.js";
import { isLikelyTestFile } from "./test-classifier.js";

export const MULTI_FILE_NAMED_EXTERNAL_CHECKS = new Set([
	"affected_tests",
	"dependency_audit",
]);

const PROJECT_BATCH_TOOLS = new Set<ToolId>([
	"tsc",
	"biome",
	"eslint",
	"oxlint",
	"semgrep",
	"gitleaks",
	"mypy",
	"ruff",
	"ruff-format",
	"cargo-check",
	"cargo-clippy",
	"rustfmt",
	"go-build",
	"golangci-lint",
	"swiftlint",
	"swift-build",
	"lizard",
	"knip",
	"actionlint",
]);

export interface ExternalCandidate {
	readonly name: string;
	readonly check: QualityCheckConfig;
	readonly toolId: ToolId;
}

export interface NamedExternalCandidate {
	readonly name: string;
	readonly check: QualityCheckConfig;
}

export interface DeferredCheck {
	readonly name: string;
	readonly reason: string;
}

export function pathMatchesCheck(path: string, check: QualityCheckConfig): boolean {
	if (!check.file_types.some((suffix) => path.endsWith(suffix))) return false;
	if (!check.skip_test_files) return true;
	const absolute = isAbsolute(path) ? path : resolve(path);
	const base = absolute.slice(absolute.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
	return !isLikelyTestFile(base, absolute);
}

export function normalizeProjectPath(projectRoot: string, path: string): string {
	const absolute = isAbsolute(path) ? path : resolve(projectRoot, path);
	return relative(projectRoot, absolute).replace(/\\/g, "/");
}

export function uniquePaths(paths: readonly string[]): string[] {
	return [...new Set(paths.filter((path) => path.length > 0))];
}

type CheckClassification =
	| { readonly kind: "ignored" }
	| { readonly kind: "affected_tests" }
	| { readonly kind: "dependency_audit" }
	| { readonly kind: "deferred"; readonly reason: string }
	| { readonly kind: "batch"; readonly toolId: ToolId };

/** Decide what one configured check contributes, given the paths in the change set. */
function classifyCheck(
	name: string,
	check: QualityCheckConfig,
	paths: readonly string[],
): CheckClassification {
	if (!check.enabled) return { kind: "ignored" };
	if (!paths.some((path) => pathMatchesCheck(path, check))) return { kind: "ignored" };
	if (name === "affected_tests") return { kind: "affected_tests" };
	if (name === "dependency_audit") return { kind: "dependency_audit" };
	if (!check.command) return { kind: "ignored" };
	const toolId = configNameToToolId(name);
	if (!toolId || toolId === "dep-audit") return { kind: "ignored" };
	if (!PROJECT_BATCH_TOOLS.has(toolId)) {
		return {
			kind: "deferred",
			reason: "the configured runner is file-only and has no bounded multi-file mode",
		};
	}
	return { kind: "batch", toolId };
}

export function candidateChecks(options: {
	paths: readonly string[];
	checks: Record<string, QualityCheckConfig>;
}): {
	candidates: ExternalCandidate[];
	deferred: DeferredCheck[];
	affectedTests?: NamedExternalCandidate;
	dependencyAudit?: NamedExternalCandidate;
} {
	const candidates: ExternalCandidate[] = [];
	const deferred: DeferredCheck[] = [];
	let affectedTests: NamedExternalCandidate | undefined;
	let dependencyAudit: NamedExternalCandidate | undefined;
	const seenTools = new Set<ToolId>();
	for (const [name, check] of Object.entries(options.checks)) {
		const classified = classifyCheck(name, check, options.paths);
		if (classified.kind === "ignored") continue;
		if (classified.kind === "affected_tests") {
			affectedTests = { name, check };
			continue;
		}
		if (classified.kind === "dependency_audit") {
			dependencyAudit = { name, check };
			continue;
		}
		if (classified.kind === "deferred") {
			deferred.push({ name, reason: classified.reason });
			continue;
		}
		if (seenTools.has(classified.toolId)) continue;
		seenTools.add(classified.toolId);
		candidates.push({ name, check, toolId: classified.toolId });
	}
	return {
		candidates,
		deferred,
		...(affectedTests ? { affectedTests } : {}),
		...(dependencyAudit ? { dependencyAudit } : {}),
	};
}
