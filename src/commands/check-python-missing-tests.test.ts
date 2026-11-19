// Tests for check-python-missing-tests.ts: the Python reading of `missing-tests`.
// A product module is a .py file that is not a test, an example, a doc file, a script, a package
// marker or generated code. It has a test when a file `test_<name>.py` or `<name>_test.py` sits
// next to it, in a tests/test directory beside it, or in a tests/test directory of an ancestor
// directory (any depth below it). Pure functions over a git-style file list: no interpreter.
// Each MUST-NOT-FIRE case has a MUST-FIRE twin.

import { describe, expect, it } from "vitest";
import { describePythonMissingTests, scanPythonMissingTests } from "./check-python-missing-tests.js";

const missing = (files: string[]): string[] => [...scanPythonMissingTests(files).files].sort();

describe("A1 missing-tests (MUST-FIRE)", () => {
	it("F1: a product module with no test file anywhere is listed", () => {
		expect(missing(["pkg/__init__.py", "pkg/core.py", "pkg/util.py", "tests/test_util.py"])).toEqual(["pkg/core.py"]);
	});

	it("F2: a test with the same name in a sibling project does not cover a module", () => {
		expect(missing(["libs/a/util.py", "libs/b/util.py", "libs/b/tests/test_util.py"])).toEqual(["libs/a/util.py"]);
	});

	it("F3: a test_ file for another module does not cover this one", () => {
		expect(missing(["pkg/a.py", "pkg/b.py", "pkg/test_a.py"])).toEqual(["pkg/b.py"]);
	});

	it("F4: a nested module in a src layout is listed when no test names it", () => {
		expect(missing(["src/app/api/routes.py", "tests/test_other.py"])).toEqual(["src/app/api/routes.py"]);
	});
});

describe("B1 covered by a test (MUST-NOT-FIRE twins)", () => {
	it("N1: test_<name>.py next to the module", () => {
		expect(missing(["pkg/core.py", "pkg/test_core.py"])).toEqual([]);
	});

	it("N2: <name>_test.py next to the module", () => {
		expect(missing(["pkg/core.py", "pkg/core_test.py"])).toEqual([]);
	});

	it("N3: a tests directory beside the module", () => {
		expect(missing(["pkg/core.py", "pkg/tests/test_core.py"])).toEqual([]);
		expect(missing(["pkg/core.py", "pkg/test/test_core.py"])).toEqual([]);
	});

	it("N4: a tests directory at the repository root, flat or mirrored", () => {
		expect(missing(["src/pkg/core.py", "tests/test_core.py"])).toEqual([]);
		expect(missing(["src/pkg/sub/core.py", "tests/pkg/sub/test_core.py"])).toEqual([]);
	});

	it("N5: a tests directory of an ancestor package", () => {
		expect(missing(["libs/a/src/a/core.py", "libs/a/tests/unit/test_core.py"])).toEqual([]);
	});
});

describe("B2 a test named after the package and the module", () => {
	it("N10: test_<package>_<module>.py, with the package taken from any directory of the module path", () => {
		expect(missing(["mcp_server/server.py", "tests/test_mcp_server.py"])).toEqual([]);
		expect(missing(["ace/integrations/mcp/models.py", "tests/test_ace_mcp_models.py"])).toEqual([]);
	});

	it("N11: test_<module>_<package>.py, and a plural package name", () => {
		expect(missing(["pkg/io_manager/daft.py", "tests/io_managers/test_daft_io_manager.py"])).toEqual([]);
		expect(missing(["src/providers/lmstudio/lmstudio.py", "tests/unit/providers/test_lmstudio_provider.py"])).toEqual([]);
	});

	it("N12: the same shape under the tests directory of the project that owns the module", () => {
		expect(missing(["integrations/github/github/probe/app/probe.py", "integrations/github/tests/github/probe/test_app_probe.py"])).toEqual([]);
	});

	it("F5: twin — a word that names neither the module nor a directory of its path does not cover it", () => {
		expect(missing(["ace/integrations/mcp/models.py", "tests/test_other_models.py"])).toEqual(["ace/integrations/mcp/models.py"]);
		expect(missing(["mcp_server/server.py", "tests/test_server_client.py"])).toEqual(["mcp_server/server.py"]);
	});

	it("F6: twin — a test named after the module in a sibling project still does not cover it", () => {
		expect(missing(["libs/a/pkg/models.py", "libs/b/tests/test_pkg_models.py"])).toEqual(["libs/a/pkg/models.py"]);
	});
});

