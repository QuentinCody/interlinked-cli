// ===========================================
// Check Command — missing-tests, layout-aware reading
// ===========================================
// The classic `missing-tests` list asks one narrow question: is a test file next to the source? (JS and TS) or does a test
// file carry the module's name (Python). Both lists stay as they are, in `files`. This module adds a second reading under
// `details.layout`, with the rule printed, two coverage numbers per language and the modules that neither rule covers:
//   by_name_mapping   the module has a test file by name, in the usual layouts (see MAPPING_RULE)
//   imported_by_tests a test file imports the module (resolved import, any layout; see IMPORT_RULE)
//   no_test_import_candidates   covered by neither: "no test imports this module" ([heuristic], not a proof of no tests)
// When the rule cannot judge (no test file at all, or a test-discovery pattern it does not support) it says so and lists no
// candidates. Modules are the product-role files: generated, vendor and linter-excluded paths are not counted.

import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { classifyFileAt } from "../lib/metrics/role-population.js";
import type { SourceRole } from "../lib/metrics/measurement-types.js";
import type { JsonObject } from "../lib/json-types.js";
import type { StructuralCheckResult } from "./check-output.js";
import { discoveryIssue } from "./check-test-discovery.js";
import { listProjectFiles } from "./check-python-files.js";
import { scanPythonMissingTests } from "./check-python-missing-tests.js";
import { jsModuleIndex, pythonModuleIndex, type Resolved, resolveJsImports, resolvePythonImports } from "./check-test-resolve.js";

const MAPPING_RULE =
	"A module has a test by name when a test file carries its name and sits in the module's own directory, or in a tests / test / __tests__ / spec directory (or any depth below one) that is a child of the module's directory or of any ancestor of it. " +
	"Python: test_<name>.py or <name>_test.py (extra words must be words of a directory in the module path). JS/TS: <name>[.<qualifier>].test|spec.<ext> or <name>.<ext> under __tests__; case, - and _ are ignored.";
const IMPORT_RULE =
	"A module is imported by tests when a test file imports it (Python import / from-import / mock.patch target; JS/TS import, require, dynamic import, vi.mock / jest.mock) and the import resolves to the module by path or dotted-name suffix. " +
	"Package names, workspace packages, tsconfig paths and re-exports through a barrel or __init__ are not followed.";

export interface LanguageLayout {
	status: "ok" | "cannot-judge";
	cannot_judge_reason?: string;
	product_modules: number;
	test_files: number;
	by_name_mapping: { covered: number; total: number };
	imported_by_tests: { covered: number; total: number };
	covered_by_either: number;
	/** Imports that looked local and did not resolve, and names that matched several modules. */
	import_notes: { unresolved: number; ambiguous: number };
	no_test_import_candidates: string[];
	/** The number of candidates before the list is capped. */
	candidate_count: number;
	tag: "[heuristic]";
}
export interface LayoutReport { rule: { mapping: string; import: string }; python?: LanguageLayout; javascript?: LanguageLayout; }
export interface LayoutInput { files: readonly string[]; read: (path: string) => string | null; roleOf: (path: string) => SourceRole; }

const CANDIDATE_CAP = 3000;
const TEST_DIRS = new Set(["tests", "test", "__tests__", "__test__", "spec", "specs"]);
const JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const JS_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const PY_TEST_FILE = /(?:^|\/)(?:test_[^/]+|[^/]+_test|tests)\.py$/;

// ---- JS and TS modules and name mapping ----

function jsExempt(path: string): boolean {
	const parts = path.split("/"), name = parts[parts.length - 1] ?? "", base = basename(path, extname(path));
	if (JS_TEST_FILE.test(name) || base.endsWith(".d") || base === "index" || /\.config\.|\.setup\./.test(name)) return true;
	return parts.slice(0, -1).some((part) => TEST_DIRS.has(part) || ["__mocks__", "fixtures", "__fixtures__", "orchestration-scripts", "templates"].includes(part));
}

const normalize = (name: string): string => name.toLowerCase().replace(/[-_]/g, "");

/** `update.integration` -> keys `updateintegration`, `update`: a qualifier after the module's name does not change what is tested. */
function nameKeys(stem: string): string[] {
	const parts = stem.split(".");
	return parts.map((_, index) => normalize(parts.slice(0, parts.length - index).join(".")));
}

function jsTestStem(path: string): string {
	return basename(path).replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");
}

/** True when the test directory is the module directory, or sits at or below a tests directory of the module directory or an ancestor. */
function covers(testDir: readonly string[], moduleDir: readonly string[]): boolean {
	if (testDir.length === moduleDir.length && testDir.every((part, index) => part === moduleDir[index])) return true;
	return testDir.some((part, index) => TEST_DIRS.has(part) && testDir.slice(0, index).every((dir, at) => dir === moduleDir[at]) && index <= moduleDir.length);
}

function jsNameCovered(modules: readonly string[], tests: readonly string[]): Set<string> {
	const index = new Map<string, string[][]>();
	for (const test of tests) {
		const dir = test.split("/").slice(0, -1);
		for (const key of nameKeys(jsTestStem(test))) index.set(key, [...(index.get(key) ?? []), dir]);
	}
	const covered = new Set<string>();
	for (const path of modules) {
		const moduleDir = path.split("/").slice(0, -1), key = normalize(basename(path, extname(path)));
		if ((index.get(key) ?? []).some((dir) => covers(dir, moduleDir))) covered.add(path);
	}
	return covered;
}

// ---- assembly ----

