// ===========================================
// Kill proof — what vitest loads to configure a run (round-4 layouts, M2/M3/M4)
// ===========================================
// A receipt binds the runtime, and the runtime includes every file vitest reads to
// decide which tests run and what runs before them: the config, the configs of each
// `test.projects` entry, the configs' own static local imports (a `test: testOptions`
// imported from a helper), and the `setupFiles` / `globalSetup` any of them declare.
// Resolution follows vitest: the config is `vitest.config.*` then `vite.config.*`,
// `-c`/`--config` in `scripts.test` wins, an explicit flag wins over both; a project
// given as a directory takes the first default config name in it; setup paths resolve
// against the PROJECT ROOT (vite's `root`, the cwd — never the config file's directory,
// M4) for the root config and against the config's directory for a `test.projects`
// config (vitest's default root for one). The values are read from the TypeScript AST
// (`loadTsModule`): arrays, string literals and expression-free template literals bind;
// anything computed — a spread, a call, an identifier, a template with `${}` — is
// recorded as `unresolvable` on the receipt and reported by `--verify` as a limit,
// never silently dropped. Without `typescript` the old text pattern over the one config
// file is used and that too is recorded as unresolvable.

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type * as TS from "typescript";
import { compileGlob } from "../../lib/path-glob.js";
import { getExtension, JS_TS_EXTS } from "../checks/shared.js";
import { loadTsModule, type TsModule } from "../mutation/differential-fuzz-deps.js";
import { resolveImportPath } from "../project-graph/resolve.js";
import { staticLocalSpecifiers } from "./bound-imports.js";

