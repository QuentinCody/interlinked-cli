// ===========================================
// Import Checks
// ===========================================
// Tier 1 validations on import relationships: resolution, duplicates,
// dead imports, hallucinated packages, and cross-package boundary violations.

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { nonNull } from "../../lib/non-null.js";
import type { ProjectGraph } from "../project-graph.js";
import type { ExportedSymbol, ImportEdge, StructuralCheckResult } from "../types.js";
import { escapeRegex } from "./helpers.js";
import {
	collectDeclaredDeps,
	findCrossPackageBoundary,
	loadNearestPackageJson,
} from "./package-json-boundary.js";

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 1: Verify all imports in the edited file resolve to existing files and exports.
 */
export function checkImportResolution(
	filePath: string,
	relPath: string,
	graph: ProjectGraph,
): StructuralCheckResult[] {
	const results: StructuralCheckResult[] = [];
	const edges = graph.getDependencies(filePath);

	for (const edge of edges) {
		// Skip node_modules imports (no toFile means unresolved bare specifier)
		if (!edge.toFile) continue;

		// Skip JSON imports — they always provide a default export, not in our TS/JS graph
		if (edge.specifier.endsWith(".json")) continue;

		// Skip deep node_modules paths (e.g., ../node_modules/@scope/pkg/dist/file.js)
		if (edge.toFile.includes("/node_modules/")) continue;

		// Check file exists
		if (!existsSync(edge.toFile)) {
			results.push({
				check: "import_resolution",
				severity: "error",
				message: `Broken import in ${relPath}: \`${edge.specifier}\` resolves to ${graph.toRelative(edge.toFile)} which does not exist.`,
				file: filePath,
				affectedFiles: [edge.toFile],
			});
			continue;
		}

		// Check imported symbols exist in the target's exports
		results.push(...checkImportedSymbolsExist(edge, filePath, relPath, graph));
	}

	return results;
}

/**
 * The subset of `edge.symbols` not found in the target file's exports (`"default"` is
 * always allowed, covering default imports), one finding per missing symbol. Returns
 * `[]` when the edge imports no named symbols — same as the caller's prior `if
 * (edge.symbols.length > 0)` guard.
 */
