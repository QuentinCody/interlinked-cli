import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CheckOutputPlan,
	emitCheckOutput,
	printToolReportIfRequested,
	warnDroppedDiscoveryTools,
} from "./check-report.js";

describe("warnDroppedDiscoveryTools", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	it("P1: does nothing when tools is not a string", () => {
		warnDroppedDiscoveryTools(true, () => true);
		warnDroppedDiscoveryTools(undefined, () => true);
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("P2: does nothing when no dropped ids match the predicate", () => {
		warnDroppedDiscoveryTools("tsc,biome", () => false);
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("N1: warns with the dropped ids when the predicate flags some", () => {
		warnDroppedDiscoveryTools("tsc, dep-audit , docs-check", (id) => id !== "tsc");
		expect(stderrSpy).toHaveBeenCalledTimes(1);
		// SAFETY: stderrSpy is mocked with a string-writing implementation above;
		// the harness's own Bash.write overload accepts Buffer too, but this call
		// site always passes a template-string literal.
		const msg = stderrSpy.mock.calls[0]?.[0] as string;
		expect(msg).toContain("dep-audit, docs-check");
		expect(msg).toContain("interlinked verify");
	});
});

describe("printToolReportIfRequested", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	it("P1: returns false and writes nothing when report is falsy", () => {
		const result = printToolReportIfRequested(process.cwd(), false, undefined, undefined);
		expect(result).toBe(false);
		expect(stderrSpy).not.toHaveBeenCalled();
	});

	it("P2: prints the report and returns true when neither tools nor onlyCheck is set", () => {
		const result = printToolReportIfRequested(process.cwd(), true, undefined, undefined);
		expect(result).toBe(true);
		expect(stderrSpy).toHaveBeenCalled();
	});

	it("N1: prints the report but returns false when tools is set", () => {
		const result = printToolReportIfRequested(process.cwd(), true, "tsc", undefined);
		expect(result).toBe(false);
		expect(stderrSpy).toHaveBeenCalled();
	});

	it("N2: prints the report but returns false when onlyCheck is set", () => {
		const result = printToolReportIfRequested(process.cwd(), true, undefined, "circular_imports");
		expect(result).toBe(false);
		expect(stderrSpy).toHaveBeenCalled();
	});
});

describe("emitCheckOutput", () => {
	const basePlan: CheckOutputPlan = {
		onlyCheck: undefined,
		isStructuralOnly: false,
		isEngineOnly: false,
	};

	it("P1: emits JSON output when json is true, regardless of plan", () => {
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		emitCheckOutput(true, basePlan, [{ name: "cycles", files: new Set(["b.ts"]) }], null, 3);
		expect(stdoutSpy).toHaveBeenCalledTimes(1);
		// SAFETY: emitJsonOutput's only stdout call is `${JSON.stringify(...)}\n`,
		// a template-string literal, never a Buffer.
		const payload = JSON.parse(stdoutSpy.mock.calls[0]?.[0] as string);
		expect(payload).toEqual({ cycles: { count: 1, files: ["b.ts"] } });
		stdoutSpy.mockRestore();
	});

	it("P2: emits the structural-only view when onlyCheck is structural", () => {
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const plan: CheckOutputPlan = { onlyCheck: "circular_imports", isStructuralOnly: true, isEngineOnly: false };
		emitCheckOutput(false, plan, [{ name: "circular_imports", files: new Set(["a.ts"]) }], null, 1);
		const stdoutLines = stdoutSpy.mock.calls.map((c) => c[0]);
		const stderrLines = stderrSpy.mock.calls.map((c) => c[0]);
		expect(stdoutLines).toEqual(["a.ts\n"]);
		expect(stderrLines).toEqual(["\n1 files\n"]);
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it("N1: emits nothing extra when onlyCheck is engine-only but engineReport is null", () => {
		const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const plan: CheckOutputPlan = { onlyCheck: "tsc", isStructuralOnly: false, isEngineOnly: true };
		emitCheckOutput(false, plan, [], null, 0);
		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(stderrSpy).not.toHaveBeenCalled();
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
	});

	it("N2: falls through to the full summary when onlyCheck is unset", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		emitCheckOutput(false, basePlan, [], null, 5);
		const stderrLines = stderrSpy.mock.calls.map((c) => c[0]);
		expect(stderrLines).toEqual([
			"\n  Interlinked project check (5 files indexed)\n\n",
			"\n  total unique: 0 / 5 files\n\n",
		]);
		stderrSpy.mockRestore();
	});
});
