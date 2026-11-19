// Entry roots named in text: packaging metadata (console scripts, entry-point groups) and the
// commands that CI, Makefiles, containers and documentation run. Pure string reads; nothing runs.

import { posix } from "node:path";

export interface EntryTarget {
	module: string;
	kind: "console-script" | "entry-point-group";
	/** The table and key that name the target, for the owner to check. */
	evidence: string;
}

const TOML_SCRIPT_TABLES = new Set(["project.scripts", "project.gui-scripts", "tool.poetry.scripts"]);
const TOML_GROUP_PREFIXES = ["project.entry-points.", "tool.poetry.plugins."];
const TOML_ENTRY = /^("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*["']([A-Za-z_][\w.]*)(?::[\w.]+)?(?:\s*\[[^\]]*\])?["']/;
const CFG_ENTRY = /^\s+([\w.-]+)\s*=\s*([A-Za-z_][\w.]*)(?::[\w.]+)?/;
const PY_ENTRY = /["']\s*([\w.-]+)\s*=\s*([A-Za-z_][\w.]*):[\w.]+\s*["']/g;
const CFG_CONSOLE_GROUPS = new Set(["console_scripts", "gui_scripts"]);

function tomlTargets(content: string): EntryTarget[] {
	const found: EntryTarget[] = [];
	let table = "";
	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		const header = /^\[([^\][]+)\]$/.exec(line);
		if (header) {
			table = (header[1] ?? "").trim();
			continue;
		}
		const isGroup = TOML_GROUP_PREFIXES.some((prefix) => table.startsWith(prefix));
		if (!isGroup && !TOML_SCRIPT_TABLES.has(table)) continue;
		const entry = TOML_ENTRY.exec(line);
		if (entry?.[1] && entry[2]) {
			const key = entry[1].replace(/^["']|["']$/g, "");
			found.push({ module: entry[2], kind: isGroup ? "entry-point-group" : "console-script", evidence: `${table}: ${key}` });
		}
	}
	return found;
}

function cfgTargets(content: string): EntryTarget[] {
	const found: EntryTarget[] = [];
	let inSection = false;
	let group = "";
	for (const raw of content.split(/\r?\n/)) {
		const header = /^\[([^\][]+)\]\s*$/.exec(raw);
		if (header) {
			inSection = (header[1] ?? "").trim() === "options.entry_points";
			group = "";
			continue;
		}
		if (!inSection) continue;
		const key = /^([\w.-]+)\s*=\s*$/.exec(raw);
		if (key) {
			group = key[1] ?? "";
			continue;
		}
		const entry = group === "" ? null : CFG_ENTRY.exec(raw);
		if (entry?.[1] && entry[2]) {
			found.push({ module: entry[2], kind: CFG_CONSOLE_GROUPS.has(group) ? "console-script" : "entry-point-group", evidence: `options.entry_points ${group}: ${entry[1]}` });
		}
	}
	return found;
}

function setupPyTargets(content: string): EntryTarget[] {
	if (!/\bentry_points\b/.test(content)) return [];
	const kind = /\bconsole_scripts\b/.test(content) ? "console-script" : "entry-point-group";
	return [...content.matchAll(PY_ENTRY)].flatMap((match) => (match[1] && match[2] ? [{ module: match[2], kind, evidence: `setup.py entry_points: ${match[1]}` } as const] : []));
}

/** Modules that packaging metadata runs or loads by name: console scripts and every entry-point group. */
export function entryPointTargets(path: string, content: string): EntryTarget[] {
	const name = posix.basename(path);
	if (name === "pyproject.toml") return tomlTargets(content);
	if (name === "setup.cfg") return cfgTargets(content);
	if (name === "setup.py") return setupPyTargets(content);
	return [];
}

export interface CommandRefs {
	/** Repository-relative `.py` paths the text runs, as written (a leading `./` removed). */
	files: string[];
	/** Dotted module names that `-m` or a server line runs. */
	modules: string[];
}

const PATH_TOKEN = /(?<![\w./:@$-])((?:\.\/)?[\w][\w./-]*\.py)(?![\w/-])/g;
const MODULE_FLAG = /(?:^|[\s,[])["']?-m["']?[\s,]+["']?([A-Za-z_][\w.]*)/g;
const SERVER_LINE = /\b(?:uvicorn|gunicorn|hypercorn|daphne|granian)\b[^\n]*?[\s"',]([A-Za-z_][\w.]*):[A-Za-z_]\w*/g;
const FROM_IMPORT = /^[ \t]*from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b/gm;
const INLINE_IMPORT = /\bpython3?[ \t]+-c[ \t]+["'][^"'\n]*?\bimport[ \t]+([A-Za-z_][\w.]*)/g;
const APP_OPTION =/\b(?:celery\s+(?:-A|--app[= ])\s*|flask\s+--app[= ]\s*)([A-Za-z_][\w.]*)/g;
const DOC_COMMAND = /\b(?:python3?(?:\.\d+)?|uv run|poetry run python)\s+(?:-[\w-]+\s+){0,4}((?:\.\/)?[\w][\w./-]*\.py)\b/g;
const DOC_MODULE = /\bpython3?(?:\.\d+)?\s+(?:-[\w-]+\s+){0,4}-m\s+([A-Za-z_][\w.]*)/g;

function normalizeFile(path: string): string {
	return posix.normalize(path.replace(/^\.\//, ""));
}

function collect(text: string, pattern: RegExp, into: string[], map: (value: string) => string = (value) => value): void {
	for (const match of text.matchAll(pattern)) if (match[1]) into.push(map(match[1]));
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/**
 * Files and modules a command text runs. `command` is for files that hold commands (Makefile, workflow, Dockerfile,
 * shell script, tox.ini): any literal `.py` path counts. `document` is for prose: only a path that follows a
 * python launcher counts, so a file that the text merely mentions is not a root.
 */
export function commandReferences(content: string, mode: "command" | "document"): CommandRefs {
	const files: string[] = [];
	const modules: string[] = [];
	if (mode === "command") {
		collect(content, PATH_TOKEN, files, normalizeFile);
		collect(content, MODULE_FLAG, modules);
		collect(content, SERVER_LINE, modules);
		collect(content, APP_OPTION, modules);
		collect(content, FROM_IMPORT, modules);
		collect(content, INLINE_IMPORT, modules);
	} else {
		collect(content, DOC_COMMAND, files, normalizeFile);
		collect(content, DOC_MODULE, modules);
	}
	return { files: unique(files), modules: unique(modules) };
}
