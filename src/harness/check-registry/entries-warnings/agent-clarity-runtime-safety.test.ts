import { describe, expect, it } from "vitest";
import { RUNTIME_SAFETY_ENTRIES } from "./agent-clarity-runtime-safety.js";

describe("RUNTIME_SAFETY_ENTRIES", () => {
	it("registers exactly the nine runtime-safety detectors, in order", () => {
		expect(RUNTIME_SAFETY_ENTRIES.map((c) => c.id)).toEqual([
			"iterator_invalidation",
			"fresh_collection_key_lookup",
			"discriminated_union_exhaustiveness",
			"await_state_toctou",
			"cleanup_reentrancy",
			"boundary_copy_no_revalidation",
			"tainted_to_privileged_sink",
			"cleanup_skipped_on_early_exit",
			"index_bounds_unchecked",
		]);
	});

	it("every entry runs at the post phase in the agent_safety pipeline", () => {
		for (const c of RUNTIME_SAFETY_ENTRIES) {
			expect(c.phase, `${c.id} phase`).toBe("post");
			expect(c.pipeline, `${c.id} pipeline`).toBe("agent_safety");
		}
	});

	it("every entry warns rather than errors, and never blocks", () => {
		for (const c of RUNTIME_SAFETY_ENTRIES) {
			expect(c.severity, `${c.id} severity`).toBe("warning");
			expect(c.phase, `${c.id} phase`).not.toBe("pre_block");
		}
	});

	it("every entry carries an id, a callable fn, and reader-facing prose", () => {
		for (const c of RUNTIME_SAFETY_ENTRIES) {
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
			expect(c.id).toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.description.length, `${c.id} description`).toBeGreaterThan(20);
			expect(c.fix_instruction.length, `${c.id} fix_instruction`).toBeGreaterThan(20);
			expect(c.resultsPropName.length, `${c.id} resultsPropName`).toBeGreaterThan(0);
		}
	});

	it("uses a unique resultsPropName per entry", () => {
		const props = RUNTIME_SAFETY_ENTRIES.map((c) => c.resultsPropName);
		expect(new Set(props).size).toBe(props.length);
	});

	it("every detector runs on clean code and reports nothing", () => {
		for (const c of RUNTIME_SAFETY_ENTRIES) {
			const out = c.fn("export const answer = 42;\n", "/tmp/clean.ts");
			expect(Array.isArray(out), `${c.id} returns an array`).toBe(true);
			expect(out, `${c.id} on clean code`).toEqual([]);
		}
	});

	it("the iterator_invalidation entry fires on mutation during iteration", () => {
		const entry = RUNTIME_SAFETY_ENTRIES.find((c) => c.id === "iterator_invalidation");
		expect(entry).toBeDefined();
		const src = [
			"function drop(items: string[]): void {",
			"\tfor (const item of items) {",
			"\t\titems.splice(0, 1);",
			"\t\tconsole.log(item);",
			"\t}",
			"}",
			"",
		].join("\n");
		const out = entry?.fn(src, "/tmp/iterate.ts") ?? [];
		expect(out.length).toBeGreaterThan(0);
	});
});
