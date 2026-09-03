// Unit tests for schema-validator-artifacts-layers.ts — validateLayerRuleEntry,
// the per-rule-entry validator extracted from validateLayerRules.

import { describe, expect, it } from "vitest";
import { validateLayerRuleEntry } from "./schema-validator-artifacts-layers.js";
import type { ValidationError } from "./schema-validator-helpers.js";

describe("validateLayerRuleEntry", () => {
	it("accepts a valid entry referencing declared layers", () => {
		const errors: ValidationError[] = [];
		validateLayerRuleEntry(
			{ from: "ui", cannot_import: ["db"], reason: "layering" },
			"$.rules[0]",
			new Set(["ui", "db"]),
			errors,
		);
		expect(errors).toEqual([]);
	});

	it("flags an unknown key", () => {
		const errors: ValidationError[] = [];
		validateLayerRuleEntry(
			// SAFETY: intentionally malformed input to exercise the unknown-key check
			{ from: "ui", cannot_import: [], reason: "x", extra: true } as never,
			"$.rules[0]",
			new Set(["ui"]),
			errors,
		);
		expect(errors).toContainEqual({ path: "$.rules[0].extra", message: 'Unknown key "extra"' });
	});

	it("flags non-string `from`", () => {
		const errors: ValidationError[] = [];
		validateLayerRuleEntry(
			// SAFETY: intentionally malformed input to exercise the type check
			{ from: 5, cannot_import: [], reason: "x" } as never,
			"$.rules[0]",
			new Set(),
			errors,
		);
		expect(errors).toContainEqual({ path: "$.rules[0].from", message: "Must be a string" });
	});

	it("flags `from` referencing an undeclared layer", () => {
		const errors: ValidationError[] = [];
		validateLayerRuleEntry(
			{ from: "ghost", cannot_import: [], reason: "x" },
			"$.rules[0]",
			new Set(["ui"]),
			errors,
		);
		expect(errors).toContainEqual({
			path: "$.rules[0].from",
			message: 'References undeclared layer "ghost"',
		});
	});

	it("skips the from/cannot_import layer check when no layers are declared", () => {
		const errors: ValidationError[] = [];
		validateLayerRuleEntry(
			{ from: "ghost", cannot_import: ["also-ghost"], reason: "x" },
			"$.rules[0]",
			new Set(),
			errors,
		);
		expect(errors).toEqual([]);
	});

	it("flags non-array cannot_import", () => {
		const errors: ValidationError[] = [];
		validateLayerRuleEntry(
			// SAFETY: intentionally malformed input to exercise the type check
			{ from: "ui", cannot_import: "db", reason: "x" } as never,
			"$.rules[0]",
			new Set(["ui"]),
			errors,
		);
		expect(errors).toContainEqual({
			path: "$.rules[0].cannot_import",
			message: "Must be an array",
		});
	});

	it("flags cannot_import entries referencing undeclared layers", () => {
		const errors: ValidationError[] = [];
		validateLayerRuleEntry(
			{ from: "ui", cannot_import: ["ghost"], reason: "x" },
			"$.rules[0]",
			new Set(["ui"]),
			errors,
		);
		expect(errors).toContainEqual({
			path: "$.rules[0].cannot_import",
			message: 'References undeclared layer "ghost"',
		});
	});

	it("flags an empty reason", () => {
		const errors: ValidationError[] = [];
		validateLayerRuleEntry(
			{ from: "ui", cannot_import: [], reason: "" },
			"$.rules[0]",
			new Set(["ui"]),
			errors,
		);
		expect(errors).toContainEqual({
			path: "$.rules[0].reason",
			message: "Must be a non-empty string",
		});
	});

	it("flags a reason over 160 characters", () => {
		const errors: ValidationError[] = [];
		validateLayerRuleEntry(
			{ from: "ui", cannot_import: [], reason: "x".repeat(161) },
			"$.rules[0]",
			new Set(["ui"]),
			errors,
		);
		expect(errors).toContainEqual({
			path: "$.rules[0].reason",
			message: "Should be under 160 characters",
		});
	});
});