function checkImportedSymbolsExist(
	edge: ImportEdge,
	filePath: string,
	relPath: string,
	graph: ProjectGraph,
): StructuralCheckResult[] {
	if (edge.symbols.length === 0) return [];
	const targetExports = graph.getExports(edge.toFile);
	const targetNames = new Set(targetExports.map((e) => e.name));
	targetNames.add("default");

	const results: StructuralCheckResult[] = [];
	for (const sym of edge.symbols) {
		if (targetNames.has(sym)) continue;
		results.push({
			check: "import_resolution",
			severity: "warning",
			message: `${relPath} imports \`${sym}\` from \`${edge.specifier}\`, but ${graph.toRelative(edge.toFile)} does not export it.`,
			file: filePath,
			affectedFiles: [edge.toFile],
		});
	}
	return results;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 1: Warn when a new export collides with an existing symbol name (boundary-aware).
 */
export function checkDuplicateSymbols(
	filePath: string,
	relPath: string,
	oldExports: ExportedSymbol[],
	graph: ProjectGraph,
	boundary?: string,
): StructuralCheckResult[] {
	const results: StructuralCheckResult[] = [];
	const newExports = graph.getExports(filePath);
	const oldNames = new Set(oldExports.map((e) => e.name));

	// Only check newly added exports
	const addedExports = newExports.filter(
		(e) => !oldNames.has(e.name) && e.name !== "default" && e.name !== "*" && !e.isTypeOnly,
	);

	for (const added of addedExports) {
		const duplicates = graph.findDuplicateExports(added.name, filePath, boundary);
		if (duplicates.length > 0) {
			const dupList = duplicates
				.slice(0, 3)
				.map((d) => graph.toRelative(d))
				.join(", ");
			results.push({
				check: "duplicate_symbols",
				severity: "warning",
				message: `New export \`${added.name}\` in ${relPath} collides with existing export in: ${dupList}. Consider using the existing one or choosing a distinct name.`,
				file: filePath,
				affectedFiles: duplicates,
			});
		}
	}

	return results;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 1: Detect unused imports after editing a file.
 */
export function checkDeadImports(
	filePath: string,
	relPath: string,
	deadCodeAction?: "flag" | "delete",
): StructuralCheckResult[] {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}

	const lines = content.split("\n");
	const { importBindings, lastImportLine } = collectImportBindings(lines);

	if (importBindings.length === 0) return [];

	// Get file body after imports
	const body = lines.slice(lastImportLine + 1).join("\n");
	const deadBindings: string[] = [];

	for (const { name } of importBindings) {
		if (!name || name.length < 2) continue;
		const regex = new RegExp(`\\b${escapeRegex(name)}\\b`);
		if (!regex.test(body)) {
			deadBindings.push(name);
		}
	}

	if (deadBindings.length === 0) return [];

	return [
		{
			check: "dead_imports",
			severity: "warning",
			message:
				`Unused imports in ${relPath}: \`${deadBindings.join("`, `")}\`. Remove them to reduce dependencies.` +
				(deadCodeAction === "delete"
					? ' Action: dead_code_action is "delete" — remove the unused binding(s) in this edit, or justify keeping them with a comment.'
					: ""),
			file: filePath,
		},
	];
}

/**
 * Scan a file's leading import section, collecting the local names bound by
 * each import statement. Stops at the first non-import, non-blank,
 * non-comment line (prevents matching import-like text inside string
 * literals, template HTML, or generated scripts further down the file).
 * Returns the last line index that was part of the import section so the
 * caller can slice the remaining body.
 */
function collectImportBindings(lines: string[]): {
	importBindings: Array<{ name: string }>;
	lastImportLine: number;
} {
	const importBindings: Array<{ name: string }> = [];
	let lastImportLine = 0;
	let buffer = "";
	let importSectionEnded = false;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = nonNull(lines[i]).trim();

		// Handle multiline imports
		if (buffer) {
			buffer = appendMultilineImport(trimmed, buffer, importBindings);
			lastImportLine = i;
			continue;
		}
		// Stop scanning once we hit non-import code (prevents matching imports
		// inside string literals, template HTML, generated scripts, etc.)
		if (importSectionEnded) continue;
		if (
			trimmed === "" ||
			trimmed.startsWith("//") ||
			trimmed.startsWith("*") ||
			trimmed.startsWith("/*") ||
			trimmed.startsWith("*/")
		)
			continue;
		if (/^import\s/.test(trimmed) && trimmed.includes("{") && !trimmed.includes("}")) {
			buffer = trimmed;
			lastImportLine = i;
			continue;
		}
		if (/^import\s/.test(trimmed)) {
			processImportLine(trimmed, importBindings);
			lastImportLine = i;
			continue;
		}
		// Non-import, non-blank line — import section is over
		importSectionEnded = true;
	}
	if (buffer) processImportLine(buffer, importBindings);

	return { importBindings, lastImportLine };
}

/**
 * Append one line to a buffered multi-line import statement (an `import { ... }`
 * that opened a brace on an earlier line) and flush it via {@link processImportLine}
 * once the buffer reaches its terminating quote — the same completion signal for
 * both a `from '...'` clause and a bare re-export string literal. Returns the
 * flushed (empty) buffer, or the still-accumulating buffer when not yet complete.
 */
