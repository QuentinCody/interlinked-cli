// ===========================================
// Alias and workspace import resolution (static)
// ===========================================
// One layer that sits in front of the two existing resolvers (the harness
// graph's fs resolver and the scoring graph's TypeScript-compiler resolver).
// It answers only for specifiers that a relative-path resolver cannot read:
//   1. tsconfig / jsconfig `paths` and `baseUrl`, with `extends`
//   2. framework aliases literal in config files (SvelteKit, Vite, Nuxt)
//   3. workspace packages by name, with subpath `exports`
//   4. package.json `imports` (`#name`)
// It reads files through a RepoView and never runs project code. A specifier
// that names an alias or a workspace package but resolves to no file returns
// `unresolved` with a reason; a specifier it does not recognise returns null.

import { posix } from "node:path";
import { isJsonObject } from "../json-types.js";
import { loadFrameworkAliases, matchFrameworkAlias, type FrameworkAliases } from "./framework-aliases.js";
import { parseJsonc } from "./jsonc.js";
import type { RepoView } from "./repo-view.js";
import { governingTsconfig, matchTsPaths, type EffectiveTsconfig } from "./tsconfig-paths.js";
import { discoverWorkspaceMembers, fileLike, resolveMemberOutputPath, resolveMemberSubpath, resolveNodeModulesPath, resolvePackageImport, type WorkspaceMember } from "./workspace-packages.js";

export type UnresolvedReason = "alias-target-missing" | "alias-not-literal" | "workspace-entry-missing" | "package-import-missing";
export type AliasResolution =
	| { kind: "local"; target: string }
	| { kind: "virtual" }
	| { kind: "unresolved"; reason: UnresolvedReason };

export interface ImportResolver {
	/** Resolution for a non-relative specifier imported by `fromRel`, or null when this layer does not recognise it. */
	resolve(fromRel: string, specifier: string): AliasResolution | null;
	/** Config problems met so far (an `extends` link that is not in the repo). */
	notes(): string[];
}

const SVELTEKIT_VIRTUAL = /^\$(?:app|env)\/|^\$service-worker$/;
const TOOL_VIRTUAL = /^(?:virtual|astro|vite):/;

interface Context {
	view: RepoView;
	members: WorkspaceMember[];
	tsconfigByDir: Map<string, EffectiveTsconfig | null>;
	aliasesByDir: Map<string, FrameworkAliases[]>;
	/** Framework config read at exactly this directory (not its ancestors). */
	aliasesAtDir: Map<string, FrameworkAliases[]>;
	notes: Set<string>;
}

function ancestors(fromRel: string): string[] {
	const dirs: string[] = [];
	for (let dir = posix.dirname(fromRel); ; dir = posix.dirname(dir)) {
		dirs.push(dir);
		if (dir === "." || dir === "/") return dirs;
	}
}

function tsconfigFor(context: Context, fromRel: string): EffectiveTsconfig | null {
	const dir = posix.dirname(fromRel);
	if (!context.tsconfigByDir.has(dir)) {
		const cfg = governingTsconfig(context.view, context.members, fromRel);
		for (const spec of cfg?.unreadableExtends ?? []) context.notes.add(`tsconfig extends not in repo: ${spec}`);
		context.tsconfigByDir.set(dir, cfg);
	}
	return context.tsconfigByDir.get(dir) ?? null;
}

/** The nearest config of each framework kind at or above the file. */
function frameworkAliasesFor(context: Context, fromRel: string): FrameworkAliases[] {
	const dir = posix.dirname(fromRel);
	const cached = context.aliasesByDir.get(dir);
	if (cached) return cached;
	const byKind = new Map<string, FrameworkAliases>();
	for (const candidate of ancestors(fromRel)) {
		if (!context.aliasesAtDir.has(candidate)) context.aliasesAtDir.set(candidate, loadFrameworkAliases(context.view, candidate));
		for (const set of context.aliasesAtDir.get(candidate) ?? []) if (!byKind.has(set.kind)) byKind.set(set.kind, set);
	}
	const sets = [...byKind.values()];
	context.aliasesByDir.set(dir, sets);
	return sets;
}

/** A repo path that an alias points at: a file, a directory entry, or a workspace member behind node_modules. */
function probe(context: Context, candidate: string): string | null {
	return resolveNodeModulesPath(context.view, context.members, candidate)
		?? fileLike(context.view, candidate)
		?? resolveMemberOutputPath(context.view, context.members, candidate);
}