describe("C1 exempt files (MUST-NOT-FIRE twins of F1)", () => {
	it("N13: a generated _version.py", () => {
		expect(missing(["pkg/_version.py"])).toEqual([]);
		expect(scanPythonMissingTests(["pkg/_version.py"]).exempt.generated).toBe(1);
	});

	it("N6: package markers, entry points, conftest, setup and generated code", () => {
		const files = ["pkg/__init__.py", "pkg/__main__.py", "pkg/conftest.py", "setup.py", "pkg/api_pb2.py", "pkg/api_pb2_grpc.py"];
		expect(missing(files)).toEqual([]);
	});

	it("N7: test modules, files under tests directories, fixtures and templates", () => {
		const files = ["tests/helpers.py", "pkg/test_x.py", "pkg/x_test.py", "pkg/fixtures/data.py", "pkg/templates/t.py", "integration_tests/run.py"];
		expect(missing(files)).toEqual([]);
	});

	it("N8: examples, docs and scripts are not product modules", () => {
		const files = ["examples/demo.py", "docs/conf.py", "scripts/build.py", "tools/gen.py", "benchmarks/run.py"];
		expect(missing(files)).toEqual([]);
	});

	it("N14: framework boilerplate and generated migrations are not product modules; twin: a module beside them is", () => {
		const files = ["manage.py", "site/wsgi.py", "site/asgi.py", "app/apps.py", "app/migrations/0001_initial.py", "app/sub/migrations/0002_x.py", "app/service.py"];
		expect(missing(files)).toEqual(["app/service.py"]);
	});

	it("N15: files in a dot-directory are CI or tooling (.github, .devcontainer)", () => {
		expect(missing([".github/validate.py", ".ci/tools/run.py", "pkg/real.py"])).toEqual(["pkg/real.py"]);
	});

	it("N16: hyphenated and underscored example and sample directories", () => {
		expect(missing(["libs/example-project/definitions.py", "useful_resources/sample_code/zoom.py", "docs_src/tutorial_one/a.py", "pkg/exampleish/real.py"])).toEqual(["pkg/exampleish/real.py"]);
	});

	it("N17: a directory named <package>_tests is a tests directory: its files are not product modules and its tests cover the package", () => {
		expect(missing(["libs/dagster_modal_tests/helpers.py", "libs/dagster_modal/resources.py", "libs/dagster_modal_tests/test_resources.py"])).toEqual([]);
		expect(missing(["libs/dagster_modal/resources.py", "libs/dagster_modal/other.py", "libs/dagster_modal_tests/test_resources.py"])).toEqual(["libs/dagster_modal/other.py"]);
	});

	it("N9: files that are not Python modules are never listed", () => {
		expect(missing(["pkg/core.pyi", "pkg/core.ts", "README.md"])).toEqual([]);
	});
});

describe("D1 description", () => {
	it("D1: a tree without Python files is no-python-files and adds nothing to the output", () => {
		const scan = scanPythonMissingTests(["a.ts", "b.ts"]);
		expect(scan.status).toBe("no-python-files");
		expect(describePythonMissingTests(scan)).toEqual({ details: null, notes: [] });
	});

	it("D2: the counts say how many product modules were judged and how many are exempt", () => {
		const scan = scanPythonMissingTests(["pkg/__init__.py", "pkg/a.py", "pkg/b.py", "pkg/test_a.py", "examples/e.py"]);
		const python = describePythonMissingTests(scan).details?.python as Record<string, unknown>;
		expect(python).toMatchObject({ status: "ok", python_files: 5, product_modules: 2, missing_count: 1, exempt: { package_marker: 1, test_file: 1, non_product_dir: 1 } });
	});
});
