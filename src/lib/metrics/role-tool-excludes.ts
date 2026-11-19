import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { inventoryPaths } from "./inventory-paths.js";
import { sourceLanguage, VENDOR_PATH } from "./inventory-roles.js";
import type { RoleDecision } from "./role-evidence.js";
import {
	isLinterConfigName, type LinterTool, type RawExclude, readLinterConfig, type SkippedPattern,
} from "./role-tool-config.js";
import { compileGlob, type GlobRule, matchesRules } from "./role-tool-glob.js";

/**
 * Source-role evidence "excluded by the repository's own linter" (kind `tool-config`). A tracked product path that a linter's
 * exclude list names gets the role `unlinted`: the owners do not lint it. That holds for generated output and also for examples,
 * scripts, vendored code and language tables, so it is NOT the role `generated`; a consumer decides what to do with the bucket,
 * and the structure measure may confirm a directory as generated (`role-repo-evidence.ts`). What is read, which
 * glob subset applies and what is NOT evidence (type checkers, coverage, formatters, tsconfig) is documented in
 * `role-tool-config.ts` and `role-tool-glob.ts`. A tool excludes only the languages it lints: a ruff exclude of a directory
 * does not move that directory's TypeScript files, and an ESLint ignore does not move Python files.
 * Only a `product` path moves; tests, vendor, generated and every other role keep their role and evidence.
 */
export interface ToolExcludeHit { tool: LinterTool; key: string; pattern: string; file: string; line: number; }
export interface ToolExcludes {
	/** Config files that were read, relative to the root. */
	configFiles: string[];
	/** Rules that were compiled and apply. */
	ruleCount: number;
	/** Patterns not applied, counted by `tool:reason`. */
	skipped: Record<string, number>;
	/** The first skipped patterns, for display. */
	skippedList: Array<{ file: string; line: number; tool: string; reason: string; pattern?: string | undefined }>;
	/** The rule that excludes a path (relative to the root), or null. */
	match(path: string): ToolExcludeHit | null;
}

const LANGUAGES: Readonly<Record<LinterTool, ReadonlySet<string>>> = {
	ruff: new Set(["python"]), flake8: new Set(["python"]), pylint: new Set(["python"]),
	eslint: new Set(["javascript", "typescript", "vue", "svelte", "astro"]),
	biome: new Set(["javascript", "typescript", "vue", "svelte", "astro"]),
	oxlint: new Set(["javascript", "typescript", "vue", "svelte", "astro"]),
};
const SKIPPED_LISTED = 50;
const EXTENSION_ONLY = /^!?(?:\*\*\/)?\*\.[\w{},]+$/;
const MAX_CONFIG_BYTES = 1024 * 1024;

interface Group { dir: string; file: string; tool: LinterTool; globs: GlobRule[]; origin: Map<GlobRule, RawExclude>; others: Array<{ test: (rel: string) => boolean; raw: RawExclude }>; }

