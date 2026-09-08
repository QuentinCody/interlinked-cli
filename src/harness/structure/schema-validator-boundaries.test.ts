import { describe, expect, it } from "vitest";
import { validateArtifactFile } from "./schema-validator-artifacts.js";
import type { ArtifactFileKey } from "./types.js";

interface EntryBoundary {
	key: ArtifactFileKey;
	path: string;
	data: (entry: unknown) => unknown;
}

const boundaries: EntryBoundary[] = [
	{ key: "public_api", path: "$.modules[0]", data: (entry) => ({ version: 1, modules: [entry] }) },
	{ key: "public_api", path: "$.modules[0].symbols[0]", data: (entry) => ({ version: 1, modules: [{ id: "module", file: "src/module.ts", symbols: [entry] }] }) },
	{ key: "env", path: "$.keys[0]", data: (entry) => ({ version: 1, keys: [entry] }) },
	{ key: "config", path: "$.keys[0]", data: (entry) => ({ version: 1, keys: [entry] }) },
	{ key: "config", path: "$.roots[0]", data: (entry) => ({ version: 1, keys: [], roots: [entry] }) },
	{ key: "glossary", path: "$.terms[0]", data: (entry) => ({ version: 1, terms: [entry] }) },
	{ key: "layers", path: "$.layers[0]", data: (entry) => ({ version: 1, layers: [entry], rules: [] }) },
	{ key: "layers", path: "$.rules[0]", data: (entry) => ({ version: 1, layers: [], rules: [entry] }) },
	{ key: "tests", path: "$.tests[0]", data: (entry) => ({ version: 1, tests: [entry] }) },
	{ key: "docs", path: "$.docs[0]", data: (entry) => ({ version: 1, docs: [entry] }) },
	{ key: "examples", path: "$.examples[0]", data: (entry) => ({ version: 1, examples: [entry] }) },
	{ key: "packages", path: "$.packages[0]", data: (entry) => ({ version: 1, packages: [entry] }) },
	{ key: "tests", path: "$.tests[0].covers[0]", data: (entry) => ({ version: 1, tests: [{ id: "unit", file: "src/module.test.ts", kind: "unit", covers: [entry] }] }) },
	{ key: "docs", path: "$.docs[0].covers[0]", data: (entry) => ({ version: 1, docs: [{ id: "guide", file: "docs/guide.md", kind: "guide", covers: [entry] }] }) },
	{ key: "examples", path: "$.examples[0].covers[0]", data: (entry) => ({ version: 1, examples: [{ id: "example", file: "examples/module.ts", covers: [entry] }] }) },
];

describe("artifact validator boundaries", () => {
	it.each(boundaries.flatMap((boundary) => [null, false, 42, "entry", []].map((entry) => ({ ...boundary, entry }))))(
		"$key rejects $entry at $path with a validation result",
		({ key, path, data, entry }) => {
			expect(validateArtifactFile(key, data(entry))).toEqual({
				valid: false,
				errors: [{ path, message: "Must be a JSON object" }],
			});
		},
	);

	it("reports each malformed entry and still validates later objects", () => {
		expect(validateArtifactFile("public_api", { version: 1, modules: [null, {}, { id: "ok", file: "src/ok.ts", symbols: [] }] })).toEqual({
			valid: false,
			errors: [
				{ path: "$.modules[0]", message: "Must be a JSON object" },
				{ path: "$.modules[1].id", message: "Must be a string" },
				{ path: "$.modules[1].file", message: "Must be a string" },
				{ path: "$.modules[1].symbols", message: "Must be an array" },
			],
		});
	});

	it.each(["aliases", "deprecated"])("reports nonstring glossary %s without throwing", (field) => {
		expect(validateArtifactFile("glossary", { version: 1, terms: [{ id: "term", canonical: "Term", [field]: [null, 42] }] })).toEqual({
			valid: false,
			errors: [
				{ path: `$.terms[0].${field}[0]`, message: "Must be a string" },
				{ path: `$.terms[0].${field}[1]`, message: "Must be a string" },
			],
		});
	});

	it("rejects nonstring layer references even with no declared layers", () => {
		expect(validateArtifactFile("layers", { version: 1, layers: [], rules: [{ from: "source", cannot_import: [null], reason: "boundary" }] })).toEqual({
			valid: false,
			errors: [{ path: "$.rules[0].cannot_import[0]", message: "Must be a string" }],
		});
	});
});
