// ===========================================
// tsconfig / jsconfig `paths` and `baseUrl`, with `extends`
// ===========================================
// Static reads only. An `extends` chain is followed when each link is a file in
// the repo: a relative path, or a workspace package (`@scope/tsconfig/base.json`).
// A link that is not in the repo (`.svelte-kit/tsconfig.json` is generated; an
// npm package is not installed) is counted in `unreadableExtends`.

import { posix } from "node:path";
import { isJsonObject, type JsonObject } from "../json-types.js";
import { parseJsonc } from "./jsonc.js";
import type { RepoView } from "./repo-view.js";
import type { WorkspaceMember } from "./workspace-packages.js";

export interface EffectiveTsconfig {
	/** `compilerOptions.paths`, from the nearest config in the chain that sets it; null when none does. */
	paths: Record<string, string[]> | null;
	/** Directory the `paths` targets are relative to: the baseUrl directory, else the directory of the config that set `paths`. */
	pathsBase: string;
	/** baseUrl directory (repo-relative), or null. */
	baseUrl: string | null;
	/** `extends` entries that are not files in the repo. */
	unreadableExtends: string[];
}

const MAX_CHAIN = 12;

function pathsOf(options: JsonObject): Record<string, string[]> | null {
	const paths = options.paths;
	if (!isJsonObject(paths)) return null;
	const out: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(paths)) {
		if (Array.isArray(value)) out[key] = value.filter((item): item is string => typeof item === "string");
	}
	return out;
}

function withJsonExtension(path: string): string {
	return path.endsWith(".json") ? path : `${path}.json`;
}

/** Repo-relative file that an `extends` entry names, or null when it is not in the repo. */
function extendsTarget(view: RepoView, members: readonly WorkspaceMember[], dir: string, spec: string): string | null {
	if (spec.startsWith(".") || spec.startsWith("/")) {
		const rel = posix.join(dir, withJsonExtension(spec));
		return view.isFile(rel) ? rel : null;
	}
	const member = members.find(item => spec === item.name || spec.startsWith(`${item.name}/`));
	if (!member) return null;
	const rest = spec.slice(member.name.length + 1);
	const rel = posix.join(member.dir, rest ? withJsonExtension(rest) : "tsconfig.json");
	return view.isFile(rel) ? rel : null;
}

function extendsList(json: JsonObject): string[] {
	const value = json.extends;
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function emptyConfig(dir: string): EffectiveTsconfig {
	return { paths: null, pathsBase: dir, baseUrl: null, unreadableExtends: [] };
}

function inherit(base: EffectiveTsconfig, parent: EffectiveTsconfig): EffectiveTsconfig {
	return {
		paths: parent.paths ?? base.paths,
		pathsBase: parent.paths ? parent.pathsBase : base.pathsBase,
		baseUrl: parent.baseUrl ?? base.baseUrl,
		unreadableExtends: [...base.unreadableExtends, ...parent.unreadableExtends],
	};
}

function loadChain(view: RepoView, members: readonly WorkspaceMember[], rel: string, seen: readonly string[]): EffectiveTsconfig | null {
	const json = seen.length < MAX_CHAIN && !seen.includes(rel) ? parseJsonc(view.read(rel) ?? "") : null;
	if (!isJsonObject(json)) return null;
	const dir = posix.dirname(rel);
	let merged = emptyConfig(dir);
	for (const spec of extendsList(json)) {
		const target = extendsTarget(view, members, dir, spec);
		const parent = target ? loadChain(view, members, target, [...seen, rel]) : null;
		if (parent) merged = inherit(merged, parent);
		else merged.unreadableExtends.push(spec);
	}
	const options = isJsonObject(json.compilerOptions) ? json.compilerOptions : {};
	const baseUrl = typeof options.baseUrl === "string" ? posix.join(dir, options.baseUrl) : merged.baseUrl;
	const paths = pathsOf(options);
	return {
		paths: paths ?? merged.paths,
		pathsBase: paths ? dir : merged.pathsBase,
		baseUrl,
		unreadableExtends: merged.unreadableExtends,
	};
}

/** The effective `paths` and `baseUrl` of one config file, or null when it is missing or not JSON. */
export function loadTsconfig(view: RepoView, members: readonly WorkspaceMember[], rel: string): EffectiveTsconfig | null {
	let cache = loaded.get(view);
	if (!cache) loaded.set(view, (cache = new Map()));
	if (!cache.has(rel)) cache.set(rel, loadChain(view, members, rel, []));
	return cache.get(rel) ?? null;
}

/** Parsed configs per view: a view is one snapshot of the repo, so the answer cannot go stale inside it. */
const loaded = new WeakMap<RepoView, Map<string, EffectiveTsconfig | null>>();

/** The nearest config at or above the file that sets `paths` or `baseUrl`; tsconfig.json is preferred over jsconfig.json in one directory. */
export function governingTsconfig(view: RepoView, members: readonly WorkspaceMember[], fromRel: string): EffectiveTsconfig | null {
	for (let dir = posix.dirname(fromRel); ; dir = posix.dirname(dir)) {
		for (const name of ["tsconfig.json", "jsconfig.json"]) {
			const cfg = view.isFile(posix.join(dir, name)) ? loadTsconfig(view, members, posix.join(dir, name)) : null;
			if (cfg && (cfg.paths || cfg.baseUrl !== null)) return cfg;
		}
		if (dir === "." || dir === "/") return null;
	}
}

interface PathMatch { targets: string[]; prefixLength: number; star: string; }

function matchPattern(pattern: string, targets: string[], spec: string): PathMatch | null {
	const at = pattern.indexOf("*");
	if (at < 0) return pattern === spec ? { targets, prefixLength: Infinity, star: "" } : null;
	const prefix = pattern.slice(0, at), suffix = pattern.slice(at + 1);
	const fits = spec.length >= pattern.length - 1 && spec.startsWith(prefix) && spec.endsWith(suffix);
	return fits ? { targets, prefixLength: prefix.length, star: spec.slice(prefix.length, spec.length - suffix.length) } : null;
}

/** Candidate repo-relative paths (not yet probed for existence) for a specifier, or null when no `paths` pattern fits. */
export function matchTsPaths(cfg: EffectiveTsconfig, specifier: string): string[] | null {
	let best: PathMatch | null = null;
	for (const [pattern, targets] of Object.entries(cfg.paths ?? {})) {
		const match = matchPattern(pattern, targets, specifier);
		if (match && (!best || match.prefixLength > best.prefixLength)) best = match;
	}
	if (!best) return null;
	const base = cfg.baseUrl ?? cfg.pathsBase;
	const star = best.star;
	return best.targets.map(target => posix.join(base, target.replaceAll("*", star)));
}
