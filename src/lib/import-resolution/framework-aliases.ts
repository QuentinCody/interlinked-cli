// ===========================================
// Framework aliases that live in config files as plain literals
// ===========================================
// SvelteKit `$lib` (default `src/lib`) and `kit.alias`; Vite `resolve.alias`;
// Nuxt `~`, `@`, `~~`, `@@`. The config file is read as TEXT and parsed with
// the TypeScript parser: it is never imported or executed. A value that is
// not a literal (a variable, a function call with computed arguments) is kept
// as an alias with a null base, so the caller can count it as unresolved.
//
// Sources: https://svelte.dev/docs/kit/configuration#alias and #files,
// https://vite.dev/config/shared-options.html#resolve-alias,
// https://nuxt.com/docs/api/nuxt-config#alias.

import { posix } from "node:path";
import type * as TS from "typescript";
import { parseTsSource } from "../../harness/checks/cyclomatic-ast.js";
import type { RepoView } from "./repo-view.js";

interface AliasEntry { key: string; bases: string[] | null; }
export interface FrameworkAliases { dir: string; kind: "sveltekit" | "vite" | "nuxt"; entries: AliasEntry[]; }

const CONFIG_STEMS: ReadonlyArray<{ stem: string; kind: FrameworkAliases["kind"] }> = [
	{ stem: "svelte.config", kind: "sveltekit" },
	{ stem: "vite.config", kind: "vite" },
	{ stem: "nuxt.config", kind: "nuxt" },
];
const CONFIG_EXTENSIONS = [".js", ".ts", ".mjs", ".mts", ".cjs", ".cts"];
const PATH_CALLS = new Set(["path.resolve", "resolve", "path.join", "join"]);

function propertyName(ts: typeof TS, name: TS.PropertyName): string | null {
	return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : null;
}

