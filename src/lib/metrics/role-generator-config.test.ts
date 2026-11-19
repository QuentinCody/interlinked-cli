import { describe, expect, it } from "vitest";
import { isGeneratorConfigName, readGeneratorConfig } from "./role-generator-config.js";

const paths = (file: string, text: string): string[] => readGeneratorConfig(file, text).claims.map((c) => `${c.tool} ${c.baseDir}|${c.path}@${c.line}`);

describe("readGeneratorConfig MUST-FIRE (one case per dialect)", () => {
	it("buf.gen.yaml: every plugin out", () => {
		expect(paths("proto/buf.gen.yaml", "version: v1\nplugins:\n  - plugin: go\n    out: gen/go\n  - name: ts\n    out: gen/ts # note\n")).toEqual(["buf proto|gen/go@4", "buf proto|gen/ts@6"]);
	});
	it("sqlc.yaml: gen out, relative to the config", () => {
		expect(paths("db/sqlc.yaml", "version: '2'\nsql:\n  - gen:\n      go:\n        out: \"internal/db\"\n")).toEqual(["sqlc db|internal/db@5"]);
	});
	it("sqlc.json", () => {
		expect(paths("sqlc.json", '{"packages":[{"path":"db","out":"gen/db"}]}')).toEqual(["sqlc |gen/db@1"]);
	});
	it("schema.prisma: the generator output, not a datasource line", () => {
		expect(paths("prisma/schema.prisma", 'generator client {\n  provider = "prisma-client-js"\n  output   = "./generated"\n}\ndatasource db {\n  output = "no"\n}\n')).toEqual(["prisma prisma|./generated@3"]);
	});
	it("orval.config.ts: target and schemas", () => {
		expect(paths("web/orval.config.ts", "export default { api: { output: { target: 'src/api/a.ts', schemas: 'src/api/model' } } };")).toEqual(["orval web|src/api/a.ts@1", "orval web|src/api/model@1"]);
	});
	it("openapi-ts.config.ts: a string output and an object output path", () => {
		expect(paths("openapi-ts.config.ts", 'export default defineConfig({ input: "x", output: "./src/client" });')).toEqual(["openapi-ts |./src/client@1"]);
		expect(paths("openapi-ts.config.ts", "export default {\n  output: {\n    path: './gen',\n  },\n};")).toEqual(["openapi-ts |./gen@3"]);
	});
	it("codegen.yml: the generates keys only", () => {
		const text = "schema: schema.graphql\ngenerates:\n  src/gql/types.ts:\n    plugins:\n      - typescript\n  src/gql/:\n    preset: client\nconfig:\n  x: y\n";
		expect(paths("codegen.yml", text)).toEqual(["graphql-codegen |src/gql/types.ts@3", "graphql-codegen |src/gql/@6"]);
	});
	it("codegen.ts: the generates keys that are paths", () => {
		const text = "const config = {\n  generates: {\n    './src/gql/': { preset: 'client', plugins: [] },\n    'schema.graphql': { plugins: ['schema-ast'] },\n  },\n};";
		expect(paths("codegen.ts", text)).toEqual(["graphql-codegen |./src/gql/@3", "graphql-codegen |schema.graphql@4"]);
	});
	it("oapi-codegen yaml: output", () => {
		expect(paths(".oapi-codegen.yaml", "package: api\noutput: backend/gen/api.gen.go\n")).toEqual(["oapi-codegen |backend/gen/api.gen.go@2"]);
	});
	it(".openapi-generator/FILES: one claim per listed file, relative to the parent of the directory", () => {
		expect(paths("client/src/api/.openapi-generator/FILES", ".gitignore\napi.ts\nmodels/user.ts\n\n")).toEqual([
			"openapi-generator client/src/api|.gitignore@1", "openapi-generator client/src/api|api.ts@2", "openapi-generator client/src/api|models/user.ts@3"]);
	});
});

