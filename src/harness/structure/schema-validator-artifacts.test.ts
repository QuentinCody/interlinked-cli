// Unit tests for schema-validator-artifacts.ts — per-artifact-file schema
// validators (public_api, env, config, glossary, layers) plus the
// validateArtifactFile dispatcher. Each validator rejects unknown keys and
// malformed shapes; these tests assert the actual rejection (path +
// message), not just that validity flipped to false.

import { describe, expect, it } from "vitest";
import {
	validateArtifactFile,
	validateConfigFile,
	validateEnvFile,
	validateGlossaryFile,
	validateLayersFile,
	validatePublicApiFile,
} from "./schema-validator-artifacts.js";

/** Convenience: find the first error whose path matches exactly. */
function errAt(result: { errors: Array<{ path: string; message: string }> }, path: string) {
	return result.errors.find((e) => e.path === path);
}

// ----------------------------------------------------------------------------
// validatePublicApiFile
// ----------------------------------------------------------------------------

describe("validatePublicApiFile", () => {
	it("accepts a minimal valid file", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [
				{
					id: "mod-a",
					file: "src/a.ts",
					symbols: [
						{
							name: "foo",
							kind: "function",
							stability: "public",
							docs: [],
							tests: [],
							examples: [],
						},
					],
				},
			],
		});
		expect(result.valid).toBe(true);
	});

	it("rejects a non-object payload", () => {
		const result = validatePublicApiFile("not an object");
		expect(result.valid).toBe(false);
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects an array payload", () => {
		expect(validatePublicApiFile([]).valid).toBe(false);
	});

	it("rejects a null payload", () => {
		expect(validatePublicApiFile(null).valid).toBe(false);
	});

	it("rejects version !== 1", () => {
		const result = validatePublicApiFile({ version: 2, modules: [] });
		expect(errAt(result, "$.version")?.message).toBe("Must be 1");
	});

	it("rejects modules that is not an array and stops early", () => {
		const result = validatePublicApiFile({ version: 1, modules: "nope" });
		expect(result.valid).toBe(false);
		expect(errAt(result, "$.modules")?.message).toBe("Must be an array");
	});

	it("rejects a module entry with a non-string id", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [{ id: 42, file: "src/a.ts", symbols: [] }],
		});
		expect(errAt(result, "$.modules[0].id")?.message).toBe("Must be a string");
	});

	it("rejects a module entry with a non-string file", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [{ id: "mod-a", file: 42, symbols: [] }],
		});
		expect(errAt(result, "$.modules[0].file")?.message).toBe("Must be a string");
	});

	it("rejects a module entry whose symbols is not an array", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [{ id: "mod-a", file: "src/a.ts", symbols: "nope" }],
		});
		expect(errAt(result, "$.modules[0].symbols")?.message).toBe("Must be an array");
	});

	it("rejects a symbol with an empty name", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [
				{
					id: "mod-a",
					file: "src/a.ts",
					symbols: [{ name: "", kind: "function", stability: "public" }],
				},
			],
		});
		expect(errAt(result, "$.modules[0].symbols[0].name")?.message).toBe(
			"Must be a non-empty string",
		);
	});

	it("rejects a symbol with a non-string name", () => {
		const result = validatePublicApiFile({
			version: 1,
			modules: [
				{
					id: "mod-a",
					file: "src/a.ts",
					symbols: [{ name: 7, kind: "function", stability: "public" }],
				},
			],
		});
		expect(errAt(result, "$.modules[0].symbols[0].name")?.message).toBe(
			"Must be a non-empty string",
		);
	});
});

// ----------------------------------------------------------------------------
// validateEnvFile
// ----------------------------------------------------------------------------

describe("validateEnvFile", () => {
	it("accepts a minimal valid file", () => {
		const result = validateEnvFile({
			version: 1,
			keys: [{ name: "API_KEY", required: true }],
		});
		expect(result.valid).toBe(true);
	});

	it("rejects a non-object payload", () => {
		const result = validateEnvFile(42);
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects a sources field that is not an object", () => {
		const result = validateEnvFile({ version: 1, sources: "nope", keys: [] });
		expect(errAt(result, "$.sources")?.message).toBe("Must be an object");
	});

	it("rejects a sources field that is an array", () => {
		const result = validateEnvFile({ version: 1, sources: [], keys: [] });
		expect(errAt(result, "$.sources")?.message).toBe("Must be an object");
	});

	it("rejects a key with a non-string name", () => {
		const result = validateEnvFile({ version: 1, keys: [{ name: 7, required: true }] });
		expect(errAt(result, "$.keys[0].name")?.message).toBe("Must be a string");
	});

	it("rejects a key with a non-boolean required flag", () => {
		const result = validateEnvFile({
			version: 1,
			keys: [{ name: "API_KEY", required: "yes" }],
		});
		expect(errAt(result, "$.keys[0].required")?.message).toBe("Must be a boolean");
	});
});

// ----------------------------------------------------------------------------
// validateConfigFile
// ----------------------------------------------------------------------------