function literalText(ts: typeof TS, node: TS.Node): string | null {
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/** `new URL('./x', import.meta.url)`: the first argument, relative to the config file. */
function urlLiteral(ts: typeof TS, node: TS.Node): string | null {
	const target = ts.isPropertyAccessExpression(node) && node.name.text === "pathname" ? node.expression : node;
	if (!ts.isNewExpression(target) || target.expression.getText() !== "URL") return null;
	const [first, second] = target.arguments ?? [];
	return first && second?.getText() === "import.meta.url" ? literalText(ts, first) : null;
}

function pathCallArguments(ts: typeof TS, node: TS.CallExpression): string[] | null {
	const parts: string[] = [];
	for (const arg of node.arguments) {
		const text = arg.getText() === "__dirname" ? "." : literalText(ts, arg);
		if (text === null) return null;
		parts.push(text);
	}
	return parts;
}

/** Repo-relative path a literal expression names, relative to the config directory `dir`; null when it is not a literal. */
function evalPath(ts: typeof TS, node: TS.Node, dir: string): string | null {
	const plain = literalText(ts, node) ?? urlLiteral(ts, node);
	if (plain !== null) return posix.join(dir, plain);
	if (ts.isCallExpression(node) && node.expression.getText() === "fileURLToPath" && node.arguments[0]) return evalPath(ts, node.arguments[0], dir);
	if (!ts.isCallExpression(node) || !PATH_CALLS.has(node.expression.getText())) return null;
	const parts = pathCallArguments(ts, node);
	return parts && !parts.some(part => part.startsWith("/")) ? posix.join(dir, ...parts) : null;
}

function objectProperties(ts: typeof TS, node: TS.Node | undefined): TS.PropertyAssignment[] {
	return node && ts.isObjectLiteralExpression(node) ? node.properties.filter(ts.isPropertyAssignment) : [];
}

function findProperty(ts: typeof TS, object: TS.Node | undefined, name: string): TS.Expression | undefined {
	return objectProperties(ts, object).find(prop => propertyName(ts, prop.name) === name)?.initializer;
}

function objectEntries(ts: typeof TS, node: TS.Node | undefined, dir: string): AliasEntry[] {
	const entries: AliasEntry[] = [];
	for (const prop of objectProperties(ts, node)) {
		const key = propertyName(ts, prop.name);
		const target = evalPath(ts, prop.initializer, dir);
		if (key !== null) entries.push({ key, bases: target === null ? null : [target] });
	}
	return entries;
}

function arrayEntries(ts: typeof TS, node: TS.Node | undefined, dir: string): AliasEntry[] {
	if (!node || !ts.isArrayLiteralExpression(node)) return [];
	const entries: AliasEntry[] = [];
	for (const item of node.elements) {
		const find = findProperty(ts, item, "find");
		const key = find ? literalText(ts, find) : null;
		const replacement = findProperty(ts, item, "replacement");
		const target = replacement ? evalPath(ts, replacement, dir) : null;
		if (key !== null) entries.push({ key, bases: target === null ? null : [target] });
	}
	return entries;
}

/** Every object literal in the tree that holds a property called `name`, outermost first. */
function propertyValues(ts: typeof TS, root: TS.Node, name: string): TS.Expression[] {
	const found: TS.Expression[] = [];
	const visit = (node: TS.Node): void => {
		if (ts.isPropertyAssignment(node) && propertyName(ts, node.name) === name) found.push(node.initializer);
		ts.forEachChild(node, visit);
	};
	visit(root);
	return found;
}

function sveltekitEntries(ts: typeof TS, root: TS.Node, dir: string): AliasEntry[] {
	const kits = propertyValues(ts, root, "kit");
	const lib = kits.map(kit => findProperty(ts, findProperty(ts, kit, "files"), "lib")).find(Boolean);
	const libBase = lib ? evalPath(ts, lib, dir) : posix.join(dir, "src/lib");
	const entries: AliasEntry[] = [{ key: "$lib", bases: libBase === null ? null : [libBase] }];
	for (const kit of kits) entries.push(...objectEntries(ts, findProperty(ts, kit, "alias"), dir));
	return entries;
}

function viteEntries(ts: typeof TS, root: TS.Node, dir: string): AliasEntry[] {
	return propertyValues(ts, root, "resolve").flatMap(resolve => {
		const alias = findProperty(ts, resolve, "alias");
		return [...objectEntries(ts, alias, dir), ...arrayEntries(ts, alias, dir)];
	});
}

function nuxtEntries(dir: string): AliasEntry[] {
	const source = [posix.join(dir, "."), posix.join(dir, "app")];
	return [{ key: "~", bases: source }, { key: "@", bases: source }, { key: "~~", bases: [dir] }, { key: "@@", bases: [dir] }];
}

function entriesFor(view: RepoView, kind: FrameworkAliases["kind"], rel: string, dir: string): AliasEntry[] {
	if (kind === "nuxt") return nuxtEntries(dir);
	const parsed = parseTsSource(view.read(rel) ?? "", rel);
	if (!parsed) return [];
	return kind === "sveltekit" ? sveltekitEntries(parsed.ts, parsed.sf, dir) : viteEntries(parsed.ts, parsed.sf, dir);
}

/** Aliases that the framework configs located directly in `dir` define. Empty when there are none. */
export function loadFrameworkAliases(view: RepoView, dir: string): FrameworkAliases[] {
	const found: FrameworkAliases[] = [];
	for (const { stem, kind } of CONFIG_STEMS) {
		const rel = CONFIG_EXTENSIONS.map(ext => posix.join(dir, `${stem}${ext}`)).find(candidate => view.isFile(candidate));
		const entries = rel ? entriesFor(view, kind, rel, dir) : [];
		if (rel && entries.length) found.push({ dir, kind, entries });
	}
	return found;
}

function suffixAfter(key: string, specifier: string): string | null {
	if (key.endsWith("/*")) return specifier.startsWith(key.slice(0, -1)) ? specifier.slice(key.length - 1) : null;
	if (specifier === key) return "";
	return specifier.startsWith(`${key}/`) ? specifier.slice(key.length) : null;
}

/** `{ bases }` for the longest alias key that fits the specifier (bases null = the value is not a literal), or null when none fits. */
export function matchFrameworkAlias(sets: readonly FrameworkAliases[], specifier: string): { bases: string[] | null } | null {
	let best: { key: string; rest: string; entry: AliasEntry } | null = null;
	for (const entry of sets.flatMap(set => set.entries)) {
		const rest = suffixAfter(entry.key, specifier);
		if (rest !== null && (!best || entry.key.length > best.key.length)) best = { key: entry.key, rest, entry };
	}
	if (!best) return null;
	const rest = best.rest.replace(/^\//, "");
	return { bases: best.entry.bases?.map(base => posix.join(base.replace(/\/\*$/, ""), rest)) ?? null };
}
