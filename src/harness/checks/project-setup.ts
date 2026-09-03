// Project setup validation checks.
// Extracted from generic-checks.ts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { describeReason, suggestRuleFix, validateSettingsFile } from "../../lib/settings-validator.js";

/**
 * Read every dependency name from a package.json into a flat record.
 * Best-effort: returns {} on any read or parse error. Includes peer- and
 * optional-dependencies because a `types: ["X"]` entry is satisfied by any
 * declared install relationship — peer deps are still installed by consumers.
 */
function readAllDeps(pkgJsonPath: string): Record<string, string> {
	try {
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as JsonObject;
		return {
			...((pkg.dependencies as Record<string, string> | undefined) || {}),
			...((pkg.devDependencies as Record<string, string> | undefined) || {}),
			...((pkg.peerDependencies as Record<string, string> | undefined) || {}),
			...((pkg.optionalDependencies as Record<string, string> | undefined) || {}),
		};
	} catch {
		return {};
	}
}

// ===========================================
// Bounded project-source walk
// ===========================================
// Directory basenames a first-party source scan must never descend into.
// Walking `node_modules` is what made the node:-protocol-import probe fire on
// essentially every project — a dependency's own `node:` imports (and the
// `.d.ts` files it ships) leaked in and looked like the project's own code.
// Build-output dirs are skipped for the same correctness reason and to keep
// the per-edit walk cheap.
const NON_SOURCE_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"target",
	"vendor",
	"__pycache__",
]);

// Hard cap on directory entries one scan will visit. interlinked-cli itself,
// minus node_modules, is a few thousand entries; 20K is well clear of any real
// first-party tree yet aborts a mis-rooted walk in well under a second. The
// cap fails toward "not found" — the safe bias for a presence probe (skip a
// dependent check rather than emit a false finding from a partial scan).
const MAX_PROJECT_SCAN_ENTRIES = 20_000;

/** `readdirSync` with file types, returning `[]` rather than throwing so a
 *  single unreadable directory never aborts a whole project walk. */
function readDirEntries(dir: string) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		// intentional: best-effort walk — an unreadable directory just
		// shrinks the scan; it must not abort the probe.
		return [];
	}
}

/** Whether a directory basename is first-party source the walk should
 *  descend into — excludes {@link NON_SOURCE_DIRS} and any dotfile dir. */
function isProjectSourceDir(name: string): boolean {
	return !NON_SOURCE_DIRS.has(name) && !name.startsWith(".");
}

/** Handle one directory entry during the walk: queue a source subdirectory
 *  onto `stack`, or run `visit` on a file. Returns `true` only when `visit`
 *  matched, signaling the walk to stop. */
function processDirEntry(
	entry: Dirent,
	dir: string,
	stack: string[],
	visit: (absPath: string) => boolean,
): boolean {
	const full = resolve(dir, entry.name);
	if (entry.isDirectory()) {
		if (isProjectSourceDir(entry.name)) stack.push(full);
		return false;
	}
	return entry.isFile() && visit(full);
}

/**
 * Bounded, skip-list-aware recursive walk of the project subtree rooted at
 * `root`. Invokes `visit` for every file and stops early (returning `true`)
 * the moment `visit` does. Never descends into dependency/build-output
 * directories ({@link NON_SOURCE_DIRS}) or any dotfile directory. Returns
 * `false` when no file matched or the entry cap was hit.
 */
function walkProjectFiles(root: string, visit: (absPath: string) => boolean): boolean {
	const stack: string[] = [root];
	let budget = MAX_PROJECT_SCAN_ENTRIES;
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of readDirEntries(dir)) {
			if (--budget <= 0) return false;
			if (processDirEntry(entry, dir, stack, visit)) return true;
		}
	}
	return false;
}

// ===========================================
// Project Setup Validation
// ===========================================

export interface ProjectSetupIssue {
	check: string;
	file: string;
	line: number;
	message: string;
	fix: string;
}

/**
 * Cross-check `compilerOptions.types: ["X"]` against installed deps. tsc
 * fails with cryptic global-name errors when an entry isn't installed. The
 * universal shape — applies to "@cloudflare/workers-types", "vitest",
 * "bun-types", "@types/node", anything in types[].
 *
 * Resolution rule: scoped names (`@org/pkg`) only match the exact package;
 * unscoped names (`vitest`, `node`) match either the package itself or
 * `@types/<name>` (DefinitelyTyped fallback).
 */
