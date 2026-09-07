import { describe, expect, it } from "vitest";
import { TEST_DISCRIMINATION_ENTRIES } from "./test-discrimination.js";

const EXPECTED_IDS = [
	"duplicate_throw_message_assertion",
	"fallback_only_assertion",
	"spy_call_unpinned_args",
	"wildcard_in_observable",
	"fixed_port_in_test",
	"in_tree_temp_fixture",
	"catch_without_assertion_guard",
	"duplicate_expected_literal_pos_neg",
	// round 2 (2026-09-07)
	"vacuous_loop_assertion",
	"mock_return_echo",
	"duplicate_test_body",
	"spy_without_restore",
	"export_existence_smoke_test",
	"commented_out_assertion",
];

describe("TEST_DISCRIMINATION_ENTRIES — positive (must hold)", () => {
	it("P1: registers the eight original and six round-2 checks; title mismatch remains unregistered", () => {
		expect(TEST_DISCRIMINATION_ENTRIES.map((c) => c.id)).toEqual(EXPECTED_IDS);
	});

	it("P2: every entry is a post-phase warning in the agent_safety pipeline with a callable fn", () => {
		for (const c of TEST_DISCRIMINATION_ENTRIES) {
			expect(c.phase, `${c.id} phase`).toBe("post");
			expect(c.severity, `${c.id} severity`).toBe("warning");
			expect(c.pipeline, `${c.id} pipeline`).toBe("agent_safety");
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
		}
	});

	it("P3: resultsPropName is the camelCase of the id and content_keywords gate every entry", () => {
		for (const c of TEST_DISCRIMINATION_ENTRIES) {
			const camel = c.id.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());
			expect(c.resultsPropName, `${c.id} resultsPropName`).toBe(camel);
			expect(c.content_keywords?.length ?? 0, `${c.id} content_keywords`).toBeGreaterThan(0);
			expect(c.fix_instruction.length, `${c.id} fix_instruction`).toBeGreaterThan(40);
		}
	});

	it("P4: every detector returns no findings for a non-test file path", () => {
		for (const c of TEST_DISCRIMINATION_ENTRIES) {
			expect(c.fn('it("x", () => { expect(a).toBeNull(); });', "src/lib/thing.ts"), c.id).toEqual([]);
		}
	});
});

describe("TEST_DISCRIMINATION_ENTRIES — negative (must not hold)", () => {
	it("N1: no entry is fully deterministic — these are heuristics and must carry the [heuristic] tag", () => {
		for (const c of TEST_DISCRIMINATION_ENTRIES) {
			expect(c.determinism, c.id).not.toBe("fully_deterministic");
		}
	});

	it("N2: no entry blocks — pre_block is reserved for zero-FP checks", () => {
		for (const c of TEST_DISCRIMINATION_ENTRIES) {
			expect(c.phase, c.id).not.toBe("pre_block");
		}
	});
});
