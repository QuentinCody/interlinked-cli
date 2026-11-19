// Entry roots for the `deadcode` reachability scan that come from more than the root package.json:
// framework route files, scripts and bins of nested packages, and tool config files.

import { frameworkEntryFiles } from "../lib/import-resolution/framework-entries.js";
import type { RepoView } from "../lib/import-resolution/repo-view.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";

/** Tool configuration that a tool loads by name from its package directory, at any depth (vite, svelte-kit, postcss, tailwind, playwright, storybook). */
const TOOL_CONFIG_RE = /(?:^|\/)[\w-]+\.config\.[cm]?[jt]s$|(?:^|\/)\.storybook\/[\w-]+\.[cm]?[jt]sx?$/;
const SOURCE_NAME_RE = /[\w./-]+\.(?:tsx?|[cm]?js)\b/g;

function parseObject(text: string | null): JsonObject | null {
	try {
		const json: unknown = JSON.parse(text ?? "");
		return isJsonObject(json) ? json : null;
	} catch {
		return null;
	}
}

/** Every string value of `scripts` and `bin`. */
function commandTexts(json: JsonObject): string[] {
	const values = [...Object.values(isJsonObject(json.scripts) ? json.scripts : {}), ...Object.values(isJsonObject(json.bin) ? json.bin : {})];
	return values.filter((value): value is string => typeof value === "string");
}

/** Paths a command text names, as written and with a build-output path mapped to its source. */
function candidatePaths(dir: string, text: string): string[] {
	return [...text.matchAll(SOURCE_NAME_RE)].flatMap(match => {
		const rel = `${dir}/${match[0].replace(/^\.\//, "")}`;
		return [rel, rel.replace(`${dir}/dist/`, `${dir}/src/`).replace(/\.js$/, ".ts")];
	});
}

/**
 * Files that a nested package's own package.json runs: `bin` targets and any
 * source file named in a script value, resolved from that package's directory.
 * The root package.json is read elsewhere. Only paths in `known` count.
 */
export function nestedPackageEntries(view: RepoView, known: ReadonlySet<string>): Set<string> {
	const found = new Set<string>();
	for (const file of view.configFiles().filter(path => path.endsWith("/package.json"))) {
		const json = parseObject(view.read(file));
		const dir = file.slice(0, -"/package.json".length);
		for (const text of json ? commandTexts(json) : []) {
			for (const path of candidatePaths(dir, text)) if (known.has(path)) found.add(path);
		}
	}
	return found;
}

/** `base` plus every root that the scan can name: `entries` for reachability, `frameworkEntries` for the export scan skip. */
export function reachabilityRoots(
	view: RepoView,
	codeFiles: readonly string[],
	componentFiles: readonly string[],
	base: Set<string>,
): { entries: Set<string>; frameworkEntries: ReadonlySet<string> } {
	const frameworkEntries = frameworkEntryFiles(view, [...codeFiles, ...componentFiles]);
	const entries = new Set([...base, ...frameworkEntries, ...nestedPackageEntries(view, new Set(codeFiles))]);
	for (const path of codeFiles) if (TOOL_CONFIG_RE.test(path)) entries.add(path);
	return { entries, frameworkEntries };
}
