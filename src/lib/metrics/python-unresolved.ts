import type { AnalyzedFile } from "./analysis.js";
import type { ScoringGraph } from "./graph-types.js";
import type { PythonImportRow } from "./python-measure.js";

function dirname(path: string): string {
	const index = path.lastIndexOf("/");
	return index < 0 ? "" : path.slice(0, index);
}

function join(...parts: string[]): string { return parts.filter(Boolean).join("/"); }

/** What the repository holds, by path: files, directories, and file stems (`a/_x.cpython-311.so` and `a/x.pyi` both give `a/_x`, `a/x`). */
class Tree {
	readonly files: Set<string>;
	readonly dirs = new Set<string>();
	readonly stems = new Set<string>();
	/** The repository builds native code (Cargo, CMake, Meson, Cython): an underscore module may be a compiled extension that no file shows. */
	readonly nativeBuild: boolean;
	constructor(paths: readonly string[]) {
		this.files = new Set(paths);
		this.nativeBuild = paths.some((path) => /(^|\/)(Cargo\.toml|CMakeLists\.txt|meson\.build|binding\.gyp)$|\.(pyx|rs)$/.test(path));
		for (const path of paths) {
			for (let dir = dirname(path); dir; dir = dirname(dir)) this.dirs.add(dir);
			const slash = path.lastIndexOf("/");
			const dot = path.indexOf(".", slash + 1);
			if (dot > slash + 1) this.stems.add(path.slice(0, dot));
		}
	}
	/** A module, a package, a namespace directory, or a native or stub file of that name. */
	holds(base: string, parts: readonly string[]): boolean {
		const joined = join(base, ...parts);
		return this.files.has(`${joined}.py`) || this.files.has(`${joined}/__init__.py`) || this.dirs.has(joined) || this.stems.has(joined);
	}
	/** A regular module or package (not a bare directory): only these shadow an installed package of the same name. */
	regular(base: string, name: string): boolean {
		const joined = join(base, name);
		return this.files.has(`${joined}.py`) || this.files.has(`${joined}/__init__.py`) || this.stems.has(joined);
	}
}

function packageTop(tree: Tree, directory: string): string {
	let current = directory;
	while (current && tree.files.has(join(current, "__init__.py"))) current = dirname(current);
	return current;
}

function relativeBase(from: string, level: number): string {
	const parts = dirname(from).split("/").filter(Boolean);
	return parts.slice(0, Math.max(0, parts.length - (level - 1))).join("/");
}

/**
 * The directories an absolute import searches, as `pythonModuleResolver` does: the root, `src/`, the top of the package chain,
 * and the file's own directory when that directory is a plain folder of scripts. A package's own directory is not searched:
 * a sibling `email.py` inside a package does not shadow the standard library.
 */
function absoluteBases(tree: Tree, from: string): string[] {
	const directory = dirname(from);
	const own = tree.files.has(join(directory, "__init__.py")) ? [] : [directory];
	return [...new Set(["", "src", ...own, packageTop(tree, directory)])];
}

function reasonFor(tree: Tree, from: string, reference: PythonImportRow): string | null {
	const parts = reference.module ? reference.module.split(".") : [];
	if (reference.level > 0) {
		// `from . import name` may name something that the package defines itself: not judged.
		return parts.length === 0 || tree.holds(relativeBase(from, reference.level), parts) ? null : "python-relative-target-missing";
	}
	const first = parts[0];
	if (first === undefined) return null;
	// A bare directory is a namespace package: an installed regular package of the same name wins, so it is not judged.
	const homes = absoluteBases(tree, from).filter((base) => tree.regular(base, first));
	if (homes.length === 0) return null;
	if (tree.nativeBuild && (parts[parts.length - 1] ?? "").startsWith("_")) return null;
	return homes.some((base) => tree.holds(base, parts)) ? null : "python-module-missing";
}

function specifierOf(reference: PythonImportRow): string {
	return `${".".repeat(reference.level)}${reference.module}`;
}

/**
 * Imports of a first-party module that the repository does not hold. A third-party or standard-library import is external and
 * never listed. `inventory` is every file path of the repository, so a generated or set-aside tree still counts as present.
 */
export function pythonUnresolvedImports(files: readonly AnalyzedFile[], inventory: readonly string[]): ScoringGraph["unresolved"] {
	const tree = new Tree(inventory);
	const found: ScoringGraph["unresolved"] = [];
	for (const file of files) {
		for (const reference of file.python?.row.imports ?? []) {
			const reason = reasonFor(tree, file.input.path, reference);
			if (reason !== null) found.push({ file: file.input.path, line: reference.line, specifier: specifierOf(reference), reason });
		}
	}
	return found;
}
