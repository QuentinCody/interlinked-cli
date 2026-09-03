import { describe, expect, it } from "vitest";
import { pushResult } from "./change-set-result-map.js";
import type { QualityCheckResult } from "./result-types.js";

function makeResult(name: string): QualityCheckResult {
	return { name, severity: "warning", message: `${name} message` };
}

describe("pushResult", () => {
	it("creates the row list for a path the map does not know yet", () => {
		const map = new Map<string, QualityCheckResult[]>();
		const result = makeResult("typescript");
		pushResult(map, "src/a.ts", result);
		expect(map.get("src/a.ts")).toEqual([result]);
	});

	it("appends to an existing row list, preserving order", () => {
		const map = new Map<string, QualityCheckResult[]>([["src/a.ts", [makeResult("first")]]]);
		pushResult(map, "src/a.ts", makeResult("second"));
		expect(map.get("src/a.ts")?.map((row) => row.name)).toEqual(["first", "second"]);
	});

	it("mutates the existing array in place so prior holders observe the push", () => {
		const rows: QualityCheckResult[] = [];
		const map = new Map<string, QualityCheckResult[]>([["src/a.ts", rows]]);
		pushResult(map, "src/a.ts", makeResult("only"));
		expect(rows).toHaveLength(1);
		expect(map.get("src/a.ts")).toBe(rows);
	});

	it("keeps paths independent", () => {
		const map = new Map<string, QualityCheckResult[]>();
		pushResult(map, "src/a.ts", makeResult("a"));
		pushResult(map, "src/b.ts", makeResult("b"));
		expect(map.get("src/a.ts")?.map((row) => row.name)).toEqual(["a"]);
		expect(map.get("src/b.ts")?.map((row) => row.name)).toEqual(["b"]);
	});
});
