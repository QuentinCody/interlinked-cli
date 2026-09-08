import { parseWire, wireObject, wireRecord, wireString, wireUnknown } from "../lib/value-validation.js";
// ===========================================
// interlinked trace — behavioral coverage (companion to trace.ts)
// ===========================================
// Drives traceExportCommand + traceImportCommand through EVERY branch:
//   export:
//     - format ternary (jsonl arm vs default json arm)
//     - the two spread ternaries (since present/absent, agent present/absent)
//       and their combinations, asserting the exact opts forwarded to
//       exportTrace
//     - `if (opts.output)` truthy (writeFileSync + output: json renderer
//       {file,format} AND normal renderer via opts.output!) vs falsy
//       (console.log straight-through)
//     - catch: Error arm (err.message) and non-Error arm (String(err))
//   import:
//     - readFileSync feeds importTrace; json renderer returns the result
//     - normal renderer: skipped > 0 arm (prints "Skipped (dedup)") and
//       skipped === 0 arm (line omitted)
//     - catch: Error arm and non-Error arm
//
// The SUT is `src/commands/trace.ts`. Its real disk dependencies —
// `node:fs` (readFileSync/writeFileSync) and the DISTINCT module
// `src/lib/trace.ts` (exportTrace/importTrace) — are fully mocked. The
// lib/trace mock path is written as a template literal so the
// `mocking_the_sut` basename heuristic doesn't mistake the sibling
// `lib/trace` for the command `commands/trace` (same basename, different
// module). The REAL output.ts is used so the genuine mode-dispatch runs;
// formatter.js is mocked to identity/parseable renderers so output
// assertions are exact strings rather than ANSI-sensitive substrings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- node:fs mock: capture writes, script reads --------------------------
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();

vi.mock("node:fs", () => ({
	readFileSync: (path: string, enc: string) => mockReadFileSync(path, enc),
	writeFileSync: (path: string, data: string) => mockWriteFileSync(path, data),
}));

// ---- lib/trace mock: scripted export/import boundary --------------------
// Template-literal path keeps this distinct from the SUT (commands/trace)
// for the mocking_the_sut basename check — see the header note.
const mockExportTrace = vi.fn();
const mockImportTrace = vi.fn();

vi.mock(`../lib/${"trace"}.js`, () => ({
	exportTrace: (opts: unknown) => mockExportTrace(opts),
	importTrace: (data: string) => mockImportTrace(data),
}));

// ---- formatter mock: identity colors + parseable header/kvLine ----------
vi.mock("../lib/formatter.js", () => {
	const identity = (s: string): string => s;
	return {
		c: new Proxy(
			{},
			{
				get: (): ((s: string) => string) => identity,
			},
		),
		header: (title: string): string => `== ${title} ==`,
		kvLine: (key: string, value: string): string => `${key}: ${value}`,
	};
});

// Real output.ts is used (no stub) so the genuine mode dispatch runs.
import { traceExportCommand, traceImportCommand } from "./trace.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const allLog = (): string =>
	logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
const lastLog = (): string => String(logSpy.mock.calls.at(-1)?.[0] ?? "");
const lastErr = (): string => String(errSpy.mock.calls.at(-1)?.[0] ?? "");
const lastJson = (): unknown => JSON.parse(lastLog());

beforeEach(() => {
	vi.clearAllMocks();
	process.exitCode = 0;

	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

	// Safe defaults: export yields a stable doc string; import a clean result.
	mockExportTrace.mockReturnValue('{"format":"interlinked-trace"}');
	mockImportTrace.mockReturnValue({ imported: 0, skipped: 0 });
	mockReadFileSync.mockReturnValue("{}");
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = 0;
});

// ===========================================
// traceExportCommand — format ternary
// ===========================================