/** vitest's own discovery order: `vitest.config.*` first, then `vite.config.*`, each in vitest's extension order. */
export const CONFIG_NAMES = ["vitest.config.ts", "vitest.config.mts", "vitest.config.cts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs", "vite.config.ts", "vite.config.mts", "vite.config.cts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];

/** Files bound through a config walk; every path is repo-relative POSIX and exists. */
export interface ConfigBinding {
	/** The configs of `test.projects` entries and the static local import closure of every config (root first). */
	configFiles: string[];
	/** `setupFiles` / `globalSetup` entries, resolved as vitest resolves them. */
	setupFiles: string[];
	/** Declarations the walk could not read statically, as `<config>: <what>`; a `--verify` limit, never a drop. */
	unresolvable: string[];
}

const DECLARED_KEYS = new Set(["setupFiles", "globalSetup"]);
/** Files the import closure of all configs may reach; a config helper tree is small, and the cap keeps a stray barrel bounded. */
const MAX_CONFIG_IMPORTS = 50;
/** Directory depth a `test.projects` glob may descend: one level for `packages/<star>`, three for `apps/<star>/packages/<star>`. */
const MAX_PROJECT_GLOB_DEPTH = 8;

export const normalizeRel = (path: string): string => path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");

/** `rel` inside the project, as a repo-relative POSIX path; null when it escapes. */
function insideRoot(root: string, abs: string): string | null {
	const rel = normalizeRel(relative(root, abs));
	return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

function propertyName(ts: TsModule, node: TS.PropertyAssignment): string | null {
	const name = node.name;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
	return null;
}

/** A static string: a string literal or a template literal without expressions; null for anything computed. */
function staticString(ts: TsModule, node: TS.Node): string | null {
	return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/** The static strings of an array literal or a single string; `computed` names what could not be read (empty when all could). */
function staticStrings(ts: TsModule, node: TS.Node): { values: string[]; computed: string[] } {
	const single = staticString(ts, node);
	if (single !== null) return { values: [single], computed: [] };
	if (!ts.isArrayLiteralExpression(node)) return { values: [], computed: [`is computed (${ts.SyntaxKind[node.kind]})`] };
	const values: string[] = [], computed: string[] = [];
	node.elements.forEach((element, index) => {
		const text = staticString(ts, element);
		if (text !== null) values.push(text);
		else computed.push(`[${index}] is computed (${ts.SyntaxKind[element.kind]})`);
	});
	return { values, computed };
}

interface Declarations { setup: string[]; projects: string[]; root: string | null; unresolvable: string[]; }

/** Every `setupFiles` / `globalSetup` / `projects` / `test.root` property assignment in the file, wherever it sits. */
function declarationsIn(ts: TsModule, file: string, text: string): Declarations {
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, getExtension(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const out: Declarations = { setup: [], projects: [], root: null, unresolvable: [] };
	const visit = (node: TS.Node): void => {
		if (ts.isPropertyAssignment(node)) {
			const key = propertyName(ts, node);
			if (key !== null && (DECLARED_KEYS.has(key) || key === "projects")) {
				const { values, computed } = staticStrings(ts, node.initializer);
				(key === "projects" ? out.projects : out.setup).push(...values);
				out.unresolvable.push(...computed.map(what => `${file}: ${key}${what.startsWith("[") ? what : ` ${what}`}`));
			} else if (key === "root" && isTestObject(ts, node)) {
				const value = staticString(ts, node.initializer);
				if (value === null) out.unresolvable.push(`${file}: test.root is computed (${ts.SyntaxKind[node.initializer.kind]})`);
				else out.root = value;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

/** `root:` counts only directly under a `test:` object (vite's own `root` and `resolve.alias.root` are not vitest's root). */
function isTestObject(ts: TsModule, property: TS.PropertyAssignment): boolean {
	const object = property.parent;
	const owner = ts.isObjectLiteralExpression(object) ? object.parent : undefined;
	return owner !== undefined && ts.isPropertyAssignment(owner) && propertyName(ts, owner) === "test";
}

function isDirectory(abs: string): boolean {
	try {
		return statSync(abs).isDirectory();
	} catch {
		return false;
	}
}

/** Repo-relative entries (files and directories) under `root` down to `depth`, skipping node_modules and .git. */
function entriesTo(root: string, depth: number): string[] {
	const out: string[] = [];
	const walk = (rel: string, left: number): void => {
		let names: string[];
		try {
			names = readdirSync(join(root, rel));
		} catch {
			return;
		}
		for (const name of names) {
			if (name === "node_modules" || name === ".git") continue;
			const child = rel ? `${rel}/${name}` : name;
			out.push(child);
			if (left > 0 && isDirectory(join(root, child))) walk(child, left - 1);
		}
	};
	walk("", depth);
	return out;
}

/** The config file a `test.projects` entry names: a directory takes its first default config name; a file is itself. */
function projectConfigs(root: string, patterns: readonly string[]): { configs: string[]; unresolvable: string[] } {
	const matched = new Set<string>(), unresolvable: string[] = [];
	const positive = patterns.filter(p => !p.startsWith("!")), negative = patterns.filter(p => p.startsWith("!")).map(p => normalizeRel(p.slice(1)));
	for (const raw of positive) {
		const pattern = normalizeRel(raw);
		const glob = /[*?[{]/.test(pattern);
		const candidates = glob ? entriesTo(root, Math.min(MAX_PROJECT_GLOB_DEPTH, pattern.includes("**") ? MAX_PROJECT_GLOB_DEPTH : pattern.split("/").length)).filter(rel => compileGlob(pattern).test(rel)) : [pattern];
		for (const rel of candidates) {
			if (negative.some(neg => compileGlob(neg).test(rel))) continue;
			const abs = join(root, rel);
			if (isDirectory(abs)) {
				const name = CONFIG_NAMES.find(candidate => existsSync(join(abs, candidate)));
				if (name !== undefined) matched.add(`${rel}/${name}`);
			} else if (existsSync(abs)) matched.add(rel);
			else if (!glob) unresolvable.push(`projects entry ${JSON.stringify(raw)} does not exist`);
		}
	}
	return { configs: [...matched], unresolvable };
}

/** The static local (relative) import closure of a config, repo-relative, bounded. */
function configImportClosure(root: string, config: string, seen: Set<string>): string[] {
	const out: string[] = [];
	const queue = [config];
	while (queue.length > 0 && seen.size < MAX_CONFIG_IMPORTS) {
		const file = queue.shift() as string;
		const abs = join(root, file);
		if (!JS_TS_EXTS.has(getExtension(file)) || !existsSync(abs)) continue;
		let content: string;
		try {
			content = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		for (const specifier of staticLocalSpecifiers(content, abs)) {
			const target = resolveImportPath(abs, specifier);
			const rel = target === null ? null : insideRoot(root, target);
			if (rel === null || seen.has(rel) || rel.split("/").includes("node_modules")) continue;
			seen.add(rel);
			out.push(rel);
			queue.push(rel);
		}
	}
	return out;
}

/** vitest's base for a config's relative paths: `test.root` when declared (resolved from the cwd, as vite does), else `defaultBase`. */
function baseFor(root: string, declaredRoot: string | null, defaultBase: string): string {
	return declaredRoot === null ? defaultBase : resolve(root, declaredRoot);
}

/**
 * Walk one config and its import closure for declarations; setup paths resolve against `base` (the project root for
 * the root config, the config's directory for a project config). Bare specifiers (`dotenv/config`) are packages, not
 * project files, and are not bound; a relative or absolute path that does not exist is a limit.
 */
function walkConfig(ts: TsModule, root: string, config: string, defaultBase: string, seen: Set<string>, binding: ConfigBinding): string[] {
	const closure = configImportClosure(root, config, seen);
	const files = [config, ...closure];
	const declared = files.map(file => declarationsIn(ts, file, readFileSync(join(root, file), "utf8")));
	const base = baseFor(root, declared[0]?.root ?? null, defaultBase);
	binding.configFiles.push(...closure);
	declared.forEach((decl, index) => {
		binding.unresolvable.push(...decl.unresolvable);
		for (const entry of decl.setup) {
			if (!entry.startsWith(".") && !isAbsolute(entry)) continue;
			const rel = insideRoot(root, resolve(base, entry));
			if (rel !== null && existsSync(join(root, rel))) {
				if (!binding.setupFiles.includes(rel)) binding.setupFiles.push(rel);
			} else binding.unresolvable.push(`${files[index]}: setup file ${JSON.stringify(entry)} is not a project file (resolved against ${relative(root, base) || "."})`);
		}
	});
	return declared.flatMap(decl => decl.projects);
}

/** The one config file text pattern the receipt used before the AST walk; only reached without `typescript`. */
function textDeclaredSetup(root: string, config: string): string[] {
	const text = readFileSync(join(root, config), "utf8"), out: string[] = [];
	for (const match of text.matchAll(/\b(?:setupFiles|globalSetup)\s*:\s*(\[[^\]]*\]|["'`][^"'`]+["'`])/g)) {
		for (const literal of (match[1] ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)) {
			const rel = insideRoot(root, resolve(root, literal[1] ?? ""));
			if (rel !== null && existsSync(join(root, rel)) && !out.includes(rel)) out.push(rel);
		}
	}
	return out;
}

/** Everything vitest loads from `configPath` (repo-relative) to configure a run of `root`; empty when there is no config. */
export function bindVitestConfig(root: string, configPath: string | null): ConfigBinding {
	const binding: ConfigBinding = { configFiles: [], setupFiles: [], unresolvable: [] };
	if (configPath === null || !existsSync(join(root, configPath))) return binding;
	const ts = loadTsModule();
	if (ts === null) {
		binding.setupFiles.push(...textDeclaredSetup(root, configPath));
		binding.unresolvable.push(`${configPath}: typescript is not installed, so the config was read by text pattern only (projects, imported helpers and computed values are not bound)`);
		return binding;
	}
	const seen = new Set<string>([configPath]);
	const projects = walkConfig(ts, root, configPath, root, seen, binding);
	const found = projectConfigs(root, projects);
	binding.unresolvable.push(...found.unresolvable.map(what => `${configPath}: ${what}`));
	for (const project of found.configs) {
		if (seen.has(project)) continue;
		seen.add(project);
		binding.configFiles.push(project);
		// A project config's own `projects` is not followed: vitest does not nest workspaces.
		walkConfig(ts, root, project, dirname(join(root, project)), seen, binding);
	}
	return binding;
}
