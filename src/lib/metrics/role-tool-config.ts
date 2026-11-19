import { basename } from "node:path";
import {
	blankNested, type FoundString, keyValueOpen, lineAt, maskComments, matchBracket, openBraces, scanStrings, topLevelKeys,
} from "./role-tool-config-text.js";

/**
 * Reads the exclude lists that a repository writes into the configuration of its OWN LINTER, without running anything.
 * A linter exclude says "the owners do not lint this path", which is evidence that nobody maintains it by hand.
 * A type checker (mypy, pyright, tsconfig), a coverage `omit`, a formatter ignore file or a build exclude says only that
 * that tool does not look at the path; they are never read here. Default excludes that a config does not write out are not invented.
 *
 * Supported files and keys:
 * - ruff: `exclude`, `extend-exclude` in `[tool.ruff]` of pyproject.toml, and at the top of ruff.toml / .ruff.toml.
 *   `lint.exclude` and `format.exclude` limit one task only and are not read.
 * - flake8: `exclude`, `extend-exclude` in `[flake8]` of setup.cfg, tox.ini, .flake8.
 * - pylint: `ignore` (base names) and `ignore-paths` (regular expressions) in `[MASTER]`/`[MAIN]` of pylintrc / .pylintrc,
 *   `[pylint.main]` of setup.cfg / tox.ini, `[tool.pylint.main]` of pyproject.toml.
 * - ESLint: a flat config object that holds only `ignores` (and `name`), `globalIgnores([...])`, .eslintignore,
 *   `ignorePatterns` of .eslintrc.json / .eslintrc.js / .eslintrc.cjs, and `eslintIgnore` / `eslintConfig.ignorePatterns` of package.json.
 * - biome: `files.ignore` (v1) and the negated entries of `files.includes` (v2). A positive `includes` entry is stored negated:
 *   it can only re-include, never exclude.
 * - oxlint: `ignorePatterns` of .oxlintrc.json and .oxlintignore.
 * Not read: YAML ESLint configs, extends chains, config computed by code, per-file overrides.
 */
export type LinterTool = "ruff" | "flake8" | "pylint" | "eslint" | "biome" | "oxlint";
/** `any-depth` / `anchored`: glob rules; `regex`: pylint ignore-paths; `basename`: pylint ignore. */
export type RuleStyle = "any-depth" | "anchored" | "regex" | "basename";

export interface RawExclude { tool: LinterTool; key: string; pattern: string; line: number; style: RuleStyle; }
export interface SkippedPattern { reason: string; pattern?: string; line: number; tool?: LinterTool; }
export interface ConfigReading { rules: RawExclude[]; skipped: SkippedPattern[]; }

const CONFIG_NAME = /^(?:pyproject\.toml|ruff\.toml|\.ruff\.toml|setup\.cfg|tox\.ini|\.flake8|\.?pylintrc|\.eslintignore|\.oxlintignore|eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.json|\.js|\.cjs)?|package\.json|biome\.jsonc?|\.oxlintrc\.json)$/;

export function isLinterConfigName(path: string): boolean {
	return CONFIG_NAME.test(basename(path));
}

const empty = (): ConfigReading => ({ rules: [], skipped: [] });

function addValue(into: ConfigReading, base: Omit<RawExclude, "pattern" | "line">, pattern: string, line: number): void {
	const text = pattern.trim();
	if (text === "") return;
	if (base.style === "basename" && /[*?[\]/\\]/.test(text)) into.skipped.push({ reason: "not-a-basename", pattern: text, line, tool: base.tool });
	else into.rules.push({ ...base, pattern: text, line });
}

// ---- TOML ----

interface TomlTarget { tool: LinterTool; keys: Readonly<Record<string, RuleStyle>>; }

/** The reader's target for a TOML section (dotted name, lower-cased, no quotes), or undefined. */
function tomlTarget(section: string, isRuffToml: boolean): TomlTarget | undefined {
	const name = section.toLowerCase();
	if (isRuffToml ? name === "" : name === "tool.ruff") return { tool: "ruff", keys: { exclude: "any-depth", "extend-exclude": "any-depth" } };
	if (!isRuffToml && (name === "tool.pylint.main" || name === "tool.pylint.master")) return { tool: "pylint", keys: { ignore: "basename", "ignore-paths": "regex" } };
	return undefined;
}

