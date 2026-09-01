// Export ripple check (detects changes to frequently-imported modules).
// Extracted from generic-checks.ts.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch } from "./shared.js";
import { extractModuleExportNames } from "./swift.js";

// ===========================================
// Check: Export Ripple
// ===========================================

/**
 * After an export signature changes, check if files that import from this file
 * still reference symbols that actually exist in the current exports.
 *
 * Uses `git ls-files` to find project files, then checks for imports from the
 * current file. For each importer, validates that imported names exist in
 * the file's current exports.
 *
 * Returns InlineMatch[] for each broken import reference, with the importer
 * file path in the match text.
 */
// Cache git ls-files results per project root (avoids 1 subprocess per file)
const _gitFilesCache = new Map<string, { files: string[]; timestamp: number }>();
const GIT_FILES_CACHE_TTL = 30_000; // 30 seconds

/**
 * List tracked + untracked (but not ignored) source files via `git ls-files`.
 * Exported so other check modules (e.g. agent-safety's dead-export check) can
 * reuse the same 30s-cached lookup without spawning git per file.
 */
export function getGitSourceFiles(cwd: string): string[] {
	const cached = _gitFilesCache.get(cwd);
	if (cached && Date.now() - cached.timestamp < GIT_FILES_CACHE_TTL) {
		return cached.files;
	}
	try {
		const raw = execFileSync(
			"git",
			["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{ cwd, encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
		);
		const files = raw
			.split("\0")
			.filter(Boolean)
			.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
		_gitFilesCache.set(cwd, { files, timestamp: Date.now() });
		return files;
	} catch {
		return [];
	}
}

/** Invariant identity of the module under test, threaded through per-importer scans. */
interface RippleTarget {
	readonly cwd: string;
	readonly noExt: string;
	readonly baseName: string;
	readonly currentExports: Set<string>;
}

/**
 * Scan one importer file's lines for named imports of `target`'s module that
 * reference a name no longer in `target.currentExports`.
 *
 * `startCount` is the number of matches already accumulated across earlier
 * importers (the caller's `matches.length` at call time). Checking
 * `startCount + found.length >= 15` at the top of each line iteration
 * reproduces the original inline loop's shared `matches.length >= 15` break
 * exactly — including that a single line's named imports are never
 * mid-line-capped, only checked at the next line boundary.
 */
function collectImporterMatches(
	importerRel: string,
	importerContent: string,
	target: RippleTarget,
	startCount: number,
): InlineMatch[] {
	const { cwd, noExt, baseName, currentExports } = target;
	const importerLines = importerContent.split("\n");
	const importerDir = dirname(join(cwd, importerRel));
	const found: InlineMatch[] = [];

	for (const [i, importerLine] of importerLines.entries()) {
		if (startCount + found.length >= 15) break;
		const trimmed = importerLine.trim();

		// Match: import { A, B, C } from "..." or import type { A } from "..."
		const importMatch = trimmed.match(
			/^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/,
		);
		if (!importMatch) continue;

		const specifier = nonNull(importMatch[2]);
		// Only check relative imports
		if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;

		// Resolve the import specifier relative to the importer's directory
		// to verify it actually points to our file (not a different file with the same basename)
		const specBase = specifier.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, "");
		const specTail = specBase.split("/").pop() || "";
		if (specTail !== baseName) continue;

		// Resolve the full path and check if it's actually our target file
		const resolvedImport = resolve(importerDir, specBase);
		const targetNoExt = resolve(cwd, noExt);
		if (resolvedImport !== targetNoExt) continue;

		// Parse named imports
		const namedImports = nonNull(importMatch[1])
			.split(",")
			.map((n) => {
				const parts = n.trim().split(/\s+as\s+/);
				return nonNull(parts[0]).trim().replace(/^type\s+/, ""); // Strip inline type prefix and 'as' alias
			})
			.filter((n) => n.length > 0);

		// Check each imported name against current exports
		for (const name of namedImports) {
			if (!currentExports.has(name)) {
				found.push({
					line: 0,
					text: `${importerRel}:${i + 1} imports "${name}" which no longer exists in exports`,
				});
			}
		}
	}

	return found;
}

export function checkExportRipple(content: string, filePath: string, cwd: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return [];
	if (filePath.endsWith(".d.ts")) return [];

	// Step 1: Parse all exports from current file content
	const currentExports = new Set(extractModuleExportNames(content));
	if (currentExports.size === 0) return [];

	// Step 2: Determine what import paths would reference this file
	const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const relFromRoot = relative(cwd, absPath);
	// Build search key from the filename without extension
	const noExt = relFromRoot.replace(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/, "");
	const baseName = noExt.split("/").pop() || "";
	if (!baseName) return [];

	// Step 3: Find files that import from this module (uses cached git ls-files)
	const allFiles = getGitSourceFiles(cwd).filter((f) => f !== relFromRoot);
	let importerFiles: string[];
	try {
		// Fast filter: only files that reference this module's basename
		importerFiles = allFiles.filter((f) => {
			try {
				const importerContent = readFileSync(join(cwd, f), "utf-8");
				return (
					importerContent.includes(`'${baseName}'`) ||
					importerContent.includes(`"${baseName}"`) ||
					importerContent.includes(`'${baseName}.js'`) ||
					importerContent.includes(`"${baseName}.js"`) ||
					importerContent.includes(`'${baseName}.ts'`) ||
					importerContent.includes(`"${baseName}.ts"`)
				);
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}

	if (importerFiles.length === 0) return [];

	// Step 4: For each importer, parse its imports and check against current exports
	const target: RippleTarget = { cwd, noExt, baseName, currentExports };
	const matches: InlineMatch[] = [];

	for (const importerRel of importerFiles) {
		if (matches.length >= 15) break;
		let importerContent: string;
		try {
			importerContent = readFileSync(join(cwd, importerRel), "utf-8");
		} catch {
			continue;
		}

		matches.push(...collectImporterMatches(importerRel, importerContent, target, matches.length));
	}

	return matches;
}
