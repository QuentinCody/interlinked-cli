import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FUNCTION_COMPLEXITY_BASELINE_REL,
	FUNCTION_COMPLEXITY_PREVIOUS_REL,
	resetFunctionComplexityBaselineCache,
	saveFunctionComplexityBaseline,
} from "../harness/function-complexity-baseline.js";
import { resetMetricCapsCache } from "../harness/metric-caps.js";
import { capsSetAction } from "./caps.js";
import { capsRatchetAction, capsStatusAction } from "./caps-ratchet.js";

/** `branches` if-statements → cyclomatic = branches + 1. */
function fnWith(name: string, branches: number): string {
	let s = `export function ${name}(a: number): number {\n\tlet r = 0;\n`;
	for (let i = 0; i < branches; i++) s += `\tif (a === ${i}) r += ${i};\n`;
	return `${s}\treturn r;\n}\n`;
}

let cwd: string;
let logs: string[];
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "caps-ratchet-"));
	execFileSync("git", ["init", "-q"], { cwd });
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), JSON.stringify({ version: 1, max_cyclomatic: 25 }));
	writeFileSync(join(cwd, "src", "a.ts"), `${fnWith("big", 20)}\n${fnWith("mid", 12)}\n${fnWith("tiny", 1)}`);
	writeFileSync(join(cwd, "src", "b.ts"), fnWith("other", 30));
	resetMetricCapsCache();
	resetFunctionComplexityBaselineCache();
	logs = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	});
});
afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const out = (): string => logs.join("\n");
function capsFile(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(cwd, ".interlinked", "metric-caps.json"), "utf8"));
}
function ledgerFile(): { metrics: Record<string, { cap: number; entries: Array<{ name: string; value: number }> }> } {
	return JSON.parse(readFileSync(join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL), "utf8"));
}

describe("capsRatchetAction — refusals", () => {
	it("rejects an unknown metric", async () => {
		expect(await capsRatchetAction("crap", { to: "10" }, { cwd })).toBe(1);
		expect(out()).toContain("cyclomatic, cognitive");
	});

	it("rejects a missing or non-positive-integer --to", async () => {
		expect(await capsRatchetAction("cyclomatic", {}, { cwd })).toBe(1);
		expect(await capsRatchetAction("cyclomatic", { to: "0" }, { cwd })).toBe(1);
		expect(await capsRatchetAction("cyclomatic", { to: "1.5" }, { cwd })).toBe(1);
		expect(await capsRatchetAction("cyclomatic", { to: "abc" }, { cwd })).toBe(1);
	});

	it("refuses to loosen the cap and writes nothing", async () => {
		expect(await capsRatchetAction("cyclomatic", { to: "30" }, { cwd })).toBe(1);
		expect(out()).toContain("loosen");
		expect(capsFile().max_cyclomatic).toBe(25);
		expect(existsSync(join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL))).toBe(false);
	});
});

describe("capsRatchetAction — dry run", () => {
	it("reports the plan and writes neither the cap nor the ledger", async () => {
		expect(await capsRatchetAction("cyclomatic", { to: "16", dryRun: true }, { cwd })).toBe(0);
		expect(out()).toContain("dry run");
		expect(out()).toContain("25 → 16");
		expect(out()).toContain("2 function(s)");
		expect(capsFile().max_cyclomatic).toBe(25);
		expect(existsSync(join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL))).toBe(false);
	});

	it("--json dry run carries the entries it would write", async () => {
		expect(await capsRatchetAction("cyclomatic", { to: "16", dryRun: true, json: true }, { cwd })).toBe(0);
		const parsed = JSON.parse(out()) as { dry_run: boolean; entries: Array<{ name: string }>; cap: number };
		expect(parsed.dry_run).toBe(true);
		expect(parsed.cap).toBe(16);
		expect(parsed.entries.map((e) => e.name)).toEqual(["big", "other"]);
	});
});