describe("validateConfigFile", () => {
	it("accepts a minimal valid file", () => {
		const result = validateConfigFile({
			version: 1,
			roots: [{ id: "root-a", file: "config.json" }],
			keys: [{ name: "port", required: true }],
		});
		expect(result.valid).toBe(true);
	});

	it("rejects a non-object payload", () => {
		const result = validateConfigFile([]);
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects version !== 1", () => {
		const result = validateConfigFile({ version: 2, keys: [] });
		expect(errAt(result, "$.version")?.message).toBe("Must be 1");
	});

	it("rejects an unknown key inside a roots entry", () => {
		const result = validateConfigFile({
			version: 1,
			roots: [{ id: "root-a", file: "config.json", bogus: true }],
			keys: [],
		});
		expect(errAt(result, "$.roots[0].bogus")?.message).toBe('Unknown key "bogus"');
	});

	it("rejects a roots entry with a non-string file", () => {
		const result = validateConfigFile({
			version: 1,
			roots: [{ id: "root-a", file: 7 }],
			keys: [],
		});
		expect(errAt(result, "$.roots[0].file")?.message).toBe("Must be a string");
	});

	it("rejects a roots entry whose file is not repo-relative", () => {
		const result = validateConfigFile({
			version: 1,
			roots: [{ id: "root-a", file: "/etc/config.json" }],
			keys: [],
		});
		expect(errAt(result, "$.roots[0].file")?.message).toBe(
			"Must be a repo-relative POSIX path",
		);
	});

	it("rejects keys that is not an array and stops early", () => {
		const result = validateConfigFile({ version: 1, keys: "nope" });
		expect(result.valid).toBe(false);
		expect(errAt(result, "$.keys")?.message).toBe("Must be an array");
	});

	it("rejects a key entry with an empty name", () => {
		const result = validateConfigFile({
			version: 1,
			keys: [{ name: "", required: true }],
		});
		expect(errAt(result, "$.keys[0].name")?.message).toBe("Must be a non-empty string");
	});

	it("rejects a key entry with a non-boolean required flag", () => {
		const result = validateConfigFile({
			version: 1,
			keys: [{ name: "port", required: 1 }],
		});
		expect(errAt(result, "$.keys[0].required")?.message).toBe("Must be a boolean");
	});
});

// ----------------------------------------------------------------------------
// validateGlossaryFile
// ----------------------------------------------------------------------------

describe("validateGlossaryFile", () => {
	it("accepts a minimal valid file", () => {
		const result = validateGlossaryFile({
			version: 1,
			terms: [{ id: "term-a", canonical: "Widget" }],
		});
		expect(result.valid).toBe(true);
	});

	it("rejects a non-object payload", () => {
		const result = validateGlossaryFile("nope");
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects version !== 1", () => {
		const result = validateGlossaryFile({ version: 2, terms: [] });
		expect(errAt(result, "$.version")?.message).toBe("Must be 1");
	});

	it("rejects terms that is not an array and stops early", () => {
		const result = validateGlossaryFile({ version: 1, terms: "nope" });
		expect(result.valid).toBe(false);
		expect(errAt(result, "$.terms")?.message).toBe("Must be an array");
	});

	it("rejects a term with a non-string id", () => {
		const result = validateGlossaryFile({
			version: 1,
			terms: [{ id: 7, canonical: "Widget" }],
		});
		expect(errAt(result, "$.terms[0].id")?.message).toBe("Must be a string");
	});

	it("rejects a term with an empty canonical", () => {
		const result = validateGlossaryFile({
			version: 1,
			terms: [{ id: "term-a", canonical: "" }],
		});
		expect(errAt(result, "$.terms[0].canonical")?.message).toBe("Must be a non-empty string");
	});

	it("flags a canonical that collides case-insensitively with a prior term", () => {
		const result = validateGlossaryFile({
			version: 1,
			terms: [
				{ id: "term-a", canonical: "Widget" },
				{ id: "term-b", canonical: "widget" },
			],
		});
		const found = errAt(result, "$.terms[1].canonical");
		expect(found?.message).toContain('collides with term "term-a"');
	});

	it("flags an alias that collides with an existing canonical", () => {
		const result = validateGlossaryFile({
			version: 1,
			terms: [
				{ id: "term-a", canonical: "Widget" },
				{ id: "term-b", canonical: "Gadget", aliases: ["widget"] },
			],
		});
		const found = errAt(result, "$.terms[1].aliases");
		expect(found?.message).toContain('collides with term "term-a"');
	});

	it("flags a deprecated name that collides with an existing canonical", () => {
		const result = validateGlossaryFile({
			version: 1,
			terms: [
				{ id: "term-a", canonical: "Widget" },
				{ id: "term-b", canonical: "Gadget", deprecated: ["widget"] },
			],
		});
		const found = errAt(result, "$.terms[1].deprecated");
		expect(found?.message).toContain('collides with term "term-a"');
	});
});

// ----------------------------------------------------------------------------
// validateLayersFile
// ----------------------------------------------------------------------------

