// Labeled P/N cases for the plan-and-render helper that fills the cognitive
// gate's `planFor` slot (cognitive-plan-message.ts).
import { describe, expect, it } from "vitest";
import { cognitiveFlatteningMessage } from "./cognitive-plan-message.js";

// depth-N nested ifs → cognitive 1+2+…+N.
function nested(name: string, depth: number): string {
	let body = "return 1;";
	for (let i = depth; i >= 1; i--) body = `if (a${i}) { ${body} }`;
	const params = Array.from({ length: depth }, (_, i) => `a${i + 1}: boolean`).join(", ");
	return `export function ${name}(${params}): number { ${body} return 0; }\n`;
}

describe("cognitiveFlatteningMessage — positive (must fire)", () => {
	it("renders the flattening plan for a named over-cap function as one `flatten:` sentence", () => {
		const message = cognitiveFlatteningMessage(nested("deep", 8), "/repo/deep.ts", "deep", 20);
		expect(message).not.toBeNull();
		expect(message).toContain("flatten:");
		expect(message).not.toContain("\n");
	});
});

describe("cognitiveFlatteningMessage — negative (must not fire)", () => {
	it("returns null when the planner cannot locate the named function in the content", () => {
		expect(cognitiveFlatteningMessage(nested("deep", 8), "/repo/deep.ts", "missing", 20)).toBeNull();
	});

	it("returns null for a non-JS/TS path the planner refuses to parse", () => {
		expect(cognitiveFlatteningMessage(nested("deep", 8), "/repo/deep.py", "deep", 20)).toBeNull();
	});
});
