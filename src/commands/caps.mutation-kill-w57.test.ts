import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capsExplainAction, capsSetAction, capsShowAction } from "./caps.js";

describe("caps.ts — mutation-kill w57", () => {
	let dir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "caps-mkw57-"));
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		logSpy.mockRestore();
		errSpy.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	});

	function loggedText(): string {
		return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
	}

	// --- capsShowAction: formatCapShowRow / header / footer -----------------

	it("P1: header line is exact (kills ae7ba82aa44a1927)", async () => {
		await capsShowAction({}, { cwd: dir });
		expect(logSpy.mock.calls[0]?.[0]).toBe(
			"Quality-metric caps  (change: interlinked caps set <metric> <value>):",
		);
	});

	it("P1: trailing hint line is exact (kills cdc2de8ec536bc8f)", async () => {
		await capsShowAction({}, { cwd: dir });
		const last = logSpy.mock.calls.at(-1)?.[0];
		expect(last).toBe("Run `interlinked caps explain` for what each metric means.");
	});

	it("P1: coverage row (stricter=higher) renders as a goal line, other metrics do not (kills 0cc9684c09e602a7)", async () => {
		await capsShowAction({}, { cwd: dir });
		const text = loggedText();
		const lines = text.split("\n").filter((l) => l.trim().startsWith("coverage"));
		expect(lines.length).toBeGreaterThan(0);
		for (const l of lines) {
			expect(l).toContain("goal");
			expect(l).toContain("ratchets rise toward it");
		}
		const cyclomaticLine = text.split("\n").find((l) => l.trim().startsWith("cyclomatic"));
		expect(cyclomaticLine).toBeDefined();
		expect(cyclomaticLine).not.toContain("goal");
		expect(cyclomaticLine).toContain("≤");
	});

	it("P1: unit is appended with a leading space for a metric with a unit (kills 7e9b52448cfe4648)", async () => {
		await capsShowAction({}, { cwd: dir });
		const text = loggedText();
		const linesRow = text.split("\n").find((l) => l.trim().startsWith("lines "));
		expect(linesRow).toBeDefined();
		// unit "lines" must appear immediately after the number, space-separated
		expect(linesRow).toMatch(/≤\s*\d+\s+lines/);
	});

	// --- buildRows: baseline !== undefined branch ----------------------------

	it("P1: large-file baseline overrides max_lines when present (kills ea9d23dad47f44bf/1cb1fa5d829bbd17/14b0960fa5b30d49)", async () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "large-files-baseline.json"),
			JSON.stringify({ max_lines: 777, files: [] }),
		);
		await capsShowAction({ json: true }, { cwd: dir });
		const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(parsed.lines.value).toBe(777);
		expect(parsed.lines.default).toBe(500);
	});

	it("N1: with no baseline file present, lines cap falls back to the shipped default", async () => {
		await capsShowAction({ json: true }, { cwd: dir });
		const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(parsed.lines.value).toBe(500);
	});

	// --- readExisting: malformed / missing / valid ----------------------------

	it("P1: malformed JSON in metric-caps.json is treated as empty and overwritten cleanly (kills 39353d2608fd210d)", async () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const path = join(dir, ".interlinked", "metric-caps.json");
		writeFileSync(path, "{ not valid json !!!");
		const code = await capsSetAction("cyclomatic", "20", {}, { cwd: dir });
		expect(code).toBe(0);
		const written = JSON.parse(readFileSync(path, "utf8"));
		expect(written.max_cyclomatic).toBe(20);
		// version key present means the object was fully rebuilt, not merged with garbage
		expect(written.version).toBe(1);
	});

	it("P1: an existing valid cap file is preserved via merge across a set (kills f860cf932bc8bdc4/ceb7c5539271f966)", async () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		const path = join(dir, ".interlinked", "metric-caps.json");
		writeFileSync(path, JSON.stringify({ version: 1, max_cyclomatic: 15 }));
		const code = await capsSetAction("crap", "40", {}, { cwd: dir });
		expect(code).toBe(0);
		const written = JSON.parse(readFileSync(path, "utf8"));
		// pre-existing key survives the merge — proves readExisting actually read the file
		expect(written.max_cyclomatic).toBe(15);
		expect(written.crap_threshold).toBe(40);
	});

	// --- capsSetAction: unknown metric / join / opts.json ---------------------

	it("P1: unknown metric error message lists all valid keys comma-joined (kills a80ec3e69c50a82b/4d2deb0b32dcdccc/4b9887b0aa6b7a57)", async () => {
		const code = await capsSetAction("bogus", "5", {}, { cwd: dir });
		expect(code).toBe(1);
		const msg = String(errSpy.mock.calls[0]?.[0]);
		expect(msg).toContain('Unknown metric "bogus"');
		expect(msg).toContain("lines, function-tokens, cyclomatic, cognitive, crap, coverage");
	});

	it("P1: capsSetAction json branch only fires when opts.json is true (kills edfd68a51b69fc6a)", async () => {
		const code = await capsSetAction("cyclomatic", "18", {}, { cwd: dir });
		expect(code).toBe(0);
		expect(logSpy.mock.calls[0]?.[0]).not.toMatch(/^\{/);
		expect(String(logSpy.mock.calls[0]?.[0])).toContain("Set");
	});

	it("P1: capsSetAction json branch emits JSON when opts.json is true", async () => {
		const code = await capsSetAction("cyclomatic", "18", { json: true }, { cwd: dir });
		expect(code).toBe(0);
		const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(parsed).toEqual({ metric: "cyclomatic", value: 18, configKey: "max_cyclomatic" });
	});

	// --- capsExplainAction: unknown metric / arrow / string parts -------------

	it("P1: capsExplainAction unknown metric message lists keys comma-joined (kills f64d547e8079e424/fd2c879206236049)", async () => {
		const code = await capsExplainAction("bogus", {}, { cwd: dir });
		expect(code).toBe(1);
		const msg = String(errSpy.mock.calls[0]?.[0]);
		expect(msg).toContain('Unknown metric "bogus"');
		expect(msg).toContain("lines, function-tokens, cyclomatic, cognitive, crap, coverage");
	});

	it("P1: capsExplainAction non-json prints label/definition/default/configure/fix per metric (kills 686f9245c5b9cd3b/fb309d2656a7bfe0/a9882eec2d55a717/7776556748f8202b/3a43c784a778496c/b964f6d092b58928/6f93762423a5b718)", async () => {
		const code = await capsExplainAction("lines", {}, { cwd: dir });
		expect(code).toBe(0);
		const text = loggedText();
		expect(text).toContain("file size (lines) (lines)");
		expect(text).toContain("Physical lines in one hand-written code file: an advisory decomposition preference");
		expect(text).toMatch(/Default: 500 lines · lower is stricter/);
		expect(text).toContain("Configure: `interlinked caps set lines <n>`");
		expect(text).toContain("Fix: Review module responsibilities when useful");
	});

	it("P1: capsExplainAction json branch emits structured JSON only when opts.json true (kills 99e262caa8de93fc)", async () => {
		const code = await capsExplainAction("lines", {}, { cwd: dir });
		expect(code).toBe(0);
		// non-json path must not have produced a JSON array as the first log line
		expect(() => JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toThrow();
	});

	it("P1: capsExplainAction json branch structure is correct when requested", async () => {
		const code = await capsExplainAction("lines", { json: true }, { cwd: dir });
		expect(code).toBe(0);
		const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed[0].key).toBe("lines");
		expect(parsed[0].label).toBe("file size (lines)");
	});
});
