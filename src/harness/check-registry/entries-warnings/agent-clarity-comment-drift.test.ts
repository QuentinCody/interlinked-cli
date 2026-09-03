import { describe, expect, it } from "vitest";
import { COMMENT_DRIFT_ENTRIES } from "./agent-clarity-comment-drift.js";

describe("COMMENT_DRIFT_ENTRIES", () => {
	it("registers exactly the five comment-vs-behavior detectors, in order", () => {
		expect(COMMENT_DRIFT_ENTRIES.map((c) => c.id)).toEqual([
			"comment_claims_limit_no_guard",
			"comment_claims_null_throws_instead",
			"comment_claims_validation_missing",
			"comment_claims_idempotent_mutates",
			"comment_claims_throws_doesnt",
		]);
	});

	it("every entry runs at the post phase in the agent_safety pipeline", () => {
		for (const c of COMMENT_DRIFT_ENTRIES) {
			expect(c.phase, `${c.id} phase`).toBe("post");
			expect(c.pipeline, `${c.id} pipeline`).toBe("agent_safety");
		}
	});

	it("every entry stays advisory — a warning that never blocks", () => {
		for (const c of COMMENT_DRIFT_ENTRIES) {
			expect(c.severity, `${c.id} severity`).toBe("warning");
			expect(c.determinism, `${c.id} determinism`).toBe("partially_deterministic");
			expect(c.phase, `${c.id} phase`).not.toBe("pre_block");
		}
	});

	it("every entry carries an id, a callable fn, and reader-facing prose", () => {
		for (const c of COMMENT_DRIFT_ENTRIES) {
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
			expect(c.id).toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.description.length, `${c.id} description`).toBeGreaterThan(20);
			expect(c.fix_instruction.length, `${c.id} fix_instruction`).toBeGreaterThan(20);
			expect(c.resultsPropName.length, `${c.id} resultsPropName`).toBeGreaterThan(0);
		}
	});

	it("uses a unique resultsPropName per entry", () => {
		const props = COMMENT_DRIFT_ENTRIES.map((c) => c.resultsPropName);
		expect(new Set(props).size).toBe(props.length);
	});

	it("every detector runs on clean code and reports nothing", () => {
		for (const c of COMMENT_DRIFT_ENTRIES) {
			const out = c.fn("export const answer = 42;\n", "/tmp/clean.ts");
			expect(Array.isArray(out), `${c.id} returns an array`).toBe(true);
			expect(out, `${c.id} on clean code`).toEqual([]);
		}
	});

	it("the comment_claims_throws_doesnt entry fires on an undelivered @throws", () => {
		const entry = COMMENT_DRIFT_ENTRIES.find((c) => c.id === "comment_claims_throws_doesnt");
		expect(entry).toBeDefined();
		const src = [
			"/**",
			" * Loads a row.",
			" * @throws {RangeError} when the index is out of range",
			" */",
			"export function load(index: number): number {",
			"\treturn index + 1;",
			"}",
			"",
		].join("\n");
		const out = entry?.fn(src, "/tmp/load.ts") ?? [];
		expect(out.length).toBeGreaterThan(0);
	});
});
