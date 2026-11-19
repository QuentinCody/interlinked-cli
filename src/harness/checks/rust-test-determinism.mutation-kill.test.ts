// Mutation-kill tests for rust-test-determinism.ts — kill-proof census row 20
// (docs/reviews/kill-proof-census-harness.md): the `#[cfg(test)]` attribute-to-brace window.
import { describe, expect, it } from "vitest";
import { checkRustTestDeterminism } from "./rust-test-determinism.js";

describe("checkRustTestDeterminism — stacked attributes before the test module", () => {
	// test-contract: boundary — a test module whose opening brace is three lines below #[cfg(test)] is still a test span
	it("flags thread_rng in a module whose brace sits three lines after the attribute", () => {
		const code = ["#[cfg(test)]", "#[allow(dead_code)]", "#[allow(unused)]", "mod tests {", "    fn t() { let r = rand::thread_rng(); }", "}"].join("\n");
		expect(checkRustTestDeterminism(code, "src/lib.rs").map((m) => m.line)).toEqual([5]);
	});
	// test-contract: boundary — a brace two lines below the attribute is also found
	it("flags thread_rng in a module whose brace sits two lines after the attribute", () => {
		const code = ["#[cfg(test)]", "#[allow(dead_code)]", "mod tests {", "    fn t() { let r = rand::thread_rng(); }", "}"].join("\n");
		expect(checkRustTestDeterminism(code, "src/lib.rs").map((m) => m.line)).toEqual([4]);
	});
});
