import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentScanLedger, withVerifyTimings } from "./check-timing.js";
import { sweepProjectChecks } from "./project-sweep.js";

function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "psweep-"));
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), content);
	}
	return root;
}

describe("sweepProjectChecks — positive", () => {
	it("P1: a bare import missing from package.json is hallucinated_imports", async () => {
		const root = project({
			"package.json": JSON.stringify({ name: "x", dependencies: {} }),
			"src/a.ts": 'import { thing } from "left-padder";\nexport const a = thing;\n',
		});
		await withVerifyTimings(root, () => {
			sweepProjectChecks(root, () => false);
			const rows = currentScanLedger()?.sweep.get("structural:hallucinated_imports") ?? [];
			expect(rows.map((row) => row.file)).toEqual(["src/a.ts"]);
		}, { allChecks: true });
	});
	it("P2: process.env keys absent from .env.example are undefined_env_vars", async () => {
		const root = project({
			".env.example": "KNOWN=1\n",
			"package.json": JSON.stringify({ name: "x" }),
			"src/a.ts": "export const a = process.env.MYSTERY_KEY;\nexport const b = process.env.KNOWN;\n",
		});
		await withVerifyTimings(root, () => {
			sweepProjectChecks(root, () => false);
			const rows = currentScanLedger()?.sweep.get("structural:undefined_env_vars") ?? [];
			expect(rows).toHaveLength(1);
			expect(rows[0]?.message).toContain("MYSTERY_KEY");
		}, { allChecks: true });
	});
	it("P3: a relative import that crosses a package.json boundary is cross_package_imports", async () => {
		const root = project({
			"package.json": JSON.stringify({ name: "root" }),
			"packages/lib/package.json": JSON.stringify({ name: "lib" }),
			"packages/lib/src/x.ts": "export const x = 1;\n",
			"src/a.ts": 'import { x } from "../packages/lib/src/x";\nexport const a = x;\n',
		});
		await withVerifyTimings(root, () => {
			sweepProjectChecks(root, () => false);
			const rows = currentScanLedger()?.sweep.get("structural:cross_package_imports") ?? [];
			expect(rows.map((row) => row.file)).toEqual(["src/a.ts"]);
		}, { allChecks: true });
	});
});

describe("sweepProjectChecks — negative", () => {
	it("N1: without --all-checks nothing runs", async () => {
		const root = project({ "package.json": "{}", "src/a.ts": 'import x from "left-padder";\nexport default x;\n' });
		await withVerifyTimings(root, () => {
			sweepProjectChecks(root, () => false);
			expect(currentScanLedger()?.sweep.size).toBe(0);
		});
	});
	it("N2: a declared dependency is not hallucinated", async () => {
		const root = project({
			"package.json": JSON.stringify({ name: "x", dependencies: { "left-padder": "1.0.0" } }),
			"src/a.ts": 'import { thing } from "left-padder";\nexport const a = thing;\n',
		});
		await withVerifyTimings(root, () => {
			sweepProjectChecks(root, () => false);
			expect(currentScanLedger()?.sweep.get("structural:hallucinated_imports") ?? []).toEqual([]);
		}, { allChecks: true });
	});
	it("N3: a file the caller marks set aside is not read", async () => {
		const root = project({ "package.json": "{}", "src/a.ts": 'import x from "left-padder";\nexport default x;\n' });
		await withVerifyTimings(root, () => {
			sweepProjectChecks(root, () => true);
			expect(currentScanLedger()?.sweep.get("structural:hallucinated_imports") ?? []).toEqual([]);
		}, { allChecks: true });
	});
});

describe("sweepProjectChecks — spec ledger", () => {
	it("P4: a missing xref anchor in markdown is xref_missing_anchor", async () => {
		const root = project({
			"package.json": "{}",
			"docs/a.md": "# A\n\nSee [the other](./b.md#nope).\n",
			"docs/b.md": "# B\n\n## Real heading\n",
		});
		await withVerifyTimings(root, () => {
			sweepProjectChecks(root, () => false);
			const rows = currentScanLedger()?.sweep.get("spec_ledger:xref_missing_anchor") ?? [];
			expect(rows.length).toBeGreaterThanOrEqual(1);
		}, { allChecks: true });
	});
});