const TOML_HEADER = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*$/;
const TOML_KEY = /^\s*(["']?)([\w.-]+)\1\s*=\s*/;

function tomlValues(masked: string, valueStart: number, lineEnd: number): { values: FoundString[]; end: number } {
	if (masked[valueStart] !== "[") return { values: scanStrings(masked, valueStart, lineEnd), end: lineEnd };
	const close = matchBracket(masked, valueStart);
	return close === -1 ? { values: [], end: lineEnd } : { values: scanStrings(masked, valueStart, close), end: close };
}

/** The wanted key on one TOML line, with the offset where its value starts, or null. */
function tomlWantedKey(line: string, target: TomlTarget | undefined): { name: string; style: RuleStyle; valueAt: number } | null {
	const key = TOML_KEY.exec(line);
	const style = key === null || target === undefined ? undefined : target.keys[key[2] ?? ""];
	return key === null || style === undefined ? null : { name: key[2] ?? "", style, valueAt: key[0].length };
}

function readToml(text: string, isRuffToml: boolean): ConfigReading {
	const masked = maskComments(text, "hash"), out = empty();
	let section = isRuffToml ? "" : "<none>", offset = 0, skipUntil = -1;
	for (const line of masked.split("\n")) {
		const lineStart = offset;
		offset += line.length + 1;
		if (lineStart < skipUntil) continue;
		const header = TOML_HEADER.exec(line);
		if (header !== null) { section = (header[1] ?? "").replaceAll(/["'\s]/g, ""); continue; }
		const target = tomlTarget(section, isRuffToml), wanted = tomlWantedKey(line, target);
		if (target === undefined || wanted === null) continue;
		const { values, end } = tomlValues(masked, lineStart + wanted.valueAt, lineStart + line.length);
		skipUntil = end;
		for (const value of values) addValue(out, { tool: target.tool, key: wanted.name, style: wanted.style }, value.value, lineAt(masked, value.offset));
	}
	return out;
}

// ---- INI ----

const INI_HEADER = /^\s*\[([^\]]+)\]\s*$/;
const INI_KEY = /^([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/;
interface IniEntry { section: string; key: string; rows: Array<{ text: string; line: number }>; }

function readIniEntries(text: string): IniEntry[] {
	const entries: IniEntry[] = [];
	let section = "", current: IniEntry | null = null;
	text.split("\n").forEach((raw, index) => {
		const line = raw.replace(/\r$/, ""), trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) return;
		const header = INI_HEADER.exec(line);
		if (header !== null) { section = (header[1] ?? "").trim().toLowerCase(); current = null; return; }
		const key = /^\s/.test(line) ? null : INI_KEY.exec(line);
		if (key !== null) { current = { section, key: key[1] ?? "", rows: [{ text: key[2] ?? "", line: index + 1 }] }; entries.push(current); return; }
		current?.rows.push({ text: trimmed, line: index + 1 });
	});
	return entries;
}

/** Split on commas that sit outside `[]`, `{}` and `()`: a pylint regex may hold a comma. */
function splitTopLevelCommas(text: string): string[] {
	const parts: string[] = [];
	let depth = 0, from = 0;
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i] ?? "";
		if ("[{(".includes(c)) depth += 1;
		else if ("]})".includes(c)) depth = Math.max(0, depth - 1);
		else if (c === "," && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
	}
	parts.push(text.slice(from));
	return parts;
}

function iniTarget(section: string, key: string, file: string): { tool: LinterTool; style: RuleStyle } | undefined {
	if (section === "flake8" && (key === "exclude" || key === "extend-exclude")) return { tool: "flake8", style: "any-depth" };
	const pylintHome = /pylintrc$/.test(file) ? ["master", "main"] : ["pylint.master", "pylint.main"];
	if (!pylintHome.includes(section)) return undefined;
	return key === "ignore" ? { tool: "pylint", style: "basename" } : key === "ignore-paths" ? { tool: "pylint", style: "regex" } : undefined;
}

function readIni(file: string, text: string): ConfigReading {
	const out = empty();
	for (const entry of readIniEntries(text)) {
		const target = iniTarget(entry.section, entry.key, basename(file));
		if (target === undefined) continue;
		for (const row of entry.rows) {
			const items = target.tool === "flake8" ? row.text.split(/[,\s]+/) : splitTopLevelCommas(row.text);
			for (const item of items) addValue(out, { ...target, key: entry.key }, item, row.line);
		}
	}
	return out;
}

// ---- ignore files ----

function readIgnoreFile(text: string, tool: LinterTool, key: string): ConfigReading {
	const out = empty();
	text.split("\n").forEach((raw, index) => {
		const line = raw.replace(/\r$/, "").trim();
		if (line !== "" && !line.startsWith("#")) out.rules.push({ tool, key, pattern: line, line: index + 1, style: "any-depth" });
	});
	return out;
}

// ---- JS and JSON ----

/** The plain strings of the array whose `[` is at `open`; anything that is not a plain string is reported, not guessed. */
function arrayItems(masked: string, open: number, out: ConfigReading): FoundString[] {
	const close = matchBracket(masked, open);
	if (close === -1) { out.skipped.push({ reason: "unterminated-list", line: lineAt(masked, open) }); return []; }
	const found = scanStrings(masked, open + 1, close);
	let rest = masked.slice(open + 1, close);
	for (const item of found) rest = rest.slice(0, item.offset - open - 1) + " ".repeat(item.end - item.offset) + rest.slice(item.end - open - 1);
	if (rest.replace(/[\s,]/g, "") !== "") out.skipped.push({ reason: "non-literal-entry", line: lineAt(masked, open) });
	return found;
}

function addArray(out: ConfigReading, masked: string, open: number, base: Omit<RawExclude, "pattern" | "line">): void {
	for (const item of arrayItems(masked, open, out)) addValue(out, base, item.value, lineAt(masked, item.offset));
}

const IGNORES = /\bignores\s*:\s*\[/g;
const GLOBAL_IGNORES = /\bglobalIgnores\s*\(\s*\[/g;

function readEslintFlat(text: string): ConfigReading {
	const masked = maskComments(text, "js"), out = empty();
	const base = { tool: "eslint", key: "ignores", style: "anchored" } as const;
	// `includeIgnoreFile(gitignorePath)` reads another file at run time: counted, not applied.
	for (const match of masked.matchAll(/\bincludeIgnoreFile\s*\(/g)) out.skipped.push({ reason: "ignore-file-include", line: lineAt(masked, match.index), tool: "eslint" });
	for (const match of masked.matchAll(GLOBAL_IGNORES)) addArray(out, masked, match.index + match[0].length - 1, { ...base, key: "globalIgnores" });
	for (const match of masked.matchAll(IGNORES)) {
		const open = match.index + match[0].length - 1, braces = openBraces(masked, match.index), object = braces[braces.length - 1];
		const close = object === undefined ? -1 : matchBracket(masked, object);
		const keys = object === undefined || close === -1 ? [] : topLevelKeys(blankNested(masked.slice(object + 1, close)));
		if (object !== undefined && keys.every((key) => key === "ignores" || key === "name")) { addArray(out, masked, open, base); continue; }
		const scoped = empty();
		for (const item of arrayItems(masked, open, scoped)) out.skipped.push({ reason: "scoped-ignores", pattern: item.value, line: lineAt(masked, item.offset) });
	}
	return out;
}

function readJsKey(text: string, key: string, tool: LinterTool): ConfigReading {
	const masked = maskComments(text, "js"), out = empty();
	for (const match of masked.matchAll(new RegExp(`\\b${key}\\s*:\\s*\\[`, "g"))) {
		if (openBraces(masked, match.index).length === 1) addArray(out, masked, match.index + match[0].length - 1, { tool, key, style: "any-depth" });
	}
	return out;
}

/** The array at `path` in a JSON or JSONC text (object keys, outermost first), as an offset into the masked text. */
function jsonArrayAt(masked: string, path: readonly string[]): number {
	let from = masked.indexOf("{"), to = from === -1 ? -1 : matchBracket(masked, from);
	for (const [index, key] of path.entries()) {
		if (from === -1 || to === -1) return -1;
		const open = keyValueOpen(masked, from + 1, to, key);
		if (open === -1) return -1;
		if (index === path.length - 1) return masked[open] === "[" ? open : -1;
		from = open; to = matchBracket(masked, open);
	}
	return -1;
}

interface JsonTarget { path: string[]; base: Omit<RawExclude, "pattern" | "line">; flip?: boolean; }

function readJson(text: string, targets: readonly JsonTarget[]): ConfigReading {
	const masked = maskComments(text, "js"), out = empty();
	for (const target of targets) {
		const open = jsonArrayAt(masked, target.path);
		if (open === -1) continue;
		if (!target.flip) { addArray(out, masked, open, target.base); continue; }
		for (const item of arrayItems(masked, open, out)) addValue(out, target.base, flipNegation(item.value), lineAt(masked, item.offset));
	}
	return out;
}

/** A biome `includes` entry: `!x` and `!!x` exclude, a positive entry can only re-include. Returns the equivalent exclude-list entry. */
function flipNegation(entry: string): string {
	return entry.startsWith("!") ? entry.replace(/^!+/, "") : `!${entry}`;
}

const JSON_TARGETS: Readonly<Record<string, readonly JsonTarget[]>> = {
	eslintrc: [{ path: ["ignorePatterns"], base: { tool: "eslint", key: "ignorePatterns", style: "any-depth" } }],
	package: [
		{ path: ["eslintIgnore"], base: { tool: "eslint", key: "eslintIgnore", style: "any-depth" } },
		{ path: ["eslintConfig", "ignorePatterns"], base: { tool: "eslint", key: "ignorePatterns", style: "any-depth" } },
	],
	biome: [
		{ path: ["files", "ignore"], base: { tool: "biome", key: "files.ignore", style: "anchored" } },
		{ path: ["files", "includes"], base: { tool: "biome", key: "files.includes", style: "anchored" }, flip: true },
	],
	oxlint: [{ path: ["ignorePatterns"], base: { tool: "oxlint", key: "ignorePatterns", style: "any-depth" } }],
};

// ---- dispatch ----

type Reader = (name: string, text: string) => ConfigReading;
const READERS: ReadonlyArray<readonly [RegExp, Reader]> = [
	[/^pyproject\.toml$/, (_name, text) => readToml(text, false)],
	[/^\.?ruff\.toml$/, (_name, text) => readToml(text, true)],
	[/^(?:setup\.cfg|tox\.ini|\.flake8|\.?pylintrc)$/, readIni],
	[/^\.eslintignore$/, (_name, text) => readIgnoreFile(text, "eslint", ".eslintignore")],
	[/^\.oxlintignore$/, (_name, text) => readIgnoreFile(text, "oxlint", ".oxlintignore")],
	[/^eslint\.config\./, (_name, text) => readEslintFlat(text)],
	[/^\.eslintrc(?:\.json)?$/, (_name, text) => readJson(text, JSON_TARGETS.eslintrc ?? [])],
	[/^\.eslintrc\.c?js$/, (_name, text) => readJsKey(text, "ignorePatterns", "eslint")],
	[/^package\.json$/, (_name, text) => (/eslintIgnore|eslintConfig/.test(text) ? readJson(text, JSON_TARGETS.package ?? []) : empty())],
	[/^biome\.jsonc?$/, (_name, text) => readJson(text, JSON_TARGETS.biome ?? [])],
	[/^\.oxlintrc\.json$/, (_name, text) => readJson(text, JSON_TARGETS.oxlint ?? [])],
];

/** Read one config file (path relative to the repository, text as committed). A file that is not a linter config reads as nothing. */
export function readLinterConfig(path: string, text: string): ConfigReading {
	const name = basename(path), reader = READERS.find(([pattern]) => pattern.test(name));
	if (reader === undefined) return empty();
	const reading = reader[1](name, text), tool = ownerOf(name);
	return { rules: reading.rules, skipped: reading.skipped.map((skip) => ({ ...skip, tool: skip.tool ?? tool })) };
}

/** The linter that owns a config file name, for a skip that the reader could not attribute. */
function ownerOf(name: string): LinterTool {
	if (/oxlint/.test(name)) return "oxlint";
	if (/biome/.test(name)) return "biome";
	if (/ruff/.test(name)) return "ruff";
	return /eslint|package\.json/.test(name) ? "eslint" : "pylint";
}