export function checkTsConfigTypesAgainstDeps(
	compilerOptions: JsonObject,
	tsconfigDir: string,
): ProjectSetupIssue[] {
	const types = compilerOptions.types;
	if (!Array.isArray(types) || types.length === 0) return [];
	const allDeps = readAllDeps(resolve(tsconfigDir, "package.json"));
	const issues: ProjectSetupIssue[] = [];
	for (const entry of types) {
		if (typeof entry !== "string" || !entry) continue;
		const isScoped = entry.startsWith("@");
		const installed = isScoped
			? entry in allDeps
			: entry in allDeps || `@types/${entry}` in allDeps;
		if (installed) continue;
		const candidate = isScoped ? entry : `@types/${entry}`;
		const detail = isScoped
			? `"${entry}" is not in package.json`
			: `neither "${entry}" nor "@types/${entry}" is in package.json`;
		issues.push({
			check: "project_setup",
			file: "tsconfig.json",
			line: 0,
			message: `tsconfig.json includes types: ["${entry}"] but ${detail}. tsc will fail to resolve these globals.`,
			fix: `Run \`npm i --save-dev ${candidate}\``,
		});
	}
	return issues;
}

/**
 * Scan project-local Claude Code settings files (`.claude/settings.json`
 * and `.claude/settings.local.json`) for malformed permission rules. Each
 * malformed rule becomes one ProjectSetupIssue. The fix instruction tells
 * the user to run `interlinked doctor --fix`, which already wraps
 * `stripMalformedRules`.
 *
 * Exported separately so tests can target it without going through the
 * TS-project-detection branches in `checkProjectSetup`.
 */
export function checkClaudeSettingsPermissions(cwd: string): ProjectSetupIssue[] {
	const issues: ProjectSetupIssue[] = [];
	const candidates = [
		resolve(cwd, ".claude", "settings.json"),
		resolve(cwd, ".claude", "settings.local.json"),
	];
	for (const filePath of candidates) {
		const result = validateSettingsFile(filePath);
		if (!result.exists) continue;
		if (result.parseError) {
			issues.push({
				check: "permission_rule_syntax",
				file: filePath,
				line: 0,
				message: `${filePath} is not valid JSON: ${result.parseError.slice(0, 100)}`,
				fix: "Fix the JSON syntax (or restore from version control).",
			});
			continue;
		}
		for (const m of result.malformed) {
			const suggestion = suggestRuleFix(m.rule, m.reason);
			const suggestionClause =
				suggestion !== null ? ` Did you mean ${JSON.stringify(suggestion)}?` : "";
			issues.push({
				check: "permission_rule_syntax",
				file: filePath,
				line: 0,
				message:
					`permissions.${m.bucket}[${m.index}] = ${JSON.stringify(m.rule)} ` +
					`is malformed (${describeReason(m.reason)}).${suggestionClause} ` +
					"Claude Code's /doctor skips this rule at load time.",
				fix: "Run `interlinked doctor --fix` to strip malformed permission rules.",
			});
		}
	}
	return issues;
}

/**
 * Detect common project setup issues that cause confusing compiler errors.
 * Runs once per project (not per-file). Returns actionable fix instructions.
 */
/** Walk up from `cwd` (5 levels max) looking for a directory containing
 *  tsconfig.json. Returns the directory, or `null` if none was found. */
function findTsconfigDir(cwd: string): string | null {
	let searchDir = cwd;
	for (let i = 0; i < 5; i++) {
		if (existsSync(resolve(searchDir, "tsconfig.json"))) {
			return searchDir;
		}
		const parent = dirname(searchDir);
		if (parent === searchDir) break;
		searchDir = parent;
	}
	return null;
}

/** Read + JSON-parse tsconfig.json from `tsconfigDir`. On parse failure,
 *  returns the same ProjectSetupIssue the inline try/catch used to push,
 *  and a `null` config so the caller can short-circuit exactly as before. */
function readTsconfig(tsconfigDir: string): {
	config: JsonObject | null;
	parseErrorIssue: ProjectSetupIssue | null;
} {
	try {
		const raw = readFileSync(resolve(tsconfigDir, "tsconfig.json"), "utf-8");
		return { config: JSON.parse(raw), parseErrorIssue: null };
	} catch {
		return {
			config: null,
			parseErrorIssue: {
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message: "tsconfig.json exists but cannot be parsed (invalid JSON)",
				fix: "Fix the JSON syntax in tsconfig.json",
			},
		};
	}
}

/** First-party source files use `node:` protocol imports if any `.ts` file
 *  (skipping node_modules et al) matches `from "node:..."`. */
