import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { currentVerifyTimings, measureVerifyCheck, measureVerifyCheckAsync, recordVerifyInputDeferral, recordVerifyInputExclusion, withVerifyTimings } from "./check-timing.js";

const roots: string[] = [];
function root(): string { const path = mkdtempSync(join(tmpdir(), "il-verify-timing-")); roots.push(path); return path; }
afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("one timing row per check includes repeated calls and actual async wall time", async () => {
    const cwd = root(); let time = 0; vi.spyOn(performance, "now").mockImplementation(() => time);
    await withVerifyTimings(cwd, async () => {
        for (let n = 0; n < 2; n++) expect(measureVerifyCheck("a", () => { time += 7; return [n]; })).toEqual([n]);
        await measureVerifyCheckAsync("b", async () => { time += 13; });
    });
    const rows = readFileSync(join(cwd, ".interlinked/verify-runs.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.check === "a")).toMatchObject({ calls: 2, duration_ms: 14, max_call_ms: 7, status: "complete" });
    expect(rows.find(row => row.check === "b")).toMatchObject({ calls: 1, duration_ms: 13 });
});

it("MUST-FIRE: cumulative budget stops later invocations and reports partial, never clean", async () => {
    const cwd = root(); let time = 0; vi.spyOn(performance, "now").mockImplementation(() => time); vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const work = vi.fn(() => { time += 31; return [1]; });
    await withVerifyTimings(cwd, () => { measureVerifyCheck("slow", work, () => []); expect(measureVerifyCheck("slow", work, () => [])).toEqual([]); }, { budgetMs: 30 });
    expect(work).toHaveBeenCalledTimes(1); expect(process.exitCode).toBe(75);
    expect(JSON.parse(readFileSync(join(cwd, ".interlinked/verify-runs.jsonl"), "utf8"))).toMatchObject({ check: "slow", skipped: 1, status: "partial" });
});

it("checks every selected input by default after more than thirty seconds of detector work", async () => {
	const cwd = root(); let time = 0;
	vi.spyOn(performance, "now").mockImplementation(() => time);
	const work = vi.fn(() => { time += 31_000; return [work.mock.calls.length]; });
	await withVerifyTimings(cwd, () => {
		for (let index = 1; index <= 3; index++) {
			expect(measureVerifyCheck("slow", work, () => [])).toEqual([index]);
		}
	});
	expect(work).toHaveBeenCalledTimes(3);
	expect(process.exitCode).toBe(0);
	expect(JSON.parse(readFileSync(join(cwd, ".interlinked/verify-runs.jsonl"), "utf8")))
		.toMatchObject({ calls: 3, skipped: 0, duration_ms: 93_000, status: "complete" });
});

it("MUST-NOT-FIRE: unexhausted check returns its original result and errors still propagate", async () => {
    const cwd = root();
    await expect(withVerifyTimings(cwd, () => measureVerifyCheck("broken", () => { throw new Error("actual failure"); }))).rejects.toThrow("actual failure");
    expect(JSON.parse(readFileSync(join(cwd, ".interlinked/verify-runs.jsonl"), "utf8"))).toMatchObject({ errors: 1, status: "error" });
    expect(measureVerifyCheck("outside", () => [1], () => [])).toEqual([1]);
});

it("retains every known unavailable input and separates intentional exclusions", async () => {
	const cwd = root();
	vi.spyOn(process.stderr, "write").mockReturnValue(true);
	await withVerifyTimings(cwd, () => {
		for (let index = 0; index < 101; index++) recordVerifyInputDeferral("unreadable", { file: `${index}.ts`, reason: "EACCES" });
		recordVerifyInputExclusion("input_excluded:generated", { file: "generated.ts", reason: "generated source" });
		const unavailable = currentVerifyTimings().find(row => row.check === "unreadable");
		expect(unavailable?.unavailable_inputs).toHaveLength(101);
		expect(unavailable?.unavailable_inputs?.[100]).toEqual({ file: "100.ts", reason: "EACCES" });
		expect(currentVerifyTimings().find(row => row.check === "input_excluded:generated")).toMatchObject({
			skipped: 0, excluded: 1, excluded_inputs: [{ file: "generated.ts", reason: "generated source" }],
		});
	});
	expect(process.exitCode).toBe(75);
});
