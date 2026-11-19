// process.env access-scope detector.
//
// The TS coding standard says: do not read `process.env` throughout the app —
// parse configuration once at a boundary (a config module / entrypoint) into
// typed values. Scattered `process.env.X` reads are a maintainability smell
// (config shape is implicit, untyped, and untestable). This generalizes the
// existing narrow `nodeenv_branch_in_prod` check (which only catches
// NODE_ENV branching) to any env read outside the config boundary.
//
// Heuristic (regex over stripped content) → findings tagged `[heuristic]`.
// Ships advisory. The boundary allowlist is built-in here (config modules,
// *.config.*, /config/ dirs, setup/bootstrap); a future repo-level
// `.interlinked/env-access-allowlist.json` can extend it on the verify path.

import { basenameNoExt } from "./shared-path-heuristics.js";
import type { InlineMatch } from "./shared.js";
import { stripCommentsAndStrings } from "./shared.js";

/** `process.env.X` or `process.env["X"]`. */
const PROCESS_ENV_RE = /\bprocess\s*\.\s*env\b\s*[.[]/;
const JS_TS_RE = /\.[mc]?[jt]sx?$/;
const TEST_RE = /\.(?:test|spec)\.[mc]?[jt]sx?$|\/__tests__\//;
const CONFIG_MODULE_NAMES: ReadonlySet<string> = new Set([
	"config",
	"config-paths",
	"env",
	"environment",
	"settings",
]);

/** True for the config boundary where env parsing legitimately lives. */
function isConfigBoundary(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	if (/\/config\//.test(norm)) return true;
	if (/\.config\.[mc]?[jt]sx?$/.test(norm)) return true;
	if (/(?:^|\/)(?:setup|bootstrap)[^/]*$/.test(norm)) return true;
	// A directory named for the role is the same boundary as a file named for
	// it: `src/test-setup/home-sandbox.ts` IS a setup file (found via dogfood
	// FP 2026-08-10 — the suite-wide HOME sandbox fired this check).
	if (/(?:^|\/)(?:test-setup|setup|bootstrap)\//.test(norm)) return true;
	return CONFIG_MODULE_NAMES.has(basenameNoExt(norm));
}

/**
 * Find `process.env` reads outside the config boundary.
 *
 * @param content - The source text to scan.
 * @param filePath - The file's path (decides whether it's a config boundary).
 * @returns One match per line reading `process.env` outside the boundary.
 */
export function findProcessEnvOutsideConfig(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_RE.test(filePath)) return [];
	if (TEST_RE.test(filePath)) return [];
	if (isConfigBoundary(filePath)) return [];
	const rawLines = content.split("\n");
	const strippedLines = stripCommentsAndStrings(content).split("\n");
	const out: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (!PROCESS_ENV_RE.test(strippedLines[i] ?? "")) continue;
		out.push({ line: i + 1, text: (rawLines[i] ?? "").trim().slice(0, 150) });
	}
	return out;
}