function importedBy(tests: readonly string[], read: (path: string) => string | null, resolve: (test: string, text: string) => Resolved): { modules: Set<string>; unresolved: number; ambiguous: number } {
	const total = { modules: new Set<string>(), unresolved: 0, ambiguous: 0 };
	for (const test of tests) {
		const text = read(test);
		if (text === null) continue;
		const found = resolve(test, text);
		for (const module of found.modules) total.modules.add(module);
		total.unresolved += found.unresolved;
		total.ambiguous += found.ambiguous;
	}
	return total;
}

function assemble(modules: readonly string[], nameCovered: ReadonlySet<string>, tests: readonly string[], imported: ReturnType<typeof importedBy>, issue: string | null): LanguageLayout {
	const importedCovered = modules.filter((path) => imported.modules.has(path)).length;
	const rest = modules.filter((path) => !nameCovered.has(path) && !imported.modules.has(path));
	const reason = tests.length === 0 ? "no test files found" : issue === null ? undefined : `test discovery is configured with a pattern the rule does not support: ${issue}`;
	const layout: LanguageLayout = {
		status: reason === undefined ? "ok" : "cannot-judge", product_modules: modules.length, test_files: tests.length,
		by_name_mapping: { covered: modules.filter((path) => nameCovered.has(path)).length, total: modules.length },
		imported_by_tests: { covered: importedCovered, total: modules.length }, covered_by_either: modules.length - rest.length,
		import_notes: { unresolved: imported.unresolved, ambiguous: imported.ambiguous },
		no_test_import_candidates: reason === undefined ? rest.slice(0, CANDIDATE_CAP) : [], candidate_count: reason === undefined ? rest.length : 0, tag: "[heuristic]",
	};
	if (reason !== undefined) layout.cannot_judge_reason = reason;
	return layout;
}

function pythonLayout(input: LayoutInput): LanguageLayout | undefined {
	const python = input.files.filter((path) => path.endsWith(".py"));
	if (python.length === 0) return undefined;
	const scan = scanPythonMissingTests([...input.files]);
	const modules = scan.modules.filter((path) => input.roleOf(path) === "product");
	const tests = python.filter((path) => PY_TEST_FILE.test(path));
	const index = pythonModuleIndex(modules, python.filter((path) => path.endsWith("/__init__.py") || path === "__init__.py"), input.read);
	const imported = importedBy(tests, input.read, (test, text) => resolvePythonImports(index, test, text));
	const nameCovered = new Set(modules.filter((path) => !scan.files.has(path)));
	return assemble(modules, nameCovered, tests, imported, discoveryIssue("python", input.files, input.read));
}

function javascriptLayout(input: LayoutInput): LanguageLayout | undefined {
	const code = input.files.filter((path) => JS_EXTS.has(extname(path)));
	if (code.length === 0) return undefined;
	const modules = code.filter((path) => !jsExempt(path) && input.roleOf(path) === "product");
	const tests = input.files.filter((path) => JS_TEST_FILE.test(path) || (/(?:^|\/)__tests__\//.test(path) && /\.[cm]?[jt]sx?$/.test(path)));
	const barrels = code.filter((path) => /(?:^|\/)index\.[cm]?[jt]sx?$/.test(path) && !JS_TEST_FILE.test(path));
	const index = jsModuleIndex(modules, barrels, input.read);
	const imported = importedBy(tests, input.read, (test, text) => resolveJsImports(index, test, text));
	return assemble(modules, jsNameCovered(modules, tests), tests, imported, discoveryIssue("javascript", input.files, input.read));
}

/** The layout-aware reading of a project: pure over a file list, a reader and a role function. */
export function analyzeLayout(input: LayoutInput): LayoutReport {
	const report: LayoutReport = { rule: { mapping: MAPPING_RULE, import: IMPORT_RULE } };
	const python = pythonLayout(input), javascript = javascriptLayout(input);
	if (python !== undefined) report.python = python;
	if (javascript !== undefined) report.javascript = javascript;
	return report;
}

function languageJson(layout: LanguageLayout): JsonObject {
	return {
		status: layout.status, ...(layout.cannot_judge_reason === undefined ? {} : { cannot_judge_reason: layout.cannot_judge_reason }),
		product_modules: layout.product_modules, test_files: layout.test_files,
		by_name_mapping: { ...layout.by_name_mapping }, imported_by_tests: { ...layout.imported_by_tests }, covered_by_either: layout.covered_by_either,
		import_notes: { ...layout.import_notes }, no_test_import_candidates: layout.no_test_import_candidates, candidate_count: layout.candidate_count, tag: layout.tag,
	};
}

function layoutJson(report: LayoutReport): JsonObject {
	return {
		rule: { ...report.rule },
		...(report.python === undefined ? {} : { python: languageJson(report.python) }),
		...(report.javascript === undefined ? {} : { javascript: languageJson(report.javascript) }),
	};
}

/** Add `details.layout` to the `missing-tests` result in place; returns stderr notes. The result's `files` are not touched. */
export function applyMissingTestsLayout(results: StructuralCheckResult[], root: string): string[] {
	const result = results.find((candidate) => candidate.name === "missing-tests");
	if (result === undefined) return [];
	const listed = listProjectFiles(root).files;
	const read = (path: string): string | null => { try { return readFileSync(join(root, path), "utf8"); } catch { return null; } };
	const report = analyzeLayout({ files: listed, read, roleOf: (path) => classifyFileAt(root, path).decision.role });
	if (report.python === undefined && report.javascript === undefined) return [];
	result.details = { ...result.details, layout: layoutJson(report) };
	const notes: string[] = [];
	for (const [language, layout] of [["python", report.python], ["javascript", report.javascript]] as const) {
		if (layout?.status === "cannot-judge") notes.push(`note: missing-tests layout reading cannot judge ${language}: ${layout.cannot_judge_reason ?? ""}`);
	}
	return notes;
}
