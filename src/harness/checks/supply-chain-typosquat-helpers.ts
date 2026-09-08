// Helpers extracted from supply-chain.ts (per-file line cap) for
// `checkTyposquatDependencies`. Pure, behavior-preserving extraction — no
// logic changes.

import { existsSync, readFileSync } from "node:fs";
import { isJsonObject } from "../../lib/json-types.js";
import { stringDependencies } from "./package-dependencies.js";
import type { InlineMatch } from "./shared.js";

/**
 * Read + parse a package.json into its raw content and merged dep-name map.
 * Returns null on any missing/unreadable/unparsable file (mirrors the
 * original inline existsSync + try/catch guards).
 */
export function parsePackageJsonDeps(
	pkgJsonPath: string,
): { content: string; allDeps: Record<string, string> } | null {
	if (!existsSync(pkgJsonPath)) return null;
	try {
		const content = readFileSync(pkgJsonPath, "utf-8");
		const pkg: unknown = JSON.parse(content);
		if (!isJsonObject(pkg)) return null;
		const allDeps: Record<string, string> = {
			...stringDependencies(pkg.dependencies),
			...stringDependencies(pkg.devDependencies),
		};
		return { content, allDeps };
	} catch {
		return null;
	}
}

/**
 * Check one dependency name against every popular package for a near-miss
 * Levenshtein match, returning the first hit (or null). Isolates the inner
 * scoring loop so the orchestrator only carries the outer per-dep decisions.
 */
export function findTyposquatForDep(
	dep: string,
	lines: readonly string[],
	scoring: {
		popularPackages: ReadonlySet<string>;
		levenshtein: (a: string, b: string) => number;
	},
): InlineMatch | null {
	const { popularPackages, levenshtein } = scoring;
	for (const popular of popularPackages) {
		if (dep === popular) break;
		const dist = levenshtein(dep.toLowerCase(), popular.toLowerCase());
		if (dist > 0 && dist <= 2 && dep.length >= 3) {
			const lineIdx = lines.findIndex((l) => l.includes(`"${dep}"`));
			return {
				line: lineIdx >= 0 ? lineIdx + 1 : 1,
				text: `Possible typosquat: "${dep}" is ${dist} character${dist > 1 ? "s" : ""} away from popular package "${popular}". Verify this is the intended package.`,
			};
		}
	}
	return null;
}
