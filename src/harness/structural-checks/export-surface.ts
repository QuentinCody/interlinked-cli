import { hasErrorCode } from "../check-engine/tool-errors.js";
// ===========================================
// Export Surface & Ripple Checks
// ===========================================
// Tier 1 check: detect removed/renamed exports and the importers they break.
// Tier 3 ripple check: re-run tsc + vitest on the affected importers to make
// sure the change didn't silently break anything downstream.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { getOrCreateEngine } from "../check-engine/index.js";
import type { ProjectGraph } from "../project-graph.js";
import type { ExportedSymbol, StructuralCheckResult } from "../types.js";
import { exportSurfaceChanged } from "./helpers.js";

/** Maximum number of affected files to type-check during ripple (keeps it fast) */
const RIPPLE_MAX_FILES = 5;
/** Maximum time for the entire ripple tsc check (ms) */
const RIPPLE_TSC_TIMEOUT_MS = 5_000;

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 1: Detect removed/renamed exports and warn about affected importers.
 */
export function checkExportSurface(
	filePath: string,
	relPath: string,
	oldExports: ExportedSymbol[],
	graph: Pick<ProjectGraph, "getExports" | "getDependents" | "getImporters" | "classifyModule" | "getProjectBoundary" | "toRelative">,
): StructuralCheckResult[] {
	const newExports = graph.getExports(filePath);
	if (!exportSurfaceChanged(oldExports, newExports)) return [];

	const results: StructuralCheckResult[] = [];

	// Find removed exports
	const newNames = new Set(newExports.map((e) => e.name));
	const removedExports = oldExports.filter((e) => !newNames.has(e.name) && e.name !== "*");

	if (removedExports.length === 0) {
		// Exports were added, not removed — no breakage risk
		return [];
	}

	const dependents = graph.getDependents(filePath);
	if (dependents.length === 0) return [];

	// Check which dependents actually import the removed symbols
	const affectedFiles: string[] = [];
	const importers = graph.getImporters(filePath);
	for (const edge of importers) {
		const usesRemoved = edge.symbols.some((s) => removedExports.some((e) => e.name === s));
		if (usesRemoved || edge.symbols.length === 0) {
			// symbols.length === 0 means namespace/wildcard import — always affected
			affectedFiles.push(edge.fromFile);
		}
	}

	if (affectedFiles.length > 0) {
		const role = graph.classifyModule(filePath);
		const removedNames = removedExports.map((e) => e.name).join(", ");
		const fileList = affectedFiles
			.slice(0, 6)
			.map((f) => graph.toRelative(f))
			.join(", ");
		const more = affectedFiles.length > 6 ? ` and ${affectedFiles.length - 6} more` : "";
		// A removed export breaks its importers regardless of module role, so
		// every export-surface removal is an error (hubs only differ in the
		// "(hub module)" message annotation below).
		const severity = "error";

		results.push({
			check: "export_surface",
			severity,
			message: `Removed export(s) \`${removedNames}\` from ${relPath}${role === "hub" ? " (hub module)" : ""}. These files import them: ${fileList}${more}. Update or remove the stale imports.`,
			file: filePath,
			affectedFiles,
		});
	}

	return results;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 3: When export surface changes, run tsc on affected importers to verify
 * they still compile. Only runs when `checkExportSurface` found affected files.
 * Results are advisory warnings (the edit already happened).
 */
export function checkExportRippleCompilation(
	filePath: string,
	relPath: string,
	affectedFiles: string[],
	graph: Pick<ProjectGraph, "getExports" | "getDependents" | "getImporters" | "classifyModule" | "getProjectBoundary" | "toRelative">,
): StructuralCheckResult[] {
	if (affectedFiles.length === 0) return [];

	const results: StructuralCheckResult[] = [];

	// Limit to first N files for speed
	const filesToCheck = affectedFiles.slice(0, RIPPLE_MAX_FILES);

	// Use the graph's project boundary (nearest sub-project root for this file)
	const projectRoot = graph.getProjectBoundary(filePath);
	const engine = getOrCreateEngine(projectRoot);

	// Check if tsc is available
	const available = engine.discoverTools();
	if (!available.find((t) => t.id === "tsc")?.available) return [];

	const brokenFiles: Array<{ file: string; errors: number }> = [];
	for (const affectedFile of filesToCheck) {
		// runTsc owns compiler admission. An outer lease here deadlocks the
		// nested call and can turn a deferred compiler into a false-clean ripple.
		const report = engine.runChecks(
			{
				projectRoot: engine.projectRoot,
				mode: "file",
				targetFile: affectedFile,
				filterToFile: true,
			},
			{ tools: ["tsc"], timeoutMs: RIPPLE_TSC_TIMEOUT_MS },
		);

		if (report.results.some((result) => result.ruleId === "tsc-unavailable")) {
			return [
				{
					check: "export_ripple_compilation_deferred",
					severity: "info",
					message: `Deferred TypeScript ripple verification for ${relPath}: the compiler was unavailable.`,
					file: filePath,
					affectedFiles: filesToCheck,
				},
			];
		}

		const errorCount = report.results.filter((r) => r.severity === "error").length;
		if (errorCount > 0) {
			brokenFiles.push({ file: affectedFile, errors: errorCount });
		}
	}

	if (brokenFiles.length > 0) {
		const detail = brokenFiles
			.map((f) => `  ${graph.toRelative(f.file)}: ${f.errors} error(s)`)
			.join("\n");
		const skipped =
			affectedFiles.length > RIPPLE_MAX_FILES
				? `\n  (${affectedFiles.length - RIPPLE_MAX_FILES} more file(s) not checked)`
				: "";

		results.push({
			check: "export_ripple_compilation",
			severity: "warning",
			message: `Export change in ${relPath} broke ${brokenFiles.length} importer(s):`,
			file: filePath,
			detail: detail + skipped,
			affectedFiles: brokenFiles.map((f) => f.file),
		});
	}

	return results;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 3: When export surface changes, run the test file for the edited source
 * (if one exists) to catch regressions early. Only triggered when export
 * surface actually changed.
 */
export function checkRippleTests(
	filePath: string,
	relPath: string,
	graph: Pick<ProjectGraph, "getExports" | "getDependents" | "getImporters" | "classifyModule" | "getProjectBoundary" | "toRelative">,
): StructuralCheckResult[] {
	const testFile = findTestFileForSource(filePath);
	if (!testFile) return [];

	const results: StructuralCheckResult[] = [];
	const projectRoot = graph.getProjectBoundary(filePath);
	const relTest = relative(projectRoot, testFile);

	// Run vitest on the test file
	const spawnResult = spawnSync("npx", ["vitest", "run", relTest, "--reporter=verbose"], {
		shell: false,
		timeout: RIPPLE_TSC_TIMEOUT_MS,
		cwd: projectRoot,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});

	if (hasErrorCode(spawnResult.error, "ENOENT")) {
		// vitest not installed — skip silently
		return [];
	}

	if (spawnResult.status !== 0 && spawnResult.status !== null) {
		const output = (spawnResult.stdout || "").trim() || (spawnResult.stderr || "").trim();
		const lines = output.split("\n");
		const truncated = lines.slice(-8).join("\n");

		results.push({
			check: "export_ripple_tests",
			severity: "warning",
			message: `Tests failed for ${relPath} after export surface change (${graph.toRelative(testFile)}):`,
			file: filePath,
			detail: truncated,
			affectedFiles: [testFile],
		});
	}

	return results;
}

/**
 * Public API — consumed by checkRippleTests and structural-checks PreToolUse.
 *
 * Find the test file for a source file using TS/JS filename conventions.
 * Returns the absolute path to the test file, or null if none exists.
 */
export function findTestFileForSource(filePath: string): string | null {
	const ext = extname(filePath);
	const base = filePath.slice(0, -ext.length);
	const dir = dirname(filePath);
	const baseName = basename(filePath, ext);

	// Skip if the file IS a test file
	if (baseName.endsWith(".test") || baseName.endsWith(".spec")) return null;

	const candidates = [
		`${base}.test${ext}`,
		`${base}.spec${ext}`,
		join(dir, "__tests__", `${baseName}.test${ext}`),
		join(dir, "__tests__", `${baseName}.spec${ext}`),
	];

	return candidates.find((t) => existsSync(t)) || null;
}