describe("a generator-config claim carries the inputs of its own config and the language of its output", () => {
	const sqlcYaml = "version: '2'\nsql:\n- name: googlesql\n  schema: googlesql/schema.sql\n  queries: googlesql/query.sql\n  engine: googlesql\n  gen:\n    go:\n      package: authors\n      out: googlesql\n- name: py\n  schema: [\"py/schema.sql\", \"py/more.sql\"]\n  queries:\n    - py/query.sql\n  gen:\n    python:\n      out: py\n";
	const detail = (file: string, text: string): string[] => readGeneratorConfig(file, text).claims.map((c) => `${c.path}|inputs=${(c.inputs ?? []).join(",")}|ext=${(c.extensions ?? []).join(",")}`);

	it("sqlc yaml: the schema and queries entries are inputs; the gen language gives the extension", () => {
		expect(detail("examples/authors/sqlc.yaml", sqlcYaml)).toEqual(["googlesql|inputs=googlesql/schema.sql,googlesql/query.sql|ext=.go", "py|inputs=py/schema.sql,py/more.sql,py/query.sql|ext=.py"]);
	});
	it("sqlc json: the same", () => {
		const json = '{"version":"2","sql":[{"schema":"db/schema.sql","queries":["db/q.sql"],"gen":{"kotlin":{"out":"db"}}}]}';
		expect(detail("sqlc.json", json)).toEqual(["db|inputs=db/schema.sql,db/q.sql|ext=.kt"]);
	});
	it("an output language that the table does not know claims every extension (no filter), but still keeps its inputs out", () => {
		const text = "sql:\n- schema: s.sql\n  queries: q.sql\n  gen:\n    json:\n      out: gen\n";
		expect(detail("sqlc.yaml", text)).toEqual(["gen|inputs=s.sql,q.sql|ext="]);
	});
	it("openapi-ts and orval: the `input` is an input", () => {
		expect(detail("openapi-ts.config.ts", "export default { input: './spec.json', output: './src/client' };")).toEqual(["./src/client|inputs=./spec.json|ext="]);
		expect(detail("orval.config.ts", "export default { api: { input: './spec.yaml', output: { target: 'src/api/a.ts' } } };")).toEqual(["src/api/a.ts|inputs=./spec.yaml|ext="]);
	});
	it("graphql-codegen yaml: schema and documents are inputs", () => {
		expect(detail("codegen.yml", "schema: schema.graphql\ndocuments: src/**/*.graphql\ngenerates:\n  src/gql/:\n    preset: client\n")).toEqual(["src/gql/|inputs=schema.graphql|ext="]);
	});
});

describe("openapi-generator config with a files: map", () => {
	const okta = "templateDir: ./templates\noutputDir: ..\npackageName: okta\nfiles:\n  okta/okta_configuration.mustache:\n    destinationFilename: okta/okta_configuration.py\n    templateType: SupportingFiles\n  okta/exceptions.mustache:\n    destinationFilename: okta/exceptions.py\n";
	it("MUST-FIRE: each destinationFilename, relative to the config directory joined with outputDir", () => {
		expect(paths("openapi/config.yaml", okta)).toEqual(["openapi-generator |okta/okta_configuration.py@6", "openapi-generator |okta/exceptions.py@9"]);
	});
	it("MUST-NOT-FIRE: an unrelated config.yaml (no destinationFilename) names nothing and is not counted as a dialect", () => {
		const reading = readGeneratorConfig("app/config.yaml", "debug: true\nport: 8080\n");
		expect(reading).toEqual({ claims: [], skipped: [] });
	});
});

describe("readGeneratorConfig MUST-NOT-FIRE", () => {
	it("a hand-written codegen.ts that has no generates map names nothing", () => {
		const reading = readGeneratorConfig("packages/cli/src/codegen/codegen.ts", "export function codegen(input: string) {\n  return input.trim();\n}\n");
		expect(reading.claims).toEqual([]);
		expect(reading.skipped).toEqual([]);
	});
	it("a commented-out out: line, in yaml and in js", () => {
		expect(paths("buf.gen.yaml", "#out: pkg/api\nplugins: []\n")).toEqual([]);
		expect(paths("openapi-ts.config.ts", "// output: './old'\nexport default {};")).toEqual([]);
	});
	it("a prisma generator without an output, and an env() output (skipped and counted)", () => {
		expect(paths("schema.prisma", 'generator client {\n  provider = "prisma-client-js"\n}\n')).toEqual([]);
		const reading = readGeneratorConfig("schema.prisma", 'generator client {\n  output = env("OUT")\n}\n');
		expect(reading.claims).toEqual([]);
		expect(reading.skipped.map((s) => s.reason)).toEqual(["variable-path"]);
	});
	it("a template-literal output is skipped, never guessed", () => {
		const reading = readGeneratorConfig("openapi-ts.config.ts", "export default { output: `${process.env.OUT}/gen` };");
		expect(reading.claims).toEqual([]);
		expect(reading.skipped.map((s) => s.reason)).toEqual(["variable-path"]);
	});
	it("a dialect that names no output is counted as unsupported", () => {
		const reading = readGeneratorConfig("openapi/python-client.yaml", "post_hooks: []\nclass_overrides: {}\n");
		expect(reading.claims).toEqual([]);
		expect(reading.skipped.map((s) => `${s.tool}:${s.reason}`)).toEqual(["openapi-python-client:no-output-path"]);
	});
});

describe("isGeneratorConfigName", () => {
	it("names the files that the reader reads", () => {
		for (const name of ["buf.gen.yaml", "x/sqlc.yaml", "schema.prisma", "orval.config.js", "openapi-ts.config.mts", "codegen.yml", "a/.oapi-codegen.yaml", "c/.openapi-generator/FILES", "openapi/python-client.yaml"]) expect(isGeneratorConfigName(name)).toBe(true);
		for (const name of ["src/codegen/index.ts", "README.md", "package.json", "sqlc.ts"]) expect(isGeneratorConfigName(name)).toBe(false);
	});
});
