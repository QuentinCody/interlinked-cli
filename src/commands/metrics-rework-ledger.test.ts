import { describe, expect, it } from "vitest";
import { createReworkLedger } from "./metrics-rework-ledger.js";

describe("rework ledger", () => {
	it("separates code, data and set-aside lines and keeps the unfiltered total", () => {
		const ledger = createReworkLedger();
		ledger.add("src/a.ts", { kind: "code" }, { rework: 3, total: 10 });
		ledger.add("src/a.ts", { kind: "code" }, { rework: 1, total: 2 });
		ledger.add("translations/de.json", { kind: "data" }, { rework: 4, total: 5 });
		ledger.add("pnpm-lock.yaml", { kind: "set-aside", reason: "lockfile" }, { rework: 50, total: 60 });
		ledger.add("dist/x.js", { kind: "set-aside", reason: "generated (path)" }, { rework: 6, total: 6 });
		const summary = ledger.summary();
		expect(summary.kept).toEqual({ rework: 8, total: 17 });
		expect(summary.byKind.code).toEqual({ rework: 4, total: 12 });
		expect(summary.byKind.data).toEqual({ rework: 4, total: 5 });
		expect(summary.setAside).toMatchObject({ files: 2, rework: 56, total: 66 });
		expect(summary.setAside.byReason).toEqual([
			{ reason: "generated (path)", files: 1, rework: 6, total: 6 },
			{ reason: "lockfile", files: 1, rework: 50, total: 60 },
		]);
		expect(summary.setAside.top.map(entry => entry.file)).toEqual(["pnpm-lock.yaml", "dist/x.js"]);
		expect(summary.withSetAside).toEqual({ rework: 64, total: 83 });
	});
	it("counts a file once in the set-aside file total however many commits touch it", () => {
		const ledger = createReworkLedger();
		for (let i = 0; i < 3; i++) ledger.add("pnpm-lock.yaml", { kind: "set-aside", reason: "lockfile" }, { rework: 1, total: 2 });
		expect(ledger.summary().setAside).toMatchObject({ files: 1, rework: 3, total: 6 });
	});
	it("reports an empty ledger as zero", () => {
		const summary = createReworkLedger().summary();
		expect(summary.kept).toEqual({ rework: 0, total: 0 });
		expect(summary.setAside).toMatchObject({ files: 0, byReason: [], top: [] });
	});
});
