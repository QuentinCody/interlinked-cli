import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCodeQualityChecks } from "./tool-results.js";
import { verifyActions } from "./action-projection.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("binds per-file action evidence to analyzed text even if disk changes before projection", () => {
	const root = mkdtempSync(join(process.cwd(), "scratch", "verify-action-source-"));
	roots.push(root);
	const file = join(root, "index.ts");
	const captured = "console.log(\"observed\");\n";
	writeFileSync(file, captured);
	const cq = runCodeQualityChecks([file], root);
	expect(cq.consoleStatements).toHaveLength(1);
	writeFileSync(file, "export const nowDifferent = true;\n");
	const report = verifyActions({ cq, tscResults: [], linterResults: [], linterName: "biome", semgrepResults: [],
		gitleaksResults: [], auditResult: null, suggestions: null, totalFiles: 1 });
	const action = report.actions.find(row => row.evidence.some(item => item.check === "console_statements"));
	expect(action).toMatchObject({ freshness: "snapshot_bound" });
	expect(action?.evidence[0]?.sourceHash).toBe(createHash("sha256").update(captured).digest("hex"));
});