/** A pylint ignore-paths regex as a JS regex anchored at the start (Python `re.match`), or null when it uses syntax JS lacks. */
function pylintRegex(source: string): RegExp | null {
	if (/\(\?[^:]|\\[AZ]/.test(source)) return null;
	try { return new RegExp(`^(?:${source.replace(/\$$/, "$")})`); } catch { return null; }
}

function prefixes(rel: string): string[] {
	const parts = rel.split("/");
	return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Add one raw rule to its group; returns a skip reason, or null when it applies. */
function addRule(group: Group, raw: RawExclude): string | null {
	if (raw.style === "basename") { group.others.push({ raw, test: (rel) => rel.split("/").includes(raw.pattern) }); return null; }
	if (raw.style === "regex") {
		const regex = pylintRegex(raw.pattern);
		if (regex === null) return "regex";
		group.others.push({ raw, test: (rel) => prefixes(rel).some((prefix) => regex.test(prefix)) });
		return null;
	}
	// `*.js` / `**/*.cjs`: a linter scoped to one language, not a statement that those files are unmaintained.
	if (EXTENSION_ONLY.test(raw.pattern)) return "extension-only";
	const compiled = compileGlob(raw.pattern, raw.style);
	if ("unsupported" in compiled) return compiled.unsupported;
	group.globs.push(compiled);
	group.origin.set(compiled, raw);
	return null;
}

function groupFor(groups: Map<string, Group>, file: string, tool: LinterTool): Group {
	const id = `${file}\0${tool}`;
	let group = groups.get(id);
	if (group === undefined) { group = { dir: dirname(file) === "." ? "" : dirname(file), file, tool, globs: [], origin: new Map(), others: [] }; groups.set(id, group); }
	return group;
}

function groupHit(group: Group, path: string): ToolExcludeHit | null {
	if (group.dir !== "" && !path.startsWith(`${group.dir}/`)) return null;
	if (!LANGUAGES[group.tool].has(sourceLanguage(path) ?? "")) return null;
	const rel = group.dir === "" ? path : path.slice(group.dir.length + 1);
	const glob = matchesRules(group.globs, rel);
	const raw = glob === null ? group.others.find((other) => other.test(rel))?.raw : group.origin.get(glob);
	return raw === undefined ? null : { tool: raw.tool, key: raw.key, pattern: raw.pattern, file: group.file, line: raw.line };
}

function countSkips(skips: readonly SkippedPattern[], file: string, into: ToolExcludes): void {
	for (const skip of skips) {
		const tool = skip.tool ?? "eslint", key = `${tool}:${skip.reason}`;
		into.skipped[key] = (into.skipped[key] ?? 0) + 1;
		if (into.skippedList.length < SKIPPED_LISTED) into.skippedList.push({ file, line: skip.line, tool, reason: skip.reason, pattern: skip.pattern });
	}
}

/** Build the exclude set from config files whose text is in hand (path relative to the root). */
export function buildToolExcludes(configs: ReadonlyArray<{ file: string; text: string }>): ToolExcludes {
	const groups = new Map<string, Group>();
	const set: ToolExcludes = { configFiles: [], ruleCount: 0, skipped: {}, skippedList: [], match: () => null };
	for (const { file, text } of configs) {
		const reading = readLinterConfig(file, text);
		if (reading.rules.length > 0) set.configFiles.push(file);
		countSkips(reading.skipped, file, set);
		for (const raw of reading.rules) {
			const reason = addRule(groupFor(groups, file, raw.tool), raw);
			if (reason === null) set.ruleCount += 1;
			else countSkips([{ reason, pattern: raw.pattern, line: raw.line, tool: raw.tool }], file, set);
		}
	}
	const ordered = [...groups.values()].sort((a, b) => b.dir.length - a.dir.length || a.file.localeCompare(b.file));
	set.match = (path) => { for (const group of ordered) { const hit = groupHit(group, path); if (hit !== null) return hit; } return null; };
	return set;
}

/** The decision for `path` after the linter-exclude layer. Only a product path moves. */
export function applyToolExclude(set: ToolExcludes, path: string, decision: RoleDecision): RoleDecision {
	if (decision.role !== "product" || decision.evidence !== null) return decision;
	const hit = set.match(path.replaceAll("\\", "/"));
	if (hit === null) return decision;
	const detail = `${hit.tool} ${hit.key} \`${hit.pattern}\` (${hit.file}:${hit.line})`;
	return { role: "unlinted", evidence: { kind: "tool-config", detail }, from: "product" };
}

const cache = new Map<string, ToolExcludes>();
export function clearToolExcludeCache(): void { cache.clear(); }

function readConfig(root: string, file: string): { file: string; text: string } | null {
	try {
		const absolute = join(root, file);
		return statSync(absolute).size > MAX_CONFIG_BYTES ? null : { file, text: readFileSync(absolute, "utf8") };
	} catch { return null; }
}

/** The exclude set of a repository: every linter config among its tracked (or, outside git, walked) files. Cached per root. */
export function loadToolExcludes(root: string, paths?: readonly string[]): ToolExcludes {
	const cached = paths === undefined ? cache.get(root) : undefined;
	if (cached !== undefined) return cached;
	const files = (paths ?? inventoryPaths(root).paths).map((path) => path.replaceAll("\\", "/"));
	const configs = files.filter((file) => isLinterConfigName(file) && !VENDOR_PATH.test(file)).map((file) => readConfig(root, file));
	const set = buildToolExcludes(configs.filter((config): config is { file: string; text: string } => config !== null));
	if (paths === undefined) cache.set(root, set);
	return set;
}
