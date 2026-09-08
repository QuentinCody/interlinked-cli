import { parseWire, wireArray, wireNumber, wireObject, wireRecord, wireString } from "../lib/value-validation.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nonNull } from "../lib/non-null.js";
import { capsExplainAction, capsSetAction, capsShowAction } from "./caps.js";

let cwd: string;
let logs: string[];
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "caps-cmd-"));
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
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

function capsFile(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(cwd, ".interlinked", "metric-caps.json"), "utf8"));
}
const out = (): string => logs.join("\n");

describe("capsShowAction", () => {
	it("shows every metric at its shipped default when no override exists", async () => {
		const code = await capsShowAction({}, { cwd });
		expect(code).toBe(0);
		expect(out()).toContain("cyclomatic");
		expect(out()).toContain("function-tokens");
		expect(out()).toContain("25"); // default cyclomatic
		expect(out()).toContain("default");
	});

	it("reflects a per-repo override and marks its source", async () => {
		writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), JSON.stringify({ max_cyclomatic: 15 }));
		await capsShowAction({}, { cwd });
		expect(out()).toContain("15");
		expect(out()).toContain("metric-caps.json");
	});

	it("emits machine-readable JSON with --json", async () => {
		await capsShowAction({ json: true }, { cwd });
		const parsed = parseWire(JSON.parse(out()), wireRecord(wireObject({ "value": wireNumber, "source": wireString })), "test JSON value");
		expect(nonNull(parsed.cyclomatic).value).toBe(25);
		expect(nonNull(parsed.lines).value).toBe(500);
		expect(nonNull(parsed["function-tokens"]).value).toBe(500);
		expect(nonNull(parsed.crap).value).toBe(30);
		expect(nonNull(parsed.coverage).value).toBe(100); // the GOAL, default 100
	});
});