function appendMultilineImport(
	trimmed: string,
	buffer: string,
	importBindings: Array<{ name: string }>,
): string {
	const next = `${buffer} ${trimmed}`;
	if (/from\s+['"]/.test(next) || /['"]/.test(next)) {
		processImportLine(next, importBindings);
		return "";
	}
	return next;
}

/** Extract local binding names from an import statement line. */
function processImportLine(line: string, bindings: Array<{ name: string }>): void {
	const trimmed = line.trim();
	if (trimmed.startsWith("//")) return;

	// Side-effect: import 'module'
	if (/^import\s+['"]/.test(trimmed)) return;

	// Namespace: import * as name — skip (used as name.X, hard to check reliably)
	if (/^import\s+\*\s+as\s/.test(trimmed)) return;

	// Named: import { a, b as c } from '...'  or  import type { ... }
	const namedMatch = trimmed.match(/^import\s+(?:type\s+)?\{([^}]+)\}/);
	if (namedMatch) {
		const names = nonNull(namedMatch[1])
			.split(",")
			.map((s) => {
				const parts = s
					.trim()
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/);
				return nonNull(parts[parts.length - 1]).trim();
			})
			.filter(Boolean);
		for (const name of names) {
			if (name !== "type") {
				bindings.push({ name });
			}
		}
		return;
	}

	// Default: import Name from '...'
	const defaultMatch = trimmed.match(/^import\s+(?:type\s+)?(\w+)\s+from/);
	if (defaultMatch && defaultMatch[1] !== "type") {
		bindings.push({ name: nonNull(defaultMatch[1]) });
	}
}

// Built-in Node modules (used by checkHallucinatedImports)
const BUILTIN_MODULES = new Set([
	"assert",
	"buffer",
	"child_process",
	"cluster",
	"console",
	"constants",
	"crypto",
	"dgram",
	"dns",
	"domain",
	"events",
	"fs",
	"http",
	"https",
	"module",
	"net",
	"os",
	"path",
	"perf_hooks",
	"process",
	"punycode",
	"querystring",
	"readline",
	"repl",
	"stream",
	"string_decoder",
	"sys",
	"timers",
	"tls",
	"tty",
	"url",
	"util",
	"v8",
	"vm",
	"wasi",
	"worker_threads",
	"zlib",
	"node:fs",
	"node:path",
	"node:child_process",
	"node:crypto",
	"node:os",
	"node:url",
	"node:util",
	"node:stream",
	"node:events",
	"node:buffer",
	"node:http",
	"node:https",
	"node:net",
	"node:readline",
	"node:tls",
	"node:zlib",
	"node:worker_threads",
	"node:assert",
	"node:dns",
	"node:perf_hooks",
	"node:process",
	"node:querystring",
	"node:timers",
	"node:vm",
	"node:test",
]);

/**
 * Bare-specifier package name to check against declared deps, or `null` when
 * this edge should be skipped entirely: relative/absolute specifiers,
 * path-alias prefixes (`@/`, `#`, `~/`), and specifiers already resolved into
 * `node_modules`. Scoped packages (`@scope/pkg/deep/path`) collapse to
 * `@scope/pkg`; unscoped deep imports (`lodash/fp`) collapse to `lodash`.
 */
function resolveBarePackageName(edge: ImportEdge): string | null {
	const spec = edge.specifier;
	// Skip relative, absolute, already-resolved paths, and path aliases (@/, #, ~/)
	if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
	if (spec.startsWith("@/") || spec.startsWith("#") || spec.startsWith("~/")) return null;
	// Skip if it resolves to a node_modules path (already found)
	// Real edges always set `toFile` to `""` (never undefined) when a
	// specifier is unresolved — see project-graph.ts's `toFile: toFile || ""`
	// — so the declared required `string` type is honest for real usage.
	if (edge.toFile.includes("/node_modules/")) return null;

	// Extract package name (handle scoped packages)
	return spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : nonNull(spec.split("/")[0]);
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 1: Detect bare-specifier imports not found in package.json dependencies.
 */
export function checkHallucinatedImports(
	filePath: string,
	relPath: string,
	graph: ProjectGraph,
): StructuralCheckResult[] {
	const results: StructuralCheckResult[] = [];
	const edges = graph.getDependencies(filePath);

	const pkgJson = loadNearestPackageJson(filePath);
	if (!pkgJson) return [];

	const allDeps = collectDeclaredDeps(pkgJson);

	for (const edge of edges) {
		const spec = edge.specifier;
		const pkgName = resolveBarePackageName(edge);
		if (pkgName === null) continue;

		if (BUILTIN_MODULES.has(spec) || BUILTIN_MODULES.has(pkgName)) continue;
		if (allDeps.has(pkgName)) continue;

		results.push({
			check: "hallucinated_imports",
			severity: "warning",
			message: `${relPath} imports "${spec}" but "${pkgName}" is not in package.json dependencies. Is this a typo or missing dependency?`,
			file: filePath,
		});
	}

	return results;
}

/**
 * Public API — consumed by structural-checks.runStructuralChecks.
 *
 * Tier 1: Detect relative imports that cross a package.json boundary.
 */
export function checkCrossPackageImports(
	filePath: string,
	relPath: string,
	graph: ProjectGraph,
): StructuralCheckResult[] {
	const results: StructuralCheckResult[] = [];
	const edges = graph.getDependencies(filePath);
	const fileDir = dirname(filePath);

	for (const edge of edges) {
		if (!edge.specifier.startsWith(".") || !edge.toFile) continue;
		// Check if there's a package.json between the importing file and the imported file
		const targetDir = dirname(edge.toFile);
		if (targetDir === fileDir) continue;

		// Walk from fileDir toward targetDir looking for package.json boundaries
		const boundaryDir = findCrossPackageBoundary(filePath, fileDir, edge.specifier);
		if (boundaryDir === null) continue;

		results.push({
			check: "cross_package_imports",
			severity: "warning",
			message: `${relPath} uses relative import "${edge.specifier}" which crosses a package.json boundary at ${graph.toRelative(boundaryDir)}. Use the package name instead.`,
			file: filePath,
		});
	}

	return results;
}
