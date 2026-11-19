// Tests for check-python-secrets.ts: the `secrets` check read over Python source and the common
// Python config files. The detector is the one the TypeScript side uses (containsSecrets);
// only the file population differs. Fake credentials are assembled at run time so that this
// test file holds no secret-shaped literal. Each MUST-NOT-FIRE case has a MUST-FIRE twin.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listProjectFiles } from "./check-python-files.js";
import { describePythonSecrets, scanPythonSecrets, type PythonSecretsScan } from "./check-python-secrets.js";

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const AWS = `AKIA${"IOSFODNN7EXAMPLE"}`;
const FILLER = `AKIA${"A".repeat(16)}`;
const PEM = `-----BEGIN RSA PRIVATE${" KEY-----"}`;

function scan(files: Record<string, string>): PythonSecretsScan {
	const root = mkdtempSync(join(tmpdir(), "check-pysec-"));
	roots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	return scanPythonSecrets(root, listProjectFiles(root).files);
}

const flagged = (result: PythonSecretsScan): string[] => [...result.files].sort();

describe("A1 secrets (MUST-FIRE)", () => {
	it("F1: a credential in a Python module is flagged with its kind and never its value", () => {
		const r = scan({ "app/settings.py": `KEY = "${AWS}"\n`, "app/__init__.py": "" });
		expect(flagged(r)).toEqual(["app/settings.py"]);
		expect(r.entries[0]?.kinds).toEqual([expect.stringContaining("AKIA")]);
		expect(JSON.stringify(describePythonSecrets(r))).not.toContain(AWS);
	});

	it("F2: a PEM private key header in a module", () => {
		expect(flagged(scan({ "a.py": `PRIVATE = """${PEM}\\nxx"""\n` }))).toEqual(["a.py"]);
	});

	it("F3: the common Python config files are scanned when the tree holds Python", () => {
		const r = scan({
			"a.py": "x = 1\n",
			"setup.cfg": `[x]\ntoken = ${AWS}\n`,
			"tox.ini": `[tox]\nsetenv = K=${AWS}\n`,
			"pytest.ini": `[pytest]\nenv = K=${AWS}\n`,
			"pyproject.toml": `[tool.x]\nkey = "${AWS}"\n`,
			"requirements-dev.txt": `pkg @ https://u:${AWS}@host/p.whl\n`,
			"Pipfile": `[[source]]\nurl = "https://${AWS}@host/simple"\n`,
			"stubs/types.pyi": `K = "${AWS}"\n`,
		});
		expect(flagged(r)).toEqual(["Pipfile", "pyproject.toml", "pytest.ini", "requirements-dev.txt", "setup.cfg", "stubs/types.pyi", "tox.ini"]);
	});

	it("F4: examples and docs are scanned (the TypeScript side skips tests only)", () => {
		expect(flagged(scan({ "examples/run.py": `K = "${AWS}"\n`, "docs/conf.py": `K = "${AWS}"\n` }))).toEqual(["docs/conf.py", "examples/run.py"]);
	});
});

describe("B1 never flagged (MUST-NOT-FIRE twins)", () => {
	it("N1: a filler value with no entropy is not a credential", () => {
		expect(scan({ "a.py": `KEY = "${FILLER}"\n` }).files.size).toBe(0);
	});

	it("N2: test modules, conftest and files under tests directories are skipped (twin of F1)", () => {
		const r = scan({ "tests/test_a.py": `K = "${AWS}"\n`, "pkg/test_b.py": `K = "${AWS}"\n`, "pkg/c_test.py": `K = "${AWS}"\n`, "pkg/conftest.py": `K = "${AWS}"\n`, "tests/data.py": `K = "${AWS}"\n` });
		expect(r.files.size).toBe(0);
		expect(r.skips.test_file).toBe(5);
	});

	it("N3: files of other languages and unrelated file types are not read by this scan", () => {
		const r = scan({ "a.py": "x = 1\n", "app.ts": `const k = "${AWS}";\n`, "README.md": `${AWS}\n`, "data.json": `{"k": "${AWS}"}\n`, "Cargo.toml": `k = "${AWS}"\n` });
		expect(r.files.size).toBe(0);
		expect(r.scannedFiles).toBe(1);
	});

	it("N4: a tree with no Python module is not scanned, even if it holds a requirements file", () => {
		const r = scan({ "app.ts": "export {};\n", "requirements.txt": `k=${AWS}\n` });
		expect(r.status).toBe("no-python-files");
		expect(describePythonSecrets(r)).toEqual({ details: null, notes: [] });
	});

	it("N5: a file over the size bound is skipped and counted, not read", () => {
		const r = scan({ "big.py": `K = "${AWS}"\n${"#".repeat(2 * 1024 * 1024 + 10)}\n` });
		expect(r.files.size).toBe(0);
		expect(r.skips.too_large).toBe(1);
	});

	it("N6: a file that is listed but missing is skipped without an error", () => {
		const root = mkdtempSync(join(tmpdir(), "check-pysec-"));
		roots.push(root);
		const r = scanPythonSecrets(root, ["gone.py"]);
		expect(r.files.size).toBe(0);
		expect(r.skips.unreadable).toBe(1);
	});
});