describe("capsRatchetAction — real ratchet", () => {
	it("writes the tightened cap and the ledger entries over the new cap", async () => {
		expect(await capsRatchetAction("cyclomatic", { to: "16" }, { cwd })).toBe(0);
		expect(capsFile().max_cyclomatic).toBe(16);
		const ledger = ledgerFile();
		expect(ledger.metrics.cyclomatic?.cap).toBe(16);
		expect(ledger.metrics.cyclomatic?.entries.map((e) => [e.name, e.value])).toEqual([
			["big", 21],
			["other", 31],
		]);
		expect(out()).toContain("Ratcheted cyclomatic cap 25 → 16");
	});

	it("a further ratchet snapshots the previous ledger, keeps other metric sections, admits only the newly-over, and never launders growth", async () => {
		saveFunctionComplexityBaseline(cwd, {
			version: 1,
			metrics: {
				cyclomatic: { cap: 16, entries: [{ file: "src/a.ts", name: "big", line: 1, value: 18 }] },
				cognitive: { cap: 30, entries: [] },
			},
		});
		writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), JSON.stringify({ version: 1, max_cyclomatic: 16 }));
		resetMetricCapsCache();
		expect(await capsRatchetAction("cyclomatic", { to: "12" }, { cwd })).toBe(0);
		const ledger = ledgerFile();
		// `mid` (13) is in (12, 16] → newly over the cap → admitted. `other` (31) was
		// over the OLD cap and never listed → stays unlisted (reported, not laundered).
		expect(ledger.metrics.cyclomatic?.entries.map((e) => [e.name, e.value])).toEqual([
			["big", 18],
			["mid", 13],
		]);
		expect(ledger.metrics.cognitive).toEqual({ cap: 30, entries: [] });
		expect(existsSync(join(cwd, FUNCTION_COMPLEXITY_PREVIOUS_REL))).toBe(true);
		expect(out()).toContain("regressed");
		expect(out()).toContain("big");
		expect(out()).toContain("NOT listed");
		expect(out()).toContain("other");
	});

	it("P: re-ratcheting at the SAME cap drops resolved functions but ADDS nothing (reports the unlisted instead)", async () => {
		saveFunctionComplexityBaseline(cwd, {
			version: 1,
			metrics: {
				cyclomatic: {
					cap: 16,
					entries: [
						{ file: "src/a.ts", name: "big", line: 1, value: 21 },
						{ file: "src/a.ts", name: "gone", line: 40, value: 19 },
					],
				},
			},
		});
		writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), JSON.stringify({ version: 1, max_cyclomatic: 16 }));
		resetMetricCapsCache();
		expect(await capsRatchetAction("cyclomatic", { to: "16", json: true }, { cwd })).toBe(0);
		expect(ledgerFile().metrics.cyclomatic?.entries.map((e) => e.name)).toEqual(["big"]);
		const parsed = JSON.parse(out()) as { added: number; unlisted: Array<{ name: string }> };
		expect(parsed.added).toBe(0);
		expect(parsed.unlisted.map((e) => e.name)).toEqual(["other"]);
	});

	it("N: the FIRST section for a metric seeds every over-cap function (no old regime to admit against)", async () => {
		expect(await capsRatchetAction("cyclomatic", { to: "25", json: true }, { cwd })).toBe(0);
		const parsed = JSON.parse(out()) as { added: number; unlisted: unknown[]; entries: Array<{ name: string }> };
		expect(parsed.entries.map((e) => e.name)).toEqual(["other"]);
		expect(parsed.added).toBe(1);
		expect(parsed.unlisted).toEqual([]);
	});

	it("ratchets the cognitive metric into max_cognitive", async () => {
		expect(await capsRatchetAction("cognitive", { to: "10" }, { cwd })).toBe(0);
		expect(capsFile().max_cognitive).toBe(10);
		expect(ledgerFile().metrics.cognitive?.cap).toBe(10);
		expect(ledgerFile().metrics.cognitive?.entries.map((e) => e.name)).toEqual(["big", "mid", "other"]);
	});
});

