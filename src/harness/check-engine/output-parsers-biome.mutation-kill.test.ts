import { describe, expect, it } from "vitest";
import { parseBiomeOutput } from "./output-parsers-biome.js";

// Census fault: `rule === "parse" || rule === "syntax"` → `rule === "parse"`
// survived the companion test (docs/reviews/kill-proof-census-harness.md).
describe("parseBiomeOutput — syntax diagnostics", () => {
	// test-contract: bug — a `syntax` header means the file does not parse; it must be an error, never a warning
	it("reports a syntax header as an error that says the file does not parse", () => {
		const [result] = parseBiomeOutput("src/broken.ts:4:1 syntax ━━━━━━━━━━\n  × Expected a semicolon.\n");
		expect(result).toMatchObject({ severity: "error", message: "syntax: file does not parse", line: 4, column: 1 });
	});
});