describe("validateLayersFile", () => {
	it("accepts a minimal valid file", () => {
		const result = validateLayersFile({
			version: 1,
			layers: [{ id: "core", globs: ["src/core/**"] }],
			rules: [{ from: "core", cannot_import: [], reason: "core stays leaf" }],
		});
		expect(result.valid).toBe(true);
	});

	it("rejects a non-object payload", () => {
		const result = validateLayersFile([]);
		expect(errAt(result, "$")?.message).toBe("Must be a JSON object");
	});

	it("rejects version !== 1", () => {
		const result = validateLayersFile({ version: 2, layers: [], rules: [] });
		expect(errAt(result, "$.version")?.message).toBe("Must be 1");
	});

	it("rejects a layers field that is not an array", () => {
		const result = validateLayersFile({ version: 1, layers: "nope", rules: [] });
		expect(errAt(result, "$.layers")?.message).toBe("Must be an array");
	});

	it("rejects a layer entry with a non-string id", () => {
		const result = validateLayersFile({
			version: 1,
			layers: [{ id: 7, globs: [] }],
			rules: [],
		});
		expect(errAt(result, "$.layers[0].id")?.message).toBe("Must be a string");
	});

	it("rejects a rules field that is not an array", () => {
		const result = validateLayersFile({ version: 1, layers: [], rules: "nope" });
		expect(errAt(result, "$.rules")?.message).toBe("Must be an array");
	});

	it("rejects a rule with a non-string from", () => {
		const result = validateLayersFile({
			version: 1,
			layers: [{ id: "core", globs: [] }],
			rules: [{ from: 7, cannot_import: [], reason: "why" }],
		});
		expect(errAt(result, "$.rules[0].from")?.message).toBe("Must be a string");
	});

	it("rejects a rule whose from references an undeclared layer", () => {
		const result = validateLayersFile({
			version: 1,
			layers: [{ id: "core", globs: [] }],
			rules: [{ from: "ghost", cannot_import: [], reason: "why" }],
		});
		expect(errAt(result, "$.rules[0].from")?.message).toBe(
			'References undeclared layer "ghost"',
		);
	});

	it("rejects a rule whose cannot_import is not an array", () => {
		const result = validateLayersFile({
			version: 1,
			layers: [{ id: "core", globs: [] }],
			rules: [{ from: "core", cannot_import: "nope", reason: "why" }],
		});
		expect(errAt(result, "$.rules[0].cannot_import")?.message).toBe("Must be an array");
	});

	it("rejects a rule whose cannot_import references an undeclared layer", () => {
		const result = validateLayersFile({
			version: 1,
			layers: [{ id: "core", globs: [] }],
			rules: [{ from: "core", cannot_import: ["ghost"], reason: "why" }],
		});
		expect(errAt(result, "$.rules[0].cannot_import")?.message).toBe(
			'References undeclared layer "ghost"',
		);
	});

	it("rejects a rule with an empty reason", () => {
		const result = validateLayersFile({
			version: 1,
			layers: [{ id: "core", globs: [] }],
			rules: [{ from: "core", cannot_import: [], reason: "" }],
		});
		expect(errAt(result, "$.rules[0].reason")?.message).toBe("Must be a non-empty string");
	});

	it("rejects a rule reason longer than 160 characters", () => {
		const result = validateLayersFile({
			version: 1,
			layers: [{ id: "core", globs: [] }],
			rules: [{ from: "core", cannot_import: [], reason: "x".repeat(161) }],
		});
		expect(errAt(result, "$.rules[0].reason")?.message).toBe("Should be under 160 characters");
	});

	it("skips undeclared-layer checks entirely when no layers are declared", () => {
		const result = validateLayersFile({
			version: 1,
			layers: [],
			rules: [{ from: "anything", cannot_import: ["anything-else"], reason: "leniency" }],
		});
		expect(errAt(result, "$.rules[0].from")).toBeUndefined();
		expect(errAt(result, "$.rules[0].cannot_import")).toBeUndefined();
	});
});

// ----------------------------------------------------------------------------
// validateArtifactFile — dispatcher
// ----------------------------------------------------------------------------

describe("validateArtifactFile", () => {
	it("dispatches to the correct validator for each known key", () => {
		expect(validateArtifactFile("public_api", { version: 1, modules: [] }).valid).toBe(true);
		expect(validateArtifactFile("env", { version: 1, keys: [] }).valid).toBe(true);
		expect(validateArtifactFile("config", { version: 1, keys: [] }).valid).toBe(true);
		expect(validateArtifactFile("glossary", { version: 1, terms: [] }).valid).toBe(true);
		expect(
			validateArtifactFile("layers", { version: 1, layers: [], rules: [] }).valid,
		).toBe(true);
	});

	it("rejects an unknown artifact file key", () => {
		const result = validateArtifactFile("bogus", {});
		expect(result.valid).toBe(false);
		expect(errAt(result, "$")?.message).toBe('Unknown artifact file key: bogus');
	});
});