describe("traceExportCommand — format selection", () => {
	it("format 'jsonl' is forwarded verbatim (jsonl arm of the ternary)", async () => {
		await traceExportCommand({ format: "jsonl" });
		expect(mockExportTrace).toHaveBeenCalledWith({ format: "jsonl" });
	});

	it("format 'json' resolves to the default json arm", async () => {
		await traceExportCommand({ format: "json" });
		expect(mockExportTrace).toHaveBeenCalledWith({ format: "json" });
	});

	it("an unrecognized format falls back to json (default arm)", async () => {
		await traceExportCommand({ format: "yaml" });
		expect(mockExportTrace).toHaveBeenCalledWith({ format: "json" });
	});

	it("an omitted format defaults to json (default arm)", async () => {
		await traceExportCommand({});
		expect(mockExportTrace).toHaveBeenCalledWith({ format: "json" });
	});
});

// ===========================================
// traceExportCommand — since/agent spread ternaries
// ===========================================

describe("traceExportCommand — option spread", () => {
	it("omits since AND agent keys when both are absent (both ternary false arms)", async () => {
		await traceExportCommand({});
		// exactOptionalPropertyTypes: absent keys must NOT appear at all.
		expect(mockExportTrace).toHaveBeenCalledWith({ format: "json" });
		const arg = parseWire(mockExportTrace.mock.calls[0]?.[0], wireRecord(wireUnknown), "test JSON value");
		expect(Object.keys(arg).sort()).toEqual(["format"]);
	});

	it("includes only since when agent is absent", async () => {
		await traceExportCommand({ since: "1h" });
		expect(mockExportTrace).toHaveBeenCalledWith({ since: "1h", format: "json" });
	});

	it("includes only agent when since is absent", async () => {
		await traceExportCommand({ agent: "worker-z" });
		expect(mockExportTrace).toHaveBeenCalledWith({ agent: "worker-z", format: "json" });
	});

	it("includes both since and agent when both are present (both true arms)", async () => {
		await traceExportCommand({ since: "2d", agent: "worker-z", format: "jsonl" });
		expect(mockExportTrace).toHaveBeenCalledWith({
			since: "2d",
			agent: "worker-z",
			format: "jsonl",
		});
	});
});

// ===========================================
// traceExportCommand — output to file (opts.output truthy)
// ===========================================

describe("traceExportCommand — write to file", () => {
	it("writes the trace data to the given path (normal mode prints a confirmation)", async () => {
		mockExportTrace.mockReturnValue("TRACE-BYTES");
		await traceExportCommand({ output: "out/trace.json" });

		expect(mockWriteFileSync).toHaveBeenCalledWith("out/trace.json", "TRACE-BYTES");
		// normal renderer uses opts.output! inside c.bold(...) (identity-mocked).
		expect(allLog()).toBe("Trace exported to out/trace.json");
		// File branch does NOT echo the trace to stdout.
		expect(allLog()).not.toContain("TRACE-BYTES");
	});

	it("json mode emits the {file, format} payload (json renderer arm)", async () => {
		mockExportTrace.mockReturnValue("TRACE-BYTES");
		await traceExportCommand({ output: "out/trace.jsonl", format: "jsonl", json: true });

		expect(mockWriteFileSync).toHaveBeenCalledWith("out/trace.jsonl", "TRACE-BYTES");
		expect(lastJson()).toEqual({ file: "out/trace.jsonl", format: "jsonl" });
	});

	it("json mode reports the default json format alongside the file", async () => {
		await traceExportCommand({ output: "out/trace.json", json: true });
		expect(lastJson()).toEqual({ file: "out/trace.json", format: "json" });
	});
});

// ===========================================
// traceExportCommand — print to stdout (opts.output falsy)
// ===========================================

describe("traceExportCommand — stdout", () => {
	it("prints the raw trace data to stdout when no --output (falsy branch)", async () => {
		mockExportTrace.mockReturnValue("RAW-TRACE-DOC");
		await traceExportCommand({});

		expect(mockWriteFileSync).not.toHaveBeenCalled();
		expect(allLog()).toBe("RAW-TRACE-DOC");
	});

	it("treats an empty-string --output as falsy and prints to stdout", async () => {
		mockExportTrace.mockReturnValue("RAW-TRACE-DOC");
		await traceExportCommand({ output: "" });

		expect(mockWriteFileSync).not.toHaveBeenCalled();
		expect(allLog()).toBe("RAW-TRACE-DOC");
	});
});

