// Entry roots of a Python tree, by rule. A root is a file that something outside the import graph
// starts or loads: a console script, a `__main__` guard, a command in CI, a Django settings string.
// Every root carries the kind and the evidence, so an owner can disagree with a single rule.

import { posix } from "node:path";
import type { RawGraph } from "../../commands/check-python-run.js";
import { commandReferences, entryPointTargets } from "./entry-text.js";
import type { EntryRoot, PyModule, RootKind } from "./types.js";

export interface RootInputs {
	modules: ReadonlyMap<string, PyModule>;
	/** Directories that absolute imports resolve from (`.`, `src`, declared roots). */
	importRoots: readonly string[];
	stringTargets: RawGraph["string_targets"];
	/** Every file of the project (not only Python), repository-relative. */
	projectFiles: readonly string[];
	read: (path: string) => string | null;
	/** The first bytes of a file. */
	head: (path: string) => string | null;
}

const FRAMEWORK_FILES = new Set(["manage.py", "wsgi.py", "asgi.py", "setup.py", "noxfile.py"]);
const COMMAND_NAMES = /^(?:makefile|gnumakefile|justfile|dockerfile[\w.-]*|procfile[\w.-]*|tox\.ini|package\.json|\.pre-commit-config\.yaml)$/i;
const COMMAND_EXTENSIONS = new Set([".sh", ".bash", ".mk", ".service", ".yml", ".yaml", ".conf", ".cfg", ".ini", ".toml"]);
const DOC_EXTENSIONS = new Set([".md", ".rst", ".txt", ".adoc"]);
const MANIFEST_NAMES = new Set(["pyproject.toml", "setup.cfg", "setup.py"]);
const DJANGO_APP_FILES = ["models.py", "admin.py", "apps.py"];
const DJANGO_APP_DIRS = ["management/commands/", "migrations/", "templatetags/"];
const DJANGO_SETTING = /DJANGO_SETTINGS_MODULE["'\s,:=]+([A-Za-z_][\w.]*)/;
const SHEBANG = /^#!.*\bpython/;
const TEXT_BYTES = 512 * 1024;

/** A dotted module name to the file it names (module or package `__init__.py`), searched under each base directory. */
export function resolveModuleName(dotted: string, bases: readonly string[], modules: ReadonlyMap<string, PyModule>): string | null {
	const path = dotted.split(".").join("/");
	for (const base of bases) {
		const prefix = base === "." || base === "" ? "" : `${base}/`;
		for (const candidate of [`${prefix}${path}.py`, `${prefix}${path}/__init__.py`]) if (modules.has(candidate)) return candidate;
	}
	return null;
}

class RootSet {
	private readonly seen = new Set<string>();
	readonly roots: EntryRoot[] = [];

	add(path: string | null, kind: RootKind, evidence: string): void {
		if (path === null) return;
		const key = `${path}\0${kind}`;
		if (this.seen.has(key)) return;
		this.seen.add(key);
		this.roots.push({ path, kind, evidence });
	}
}

function ruleRoots(inputs: RootInputs, set: RootSet): void {
	for (const module of inputs.modules.values()) {
		const name = posix.basename(module.path);
		if (module.role === "test") set.add(module.path, name === "conftest.py" ? "conftest" : "test", name === "conftest.py" ? "conftest.py is collected by pytest" : "test file");
		else if (name === "__main__.py") set.add(module.path, "main-module", "python -m runs __main__.py");
		else if (module.mainGuard) set.add(module.path, "main-guard", 'has an `if __name__ == "__main__":` block');
		else if (FRAMEWORK_FILES.has(name) || (name === "conf.py" && module.role === "docs")) set.add(module.path, "framework-file", `${name} is run or loaded by its tool`);
		else if (SHEBANG.test(inputs.head(module.path) ?? "")) set.add(module.path, "shebang", "starts with a python shebang line");
	}
}

function alembicRoots(inputs: RootInputs, set: RootSet): void {
	const files = new Set(inputs.projectFiles);
	for (const module of inputs.modules.values()) {
		if (posix.basename(module.path) !== "env.py") continue;
		const dir = posix.dirname(module.path);
		const prefix = dir === "." ? "" : `${dir}/`;
		if (!files.has(`${prefix}script.py.mako`)) continue;
		set.add(module.path, "alembic", "alembic env.py (script.py.mako beside it)");
		for (const other of inputs.modules.keys()) if (other.startsWith(`${prefix}versions/`)) set.add(other, "alembic", "alembic revision file");
	}
}

/** A glob such as `extension_*\/provider_*.py` as a regular expression over the tail of a path; null when it holds no literal part to match on. */
function globTail(glob: string): RegExp | null {
	const literal = glob.replace(/\.py$/, "").replace(/[*?/]/g, "");
	if (literal === "") return null;
	const body = glob
		.split(/(\*\*\/?|\*|\?)/)
		.map((part) => (part.startsWith("**") ? "(?:.*/)?" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
		.join("");
	return new RegExp(`(?:^|/)${body}$`);
}

/** Files that a module with a computed import names by a glob pattern are loaded by that module. */
function loaderGlobRoots(inputs: RootInputs, set: RootSet): void {
	for (const loader of inputs.modules.values()) {
		for (const glob of loader.loaderGlobs) {
			const pattern = globTail(glob);
			if (pattern === null) continue;
			for (const path of inputs.modules.keys()) {
				if (path !== loader.path && pattern.test(path)) set.add(path, "loader-glob", `${loader.path} loads files matching "${glob}"`);
			}
		}
	}
}

function manifestRoots(inputs: RootInputs, set: RootSet): void {
	for (const file of inputs.projectFiles) {
		if (!MANIFEST_NAMES.has(posix.basename(file))) continue;
		const content = inputs.read(file);
		if (content === null) continue;
		const dir = posix.dirname(file);
		const bases = [dir, posix.join(dir, "src"), ...inputs.importRoots].map((base) => (base === "." ? "" : base));
		for (const target of entryPointTargets(file, content)) {
			set.add(resolveModuleName(target.module, bases, inputs.modules), target.kind, `${file} ${target.evidence}`);
		}
	}
}

function isCommandFile(path: string): boolean {
	const name = posix.basename(path);
	return COMMAND_NAMES.test(name) || COMMAND_EXTENSIONS.has(posix.extname(name).toLowerCase());
}

function commandRoots(inputs: RootInputs, set: RootSet): void {
	for (const file of inputs.projectFiles) {
		const extension = posix.extname(file).toLowerCase();
		const mode = DOC_EXTENSIONS.has(extension) ? "document" : isCommandFile(file) ? "command" : null;
		if (mode === null || inputs.modules.has(file)) continue;
		const content = inputs.read(file);
		if (content === null) continue;
		const refs = commandReferences(content, mode);
		const dir = posix.dirname(file);
		const kind = mode === "document" ? "documented-command" : "command";
		for (const target of refs.files) {
			const local = dir === "." ? target : posix.join(dir, target);
			const found = inputs.modules.has(target) ? target : inputs.modules.has(local) ? local : null;
			set.add(found, kind, `${file} runs ${target}`);
		}
		for (const dotted of refs.modules) set.add(resolveModuleName(dotted, [...inputs.importRoots, dir], inputs.modules), kind, `${file} runs -m ${dotted}`);
	}
}

function djangoAppRoots(inputs: RootInputs, appTarget: string, set: RootSet): void {
	const dir = posix.dirname(appTarget);
	const prefix = dir === "." ? "" : `${dir}/`;
	set.add(appTarget, "django-app", "INSTALLED_APPS entry");
	for (const file of DJANGO_APP_FILES) if (inputs.modules.has(`${prefix}${file}`)) set.add(`${prefix}${file}`, "django-app", `Django loads ${file} of an installed app`);
	for (const path of inputs.modules.keys()) {
		if (DJANGO_APP_DIRS.some((part) => path.startsWith(`${prefix}${part}`))) set.add(path, "django-app", "Django loads this folder of an installed app");
	}
}

function stringRoots(inputs: RootInputs, set: RootSet): void {
	for (const item of inputs.stringTargets) {
		if (item.to === null) continue;
		const evidence = `${item.from}:${item.line} ${item.setting} = ${item.value}`;
		if (item.setting === "INSTALLED_APPS") djangoAppRoots(inputs, item.to, set);
		else if (item.setting === "pytest_plugins") set.add(item.to, "pytest-plugin", evidence);
		else set.add(item.to, "django-settings", evidence);
	}
	for (const path of ["manage.py", ...[...inputs.modules.keys()].filter((item) => /(?:^|\/)(?:wsgi|asgi)\.py$/.test(item))]) {
		const content = inputs.modules.has(path) ? inputs.read(path) : null;
		const dotted = content === null ? undefined : DJANGO_SETTING.exec(content)?.[1];
		if (dotted) set.add(resolveModuleName(dotted, inputs.importRoots, inputs.modules), "django-settings", `${path} sets DJANGO_SETTINGS_MODULE=${dotted}`);
	}
}

/** Every entry root of the tree, sorted by path then kind. */
export function discoverEntryRoots(inputs: RootInputs): EntryRoot[] {
	const set = new RootSet();
	ruleRoots(inputs, set);
	alembicRoots(inputs, set);
	loaderGlobRoots(inputs, set);
	manifestRoots(inputs, set);
	commandRoots(inputs, set);
	stringRoots(inputs, set);
	return set.roots.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}

/** Read at most `TEXT_BYTES` of a text file; the loader wires this to the disk. */
export const MAX_TEXT_BYTES = TEXT_BYTES;
