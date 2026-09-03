import { describe, expect, it } from "vitest";
import { UBS_ENTRIES_LANG } from "./ubs-checks-lang.js";

describe("UBS_ENTRIES_LANG", () => {
	it("is non-empty and every entry is in the agent_safety pipeline", () => {
		expect(UBS_ENTRIES_LANG.length).toBeGreaterThan(0);
		for (const c of UBS_ENTRIES_LANG) {
			expect(c.pipeline, c.id).toBe("agent_safety");
		}
	});

	it("every entry has a callable fn + valid phase + required metadata", () => {
		for (const c of UBS_ENTRIES_LANG) {
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
			expect(["pre_warn", "post", "pre_block"], `${c.id} phase`).toContain(c.phase);
			expect(c.id, "id").toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.fix_instruction.length, `fix_instruction for ${c.id}`).toBeGreaterThan(20);
			expect(c.resultsPropName.length, `resultsPropName for ${c.id}`).toBeGreaterThan(0);
			expect(["error", "warning"], `${c.id} severity`).toContain(c.severity);
		}
	});

	it("includes the expected language-specific detector ids", () => {
		const ids = UBS_ENTRIES_LANG.map((c) => c.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				"ubs_js_loose_equality",
				"ubs_float_equality",
				"ubs_java_optional_get",
				"ubs_rust_debug_assert_side_effect",
				"ubs_division_by_variable",
				"ubs_eval_input_tainted",
				"ubs_sql_string_concat",
				"sql_escape_hatch_non_literal",
				"ubs_python_mutable_default_arg",
				"ubs_tempfile_mktemp_race",
				"ubs_pickle_untrusted_load",
				"ubs_xml_external_entity",
				"ubs_os_system_tainted",
				"ubs_unsafe_format_string",
				"ubs_unchecked_redirect",
				"ubs_goroutine_no_waitgroup",
				"ubs_defer_in_loop",
				"ubs_string_concat_in_loop",
				"ubs_numeric_comparison_chain",
				"ubs_print_debug_leak",
				"ubs_magic_number_no_const",
				"ubs_large_function",
				"ubs_deeply_nested_callback",
				"ubs_time_format_locale_dep",
				"ubs_regex_in_loop_no_compile",
			]),
		);
	});

	it("running each detector's fn on empty content does not throw", () => {
		for (const c of UBS_ENTRIES_LANG) {
			expect(() => c.fn("", "test.ts"), c.id).not.toThrow();
		}
	});
});
