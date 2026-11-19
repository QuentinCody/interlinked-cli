import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyByPath } from "./role-evidence.js";
import { applyRepoEvidence, loadRepoEvidence } from "./role-repo-evidence.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tree(files: Record<string, string>): { root: string; paths: string[] } {
	const root = mkdtempSync(join(tmpdir(), "repo-evidence-"));
	roots.push(root);
	for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
	return { root, paths: Object.keys(files) };
}

const model = (name: string): string => `from typing import Any\n\nfrom attrs import define\n\n\n@define\nclass ${name}:\n    id: str\n    value: Any\n\n    def to_dict(self) -> dict:\n        return {"id": self.id, "value": self.value}\n`;
const models = (dir: string, count: number): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${dir}/m${i}.py`, model(`M${i}`)]));
const hand = (dir: string, count: number): Record<string, string> => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${dir}/h${i}.py`, `H${i}_a = ${i}\nH${i}_b = ${i + 1}\n`]));

function decide(files: Record<string, string>, path: string) {
	const { root, paths } = tree(files);
	return applyRepoEvidence(loadRepoEvidence(root, paths), path, classifyByPath(path));
}

describe("applyRepoEvidence: generator evidence sets a file aside as generated", () => {
	it("MUST-FIRE generator-command: a script that runs openapi-python-client with --output-path", () => {
		const files = { "scripts/gen.sh": "#!/bin/sh\nuvx openapi-python-client generate \\\n  --path spec.json \\\n  --output-path src/client\n", ...models("src/client/models", 3), "src/handwritten.py": "x = 1\n" };
		const decision = decide(files, "src/client/models/m0.py");
		expect(decision.role).toBe("generated");
		expect(decision.evidence?.kind).toBe("generator-command");
		expect(decision.evidence?.detail).toContain("openapi-python-client");
		expect(decision.evidence?.detail).toContain("scripts/gen.sh:4");
		expect(decision.from).toBe("product");
		expect(decide(files, "src/handwritten.py").role).toBe("product");
	});

	it("MUST-FIRE generator-config: an openapi-ts config output", () => {
		const files = { "web/openapi-ts.config.ts": "export default {\n  output: './src/client',\n};\n", "web/src/client/a.ts": "export const a = 1;\n", "web/src/app.ts": "export const b = 2;\n" };
		expect(decide(files, "web/src/client/a.ts").evidence?.kind).toBe("generator-config");
		expect(decide(files, "web/src/app.ts").role).toBe("product");
	});

	it("MUST-FIRE attributes: linguist-generated names the directory", () => {
		const files = { ".gitattributes": "/api/models/** linguist-generated=true\n", "api/models/u.py": "x = 1\n", "api/other.py": "y = 2\n" };
		const decision = decide(files, "api/models/u.py");
		expect([decision.role, decision.evidence?.kind]).toEqual(["generated", "attributes"]);
		expect(decision.evidence?.detail).toContain(".gitattributes:1");
		expect(decide(files, "api/other.py").role).toBe("product");
	});

	it("MUST-FIRE attributes: linguist-vendored gives vendor", () => {
		expect(decide({ ".gitattributes": "third/** linguist-vendored\n", "third/a.py": "x = 1\n" }, "third/a.py").role).toBe("vendor");
	});

	it("MUST-FIRE generator-config: an openapi-generator FILES manifest lists exact files", () => {
		const files = { "client/.openapi-generator/FILES": "api.ts\nmodels/user.ts\n", "client/api.ts": "export const a = 1;\n", "client/models/user.ts": "export const u = 1;\n", "client/custom.ts": "export const c = 1;\n" };
		expect(decide(files, "client/models/user.ts").evidence?.kind).toBe("generator-config");
		expect(decide(files, "client/custom.ts").role).toBe("product");
	});
});

describe("applyRepoEvidence: a sqlc output directory that also holds the inputs", () => {
	const yaml = "version: '2'\nsql:\n- name: googlesql\n  schema: googlesql/schema.sql\n  queries: googlesql/query.sql\n  engine: googlesql\n  gen:\n    go:\n      package: authors\n      out: googlesql\n- name: duckdb\n  schema: duckdb/schema.sql\n  queries: duckdb/query.sql\n  gen:\n    go:\n      out: duckdb\n";
	const files = { "examples/authors/sqlc.yaml": yaml, "examples/authors/googlesql/schema.sql": "CREATE TABLE a (id int);\n", "examples/authors/googlesql/query.sql": "-- name: Get :one\nSELECT 1;\n",
		"examples/authors/googlesql/query.sql.go": "package authors\n", "examples/authors/googlesql/db.go": "package authors\n", "examples/authors/duckdb/schema.sql": "CREATE TABLE b (id int);\n", "examples/authors/duckdb/models.go": "package authors\n" };

	it("MUST-NOT-FIRE: examples/authors/googlesql/schema.sql (an input in the output directory) stays product", () => {
		expect(decide(files, "examples/authors/googlesql/schema.sql").role).toBe("product");
		expect(decide(files, "examples/authors/googlesql/query.sql").role).toBe("product");
	});
	it("MUST-NOT-FIRE: examples/authors/duckdb/schema.sql stays product", () => {
		expect(decide(files, "examples/authors/duckdb/schema.sql").role).toBe("product");
	});
	it("MUST-FIRE: examples/authors/googlesql/query.sql.go and db.go are generated by generator-config", () => {
		expect(decide(files, "examples/authors/googlesql/query.sql.go")).toMatchObject({ role: "generated", evidence: { kind: "generator-config" } });
		expect(decide(files, "examples/authors/duckdb/models.go").role).toBe("generated");
		expect(decide(files, "examples/authors/googlesql/db.go").evidence?.detail).toContain("examples/authors/sqlc.yaml:");
	});
});

