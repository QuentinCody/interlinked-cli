import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hashBytes } from "../metrics/inventory.js";
import { collectStandardsInventory } from "./inventory.js";
import { collectStandardsDiscovery } from "./discovery.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = realpathSync(mkdtempSync(join(process.cwd(), "scratch", "standards-discovery-"))); roots.push(root);
	const content = "type Outcome = { ok: true; value: number } | { ok: false; error: string }; function attempt(): Outcome { return {ok: false, error: 'x'}; } attempt();";
	writeFileSync(join(root, "source.ts"), content);
	return { root, files: [{ path: "source.ts", role: "product" as const, language: "typescript", content, sha256: hashBytes(content) }] };
}

it("reuses local finding discovery and preserves complete review cases and unresolved call counts", () => {
	const { root, files } = fixture();
	const result = collectStandardsDiscovery(root, files);
	expect(result.cases.some(row => row.family === "error_handling")).toBe(true);
	expect(result.cases.every(row => row.sources[0]?.expectedHash === files[0]?.sha256)).toBe(true);
	expect(result.files).toBe(1);
	expect(result.unresolvedCalls).toBeGreaterThanOrEqual(0);
});

it("excludes changed primary evidence and records the measurement gap", () => {
	const { root, files } = fixture();
	writeFileSync(join(root, "source.ts"), "export const changed = 1;");
	const result = collectStandardsDiscovery(root, files);
	expect(result.cases).toEqual([]);
	expect(result.notMeasured).toContain("source.ts: source changed after inventory capture");
});

it("reports unavailable discovery without inventing zero semantic candidates", () => {
	const { root, files } = fixture();
	const result = collectStandardsDiscovery(root, files, () => { throw new Error("compiler unavailable"); });
	expect(result.notMeasured).toContain("Discovery unavailable: compiler unavailable");
	expect(result.files).toBe(0);
});

it("discovers a typed outcome in complete inventory text beyond 1 MB", () => {
	const root = realpathSync(mkdtempSync(join(process.cwd(), "scratch", "standards-discovery-full-"))); roots.push(root);
	writeFileSync(join(root, "source.ts"), `/* ${"padding".repeat(150_000)} */\nfunction attempt(): {ok:true}|{ok:false,error:string} { return {ok:false,error:"failure"}; }\nattempt();`);
	const inventory = collectStandardsInventory(root, "all", { resourcePolicy: "foreground-survey" });
	expect(inventory.files).toHaveLength(1);
	expect(inventory.gaps).toEqual([]);
	const result = collectStandardsDiscovery(root, inventory.files);
	expect(result.files).toBe(1);
	expect(result.notMeasured).toEqual([]);
	expect(result.cases.filter(row => row.id.includes("discarded-outcome"))).toHaveLength(1);
});

it("keeps a global declaration beyond the former 10000-file batch in the selected compiler population", () => {
	const root = realpathSync(mkdtempSync(join(process.cwd(), "scratch", "standards-discovery-population-"))); roots.push(root);
	const files = Array.from({ length: 10_001 }, (_, index) => {
		const path = `${String(index).padStart(5, "0")}.ts`;
		const content = index === 0 ? "attempt();" : index === 10_000
			? 'declare function attempt(): {ok:true}|{ok:false,error:string};'
			: `declare const filler${index}: number;`;
		writeFileSync(join(root, path), content);
		return { path, content, role: "product" as const, language: "typescript", sha256: hashBytes(content) };
	});
	const result = collectStandardsDiscovery(root, files);
	expect(result.files).toBe(10_001);
	expect(result.notMeasured).toEqual([]);
	expect(result.unresolvedCalls).toBe(0);
	expect(result.cases.filter(row => row.id.includes("discarded-outcome"))).toHaveLength(1);
	expect(result.cases[0]?.sources.map(source => source.file)).toEqual(["00000.ts", "10000.ts"]);
}, 30_000);

it("retains large discovery result and gap populations beyond the JavaScript call argument ceiling", () => {
	const { root, files } = fixture();
	const source = files[0]!;
	const cases = Array.from({ length: 200_000 }, (_, index) => ({ id: `case-${index}`, family: "error_handling", origin: "detector" as const,
		claim: "collection control", sources: [{ id: "implementation", file: source.path, expectedHash: source.sha256, purpose: "collection control" }], missing: [] }));
	const notMeasured = Array.from({ length: 200_000 }, (_, index) => `control-gap-${index}`);
	const result = collectStandardsDiscovery(root, files, () => ({ cases, notMeasured, files: 1, unresolvedCalls: 0 }));
	expect(result.notMeasured.find(reason => reason.startsWith("Discovery unavailable"))).toBeUndefined();
	expect(result.cases).toHaveLength(200_000);
	expect(result.notMeasured).toEqual(notMeasured);
	expect(result.files).toBe(1);
});
