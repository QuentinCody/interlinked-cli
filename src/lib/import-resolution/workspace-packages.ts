// ===========================================
// Workspace packages: name, entry points, subpath exports
// ===========================================
// A monorepo imports its own packages by name (`@scope/utils/export`). The
// package lives in the repo, so the import resolves with static reads only:
// the member list comes from `pnpm-workspace.yaml` or `package.json`
// `workspaces`, the target from `exports`, `main`, `module`, `types`, `svelte`
// or `src/index.*`. A build-output target (`./dist/x.js`) maps to the source
// file beside it (`src/x.ts`) because the build output is not in the tree.
// Nothing is guessed: a candidate counts only when the file exists.

import { posix } from "node:path";
import { isJsonObject, type JsonObject } from "../json-types.js";
import { parseJsonc } from "./jsonc.js";
import type { RepoView } from "./repo-view.js";

export interface WorkspaceMember { name: string; dir: string; pkg: JsonObject; }

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
	".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"],
};
/** Build-output directory names: `tsc` and bundlers write here; the source sits in `src/`. */
const OUTPUT_DIRS = new Set(["dist", "build", "lib", "out"]);
const OUTPUT_FLAVOURS = new Set(["esm", "cjs", "es", "types", "mjs"]);
const ENTRY_FIELDS = ["source", "svelte", "module", "main", "types", "typings"];