describe("capsSetAction on a complexity cap — the ledger follows the cap", () => {
	it("P1: with a ledger section, `caps set cyclomatic <lower>` delegates to the ratchet (cap + ledger regenerated together)", async () => {
		await capsRatchetAction("cyclomatic", { to: "16" }, { cwd });
		logs = [];
		expect(await capsSetAction("cyclomatic", "12", {}, { cwd })).toBe(0);
		expect(capsFile().max_cyclomatic).toBe(12);
		expect(ledgerFile().metrics.cyclomatic?.cap).toBe(12);
		expect(ledgerFile().metrics.cyclomatic?.entries.map((e) => e.name)).toEqual(["big", "mid", "other"]);
		expect(out()).toContain("Ratcheted cyclomatic cap 16 → 12");
	});

	it("P2: with a ledger section, `caps set` refuses to LOOSEN the cap (the ratchet's rule)", async () => {
		await capsRatchetAction("cyclomatic", { to: "16" }, { cwd });
		logs = [];
		expect(await capsSetAction("cyclomatic", "20", {}, { cwd })).toBe(1);
		expect(out()).toContain("loosen");
		expect(capsFile().max_cyclomatic).toBe(16);
		expect(ledgerFile().metrics.cyclomatic?.cap).toBe(16);
	});

	it("N1: without a ledger section, `caps set cyclomatic` writes only the cap and creates no ledger", async () => {
		expect(await capsSetAction("cyclomatic", "12", {}, { cwd })).toBe(0);
		expect(capsFile().max_cyclomatic).toBe(12);
		expect(existsSync(join(cwd, FUNCTION_COMPLEXITY_BASELINE_REL))).toBe(false);
	});

	it("N2: a section for the OTHER metric does not pull `caps set` into the ratchet", async () => {
		await capsRatchetAction("cognitive", { to: "10" }, { cwd });
		logs = [];
		expect(await capsSetAction("cyclomatic", "12", {}, { cwd })).toBe(0);
		expect(capsFile().max_cyclomatic).toBe(12);
		expect(ledgerFile().metrics.cyclomatic).toBeUndefined();
	});
});

describe("capsStatusAction", () => {
	it("says how to start when no ledger exists", async () => {
		expect(await capsStatusAction({}, { cwd })).toBe(0);
		expect(out()).toContain("no ledger");
		expect(out()).toContain("caps ratchet cyclomatic --to");
	});

	it("prints cap, entries remaining, top 10 by value, and the delta vs the previous ledger", async () => {
		await capsRatchetAction("cyclomatic", { to: "16" }, { cwd });
		await capsRatchetAction("cyclomatic", { to: "12" }, { cwd });
		logs = [];
		expect(await capsStatusAction({}, { cwd })).toBe(0);
		const text = out();
		expect(text).toContain("cyclomatic");
		expect(text).toContain("cap 12");
		expect(text).toContain("3 entries remaining");
		expect(text.indexOf("other")).toBeLessThan(text.indexOf("big")); // sorted by value desc
		expect(text).toContain("previous: cap 16, 2 entries");
		expect(text).toContain("cognitive: no ledger");
	});

	it("flags a ledger cap that drifted from the effective metric-caps.json cap", async () => {
		await capsRatchetAction("cyclomatic", { to: "16" }, { cwd });
		writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), JSON.stringify({ version: 1, max_cyclomatic: 14 }));
		resetMetricCapsCache();
		logs = [];
		await capsStatusAction({}, { cwd });
		expect(out()).toContain("effective cap 14");
	});

	it("--json exposes the same data machine-readably", async () => {
		await capsRatchetAction("cyclomatic", { to: "16" }, { cwd });
		logs = [];
		expect(await capsStatusAction({ json: true }, { cwd })).toBe(0);
		const parsed = JSON.parse(out()) as Record<
			string,
			{ cap: number; effective_cap: number; remaining: number; top: Array<{ name: string }>; previous: unknown } | null
		>;
		expect(parsed.cyclomatic?.cap).toBe(16);
		expect(parsed.cyclomatic?.effective_cap).toBe(16);
		expect(parsed.cyclomatic?.remaining).toBe(2);
		expect(parsed.cyclomatic?.top.map((e) => e.name)).toEqual(["other", "big"]);
		expect(parsed.cyclomatic?.previous).toBeNull();
		expect(parsed.cognitive).toBeNull();
	});
});
