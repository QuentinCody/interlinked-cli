import { posix } from "node:path";
import type { AnalyzedFile } from "./analysis.js";
import type { RepositoryInventory } from "./measurement-types.js";
import { pythonPublicRoots } from "./python-public-roots.js";

const SCRIPT_TABLES = new Set(["project.scripts", "project.gui-scripts", "tool.poetry.scripts"]);
const SCRIPT_GROUPS = new Set(["console_scripts", "gui_scripts"]);
const TARGET = /^([\w.-]+)\s*=\s*["']?([A-Za-z_][\w.]*):[\w.]+/;
const QUOTED_TARGET = /["']\s*([\w.-]+)\s*=\s*([A-Za-z_][\w.]*):[\w.]+\s*["']/g;

export interface ScriptEntry { name: string; module: string; }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function entry(match: RegExpExecArray | RegExpMatchArray | null): ScriptEntry[] {
	return match?.[1] && match[2] ? [{ name: match[1], module: match[2] }] : [];
}

function tomlTargets(content: string): ScriptEntry[] {
	let table = "";
	const found: ScriptEntry[] = [];
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		const header = /^\[([^\][]+)\]$/.exec(line);
		if (header) { table = (header[1] ?? "").trim(); continue; }
		found.push(...entry(SCRIPT_TABLES.has(table) ? TARGET.exec(line) : null));
	}
	return found;
}

function cfgTargets(content: string): ScriptEntry[] {
	let section = "", group = "";
	const found: ScriptEntry[] = [];
	for (const raw of content.split(/\r?\n/)) {
		const header = /^\[([^\][]+)\]\s*$/.exec(raw);
		if (header) { section = (header[1] ?? "").trim(); group = ""; continue; }
		if (section !== "options.entry_points") continue;
		const key = /^([\w.-]+)\s*=\s*$/.exec(raw);
		if (key) { group = key[1] ?? ""; continue; }
		found.push(...entry(/^\s+/.test(raw) && SCRIPT_GROUPS.has(group) ? TARGET.exec(raw.trim()) : null));
	}
	return found;
}

/** Declared console or GUI scripts (`name = module:function`) in `pyproject.toml`, `setup.cfg` and `setup.py`. */
export function scriptEntries(path: string, content: string): ScriptEntry[] {
	const name = posix.basename(path);
	if (name === "pyproject.toml") return tomlTargets(content);
	if (name === "setup.cfg") return cfgTargets(content);
	if (name === "setup.py" && /\b(console_scripts|gui_scripts)\b/.test(content)) return [...content.matchAll(QUOTED_TARGET)].flatMap(entry);
	return [];
}

/** The modules those scripts run. */
export function scriptTargets(path: string, content: string): string[] {
	return unique(scriptEntries(path, content).map(item => item.module));
}

/** A dotted module name to a known `.py` file or package `__init__.py`, searched under the manifest directory, its `src/`, the root and `src/`. */
export function moduleFile(dotted: string, base: string, known: ReadonlySet<string>): string | null {
	const path = dotted.split(".").join("/");
	for (const root of unique([base, posix.join(base, "src"), "", "src"])) {
		for (const candidate of [posix.join(root, `${path}.py`), posix.join(root, path, "__init__.py")]) if (known.has(candidate)) return candidate;
	}
	return null;
}

function runsAsScript(file: AnalyzedFile): boolean {
	return file.python?.row.facts.mainGuard === true || posix.basename(file.input.path) === "__main__.py";
}

/** `python file.py` and `python -m module` lines in documentation. */
function documentedTargets(content: string, known: ReadonlySet<string>): (string | null)[] {
	return [...content.matchAll(/\bpython3?(?:\.\d+)?\s+(?:-m\s+([A-Za-z_][\w.]*)|([\w./-]+\.py)\b)/g)]
		.map(match => match[1] ? moduleFile(match[1], "", known) : posix.normalize(match[2] ?? ""));
}

function ancestorInits(path: string, known: ReadonlySet<string>): string[] {
	const found: string[] = [];
	for (let directory = posix.dirname(path); ; directory = posix.dirname(directory)) {
		const init = posix.join(directory === "." ? "" : directory, "__init__.py");
		if (init !== path && known.has(init)) found.push(init);
		if (directory === "." || directory === "/") return found;
	}
}

/**
 * Modules reached from `entries` by resolved imports. Importing a Python module first runs the `__init__.py` of every
 * parent package, so those files are reached too, and so is whatever they import. JavaScript has no such rule.
 */
export function reachableWithPackageInits(entries: readonly string[], reach: (roots: readonly string[]) => Set<string>, known: ReadonlySet<string>): Set<string> {
	let reached = reach(entries);
	for (;;) {
		const missing = [...reached].filter(path => path.endsWith(".py")).flatMap(path => ancestorInits(path, known)).filter(init => !reached.has(init));
		if (missing.length === 0) return reached;
		reached = reach([...reached, ...missing]);
	}
}

export interface PythonEntries { entries: string[]; publicEntries: string[]; }

/**
 * Python entry points, the analogue of `discoverScoringEntries`: declared scripts (also public), product files with a
 * `__main__` guard or named `__main__.py`, and files that documentation runs with `python file.py` or `python -m module`.
 * Entry points named only in strings (Django settings, plugin groups) are not discovered.
 */
export function pythonScoringEntries(inventory: RepositoryInventory, files: readonly AnalyzedFile[], known: ReadonlySet<string>): PythonEntries {
	const products = new Set(files.filter(file => file.python && file.input.role === "product").map(file => file.input.path));
	const entries = new Set<string>(), publicEntries = new Set<string>();
	const add = (path: string | null, isPublic: boolean): void => {
		if (path === null || !products.has(path)) return;
		entries.add(path);
		if (isPublic) publicEntries.add(path);
	};
	for (const file of files) if (runsAsScript(file)) add(file.input.path, false);
	for (const file of inventory.files) {
		const base = posix.dirname(file.path) === "." ? "" : posix.dirname(file.path);
		for (const target of scriptTargets(file.path, file.content)) add(moduleFile(target, base, known), true);
		if (file.role === "documentation") for (const path of documentedTargets(file.content, known)) add(path, false);
	}
	const roots = pythonPublicRoots(inventory.files, known, moduleFile);
	for (const path of roots.toolFiles) add(path, false);
	for (const path of roots.publicApi) add(path, true);
	return { entries: [...entries].sort(), publicEntries: [...publicEntries].sort() };
}
