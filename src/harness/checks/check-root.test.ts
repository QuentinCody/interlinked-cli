// Tests for the check-root context: the one mechanism that carries a scan's
// project root, and its NOT MEASURED disclosures, to registry detectors.

import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRoot, notMeasuredLine, reportNotMeasured, withCheckRoot } from "./check-root.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("checkRoot / withCheckRoot", () => {
	it("P1: returns the active run's root inside withCheckRoot", () => {
		const seen = withCheckRoot("/scan/root", () => checkRoot());
		expect(seen.result).toBe("/scan/root");
	});

	it("P2: a nested run sees its own root and restores the outer root on exit", () => {
		const seen = withCheckRoot("/outer", () => {
			const inner = withCheckRoot("/inner", () => checkRoot()).result;
			return [inner, checkRoot()];
		});
		expect(seen.result).toEqual(["/inner", "/outer"]);
	});

	it("N1: falls back to process.cwd() outside a run", () => {
		vi.spyOn(process, "cwd").mockReturnValue("/process/cwd");
		expect(checkRoot()).toBe("/process/cwd");
	});

	it("N2: restores the fallback when the run throws", () => {
		vi.spyOn(process, "cwd").mockReturnValue("/process/cwd");
		expect(() =>
			withCheckRoot("/scan/root", () => {
				throw new Error("detector failure");
			}),
		).toThrow("detector failure");
		expect(checkRoot()).toBe("/process/cwd");
	});
});

describe("reportNotMeasured", () => {
	it("P3: formats the standard disclosure line", () => {
		expect(notMeasuredLine("some_check", "no compiler")).toBe(
			"[interlinked:some_check] NOT MEASURED: no compiler",
		);
	});

	it("P4: a run collects each distinct line once and writes nothing to stderr", () => {
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const run = withCheckRoot("/scan/root", () => {
			reportNotMeasured("some_check", "no compiler");
			reportNotMeasured("some_check", "no compiler");
			reportNotMeasured("other_check", "no config");
			return 7;
		});
		expect(run).toEqual({
			result: 7,
			notMeasured: [
				"[interlinked:some_check] NOT MEASURED: no compiler",
				"[interlinked:other_check] NOT MEASURED: no config",
			],
		});
		expect(write).not.toHaveBeenCalled();
	});

	it("P5: a nested run's lines also reach the enclosing run", () => {
		const outer = withCheckRoot("/outer", () => {
			withCheckRoot("/inner", () => reportNotMeasured("inner_check", "no compiler"));
		});
		expect(outer.notMeasured).toEqual(["[interlinked:inner_check] NOT MEASURED: no compiler"]);
	});

	it("N3: outside a run, writes each distinct line to stderr once per process", () => {
		const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		reportNotMeasured("stderr_check", "unique reason for N3");
		reportNotMeasured("stderr_check", "unique reason for N3");
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("[interlinked:stderr_check] NOT MEASURED: unique reason for N3\n");
	});
});
