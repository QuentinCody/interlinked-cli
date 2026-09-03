// ===========================================
// Project Graph — Import Path Resolution
// ===========================================
// Maps import specifiers to absolute file paths, mirroring Node's resolver
// plus TypeScript's path-alias extensions. Extracted from project-graph.ts
// so structural checks can reuse the logic without dragging in the graph.

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/**
 * Resolve a bare (node_modules-style) specifier via tsconfig path aliases.
 * Extracted from resolveImportPath so the alias-matching loop restarts at
 * nesting depth 0 (2026-09 cognitive-complexity flattening).
 * Returns null when no alias/target combination resolves to a real file —
 * including when no tsconfigPaths were supplied at all.
 */
function resolveBareSpecifier(
	fromFile: string,
	specifier: string,
	tsconfigPaths?: Record<string, string[]>,
): string | null {
	if (!tsconfigPaths) return null;
	for (const [alias, targets] of Object.entries(tsconfigPaths)) {
		const pattern = alias.replace("/*", "");
		if (!specifier.startsWith(pattern)) continue;
		// Strip the leading "/" from the remainder: path.resolve treats an
		// absolute segment as a restart, so "@lib/util" → rest "/util"
		// discarded everything before it and every suffixed alias
		// specifier resolved to null (wave-9 find, 2026-08-17).
		const rest = specifier.slice(pattern.length).replace(/^\//, "");
		for (const target of targets) {
			const base = target.replace("/*", "");
			const candidate = resolve(dirname(fromFile), "..", base, rest);
			const resolved = tryResolveFile(candidate);
			if (resolved) return resolved;
		}
	}
	return null;
}

/**
 * Public API — consumed by ProjectGraph.indexFile and structural-checks.
 *
 * Resolve a relative import specifier to an absolute file path.
 * Returns null for node_modules imports (non-relative specifiers).
 */
export function resolveImportPath(
	fromFile: string,
	specifier: string,
	tsconfigPaths?: Record<string, string[]>,
): string | null {
	// Skip node_modules imports (bare specifiers)
	if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
		return resolveBareSpecifier(fromFile, specifier, tsconfigPaths);
	}

	const baseDir = dirname(fromFile);
	const candidate = resolve(baseDir, specifier);
	return tryResolveFile(candidate);
}

/**
 * Public API — consumed by resolveImportPath and ProjectGraph.
 *
 * Try resolving a path by appending extensions or /index.
 * Handles .js → .ts/.tsx mapping used by ESM TypeScript projects.
 */
export function tryResolveFile(candidate: string): string | null {
	// Exact match (already has extension — includes .json, .ts, etc.)
	if (existsSync(candidate) && statSync(candidate).isFile()) {
		return candidate;
	}

	// Handle .js → .ts/.tsx mapping (common in ESM TypeScript projects)
	if (candidate.endsWith(".js")) {
		const tsCandidate = `${candidate.slice(0, -3)}.ts`;
		if (existsSync(tsCandidate)) return tsCandidate;
		const tsxCandidate = `${candidate.slice(0, -3)}.tsx`;
		if (existsSync(tsxCandidate)) return tsxCandidate;
	}
	if (candidate.endsWith(".mjs")) {
		const mtsCandidate = `${candidate.slice(0, -4)}.mts`;
		if (existsSync(mtsCandidate)) return mtsCandidate;
	}

	// Try extensions
	for (const ext of RESOLVE_EXTENSIONS) {
		const withExt = candidate + ext;
		if (existsSync(withExt)) return withExt;
	}

	// Try /index
	for (const ext of RESOLVE_EXTENSIONS) {
		const indexPath = join(candidate, `index${ext}`);
		if (existsSync(indexPath)) return indexPath;
	}

	return null;
}
