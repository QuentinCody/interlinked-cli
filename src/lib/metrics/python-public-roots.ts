// Python entry roots that no script table declares: tool files and the public API of a library.
//
// RULES (each is a root of the disconnected-module and reach graph):
//   tool-file   `setup.py`, `conftest.py`, `noxfile.py`, `tasks.py`, `manage.py` and `docs/conf.py`
//               are run by a tool (a build backend, pytest, nox, invoke, Django, Sphinx), never imported.
//   public-api  in a repository that DISTRIBUTES a package (a pyproject.toml with `[project]` or
//               `[tool.poetry]`, a setup.cfg with `[metadata]`, or a setup.py), (1) the `__init__.py` of each
//               top-level package next to the manifest or under its `src/`, and (2) every module that a
//               test or a documentation file imports by its dotted name under such a package, are roots.
//               Importing from a root reaches whatever the root imports or re-exports.
// A top-level directory named like a test, docs or example tree is not a distributed package.
// Tests that reach a module make it a public root only when it is imported by its package-qualified name.

import { posix } from "node:path";
import type { InventoryFile } from "./measurement-types.js";

/** Resolves a dotted module name to a known file (`moduleFile` in python-entries.ts; passed in to avoid an import cycle). */
export type ModuleResolver = (dotted: string, base: string, known: ReadonlySet<string>) => string | null;

const TOOL_FILES: ReadonlySet<string> = new Set(["setup.py", "conftest.py", "noxfile.py", "tasks.py", "manage.py"]);
const NON_PACKAGE_DIRS: ReadonlySet<string> = new Set(["tests", "test", "testing", "docs", "doc", "examples", "example", "scripts", "benchmarks", "tools", "build", "dist"]);
const MANIFESTS: ReadonlySet<string> = new Set(["pyproject.toml", "setup.cfg", "setup.py"]);

export interface PythonPublicRoots { toolFiles: string[]; publicApi: string[]; }

function distributes(file: InventoryFile): boolean {
	const name = posix.basename(file.path);
	if (name === "pyproject.toml") return /^\[(?:project|tool\.poetry)\]/m.test(file.content);
	if (name === "setup.cfg") return /^\[metadata\]/m.test(file.content);
	return name === "setup.py" && /\bsetup\s*\(/.test(file.content);
}

/** Top-level package names and their `__init__.py`, next to a manifest directory or under its `src/`. */
function packagesUnder(base: string, known: ReadonlySet<string>): { name: string; init: string }[] {
	const found: { name: string; init: string }[] = [];
	for (const root of [base, posix.join(base, "src")]) {
		for (const path of known) {
			const match = new RegExp(`^${root === "" || root === "." ? "" : `${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`}([A-Za-z_]\\w*)/__init__\\.py$`).exec(path);
			if (match?.[1] && !NON_PACKAGE_DIRS.has(match[1])) found.push({ name: match[1], init: path });
		}
	}
	return found;
}

function importedNames(text: string, pattern: RegExp): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(pattern)) {
		names.push(match[1] ?? "");
		for (const item of (match[2] ?? "").split(",")) {
			const name = item.trim().split(/\s+/)[0] ?? "";
			if (/^[A-Za-z_]\w*$/.test(name)) names.push(`${match[1]}.${name}`);
		}
	}
	return names.filter(Boolean);
}

export function pythonPublicRoots(files: readonly InventoryFile[], known: ReadonlySet<string>, resolve: ModuleResolver): PythonPublicRoots {
	const toolFiles = [...known].filter(path => TOOL_FILES.has(posix.basename(path)) || /(?:^|\/)docs?\/conf\.py$/.test(path));
	const publicApi = new Set<string>();
	const bases = files.filter(file => MANIFESTS.has(posix.basename(file.path)) && distributes(file)).map(file => posix.dirname(file.path) === "." ? "" : posix.dirname(file.path));
	for (const base of new Set(bases)) {
		const packages = packagesUnder(base, known);
		for (const item of packages) publicApi.add(item.init);
		const names = [...new Set(packages.map(item => item.name))];
		if (names.length === 0) continue;
		const pattern = new RegExp(String.raw`\b(?:from|import)\s+((?:${names.join("|")})(?:\.\w+)*)(?:\s+import\s+([\w ,]+))?`, "g");
		for (const file of files) {
			if (file.role !== "test" && file.role !== "documentation") continue;
			for (const dotted of importedNames(file.content, pattern)) {
				const path = resolve(dotted, base, known);
				if (path !== null) publicApi.add(path);
			}
		}
	}
	return { toolFiles: toolFiles.sort(), publicApi: [...publicApi].sort() };
}