describe("applyRepoEvidence: weak evidence does not claim a generator", () => {
	it("MUST-NOT-FIRE as generated: a linter exclude alone gives the role unlinted, with the rule", () => {
		const files = { "pyproject.toml": '[tool.ruff]\nextend-exclude = ["examples"]\n', "examples/a.py": "x = 1\n", "src/b.py": "y = 2\n" };
		const decision = decide(files, "examples/a.py");
		expect([decision.role, decision.evidence?.kind]).toEqual(["unlinted", "tool-config"]);
		expect(decision.evidence?.detail).toContain("pyproject.toml:2");
		expect(decide(files, "src/b.py").role).toBe("product");
	});

	it("uniform structure alone is a candidate: the role stays product and the decision carries the numbers", () => {
		const files = { ...models("src/api/models", 30), ...hand("src/app", 14) };
		const decision = decide(files, "src/api/models/m3.py");
		expect(decision.role).toBe("product");
		expect(decision.evidence).toBeNull();
		expect(decision.candidate?.dir).toBe("src/api/models");
		expect(decision.candidate?.detail).toMatch(/30 files, top-3 shape share 1\.00/);
		expect(decide(files, "src/app/h1.py").candidate).toBeUndefined();
	});

	it("uniform structure plus a linter exclude of the directory is generated, naming both", () => {
		const files = { "pyproject.toml": '[tool.ruff]\nextend-exclude = ["src/api/models"]\n', ...models("src/api/models", 30), ...hand("src/app", 14) };
		const decision = decide(files, "src/api/models/m3.py");
		expect([decision.role, decision.evidence?.kind]).toEqual(["generated", "uniform-structure"]);
		expect(decision.evidence?.detail).toContain("confirmed by");
		expect(decision.evidence?.detail).toContain("pyproject.toml:2");
	});

	it("uniform structure plus a document that names a generator and the path is generated", () => {
		const files = { "docs/SOURCE.md": "The client in `src/api/models` is generated by openapi-python-client.\n", ...models("src/api/models", 30), ...hand("src/app", 14) };
		const decision = decide(files, "src/api/models/m3.py");
		expect([decision.role, decision.evidence?.kind]).toEqual(["generated", "uniform-structure"]);
		expect(decision.evidence?.detail).toContain("docs/SOURCE.md:1");
	});

	it("a README that names a generator without a path leaves a uniform directory a candidate", () => {
		const files = { "README.md": "We use openapi-python-client to generate the SDK.\n", ...models("src/api/models", 30), ...hand("src/app", 14) };
		const decision = decide(files, "src/api/models/m3.py");
		expect(decision.role).toBe("product");
		expect(decision.candidate).toBeDefined();
	});
});

describe("applyRepoEvidence: traps that must stay product", () => {
	it("a hand-written directory of varied files that a command names only in a comment", () => {
		const files = { "Makefile": "# openapi-typescript spec.json -o src/lib\nall:\n\ttrue\n", ...hand("src/lib", 25) };
		expect(decide(files, "src/lib/h1.py").role).toBe("product");
	});

	it("a gen.ts that is a hand-written generator script, not its output", () => {
		const files = { "scripts/gen.ts": "export function generate() { return 1; }\n", "src/a.ts": "export const a = 1;\n" };
		expect(decide(files, "scripts/gen.ts").role).toBe("product");
	});

	it("a hand-written codegen.ts without a generates map", () => {
		const files = { "tools/codegen.ts": "export const run = () => 1;\n", "tools/other.ts": "export const o = 1;\n" };
		expect(decide(files, "tools/other.ts").role).toBe("product");
	});

	it("a broad output (the repository root) is skipped and counted, never applied", () => {
		const files = { "buf.gen.yaml": "plugins:\n  - out: .\n", "a.py": "x = 1\n" };
		const { root, paths } = tree(files);
		const evidence = loadRepoEvidence(root, paths);
		expect(applyRepoEvidence(evidence, "a.py", classifyByPath("a.py")).role).toBe("product");
		expect(evidence.summary().skipped["buf:too-broad"]).toBe(1);
	});

	it("tests, vendored and other non-product roles keep their evidence", () => {
		const files = { ".gitattributes": "** linguist-generated\n", "tests/test_a.py": "x = 1\n" };
		expect(decide(files, "tests/test_a.py").role).toBe("test");
	});
});
