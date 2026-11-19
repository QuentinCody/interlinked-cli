import { describe, expect, it } from "vitest";
import { maskDiscardedValidators } from "./discarded-validation.js";
import { checkUnvalidatedJsonBoundary } from "./agent-safety-advanced-style.js";
import { detectUnvalidatedInputBoundary } from "./unvalidated-input-boundary.js";

describe("discarded nonthrowing validation", () => {
	it("P1: an ignored predicate does not validate subsequent raw property access", () => {
		expect(checkUnvalidatedJsonBoundary("const raw = JSON.parse(text);\nisPayload(raw);\nuse(raw.name);", "src/example.ts")).toHaveLength(1);
	});
	it("P2: a discarded safeParse does not satisfy the inline boundary check", () => {
		expect(detectUnvalidatedInputBoundary("const raw = await response.json();\nSchema.safeParse(raw);\nuse(raw.name);", "src/example.ts")).toHaveLength(1);
	});
	it("N1: keeps an actual predicate branch and throwing parse intact", () => {
		const source = "if (!isPayload(raw)) return;\nSchema.parse(raw);";
		expect(maskDiscardedValidators(source, "src/example.ts")).toBe(source);
	});
	it("N2: argv executable and entrypoint positions are runtime metadata", () => {
		expect(detectUnvalidatedInputBoundary("const exe = process.argv[0];\nconst entry = process.argv[1];", "src/runtime.ts")).toEqual([]);
		expect(detectUnvalidatedInputBoundary("const argument = process.argv[10];", "src/runtime.ts")).toHaveLength(1);
	});
});
