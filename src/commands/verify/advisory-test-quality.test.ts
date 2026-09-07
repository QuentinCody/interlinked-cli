import { describe, expect, it } from "vitest";
import { TEST_QUALITY_ADVISORY_IDS } from "./advisory-test-quality.js";

describe("TEST_QUALITY_ADVISORY_IDS — positive (must hold)", () => {
	it("P1: carries the five pre-existing ids and all fourteen test-discrimination ids", () => {
		expect([...TEST_QUALITY_ADVISORY_IDS]).toEqual([
			"mock_only_test",
			"happy_path_only_test",
			"introverted_test",
			"test_legitimacy",
			"procfs_probe_in_test",
			"duplicate_throw_message_assertion",
			"fallback_only_assertion",
			"spy_call_unpinned_args",
			"wildcard_in_observable",
			"fixed_port_in_test",
			"in_tree_temp_fixture",
			"catch_without_assertion_guard",
			"duplicate_expected_literal_pos_neg",
			"vacuous_loop_assertion",
			"mock_return_echo",
			"duplicate_test_body",
			"spy_without_restore",
			"export_existence_smoke_test",
			"commented_out_assertion",
		]);
	});
});

describe("TEST_QUALITY_ADVISORY_IDS — negative (must not hold)", () => {
	it("N1: holds no duplicates and no id outside the snake_case grammar", () => {
		expect(new Set(TEST_QUALITY_ADVISORY_IDS).size).toBe(TEST_QUALITY_ADVISORY_IDS.length);
		for (const id of TEST_QUALITY_ADVISORY_IDS) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
	});
});