function hasNodeProtocolImportsIn(cwd: string): boolean {
	return walkProjectFiles(cwd, (f) => {
		if (!f.endsWith(".ts")) return false;
		try {
			return /from\s+["']node:/.test(readFileSync(f, "utf-8"));
		} catch {
			// intentional: an unreadable file → treat as no match, keep scanning.
			return false;
		}
	});
}

/** Best-effort probe: is `@types/node` declared in package.json's
 *  dependencies or devDependencies at `tsconfigDir`? */
function packageHasTypesNode(tsconfigDir: string): boolean {
	try {
		const pkgPath = resolve(tsconfigDir, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		const allDeps = {
			...(pkg.dependencies || {}),
			...(pkg.devDependencies || {}),
		};
		return "@types/node" in allDeps;
	} catch {
		// intentional: best-effort package.json probe — absence or parse
		// failure just means we can't confirm @types/node is installed.
		return false;
	}
}

/** Issues for the "uses node: imports" case: missing @types/node, and/or a
 *  tsconfig `types` field that omits "node". Only called when the project
 *  is already known to use node: protocol imports. */
function checkNodeImportIssues(
	tsconfigDir: string,
	compilerOptions: JsonObject,
): ProjectSetupIssue[] {
	const issues: ProjectSetupIssue[] = [];

	if (!packageHasTypesNode(tsconfigDir)) {
		issues.push({
			check: "project_setup",
			file: "package.json",
			line: 0,
			message:
				"Code uses node: protocol imports (node:fs, node:path, etc.) but @types/node is not in devDependencies",
			fix: "Run `npm i --save-dev @types/node`",
		});
	}

	const typesForNode = compilerOptions.types as string[] | undefined;
	if (typesForNode && !typesForNode.includes("node")) {
		issues.push({
			check: "project_setup",
			file: "tsconfig.json",
			line: 0,
			message:
				'tsconfig.json has a "types" field but "node" is not included — node: imports will fail',
			fix: 'Add "node" to the "types" array in compilerOptions',
		});
	}

	return issues;
}

/** Issue for a `moduleResolution` value that won't resolve node: protocol
 *  imports, or `null` when there's nothing to flag. */
function checkModuleResolutionIssue(
	compilerOptions: JsonObject,
	hasNodeProtocolImports: boolean,
): ProjectSetupIssue | null {
	const moduleResolution = compilerOptions.moduleResolution as string | undefined;
	if (
		hasNodeProtocolImports &&
		moduleResolution &&
		!["node16", "nodenext", "bundler"].includes(moduleResolution.toLowerCase())
	) {
		return {
			check: "project_setup",
			file: "tsconfig.json",
			line: 0,
			message: `moduleResolution "${moduleResolution}" may not resolve node: protocol imports`,
			fix: 'Set "moduleResolution": "node16" or "bundler" in compilerOptions',
		};
	}
	return null;
}

/** Issue for strict mode being disabled, or `null` when it's on. */
function checkStrictModeIssue(compilerOptions: JsonObject): ProjectSetupIssue | null {
	if (compilerOptions.strict !== true) {
		return {
			check: "project_setup",
			file: "tsconfig.json",
			line: 0,
			message:
				"TypeScript strict mode is not enabled — agents produce safer code with strict checks",
			fix: 'Add "strict": true to compilerOptions',
		};
	}
	return null;
}

export function checkProjectSetup(cwd: string): ProjectSetupIssue[] {
	const issues: ProjectSetupIssue[] = [];

	// Run the Claude settings scan unconditionally — it applies to every
	// project that has a .claude/ directory, regardless of language.
	issues.push(...checkClaudeSettingsPermissions(cwd));

	const tsconfigDir = findTsconfigDir(cwd);

	// Check if this is a TypeScript project (has .ts/.tsx files in first-party
	// source). The walk skips node_modules: an unbounded recursive readdir
	// over cwd pulled in dependencies' own .ts/.d.ts files and mislabelled
	// pure-JavaScript projects as TypeScript ones.
	const hasTypeScriptFiles = walkProjectFiles(cwd, (f) => /\.tsx?$/.test(f));

	if (!hasTypeScriptFiles) return issues;

	// Issue: No tsconfig.json
	if (!tsconfigDir) {
		issues.push({
			check: "project_setup",
			file: "tsconfig.json",
			line: 0,
			message: "TypeScript files found but no tsconfig.json exists",
			fix: "Run `npx tsc --init` to create a tsconfig.json",
		});
		return issues;
	}

	// Read and parse tsconfig
	const { config, parseErrorIssue } = readTsconfig(tsconfigDir);
	if (parseErrorIssue) {
		issues.push(parseErrorIssue);
		return issues;
	}
	const tsconfig: JsonObject = config as JsonObject;

	const compilerOptions = (tsconfig.compilerOptions || {}) as JsonObject;

	// Check for node:* protocol imports in FIRST-PARTY source files. The walk
	// skips node_modules — otherwise a dependency's own `node:` imports made
	// this probe fire on nearly every project, recommending @types/node even
	// when the project's own code never touches a node builtin.
	const hasNodeProtocolImports = hasNodeProtocolImportsIn(cwd);

	// Issue: Uses node: imports but @types/node not installed, and/or
	// tsconfig types field missing "node"
	if (hasNodeProtocolImports) {
		issues.push(...checkNodeImportIssues(tsconfigDir, compilerOptions));
	}

	issues.push(...checkTsConfigTypesAgainstDeps(compilerOptions, tsconfigDir));

	// Issue: Wrong moduleResolution for node: imports
	const moduleResolutionIssue = checkModuleResolutionIssue(
		compilerOptions,
		hasNodeProtocolImports,
	);
	if (moduleResolutionIssue) issues.push(moduleResolutionIssue);

	// Issue: strict mode disabled
	const strictModeIssue = checkStrictModeIssue(compilerOptions);
	if (strictModeIssue) issues.push(strictModeIssue);

	return issues;
}
