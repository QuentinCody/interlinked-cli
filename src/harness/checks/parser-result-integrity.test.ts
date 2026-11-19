import { describe, expect, it } from "vitest";
import { checkUnvalidatedJsonBoundary } from "./agent-safety-advanced-style.js";

describe("unvalidated_json_boundary parser-result integrity", () => {
	it("P1: a discarded nonthrowing parse does not validate later raw access", () => {
		expect(checkUnvalidatedJsonBoundary("const raw = JSON.parse(input);\nSchema.safeParse(raw);\nsend(raw.name);", "src/input.ts")).toHaveLength(1);
	});
	it("P2: assigning a failure-bearing result does not establish success for raw data", () => {
		expect(checkUnvalidatedJsonBoundary("const raw = JSON.parse(input);\nconst result = Schema.safeParse(raw);\nsend(raw.name);", "src/input.ts")).toHaveLength(1);
	});
	it("N1: using guarded parsed data does not report raw consumption", () => {
		expect(checkUnvalidatedJsonBoundary("const raw = JSON.parse(input);\nconst result = Schema.safeParse(raw);\nif (!result.success) return;\nsend(result.data.name);", "src/input.ts")).toEqual([]);
	});
	it("N2: a recognized throwing parser can validate without retaining its return", () => {
		expect(checkUnvalidatedJsonBoundary("const raw = JSON.parse(input);\nSchema.parse(raw);\nsend(raw.name);", "src/input.ts")).toEqual([]);
	});
});
