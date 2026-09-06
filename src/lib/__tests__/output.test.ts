import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOutputMode, output, outputError, outputSuccess } from "../output.js";

describe("getOutputMode", () => {
	it("returns `json` when options.json is true", () => {
		expect(getOutputMode({ json: true })).toBe("json");
	});

	it("returns `short` when options.short is true", () => {
		expect(getOutputMode({ short: true })).toBe("short");
	});

	it("returns `full` when options.full is true", () => {
		expect(getOutputMode({ full: true })).toBe("full");
	});

	it("returns `normal` by default", () => {
		expect(getOutputMode({})).toBe("normal");
	});

	it("json precedence: json + short → json", () => {
		expect(getOutputMode({ json: true, short: true })).toBe("json");
	});
});

describe("output() dispatch", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
		errSpy.mockRestore();
		process.exitCode = 0;
	});

	it("json mode prints JSON-stringified renderer output", () => {
		output("json", { a: 1 }, { normal: () => "ignored", json: () => ({ b: 2 }) });
		expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ b: 2 }, null, 2));
	});

	it("json mode falls back to data when no json renderer is provided", () => {
		output("json", { a: 1 }, { normal: () => "ignored" });
		expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2));
	});

	it("short mode uses the short renderer", () => {
		output("short", null, { normal: () => "n", short: () => "s" });
		expect(logSpy).toHaveBeenCalledWith("s");
	});

	it("short mode falls back to normal when short renderer is absent", () => {
		output("short", null, { normal: () => "n" });
		expect(logSpy).toHaveBeenCalledWith("n");
	});

	it("full mode uses the full renderer when present", () => {
		output("full", null, { normal: () => "n", full: () => "f" });
		expect(logSpy).toHaveBeenCalledWith("f");
	});

	it("normal mode always uses the normal renderer", () => {
		output("normal", null, { normal: () => "n" });
		expect(logSpy).toHaveBeenCalledWith("n");
	});

	it("throws a named error for a mode value outside the OutputMode union", () => {
		// SAFETY: deliberately outside the OutputMode union to exercise the
		// runtime exhaustiveness guard that a real caller's TS check would refuse.
		const bogusMode = "bogus" as unknown as Parameters<typeof output>[0];
		expect(() => output(bogusMode, null, { normal: () => "n" })).toThrow(
			"unhandled output mode: bogus",
		);
	});

	it("outputError in json mode prints structured JSON to stderr + sets exitCode=1", () => {
		outputError("json", "boom", { code: 42 });
		expect(errSpy).toHaveBeenCalledWith(
			JSON.stringify({ error: "boom", details: { code: 42 } }, null, 2),
		);
		expect(process.exitCode).toBe(1);
	});

	it("outputError in normal mode prints `Error: ...`", () => {
		outputError("normal", "boom");
		expect(errSpy).toHaveBeenCalledWith("Error: boom");
		expect(process.exitCode).toBe(1);
	});

	it("outputError in full mode prints details", () => {
		outputError("full", "boom", { stack: "..." });
		expect(
			errSpy.mock.calls.some((c) => typeof c[0] === "string" && c[0].includes("stack")),
		).toBe(true);
	});

	it("outputSuccess is silent in json mode", () => {
		outputSuccess("json", "ok");
		expect(logSpy).not.toHaveBeenCalled();
	});

	it("outputSuccess prints in normal mode", () => {
		outputSuccess("normal", "ok");
		expect(logSpy).toHaveBeenCalledWith("ok");
	});
});
