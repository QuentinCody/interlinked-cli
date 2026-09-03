import { describe, expect, it } from "vitest";
import { runOverExtractionChecks } from "./file-checks-over-extraction.js";
import { emptyResults } from "./tool-results-types-keys.js";

function ctxFor(content: string, file: string): Parameters<typeof runOverExtractionChecks>[0] {
	return {
		content,
		file,
		relPath: file,
		cwd: "/tmp/wiring-probe",
		r: emptyResults(),
		// SAFETY: `piiOpts` is the only omitted field and this helper never
		// reads it — it passes content / file / relPath / r straight through.
	} as Parameters<typeof runOverExtractionChecks>[0];
}

const OVER_EXTRACTED = `function processItems(items: number[]): number[] {
	const doubled = items.map((n) => n * 2);
	return doubled;
}
export function report(i: number[]): number[] { return processItems(i); }
`;

describe("runOverExtractionChecks — positive (must fire)", () => {
	it("P1: files the finding under singleUseTrivialHelper with its check id", () => {
		const ctx = ctxFor(OVER_EXTRACTED, "orders.ts");
		runOverExtractionChecks(ctx);
		expect(ctx.r.singleUseTrivialHelper).toHaveLength(1);
		expect(ctx.r.singleUseTrivialHelper[0]?.check).toBe("single_use_trivial_helper");
		expect(ctx.r.singleUseTrivialHelper[0]?.file).toBe("orders.ts");
	});
});

describe("runOverExtractionChecks — negative (must not fire)", () => {
	it("N1: leaves the key empty for a file with no trivial single-use helper", () => {
		const ctx = ctxFor("export function report(n: number): number { return n * 2; }\n", "a.ts");
		runOverExtractionChecks(ctx);
		expect(ctx.r.singleUseTrivialHelper).toEqual([]);
	});
});
