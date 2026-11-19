import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentScanLedger, withVerifyTimings } from "./check-timing.js";
import { SWEEP_INLINE_IDS, sweepFileChecks } from "./registry-sweep.js";

function fixture(name: string, content: string): { root: string; file: string } {
	const root = mkdtempSync(join(tmpdir(), "sweep-"));
	const file = join(root, name);
	writeFileSync(file, content);
	return { root, file };
}

describe("sweepFileChecks — positive", () => {
	it("P1: with --all-checks a firing sweep check lands in the ledger under inline:<id>", async () => {
		const { root, file } = fixture("a.ts", "const a = [10, 9, 1].sort();\n");
		await withVerifyTimings(root, () => {
			sweepFileChecks({ file, relPath: "a.ts", content: "const a = [10, 9, 1].sort();\n" });
			const rows = currentScanLedger()?.sweep.get("inline:numeric_sort_without_comparator") ?? [];
			expect(rows).toHaveLength(1);
			expect(rows[0]?.file).toBe("a.ts");
			expect(rows[0]?.line).toBe(1);
		}, { allChecks: true });
	});
	it("P2: every ledger entry for a swept id exists even when nothing fires", async () => {
		const { root, file } = fixture("b.ts", "export const b = 1;\n");
		await withVerifyTimings(root, () => {
			sweepFileChecks({ file, relPath: "b.ts", content: "export const b = 1;\n" });
			expect(currentScanLedger()?.sweep.get("inline:numeric_sort_without_comparator") ?? []).toEqual([]);
		}, { allChecks: true });
	});
	it("P3: an inline-ignore comment on the finding line suppresses it", async () => {
		const text = "// interlinked-ignore: numeric_sort_without_comparator — test fixture\nconst a = [10, 9, 1].sort();\n";
		const { root, file } = fixture("c.ts", text);
		await withVerifyTimings(root, () => {
			sweepFileChecks({ file, relPath: "c.ts", content: text });
			expect(currentScanLedger()?.sweep.get("inline:numeric_sort_without_comparator") ?? []).toEqual([]);
		}, { allChecks: true });
	});
});

describe("sweepFileChecks — negative", () => {
	it("N1: without --all-checks nothing runs, so the default gate gains no check", async () => {
		const { root, file } = fixture("d.ts", "const a = [10, 9, 1].sort();\n");
		await withVerifyTimings(root, () => {
			sweepFileChecks({ file, relPath: "d.ts", content: "const a = [10, 9, 1].sort();\n" });
			expect(currentScanLedger()?.sweep.size).toBe(0);
		});
	});
	it("N2: an id named in --skip does not run", async () => {
		const { root, file } = fixture("e.ts", "const a = [10, 9, 1].sort();\n");
		await withVerifyTimings(root, () => {
			sweepFileChecks({ file, relPath: "e.ts", content: "const a = [10, 9, 1].sort();\n" });
			expect(currentScanLedger()?.sweep.get("inline:numeric_sort_without_comparator")).toBeUndefined();
		}, { allChecks: true, skipChecks: new Set(["numeric_sort_without_comparator"]) });
	});
});

describe("SWEEP_INLINE_IDS", () => {
	it("P4: lists each id once", () => {
		expect(new Set(SWEEP_INLINE_IDS).size).toBe(SWEEP_INLINE_IDS.length);
	});
});