function firstFound(context: Context, candidates: readonly string[]): string | null {
	for (const candidate of candidates) {
		const found = probe(context, candidate);
		if (found) return found;
	}
	return null;
}

function viaTsconfig(context: Context, fromRel: string, specifier: string): AliasResolution | null {
	const cfg = tsconfigFor(context, fromRel);
	const candidates = cfg ? matchTsPaths(cfg, specifier) : null;
	if (!candidates) return null;
	const target = firstFound(context, candidates);
	return target ? { kind: "local", target } : { kind: "unresolved", reason: "alias-target-missing" };
}

function viaFramework(context: Context, fromRel: string, specifier: string): AliasResolution | null {
	const sets = frameworkAliasesFor(context, fromRel);
	if (sets.some(set => set.kind === "sveltekit") && SVELTEKIT_VIRTUAL.test(specifier)) return { kind: "virtual" };
	const match = matchFrameworkAlias(sets, specifier);
	if (!match) return null;
	if (match.bases === null) return { kind: "unresolved", reason: "alias-not-literal" };
	const target = firstFound(context, match.bases);
	return target ? { kind: "local", target } : { kind: "unresolved", reason: "alias-target-missing" };
}

function viaBaseUrl(context: Context, fromRel: string, specifier: string): AliasResolution | null {
	const baseUrl = tsconfigFor(context, fromRel)?.baseUrl;
	const target = typeof baseUrl === "string" ? fileLike(context.view, posix.join(baseUrl, specifier)) : null;
	return target ? { kind: "local", target } : null;
}

function viaWorkspace(context: Context, specifier: string): AliasResolution | null {
	const member = context.members
		.filter(item => specifier === item.name || specifier.startsWith(`${item.name}/`))
		.sort((a, b) => b.name.length - a.name.length)[0];
	if (!member) return null;
	const target = resolveMemberSubpath(context.view, member, specifier.slice(member.name.length + 1));
	return target ? { kind: "local", target } : { kind: "unresolved", reason: "workspace-entry-missing" };
}

function nearestPackageDir(context: Context, fromRel: string): string | null {
	return ancestors(fromRel).find(dir => context.view.isFile(posix.join(dir, "package.json"))) ?? null;
}

/** `#name` imports: the nearest package.json `imports` map; Nuxt's `#imports`, `#app` and similar are virtual. */
function resolveHashImport(context: Context, fromRel: string, specifier: string): AliasResolution | null {
	const dir = nearestPackageDir(context, fromRel);
	const pkg = dir === null ? null : parseJsonc(context.view.read(posix.join(dir, "package.json")) ?? "");
	const hasImports = isJsonObject(pkg) && isJsonObject(pkg.imports);
	const target = dir !== null && hasImports ? resolvePackageImport(context.view, dir, specifier) : null;
	if (target) return { kind: "local", target };
	if (frameworkAliasesFor(context, fromRel).some(set => set.kind === "nuxt")) return { kind: "virtual" };
	return hasImports ? { kind: "unresolved", reason: "package-import-missing" } : null;
}

function resolveBare(context: Context, fromRel: string, specifier: string): AliasResolution | null {
	if (specifier.startsWith("#")) return resolveHashImport(context, fromRel, specifier);
	const hits = [viaTsconfig, viaFramework].map(step => step(context, fromRel, specifier));
	const local = hits.find(hit => hit?.kind === "local" || hit?.kind === "virtual");
	if (local) return local;
	const based = viaBaseUrl(context, fromRel, specifier);
	if (based) return based;
	const workspace = viaWorkspace(context, specifier);
	if (workspace?.kind === "local") return workspace;
	return hits.find(hit => hit !== null) ?? workspace;
}

export function createImportResolver(view: RepoView): ImportResolver {
	const context: Context = { view, members: discoverWorkspaceMembers(view), tsconfigByDir: new Map(), aliasesByDir: new Map(), aliasesAtDir: new Map(), notes: new Set() };
	// One answer per (directory, specifier): the answer depends on the importer only through its directory.
	const answers = new Map<string, AliasResolution | null>();
	return {
		resolve(fromRel, specifier) {
			if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
			if (TOOL_VIRTUAL.test(specifier)) return { kind: "virtual" };
			if (/^[a-z][\w+.-]*:/.test(specifier)) return null;
			const key = `${posix.dirname(fromRel)}\0${specifier}`;
			if (!answers.has(key)) answers.set(key, resolveBare(context, fromRel, specifier));
			return answers.get(key) ?? null;
		},
		notes: () => [...context.notes].sort(),
	};
}
