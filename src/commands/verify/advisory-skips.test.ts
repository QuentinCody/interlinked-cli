// ===========================================
// advisory-skips unit tests (moved from advisory.test.ts with the functions)
// ===========================================

import { describe, expect, it } from "vitest";
import { DEFAULT_ADVISORY_SKIPS, TOOL_IDS } from "./advisory.js";
import { getEffectiveSkipChecks, getSkipTools } from "./advisory-skips.js";

describe("getEffectiveSkipChecks", () => {
	it.each(["json_stringify_error", "catch_rewrap_loses_cause", "resource_handle_leak", "public_api_leaks_internal_type", "jsdoc_param_drift", "unvalidated_input_boundary", "numeric_zero_default"])("keeps %s advisory and preserves explicit exclusion", check => {
		expect(getEffectiveSkipChecks(undefined, false).has(check)).toBe(true);
		expect(getEffectiveSkipChecks(undefined, true).has(check)).toBe(false);
		expect(getEffectiveSkipChecks(check, true).has(check)).toBe(true);
	});

	it("includes every advisory default when --all-checks is off", () => {
		const skip = getEffectiveSkipChecks(undefined, false);
		for (const id of DEFAULT_ADVISORY_SKIPS) expect(skip.has(id)).toBe(true);
	});

	it("adds CLI exclusions to the all-checks selection", () => {
		const skip = getEffectiveSkipChecks("Knip, complexity ", true);
		expect(skip).toEqual(new Set(["knip", "complexity", "semgrep"]));
	});

	it("merges, trims, and lowercases the CLI --skip list", () => {
		const skip = getEffectiveSkipChecks(" TSC ,, biome ", false);
		expect(skip.has("tsc")).toBe(true);
		expect(skip.has("biome")).toBe(true);
		expect(skip.has("")).toBe(false);
	});

	it.each([false, true])("only selects Semgrep on explicit request (allChecks=%s)", allChecks => {
		expect(getSkipTools(getEffectiveSkipChecks(undefined, allChecks))).toContain("semgrep");
		expect(getEffectiveSkipChecks(undefined, allChecks, "semgrep")).toEqual(new Set());
		expect(getEffectiveSkipChecks("semgrep", allChecks, "semgrep")).toEqual(new Set(["semgrep"]));
		expect(getEffectiveSkipChecks(undefined, allChecks, "tsc")).toEqual(new Set(["semgrep"]));
	});
});

describe("getSkipTools", () => {
	it("keeps only known tool ids", () => {
		const tools = getSkipTools(new Set(["tsc", "complexity", "nonsense"]));
		expect(tools).toEqual(["tsc"]);
	});

	it("passes through every tool id and nothing else", () => {
		const all = getSkipTools(new Set([...TOOL_IDS, "cognitive_complexity"]));
		expect([...all].sort()).toEqual([...TOOL_IDS].sort());
	});

	it("returns empty for an empty skip set", () => {
		expect(getSkipTools(new Set())).toEqual([]);
	});

	it("resolves additional catalog tools and configuration aliases", () => {
		expect(getSkipTools(new Set(["rustfmt", "typescript", "cargo_clippy"]))).toEqual(["rustfmt", "tsc", "cargo-clippy"]);
	});
});
