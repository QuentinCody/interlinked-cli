// Shared helpers used by all check modules.
// Extracted from generic-checks.ts. These are internal to the checks/ package.

/** A single match found by an inline check. Public API — re-exported by generic-checks.ts. */
export interface InlineMatch {
	/** 1-based line number */
	line: number;
	/** Trimmed text of the matching line (truncated to 150 chars) */
	text: string;
}

/**
 * JS/TS extension set (includes .mts/.cts). Used across many checks.
 * Prefer JS_TS_ALL_EXTS (array) when you need `Array.includes`.
 */
export const JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** JS/TS extension array — same values as JS_TS_EXTS but ordered for `.includes()`. */
export const JS_TS_ALL_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"];

// Function-signature/parameter-count helpers and vendored/script path
// heuristics moved to shared-path-heuristics.ts; re-exported below.
export {
	collectFunctionSignature,
	countTopLevelCommas,
	isScriptOrCliPath,
	isVendoredOrFixturePath,
} from "./shared-path-heuristics.js";

// Test-file / harness-internal-data-file classification moved to
// shared-test-classification.ts; re-exported below.
export {
	__setPackageRootForTesting,
	isPatternDataFile,
	isStrictTestFile,
	isTestFile,
	isTestSourcePath,
} from "./shared-test-classification.js";

/**
 * Check if a file is a CLI entry point or command file.
 * These files use console.log as their primary output method.
 * Path-agnostic: works for any project structure.
 */
export function isCliFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	// CLI command directories (convention across many frameworks)
	if (normalized.includes("/commands/")) return true;
	if (normalized.includes("/cmd/")) return true;
	// Bin directories
	if (normalized.includes("/bin/")) return true;
	// Entry points named index/main/cli in typical CLI locations
	const basename = normalized.split("/").pop() || "";
	if (/^(main|cli|index)\.(ts|js|mjs|py|go|rs)$/.test(basename)) {
		// Only skip if it's in a recognizable CLI/bin/src root — not deeply nested library code
		if (
			normalized.includes("/cli/") ||
			normalized.includes("/bin/") ||
			normalized.includes("/cmd/") ||
			// Top-level entry points (e.g., src/main.ts, src/index.ts)
			/\/src\/[^/]+$/.test(normalized)
		) {
			return true;
		}
	}
	return false;
}

// Generator-output detection and Bandit/eslint-noqa suppression respect
// moved to shared-generated-and-suppression.ts; re-exported below.
export {
	isGeneratedFile,
	lineHasNoqaSuppression,
} from "./shared-generated-and-suppression.js";

// ===========================================
// Internal Helpers
// ===========================================

/** Extract file extension (lowercase, with dot) */
export function getExtension(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return "";
	return filePath.slice(dot).toLowerCase();
}


// Re-export the code-shape scanners moved to shared-scan.ts so existing
// importers (and the smoke test) keep resolving them from this module.
export { findEnclosingScope, isTypeOnlyModule } from "./shared-scan.js";
// ===========================================
// Comment & String Stripping Helpers (delegated to shared-text-utils.ts)
// ===========================================
export {
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
	stripForBraceScan,
	stripStrings,
} from "./shared-text-utils.js";
