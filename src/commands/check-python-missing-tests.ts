// ===========================================
// Check Command — missing-tests scan for Python
// ===========================================
// The Python reading of `missing-tests`: a product module that no test file names. A product
// module is a `.py` file that is not a test, an example, a doc file, a script, a package
// marker (`__init__.py`, `__main__.py`), `conftest.py`, `setup.py`, generated protobuf code,
// `_version.py` or a file under a `fixtures` or `templates` directory. It has a test when
// `test_<name>.py` or `<name>_test.py` sits (a) in its own directory, (b) in a `tests` or `test`
// directory of its own directory or of any ancestor directory, at any depth below that directory.
// The name may carry extra words if each is a word of a directory in the module's path:
// `test_mcp_server.py` tests `mcp_server/server.py`, `test_daft_io_manager.py` tests
// `io_manager/daft.py`; a plural directory name matches its singular. A name that repeats in
// several packages is covered by one test file in a shared tests directory: the scan errs
// toward silence. It reads names only, never file contents, so a module that a test imports
// under another name is still listed.

import type { JsonObject } from "../lib/json-types.js";
import { pythonRole, TEST_FOLDER_SUFFIX } from "./check-python-files.js";
import { bump } from "./check-python-imports.js";

export interface PythonMissingTestsScan {
	status: "ok" | "no-python-files";
	/** Relative paths of the product modules that no test names. */
	files: Set<string>;
	/** Every product module, flagged or not (`files` is the flagged subset). */
	modules: string[];
	productModules: number;
	exempt: Record<string, number>;
	pythonFiles: number;
}

const PACKAGE_MARKERS = new Set(["__init__.py", "__main__.py"]);
const TEST_DIRS = new Set(["tests", "test"]);
const FRAMEWORK_FILES = new Set(["manage.py", "wsgi.py", "asgi.py", "apps.py"]);
const GENERATED_FILE = /(_pb2|_pb2_grpc)\.py$|(^|\/)_version\.py$/;
const NON_PRODUCT_COMPONENTS = new Set(["fixtures", "__fixtures__", "templates"]);

function exemptReason(path: string): string | null {
	const parts = path.split("/");
	const name = parts[parts.length - 1] ?? "";
	if (PACKAGE_MARKERS.has(name)) return "package_marker";
	if (name === "conftest.py" || name === "setup.py") return "config_file";
	if (FRAMEWORK_FILES.has(name)) return "framework_boilerplate";
	if (parts.slice(0, -1).some((part) => part === "migrations" || part.startsWith("."))) return "migration_or_tooling_dir";
	if (GENERATED_FILE.test(name)) return "generated";
	if (pythonRole(path) === "test") return "test_file";
	if (pythonRole(path) !== "other") return "non_product_dir";
	if (parts.slice(0, -1).some((part) => NON_PRODUCT_COMPONENTS.has(part))) return "fixture_or_template";
	return null;
}

interface TestEntry {
	/** Words of the name that follows `test_` (or precedes `_test`), singular, lower case. */
	tokens: string[];
	dir: string[];
}

/** Lower-case words of a file or directory name, with a trailing plural `s` removed (`providers` -> `provider`). */
function tokensOf(name: string): string[] {
	return name
		.toLowerCase()
		.split(/[_\-.]+/)
		.filter((token) => token !== "")
		.map((token) => (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token));
}

/** Test files, indexed by each word of the name they test. */
function indexTests(files: string[]): Map<string, TestEntry[]> {
	const index = new Map<string, TestEntry[]>();
	for (const path of files) {
		const parts = path.split("/");
		const name = parts[parts.length - 1] ?? "";
		if (!name.endsWith(".py")) continue;
		const stem = name.slice(0, -3);
		const tested = stem.startsWith("test_") ? stem.slice(5) : stem.endsWith("_test") ? stem.slice(0, -5) : null;
		if (!tested) continue;
		const entry: TestEntry = { tokens: tokensOf(tested), dir: parts.slice(0, -1) };
		for (const token of new Set(entry.tokens)) index.set(token, [...(index.get(token) ?? []), entry]);
	}
	return index;
}

/** True when `needle` occurs in `words` as a run of neighbours. */
function containsRun(words: string[], needle: string[]): boolean {
	for (let start = 0; start + needle.length <= words.length; start += 1) {
		if (needle.every((word, i) => words[start + i] === word)) return true;
	}
	return false;
}

/**
 * True when a test file tests this module: its name carries the module's words, any other word of
 * the name is a word of a directory in the module's path, and its location covers the module.
 */
function isTested(tests: Map<string, TestEntry[]>, moduleDir: string[], stem: string): boolean {
	const stemTokens = tokensOf(stem);
	const first = stemTokens[0];
	if (first === undefined) return false;
	const known = new Set([...moduleDir.flatMap(tokensOf), ...stemTokens]);
	return (tests.get(first) ?? []).some(
		(entry) => containsRun(entry.tokens, stemTokens) && entry.tokens.every((token) => known.has(token)) && covers(entry.dir, moduleDir),
	);
}

/** True when the test directory `testDir` is the module directory or sits below a tests directory of an ancestor-or-self. */
function covers(testDir: string[], moduleDir: string[]): boolean {
	if (testDir.length === moduleDir.length && testDir.every((part, i) => part === moduleDir[i])) return true;
	for (let k = 0; k < testDir.length && k <= moduleDir.length; k += 1) {
		const dir = testDir[k] ?? "";
		if (!TEST_DIRS.has(dir) && !TEST_FOLDER_SUFFIX.test(dir)) continue;
		if (testDir.slice(0, k).every((part, i) => part === moduleDir[i])) return true;
	}
	return false;
}

/** The missing-tests scan over a project file list (relative paths). */
export function scanPythonMissingTests(files: string[]): PythonMissingTestsScan {
	const python = files.filter((path) => path.endsWith(".py"));
	const result: PythonMissingTestsScan = { status: python.length === 0 ? "no-python-files" : "ok", files: new Set(), modules: [], productModules: 0, exempt: {}, pythonFiles: python.length };
	if (python.length === 0) return result;
	const tests = indexTests(python);
	for (const path of python) {
		const reason = exemptReason(path);
		if (reason) {
			bump(result.exempt, reason);
			continue;
		}
		result.productModules += 1;
		result.modules.push(path);
		const parts = path.split("/");
		const moduleDir = parts.slice(0, -1);
		const stem = (parts[parts.length - 1] ?? "").slice(0, -3);
		if (!isTested(tests, moduleDir, stem)) result.files.add(path);
	}
	return result;
}

/** What the scan adds to the `missing-tests` output: a `python` detail object and stderr notes. */
export function describePythonMissingTests(scan: PythonMissingTestsScan): { details: JsonObject | null; notes: string[] } {
	if (scan.status === "no-python-files") return { details: null, notes: [] };
	const python: JsonObject = {
		status: "ok",
		python_files: scan.pythonFiles,
		product_modules: scan.productModules,
		missing_count: scan.files.size,
		exempt: scan.exempt,
	};
	return { details: { python }, notes: [] };
}
