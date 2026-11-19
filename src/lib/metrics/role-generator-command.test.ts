import { describe, expect, it } from "vitest";
import { isCommandSourceName, readGeneratorCommands } from "./role-generator-command.js";

const claims = (file: string, text: string): string[] => readGeneratorCommands(file, text).claims.map((c) => `${c.tool} ${c.path}@${c.line}`);

describe("readGeneratorCommands MUST-FIRE", () => {
	it("openapi-python-client in a shell script with line continuations: the output flag line", () => {
		const text = ["#!/bin/sh", "uvx openapi-python-client generate \\", "  --path api/library.json \\", "  --output-path src/library_client", ""].join("\n");
		expect(claims("scripts/build_client.sh", text)).toEqual(["openapi-python-client src/library_client@4"]);
	});

	it("package.json scripts: openapi-typescript -o file, and openapi-generator-cli -o dir", () => {
		const text = '{\n  "scripts": {\n    "generate": "openapi-typescript ../../openapi/spec.json -o src/generated/schema.ts",\n    "openapi:sdk": "npx openapi-generator-cli generate -i ./src/spec.json -g typescript-axios -o ../client/src/api"\n  }\n}\n';
		expect(claims("packages/ts/package.json", text)).toEqual(["openapi-typescript src/generated/schema.ts@3", "openapi-generator ../client/src/api@4"]);
	});

	it("protoc: every --*_out flag, with a plugin option prefix removed", () => {
		expect(claims("Makefile", "gen:\n\tprotoc -I. --python_out=gen --go_out=plugins=grpc:out/go api.proto\n")).toEqual(["protoc gen@2", "protoc out/go@2"]);
	});

	it("a generator whose output is a redirect", () => {
		expect(claims("package.json", '{"scripts":{"types":"supabase gen types typescript --local > src/db/types.ts"}}')).toEqual(["supabase gen types src/db/types.ts@1"]);
	});

	it("a freshness check names the path that the repository regenerates", () => {
		const text = "jobs:\n  gen:\n    steps:\n      - run: pnpm generate\n      - run: git diff --exit-code src/api\n";
		const reading = readGeneratorCommands(".github/workflows/ci.yml", text);
		expect(reading.claims.map((c) => `${c.tool} ${c.path}@${c.line}`)).toEqual(["freshness-check src/api@5"]);
	});
});

describe("readGeneratorCommands MUST-NOT-FIRE", () => {
	it("a comment that mentions the command", () => {
		expect(claims("Makefile", "# run: openapi-typescript spec.json -o src/x.ts\n")).toEqual([]);
	});

	it("the word protocol is not protoc", () => {
		expect(claims("scripts/a.sh", "echo protocol --foo_out=bar\n")).toEqual([]);
	});

	it("installing or listing a generator without an output flag", () => {
		expect(claims("package.json", '{"scripts":{"setup":"npm install openapi-typescript"}}')).toEqual([]);
	});

	it("-o of an unrelated tool", () => {
		expect(claims("Makefile", "build:\n\tgcc -o main main.c\n")).toEqual([]);
	});

	it("a freshness check with no generator step near it", () => {
		expect(claims(".github/workflows/lint.yml", "steps:\n  - run: git diff --exit-code package-lock.json\n")).toEqual([]);
	});

	it("git diff without a failing flag is not a freshness check", () => {
		expect(claims(".github/workflows/ci.yml", "steps:\n  - run: pnpm generate\n  - run: git diff src/api\n")).toEqual([]);
	});
});

describe("freshness checks cover exactly the paths the repository regenerates", () => {
	const workflow = [
		"jobs:", "  pg:", "    steps:", "    - run: go run ./cmd/buildspec generate catalogue", "    - name: Save results", "      uses: actions/upload-artifact@v7",
		"      with:", "        name: grammar-catalogue", "        path: lib/formats/catalogue/grammar", "    - name: Fail if the committed grammar differs",
		"      run: git add -N lib/formats/catalogue && git diff --exit-code --stat -- lib/formats/catalogue", "",
	].join("\n");

	it("MUST-FIRE: a check on a directory narrows to the sub-directory that the same job uploads as the generated artifact", () => {
		expect(claims(".github/workflows/gen.yml", workflow)).toEqual(["freshness-check lib/formats/catalogue/grammar@11"]);
	});

	it("MUST-NOT-FIRE: the parent directory (it also holds hand-written seed.go) is not claimed", () => {
		expect(claims(".github/workflows/gen.yml", workflow)).not.toContain("freshness-check lib/formats/catalogue@11");
	});

	it("without a narrower artifact path the named directory is the claim", () => {
		expect(claims(".github/workflows/ci.yml", "steps:\n  - run: pnpm generate\n  - run: git diff --exit-code src/api\n")).toEqual(["freshness-check src/api@3"]);
	});
});

describe("a script that runs a generator and names its output directory in a variable assigned a literal", () => {
	it("MUST-FIRE: python, the generator in an argv list and the destination in `output_path = Path(...)`; the temp directory is not claimed", () => {
		const text = [
			"def generate_inventory():", "    output_path = Path(\"src/catalogue/api/inventory\")", "    temp_output = Path(\"temp_inventory_client\")",
			"    cmd = [", "        \"openapi-python-client\",", "        \"generate\",", "        \"--output-path\",", "        str(temp_output),", "    ]", "",
		].join("\n");
		expect(claims("sdks/python/scripts/generate_api.py", text)).toEqual(["openapi-python-client src/catalogue/api/inventory@2"]);
	});

	it("MUST-FIRE: shell, a literal variable reused inside another and an unresolved leading variable that is dropped", () => {
		const text = "ROOT=\"$(cd \"$(dirname \"$0\")/..\" && pwd)\"\nPKG_DIR=\"$ROOT/packages/sdk\"\nOUT_DIR=\"$PKG_DIR/src/gen\"\nuv tool run openapi-python-client generate --path x.yaml --output-path \"$TMP\"\n";
		expect(claims("packages/sdk/scripts/codegen.sh", text)).toEqual(["openapi-python-client packages/sdk/src/gen@3"]);
	});

	it("MUST-NOT-FIRE: an output variable in a script that runs no generator", () => {
		expect(claims("scripts/build.sh", "OUT_DIR=\"src/docs\"\ncp -r a \"$OUT_DIR\"\n")).toEqual([]);
	});

	it("MUST-NOT-FIRE: a script whose name says generate but which runs no known generator", () => {
		expect(claims("scripts/generate.sh", "output_dir=\"src/x\"\necho hi\n")).toEqual([]);
	});

	it("MUST-NOT-FIRE: a variable that is not an output, and one that holds a temporary directory", () => {
		const text = "SPEC=\"docs/api.yaml\"\nTMP_DIR=\"build/tmp_out\"\nopenapi-python-client generate --path docs/api.yaml\n";
		expect(claims("scripts/gen.sh", text)).toEqual([]);
	});
});

describe("isCommandSourceName", () => {
	it("names script-like sources", () => {
		for (const name of ["package.json", "a/Makefile", "justfile", "scripts/gen.sh", ".github/workflows/ci.yml", "tox.ini", "Taskfile.yml"]) expect(isCommandSourceName(name)).toBe(true);
		for (const name of ["src/index.ts", "README.md", "tsconfig.json"]) expect(isCommandSourceName(name)).toBe(false);
	});
});