function normalize(path: string): string {
	return posix.normalize(path).replace(/^\.\//, "");
}

/** Resolve a path without an extension, as a bundler would: exact, `.js` to `.ts`, extensions, then `index`. */
export function fileLike(view: RepoView, base: string): string | null {
	if (view.isFile(base)) return base;
	const ext = posix.extname(base);
	const stem = base.slice(0, base.length - ext.length);
	const swapped = (JS_TO_TS[ext] ?? []).map(to => `${stem}${to}`);
	const appended = SOURCE_EXTENSIONS.map(to => `${base}${to}`);
	const indexed = SOURCE_EXTENSIONS.flatMap(to => (ext in JS_TO_TS ? [`${base}/index${to}`, `${stem}/index${to}`] : [`${base}/index${to}`]));
	return [...swapped, ...appended, ...indexed].find(candidate => view.isFile(candidate)) ?? null;
}

/** Candidate source paths for a build-output path inside `dir`: the path itself, then `src/` in place of the output directory. */
function sourceBases(dir: string, target: string): string[] {
	const rel = normalize(target.replace(/\.d\.([cm]?)ts$/, ".$1js"));
	const bases = [posix.join(dir, rel)];
	const parts = rel.split("/");
	if (!OUTPUT_DIRS.has(parts[0] ?? "")) return bases;
	const rest = parts.slice(1);
	bases.push(posix.join(dir, "src", ...rest));
	if (OUTPUT_FLAVOURS.has(rest[0] ?? "")) bases.push(posix.join(dir, "src", ...rest.slice(1)));
	return bases;
}

function resolveTarget(view: RepoView, dir: string, target: string): string | null {
	for (const base of sourceBases(dir, target)) {
		const found = fileLike(view, base);
		if (found) return found;
	}
	return null;
}

function yamlWorkspacePatterns(text: string): string[] {
	const patterns: string[] = [];
	let inPackages = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^packages\s*:/.test(line)) inPackages = true;
		else if (/^\S/.test(line)) inPackages = false;
		const item = inPackages ? /^\s+-\s+(.+?)\s*$/.exec(line) : null;
		if (item) patterns.push((item[1] as string).replace(/^['"]|['"]$/g, ""));
	}
	return patterns;
}

function packageJsonPatterns(text: string): string[] {
	const json = parseJsonc(text);
	if (!isJsonObject(json)) return [];
	const field = json.workspaces;
	const list = Array.isArray(field) ? field : isJsonObject(field) ? field.packages : [];
	return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

function patternToRegExp(pattern: string): RegExp {
	const body = normalize(pattern.replace(/\/+$/, ""))
		.split("/")
		.map(segment => (segment === "**" ? ".+" : segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]+")))
		.join("/");
	return new RegExp(`^${body}$`);
}

function workspacePatterns(view: RepoView): string[] {
	const yaml = view.read("pnpm-workspace.yaml");
	const root = view.read("package.json");
	return [...(yaml ? yamlWorkspacePatterns(yaml) : []), ...(root ? packageJsonPatterns(root) : [])];
}

/** Every workspace member that has a named package.json, sorted by name. Empty without workspace config. */
export function discoverWorkspaceMembers(view: RepoView): WorkspaceMember[] {
	const patterns = workspacePatterns(view);
	const include = patterns.filter(item => !item.startsWith("!")).map(patternToRegExp);
	const exclude = patterns.filter(item => item.startsWith("!")).map(item => patternToRegExp(item.slice(1)));
	const members: WorkspaceMember[] = [];
	for (const file of view.configFiles()) {
		if (posix.basename(file) !== "package.json" || file === "package.json") continue;
		const dir = posix.dirname(file);
		if (!include.some(re => re.test(dir)) || exclude.some(re => re.test(dir))) continue;
		const pkg = parseJsonc(view.read(file) ?? "");
		if (isJsonObject(pkg) && typeof pkg.name === "string") members.push({ name: pkg.name, dir, pkg });
	}
	return members.sort((a, b) => a.name.localeCompare(b.name));
}

/** Targets of an exports or imports entry, in written order: a string, an array, or the values of a condition object. */
function entryTargets(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(entryTargets);
	return isJsonObject(value) ? Object.values(value).flatMap(entryTargets) : [];
}

/** The entry for `key` in an exports or imports map: exact key first, then the longest `prefix*suffix` pattern. */
function matchMapKey(map: JsonObject, key: string): { value: unknown; star: string } | null {
	if (key in map) return { value: map[key], star: "" };
	let best: { value: unknown; star: string; length: number } | null = null;
	for (const [pattern, value] of Object.entries(map)) {
		const at = pattern.indexOf("*");
		if (at < 0) continue;
		const prefix = pattern.slice(0, at), suffix = pattern.slice(at + 1);
		const fits = key.length >= pattern.length - 1 && key.startsWith(prefix) && key.endsWith(suffix);
		if (fits && (!best || prefix.length > best.length)) best = { value, star: key.slice(prefix.length, key.length - suffix.length), length: prefix.length };
	}
	return best;
}

/** `exports` written as a string, array or condition object stands for the "." entry. */
function exportsAsMap(value: unknown): JsonObject {
	const subpathMap = isJsonObject(value) && Object.keys(value).some(key => key.startsWith("."));
	return subpathMap ? (value as JsonObject) : { ".": value };
}

function resolveMapEntry(view: RepoView, dir: string, map: JsonObject, key: string): string | null {
	const entry = matchMapKey(map, key);
	if (!entry) return null;
	for (const target of entryTargets(entry.value)) {
		if (!target.startsWith("./")) continue;
		const found = resolveTarget(view, dir, target.replaceAll("*", entry.star));
		if (found) return found;
	}
	return null;
}

function resolveLegacyEntry(view: RepoView, member: WorkspaceMember, subpath: string): string | null {
	if (subpath) {
		return fileLike(view, posix.join(member.dir, subpath)) ?? fileLike(view, posix.join(member.dir, "src", subpath));
	}
	for (const field of ENTRY_FIELDS) {
		const target = member.pkg[field];
		const found = typeof target === "string" ? resolveTarget(view, member.dir, target) : null;
		if (found) return found;
	}
	return fileLike(view, posix.join(member.dir, "src/index")) ?? fileLike(view, posix.join(member.dir, "index"));
}

/** Source file for `<member.name>/<subpath>` (empty subpath = the package entry), or null. */
export function resolveMemberSubpath(view: RepoView, member: WorkspaceMember, subpath: string): string | null {
	if (member.pkg.exports === undefined) return resolveLegacyEntry(view, member, subpath);
	const viaExports = resolveMapEntry(view, member.dir, exportsAsMap(member.pkg.exports), subpath ? `./${subpath}` : ".");
	return viaExports ?? (subpath ? null : resolveLegacyEntry(view, member, ""));
}

/** Source file for a `#name` import of the package at `dir` (package.json `imports`), or null. */
export function resolvePackageImport(view: RepoView, dir: string, specifier: string): string | null {
	const pkg = parseJsonc(view.read(posix.join(dir, "package.json")) ?? "");
	return isJsonObject(pkg) && isJsonObject(pkg.imports) ? resolveMapEntry(view, dir, pkg.imports, specifier) : null;
}

/**
 * A path inside a workspace member that names its build output (`packages/ui/dist/hosted.js`):
 * the build output is not in the tree, so look for the source file beside it. Null when the path
 * is in no member or no source file exists.
 */
export function resolveMemberOutputPath(view: RepoView, members: readonly WorkspaceMember[], rel: string): string | null {
	const path = normalize(rel);
	const member = members.filter(item => path.startsWith(`${item.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
	return member ? resolveTarget(view, member.dir, path.slice(member.dir.length + 1)) : null;
}

/**
 * A path under `node_modules/<member>/...` points at a workspace member that
 * the package manager links in. The link is not in the tree, so map it to the
 * member directory. Null for any other path.
 */
export function resolveNodeModulesPath(view: RepoView, members: readonly WorkspaceMember[], rel: string): string | null {
	const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/(.*))?$/.exec(normalize(rel));
	const member = match ? members.find(item => item.name === match[1]) : undefined;
	if (!member) return null;
	const rest = match?.[2] ?? "";
	return rest ? resolveTarget(view, member.dir, rest) : resolveMemberSubpath(view, member, "");
}