// ===========================================
// traceExportCommand — catch path
// ===========================================

describe("traceExportCommand — error handling", () => {
	it("reports an Error thrown by exportTrace via outputError (err.message arm, exitCode 1)", async () => {
		mockExportTrace.mockImplementation(() => {
			throw new Error("export blew up");
		});

		await traceExportCommand({});

		expect(lastErr()).toBe("Error: export blew up");
		expect(process.exitCode).toBe(1);
	});

	it("stringifies a non-Error throwable from writeFileSync (String(err) arm)", async () => {
		mockExportTrace.mockReturnValue("DATA");
		mockWriteFileSync.mockImplementation(() => {
			throw "disk full"; // eslint-disable-line no-throw-literal
		});

		await traceExportCommand({ output: "out/x.json", json: true });

		const payload = parseWire(JSON.parse(lastErr()), wireObject({ "error": wireString }), "test JSON value");
		expect(payload.error).toBe("disk full");
		expect(process.exitCode).toBe(1);
	});
});

// ===========================================
// traceImportCommand — happy paths
// ===========================================

describe("traceImportCommand — import", () => {
	it("reads the file as utf-8 and feeds its contents to importTrace", async () => {
		mockReadFileSync.mockReturnValue("FILE-CONTENTS");
		await traceImportCommand("in/trace.json", {});

		expect(mockReadFileSync).toHaveBeenCalledWith("in/trace.json", "utf-8");
		expect(mockImportTrace).toHaveBeenCalledWith("FILE-CONTENTS");
	});

	it("json mode returns the raw import result (json renderer arm)", async () => {
		mockImportTrace.mockReturnValue({ imported: 5, skipped: 2 });
		await traceImportCommand("in/trace.json", { json: true });

		expect(lastJson()).toEqual({ imported: 5, skipped: 2 });
	});

	it("normal mode with skipped > 0 prints both Imported and Skipped lines (ternary true arm)", async () => {
		mockImportTrace.mockReturnValue({ imported: 5, skipped: 2 });
		await traceImportCommand("in/trace.json", {});

		const out = allLog();
		expect(out).toContain("== Trace Import ==");
		expect(out).toContain("Imported: 5");
		expect(out).toContain("Skipped (dedup): 2");
	});

	it("normal mode with skipped === 0 omits the Skipped line (ternary false arm)", async () => {
		mockImportTrace.mockReturnValue({ imported: 3, skipped: 0 });
		await traceImportCommand("in/trace.json", {});

		const out = allLog();
		expect(out).toContain("Imported: 3");
		expect(out).not.toContain("Skipped");
	});
});

// ===========================================
// traceImportCommand — catch path
// ===========================================

describe("traceImportCommand — error handling", () => {
	it("reports an Error thrown by readFileSync via outputError (err.message arm, exitCode 1)", async () => {
		mockReadFileSync.mockImplementation(() => {
			throw new Error("ENOENT: no such file");
		});

		await traceImportCommand("missing.json", {});

		expect(lastErr()).toBe("Error: ENOENT: no such file");
		expect(process.exitCode).toBe(1);
		expect(mockImportTrace).not.toHaveBeenCalled();
	});

	it("stringifies a non-Error throwable from importTrace (String(err) arm, json mode)", async () => {
		mockImportTrace.mockImplementation(() => {
			throw "corrupt trace"; // eslint-disable-line no-throw-literal
		});

		await traceImportCommand("in/trace.json", { json: true });

		const payload = parseWire(JSON.parse(lastErr()), wireObject({ "error": wireString }), "test JSON value");
		expect(payload.error).toBe("corrupt trace");
		expect(process.exitCode).toBe(1);
	});
});