describe("capsSetAction", () => {
	it("writes a per-repo cyclomatic override and confirms", async () => {
		const code = await capsSetAction("cyclomatic", "15", {}, { cwd });
		expect(code).toBe(0);
		expect(capsFile().max_cyclomatic).toBe(15);
		expect(out()).toContain("cyclomatic");
	});

	it("creates .interlinked/ when absent instead of throwing ENOENT (finding 2026-06)", async () => {
		// A fresh repo (before `interlinked enable`) has no .interlinked/; the
		// beforeEach pre-creates it, so remove it to reproduce. caps set must create
		// the dir and write the policy file rather than crash on ENOENT.
		rmSync(join(cwd, ".interlinked"), { recursive: true, force: true });
		const code = await capsSetAction("cyclomatic", "15", {}, { cwd });
		expect(code).toBe(0);
		expect(capsFile().max_cyclomatic).toBe(15);
	});

	it("maps each metric to its config key", async () => {
		await capsSetAction("lines", "500", {}, { cwd });
		await capsSetAction("function-tokens", "400", {}, { cwd });
		await capsSetAction("crap", "20", {}, { cwd });
		await capsSetAction("coverage", "90", {}, { cwd });
		const f = capsFile();
		expect(f.max_lines).toBe(500);
		expect(f.max_function_tokens).toBe(400);
		expect(f.crap_threshold).toBe(20);
		// `caps set coverage` writes the GOAL; the min_coverage hard floor is a
		// separate hand-edited lever (2026-08-17 goal-vs-cap redesign).
		expect(f.coverage_goal).toBe(90);
		expect(f.min_coverage).toBeUndefined();
	});

	it("enforces the fixed integer ceiling and refuses to loosen a tightened function-token cap", async () => {
		expect(await capsSetAction("function-tokens", "501", {}, { cwd })).toBe(1);
		expect(await capsSetAction("function-tokens", "499.5", {}, { cwd })).toBe(1);
		expect(await capsSetAction("function-tokens", "400", {}, { cwd })).toBe(0);
		expect(await capsSetAction("function-tokens", "401", {}, { cwd })).toBe(1);
		expect(capsFile().max_function_tokens).toBe(400);
	});

	it("merges into an existing file without clobbering other keys", async () => {
		await capsSetAction("cyclomatic", "15", {}, { cwd });
		await capsSetAction("crap", "20", {}, { cwd });
		const f = capsFile();
		expect(f.max_cyclomatic).toBe(15);
		expect(f.crap_threshold).toBe(20);
	});

	it("rejects an unknown metric", async () => {
		const code = await capsSetAction("bogus", "10", {}, { cwd });
		expect(code).toBe(1);
		expect(existsSync(join(cwd, ".interlinked", "metric-caps.json"))).toBe(false);
	});

	it("rejects a non-numeric or out-of-scale value (coverage goal bounded 1..100)", async () => {
		expect(await capsSetAction("cyclomatic", "abc", {}, { cwd })).toBe(1);
		expect(await capsSetAction("cyclomatic", "0", {}, { cwd })).toBe(1);
		expect(await capsSetAction("coverage", "0", {}, { cwd })).toBe(1); // a goal of 0 is meaningless
		expect(await capsSetAction("coverage", "150", {}, { cwd })).toBe(1); // beyond the scale's own ceiling
		expect(await capsSetAction("coverage", "80", {}, { cwd })).toBe(0); // a less ambitious goal is fine
	});

	it("--json emits the written override", async () => {
		await capsSetAction("cyclomatic", "15", { json: true }, { cwd });
		expect(JSON.parse(out())).toMatchObject({ metric: "cyclomatic", value: 15 });
	});

	it("overwrites a malformed existing metric-caps.json cleanly", async () => {
		writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), "{not json");
		const code = await capsSetAction("cyclomatic", "15", {}, { cwd });
		expect(code).toBe(0);
		expect(capsFile().max_cyclomatic).toBe(15);
	});

	it("P1: merges into an existing metric-caps.json that parses to a real object", async () => {
		writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), JSON.stringify({ max_lines: 400 }));
		const code = await capsSetAction("cyclomatic", "15", {}, { cwd });
		expect(code).toBe(0);
		expect(capsFile()).toEqual({ version: 1, max_lines: 400, max_cyclomatic: 15 });
	});

	it("N1: overwrites cleanly when metric-caps.json parses to a JSON array (valid JSON, wrong shape)", async () => {
		// Regression: the old `JSON.parse(...) as Record<string, unknown>` cast
		// admitted the array as-is, so spreading it leaked its numeric-index
		// entries (`{0:1,1:2,2:3}`) into the written file instead of taking the
		// documented "{} — overwrite cleanly" path.
		writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), JSON.stringify([1, 2, 3]));
		const code = await capsSetAction("cyclomatic", "15", {}, { cwd });
		expect(code).toBe(0);
		expect(capsFile()).toEqual({ version: 1, max_cyclomatic: 15 });
	});

	it("N2: overwrites cleanly when metric-caps.json parses to a bare JSON string (valid JSON, wrong shape)", async () => {
		writeFileSync(join(cwd, ".interlinked", "metric-caps.json"), JSON.stringify("oops"));
		const code = await capsSetAction("cyclomatic", "15", {}, { cwd });
		expect(code).toBe(0);
		expect(capsFile()).toEqual({ version: 1, max_cyclomatic: 15 });
	});
});

describe("capsExplainAction", () => {
	it("explains every metric when no metric is named", async () => {
		const code = await capsExplainAction(undefined, {}, { cwd });
		expect(code).toBe(0);
		for (const m of ["lines", "function-tokens", "cyclomatic", "cognitive", "crap", "coverage"])
			expect(out()).toContain(m);
	});

	it("explains a single metric with its definition and how-to-configure", async () => {
		await capsExplainAction("cyclomatic", {}, { cwd });
		expect(out().toLowerCase()).toContain("branch");
		expect(out()).toContain("interlinked caps set cyclomatic");
	});

	it("rejects an unknown metric", async () => {
		expect(await capsExplainAction("bogus", {}, { cwd })).toBe(1);
	});

	it("--json returns the glossary entries", async () => {
		await capsExplainAction(undefined, { json: true }, { cwd });
		const parsed = parseWire(JSON.parse(out()), wireArray(wireObject({ "key": wireString })), "test JSON value");
		expect(parsed.map((d) => d.key)).toEqual([
			"lines",
			"function-tokens",
			"cyclomatic",
			"cognitive",
			"crap",
			"coverage",
		]);
	});
});
